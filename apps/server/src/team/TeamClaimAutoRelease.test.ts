import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  type PullRequestState,
  TeamFile,
  TeamId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { RELEASE_REASONS, TeamClaimAutoReleaseLive } from "./TeamClaimAutoRelease.ts";
import * as TeamOrchestrator from "./teamOrchestrator.testkit.ts";
import * as TeamService from "./TeamService.ts";
import { makeTeamOrigin, testTeamServiceLayer, useTeamOrigin } from "./testing/teamState.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_FILE = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
const NOW = "1970-01-01T00:00:00.000Z";
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
/** Archived at the end of each settle: its release proves every earlier event was handled. */
const isSentinel = (threadId: ThreadId) => threadId.startsWith("thread-sentinel-");

function link(
  number: number,
  state: PullRequestState | null,
  mergedAt?: string,
): ThreadPullRequestLink {
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
            ...(mergedAt === undefined ? {} : { mergedAt }),
          },
    stack: null,
  };
}

interface Released {
  readonly threadId: ThreadId;
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
}

const makeHarness = Effect.fn("makeTeamClaimAutoReleaseHarness")(function* (
  threads: ReadonlyArray<ThreadId>,
) {
  const merges = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  // Every release call, in order, with what it released.
  const releases = yield* Queue.unbounded<Released>();

  // The real service on a local origin, recording each release call.
  const fs = yield* FileSystem.FileSystem;
  const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-release-" });
  useTeamOrigin(
    checkout,
    makeTeamOrigin(yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-origin-" })),
  );
  const teamContext = yield* Layer.build(
    Layer.effect(
      TeamService.TeamService,
      TeamService.TeamService.pipe(
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
    ).pipe(
      Layer.provide(
        testTeamServiceLayer({
          environmentId: ENVIRONMENT_ID,
          stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-state-" }),
        }),
      ),
    ),
  );
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(teamContext));
  const { membership } = yield* teams.ensureTeam({ teamFile: TEAM_FILE, checkout });
  assert.equal(membership.status, "member");
  const owner = Option.getOrThrow(yield* teams.currentMember(TEAM_FILE.teamId));
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

  // The real v2 orchestrator, with each thread (and the sentinel) in it.
  const orchestration = yield* Layer.build(TeamOrchestrator.layer);
  for (const threadId of threads) {
    yield* TeamOrchestrator.seedThread({
      projectId: PROJECT_ID,
      threadId,
      workspaceRoot: checkout,
    }).pipe(Effect.provide(orchestration));
  }
  const orchestrator = yield* Orchestrator.OrchestratorV2.pipe(Effect.provide(orchestration));
  const eventSink = yield* EventSink.EventSinkV2.pipe(Effect.provide(orchestration));
  let commands = 0;
  const nextCommandId = () => CommandId.make(`command:release-test-${++commands}`);

  const start = Effect.gen(function* () {
    yield* Layer.build(
      TeamClaimAutoReleaseLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(teamContext),
            Layer.succeedContext(orchestration),
            Layer.mock(PullRequestService.PullRequestService)({
              subscribeMerges: PubSub.subscribe(merges).pipe(
                Effect.map((subscription) => Stream.fromSubscription(subscription)),
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

  const archive = (threadId: ThreadId) =>
    orchestrator.dispatch({ type: "thread.archive", commandId: nextCommandId(), threadId });
  const remove = (threadId: ThreadId) =>
    orchestrator.dispatch({ type: "thread.delete", commandId: nextCommandId(), threadId });
  /** The provider sync's event: the thread with these links. */
  const syncPullRequests = (
    threadId: ThreadId,
    pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  ) =>
    Effect.gen(function* () {
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      const commandId = nextCommandId();
      yield* eventSink.write({
        commandId,
        events: [
          {
            id: EventId.make(`event:${commandId}`),
            type: "thread.pull-request-synced",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, pullRequests },
          },
        ],
      });
    });

  /** Archives a new sentinel and waits for it: every release before it is returned. */
  let sentinels = 0;
  const settle = Effect.gen(function* () {
    const sentinel = ThreadId.make(`thread-sentinel-${++sentinels}`);
    yield* TeamOrchestrator.seedThread({
      projectId: PROJECT_ID,
      threadId: sentinel,
      workspaceRoot: checkout,
    }).pipe(Effect.provide(orchestration));
    yield* archive(sentinel);
    const seen: Array<Released> = [];
    while (true) {
      const next = yield* Queue.take(releases);
      if (isSentinel(next.threadId)) return seen;
      seen.push(next);
    }
  });

  return {
    start,
    settle,
    claim,
    activePaths,
    releases,
    archive,
    remove,
    syncPullRequests,
    merge: (value: PullRequestService.PullRequestMergeEvent) => PubSub.publish(merges, value),
  };
}, Effect.provide(NodeServices.layer));

describe("TeamClaimAutoRelease", () => {
  it.effect("keeps claims when a turn ends: nothing releases them by default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([THREAD_A]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.start;
      // The thread's pull request is linked, opens and closes.
      yield* harness.syncPullRequests(THREAD_A, [link(1, null)]);
      yield* harness.syncPullRequests(THREAD_A, [link(1, "open")]);
      yield* harness.syncPullRequests(THREAD_A, [link(1, "closed")]);

      assert.deepEqual(yield* harness.settle, []);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/login.ts"]);
    }),
  );

  it.effect("releases a thread's claims when it is archived or deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([THREAD_A, THREAD_B]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.claim(THREAD_B, ["src/api.ts"]);
      yield* harness.start;
      // The start-up pass is done before events are handled.
      assert.deepEqual(yield* harness.settle, []);

      yield* harness.archive(THREAD_A);
      assert.deepEqual(yield* Queue.take(harness.releases), {
        threadId: THREAD_A,
        reason: RELEASE_REASONS.archived,
        paths: ["src/login.ts"],
      });
      assert.deepEqual(yield* harness.activePaths(THREAD_B), ["src/api.ts"]);

      yield* harness.remove(THREAD_B);
      assert.deepEqual(yield* Queue.take(harness.releases), {
        threadId: THREAD_B,
        reason: RELEASE_REASONS.deleted,
        paths: ["src/api.ts"],
      });
    }),
  );

  it.effect("releases claims made before a linked pull request merged, not after", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([THREAD_A]);
      yield* harness.syncPullRequests(THREAD_A, [link(1, "open")]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* TestClock.adjust("60 seconds");
      // The chat carries on after the merge and claims new work.
      yield* harness.claim(THREAD_A, ["src/next.ts"]);
      yield* harness.start;

      yield* harness.syncPullRequests(THREAD_A, [link(1, "merged", "1970-01-01T00:00:30.000Z")]);
      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_A, reason: RELEASE_REASONS.merged, paths: ["src/login.ts"] },
      ]);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/next.ts"]);
    }),
  );

  it.effect("waits for every open pull request of the thread (a stack) to merge", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([THREAD_A]);
      yield* harness.syncPullRequests(THREAD_A, [link(1, "open"), link(2, "open")]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.start;

      yield* harness.syncPullRequests(THREAD_A, [link(1, "merged"), link(2, "open")]);
      assert.deepEqual(yield* harness.settle, []);

      yield* harness.syncPullRequests(THREAD_A, [link(1, "merged"), link(2, "merged")]);
      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_A, reason: RELEASE_REASONS.merged, paths: ["src/login.ts"] },
      ]);
    }),
  );

  it.effect("releases on a merge made from T3 of the thread's branch pull request", () =>
    Effect.gen(function* () {
      // A merge made from T3 names the pull request, here one linked to each thread.
      const harness = yield* makeHarness([THREAD_A, THREAD_B]);
      yield* harness.syncPullRequests(THREAD_A, [link(7, "open")]);
      yield* harness.syncPullRequests(THREAD_B, [link(8, "open")]);
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
      const harness = yield* makeHarness([THREAD_A, THREAD_B]);
      yield* harness.claim(THREAD_A, ["src/login.ts"]);
      yield* harness.claim(THREAD_B, ["src/gone.ts"]);
      yield* harness.remove(THREAD_B);
      yield* harness.start;

      assert.deepEqual(yield* harness.settle, [
        { threadId: THREAD_B, reason: RELEASE_REASONS.inactive, paths: ["src/gone.ts"] },
      ]);
      assert.deepEqual(yield* harness.activePaths(THREAD_A), ["src/login.ts"]);
    }),
  );
});
