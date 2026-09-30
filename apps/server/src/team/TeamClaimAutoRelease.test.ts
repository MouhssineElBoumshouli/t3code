import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TeamFile,
  TeamId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PullRequestState,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { RELEASE_REASONS, TeamClaimAutoReleaseLive } from "./TeamClaimAutoRelease.ts";
import * as TeamService from "./TeamService.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_FILE = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
const NOW = "1970-01-01T00:00:00.000Z";
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
/** Archived at the end of a test: its release proves every earlier event was handled. */
const SENTINEL = ThreadId.make("thread-sentinel");

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: `/worktrees/${id}`,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function link(number: number, state: PullRequestState | null): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "created",
    linkedAt: NOW,
    snapshot:
      state === null
        ? null
        : {
            state,
            title: `PR ${number}`,
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: NOW,
            syncedAt: NOW,
          },
    stack: null,
  };
}

let sequence = 0;
/** The reactor reads only `type` and the payload fields it needs. */
function event(type: OrchestrationEvent["type"], payload: object): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_A,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as unknown as OrchestrationEvent;
}

const archived = (threadId: ThreadId) =>
  event("thread.archived", { threadId, archivedAt: NOW, updatedAt: NOW });

function synced(threadId: ThreadId, number: number, state: PullRequestState, mergedAt?: string) {
  const snapshot = link(number, state).snapshot!;
  return event("thread.pull-request-synced", {
    threadId,
    host: "github.com",
    repository: "acme/app",
    number,
    snapshot: mergedAt === undefined ? snapshot : { ...snapshot, mergedAt },
    stack: null,
    updatedAt: NOW,
  });
}

interface Released {
  readonly threadId: ThreadId;
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
}

const makeHarness = Effect.fn("makeTeamClaimAutoReleaseHarness")(function* (
  threads: ReadonlyArray<OrchestrationThreadShell>,
) {
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const merges = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const shells = yield* Ref.make(threads);
  // Every release call, in order, with what it released.
  const releases = yield* Queue.unbounded<Released>();

  // The real service, recording each release call.
  const teamContext = yield* Layer.build(
    Layer.effect(
      TeamService.TeamService,
      TeamService.make.pipe(
        Effect.map((service) =>
          TeamService.TeamService.of({
            ...service,
            releaseThreadClaims: (input) =>
              service.releaseThreadClaims(input).pipe(
                Effect.tap((released) =>
                  Queue.offer(releases, {
                    threadId: input.thread.threadId,
                    reason: input.reason,
                    paths: released.flatMap((claim) => claim.paths),
                  }),
                ),
              ),
          }),
        ),
      ),
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer)),
  );
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(teamContext));
  const { owner } = yield* teams.ensureTeam({
    teamFile: TEAM_FILE,
    canonicalKey: null,
    owner: { environmentId: ENVIRONMENT_ID, displayName: "Mouhssine" },
  });
  const claim = (threadId: ThreadId, paths: Array<string>) =>
    teams.claimPaths({
      teamId: TEAM_FILE.teamId,
      memberId: owner.memberId,
      thread: { environmentId: ENVIRONMENT_ID, threadId },
      paths,
    });
  const activePaths = (threadId: ThreadId) =>
    teams
      .listActiveClaims(TEAM_FILE.teamId)
      .pipe(
        Effect.map((claims) =>
          claims.filter((held) => held.thread.threadId === threadId).flatMap((held) => held.paths),
        ),
      );

  const start = Effect.gen(function* () {
    yield* Layer.build(
      TeamClaimAutoReleaseLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(teamContext),
            Layer.mock(OrchestrationEngineService)({
              subscribeDomainEvents: PubSub.subscribe(events).pipe(
                Effect.map((subscription) => Stream.fromSubscription(subscription)),
              ),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              subscribeMerges: PubSub.subscribe(merges).pipe(
                Effect.map((subscription) => Stream.fromSubscription(subscription)),
              ),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadShellById: (threadId) =>
                Ref.get(shells).pipe(
                  Effect.map((current) =>
                    Option.fromUndefinedOr(
                      current.find((shell) => shell.id === threadId && shell.archivedAt === null),
                    ),
                  ),
                ),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
            }),
          ),
        ),
      ),
    );
  });

  /** Archives the sentinel and waits for it: every release before it is returned. */
  const settle = Effect.gen(function* () {
    yield* PubSub.publish(events, archived(SENTINEL));
    const seen: Array<Released> = [];
    while (true) {
      const next = yield* Queue.take(releases);
      if (next.threadId === SENTINEL) return seen;
      seen.push(next);
    }
  });

  return {
    start,
    settle,
    claim,
    activePaths,
    releases,
    shells,
    publish: (value: OrchestrationEvent) => PubSub.publish(events, value),
    merge: (value: PullRequestService.PullRequestMergeEvent) => PubSub.publish(merges, value),
  };
});

describe("TeamClaimAutoRelease", () => {
  it.effect("keeps claims when a turn ends: nothing releases them by default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([makeThread(THREAD_A, { pullRequests: [link(1, null)] })]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.start;
      // A turn ends, its diff lands, the thread goes idle and settles, its PR opens and closes.
      yield* harness.publish(event("thread.turn-diff-completed", { threadId: THREAD_A }));
      yield* harness.publish(event("thread.session-set", { threadId: THREAD_A }));
      yield* harness.publish(event("thread.settled", { threadId: THREAD_A }));
      yield* harness.publish(synced(THREAD_A, 1, "open"));
      yield* harness.publish(synced(THREAD_A, 1, "closed"));

      assert.deepEqual(yield* harness.settle, []);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/login.ts"]);
    }),
  );

  it.effect("releases a thread's claims when it is archived or deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([makeThread(THREAD_A), makeThread(THREAD_B)]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.claim(THREAD_B, ["src/api.ts"]);
      yield* harness.start;

      yield* harness.publish(archived(THREAD_A));
      assert.deepEqual(yield* Queue.take(harness.releases), {
        threadId: THREAD_A,
        reason: RELEASE_REASONS.archived,
        paths: ["src/login.ts"],
      });
      assert.deepEqual(yield* harness.activePaths(THREAD_B), ["src/api.ts"]);

      yield* harness.publish(event("thread.deleted", { threadId: THREAD_B, deletedAt: NOW }));
      assert.deepEqual(yield* Queue.take(harness.releases), {
        threadId: THREAD_B,
        reason: RELEASE_REASONS.deleted,
        paths: ["src/api.ts"],
      });
    }),
  );

  it.effect("releases claims made before a linked pull request merged, not after", () =>
    Effect.gen(function* () {
      // The projection can still show the link as open when the event arrives.
      const harness = yield* makeHarness([
        makeThread(THREAD_A, { pullRequests: [link(1, "open")] }),
      ]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* TestClock.adjust("60 seconds");
      // The chat carries on after the merge and claims new work.
      yield* harness.claim(THREAD_A, ["src/next.ts"]);
      yield* harness.start;

      yield* harness.publish(synced(THREAD_A, 1, "merged", "1970-01-01T00:00:30.000Z"));
      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_A, reason: RELEASE_REASONS.merged, paths: ["src/login.ts"] },
      ]);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/next.ts"]);
    }),
  );

  it.effect("waits for every open pull request of the thread (a stack) to merge", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        makeThread(THREAD_A, { pullRequests: [link(1, "open"), link(2, "open")] }),
      ]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.start;

      yield* harness.publish(synced(THREAD_A, 1, "merged"));
      assert.deepEqual(yield* harness.settle, []);

      yield* Ref.set(harness.shells, [
        makeThread(THREAD_A, { pullRequests: [link(1, "merged"), link(2, "open")] }),
      ]);
      yield* harness.publish(synced(THREAD_A, 2, "merged"));
      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_A, reason: RELEASE_REASONS.merged, paths: ["src/login.ts"] },
      ]);
    }),
  );

  it.effect("releases on a merge made from T3 of the thread's branch pull request", () =>
    Effect.gen(function* () {
      const branchPullRequest = {
        projectId: PROJECT_ID,
        repository: "Acme/App",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
      };
      const harness = yield* makeHarness([
        makeThread(THREAD_A, { branchPullRequest }),
        makeThread(THREAD_B, { branchPullRequest: { ...branchPullRequest, number: 8 } }),
      ]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.claim(THREAD_B, ["src/api.ts"]);
      yield* harness.start;

      const mergedAt = "1970-01-01T00:00:30.000Z";
      // Thread B's number, but in another project; then thread A's pull request.
      yield* harness.merge({
        projectId: ProjectId.make("other"),
        repository: "acme/app",
        number: 8,
        mergedAt,
      });
      yield* harness.merge({ projectId: PROJECT_ID, repository: "acme/app", number: 7, mergedAt });
      assert.deepEqual(yield* Queue.take(harness.releases), {
        threadId: THREAD_A,
        reason: RELEASE_REASONS.merged,
        paths: ["src/login.ts"],
      });
      assert.deepEqual(yield* harness.activePaths(THREAD_B), ["src/api.ts"]);
      assert.deepEqual(yield* harness.settle, []);
    }),
  );

  it.effect("at startup, releases claims of threads archived or deleted while it was off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([makeThread(THREAD_A)]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.claim(THREAD_B, ["src/gone.ts"]);
      yield* harness.start;

      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_B, reason: RELEASE_REASONS.inactive, paths: ["src/gone.ts"] },
      ]);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/login.ts"]);
    }),
  );
});
