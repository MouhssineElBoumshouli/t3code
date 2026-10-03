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
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type TeamHandoff,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { TeamAutoNotesLive } from "./TeamAutoNotes.ts";
import * as TeamService from "./TeamService.ts";
import { git, initRepo, writeFile } from "./testing/gitRepo.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const NOW = "2026-10-01T00:00:00.000Z";
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
/** Its project has no `.team/`. */
const THREAD_PLAIN = ThreadId.make("thread-plain");

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-auto-notes-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

function makeThread(id: ThreadId, worktreePath: string | null): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
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
  };
}

function makeProject(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let sequence = 0;
/** A turn diff as the checkpoint reactor sends it: paths relative to the repo root. */
function turnDiff(
  threadId: ThreadId,
  files: ReadonlyArray<string>,
  status: "ready" | "missing" = "ready",
): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-diff-completed",
    payload: {
      threadId,
      turnId: `turn-${sequence}`,
      checkpointTurnCount: sequence,
      checkpointRef: `refs/t3/checkpoints/${sequence}`,
      status,
      files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
      assistantMessageId: null,
      completedAt: NOW,
    },
  } as unknown as OrchestrationEvent;
}

const makeHarness = Effect.fn("makeTeamAutoNotesHarness")(function* (options: {
  readonly workspaceRoot: string;
  readonly plainRoot: string;
  readonly worktrees?: Partial<Record<ThreadId, string>>;
}) {
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  // Every saved note, in order.
  const saved = yield* Queue.unbounded<TeamHandoff>();
  const teamContext = yield* Layer.build(
    Layer.effect(
      TeamService.TeamService,
      TeamService.make.pipe(
        Effect.map((service) =>
          TeamService.TeamService.of({
            ...service,
            saveAutomaticNote: (input) =>
              service.saveAutomaticNote(input).pipe(Effect.tap((note) => Queue.offer(saved, note))),
          }),
        ),
      ),
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer)),
  );
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(teamContext));
  // This server hosts the team, as after `t3 team init` (team/DESIGN.md M2.1).
  yield* teams.ensureTeam({
    teamFile: TeamFile.make({ teamId: TEAM_ID, name: "Core" }),
    canonicalKey: null,
    owner: { environmentId: ENVIRONMENT_ID, displayName: "Mouhssine's laptop" },
  });

  yield* Layer.build(
    TeamAutoNotesLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(teamContext),
          GitLayer,
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (threadId) =>
              Effect.succeed(
                Option.some(
                  makeThread(
                    threadId,
                    threadId === THREAD_PLAIN
                      ? options.plainRoot
                      : (options.worktrees?.[threadId] ?? null),
                  ),
                ),
              ),
            getProjectShellById: () =>
              Effect.succeed(Option.some(makeProject(options.workspaceRoot))),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
            getDescriptor: Effect.succeed({
              environmentId: ENVIRONMENT_ID,
              label: "Mouhssine's laptop",
              platform: { os: "linux" as const, arch: "x64" as const },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          }),
        ),
      ),
    ),
  );

  return {
    teams,
    publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
    /** The next saved note; events are handled in order, so earlier ones are done. */
    nextSaved: Queue.take(saved),
    savedCount: Queue.size(saved),
  };
});

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-auto-notes-" });
});

const teamJson = `{ "teamId": "${TEAM_ID}", "name": "Core" }`;

describe("TeamAutoNotes", () => {
  it.effect("saves one note per thread after each ready turn, updated in place", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      const plainRoot = yield* tempDir;
      const base = initRepo(root, { ".team/team.json": teamJson, "src/login.ts": "v1\n" });
      initRepo(plainRoot, { "src/x.ts": "x\n" });
      const harness = yield* makeHarness({ workspaceRoot: root, plainRoot });

      // Skipped: a mid-turn placeholder, a turn with no files, and a project not in a team.
      yield* harness.publish(turnDiff(THREAD_A, ["src/login.ts"], "missing"));
      yield* harness.publish(turnDiff(THREAD_A, []));
      yield* harness.publish(turnDiff(THREAD_PLAIN, ["src/x.ts"]));

      writeFile(root, "src/login.ts", "v2\n");
      writeFile(root, "src/form.ts", "form\n");
      yield* harness.publish(turnDiff(THREAD_A, ["src/login.ts", "src/form.ts"]));
      const first = yield* harness.nextSaved;
      assert.equal(first.thread.threadId, THREAD_A);
      assert.isTrue(first.automatic);
      assert.deepEqual(first.files, ["src/login.ts", "src/form.ts"]);
      assert.equal(first.commit, base);
      assert.deepEqual(first.fileHashes, {
        "src/login.ts": git(root, "hash-object", "src/login.ts"),
        "src/form.ts": git(root, "hash-object", "src/form.ts"),
      });
      // The content is stored, so a later reason can count lines.
      assert.equal(git(root, "cat-file", "blob", first.fileHashes!["src/form.ts"]!), "form");

      writeFile(root, "src/api.ts", "api\n");
      yield* harness.publish(turnDiff(THREAD_A, ["src/api.ts"]));
      const second = yield* harness.nextSaved;
      assert.equal(second.handoffId, first.handoffId);
      assert.deepEqual(second.files, ["src/api.ts", "src/login.ts", "src/form.ts"]);

      const notes = yield* harness.teams.listHandoffs(TEAM_ID);
      assert.lengthOf(notes, 1);
      assert.equal(yield* harness.savedCount, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a note for each thread, with paths from the folder holding .team", () =>
    Effect.gen(function* () {
      const repo = yield* tempDir;
      const plainRoot = yield* tempDir;
      const path = yield* Path.Path;
      // The project, and its `.team/`, are a subfolder of the repo.
      initRepo(repo, {
        "README.md": "repo\n",
        "app/.team/team.json": teamJson,
        "app/src/a.ts": "a\n",
      });
      const worktree = path.join(yield* tempDir, "chat-b");
      git(repo, "worktree", "add", "--quiet", "-b", "chat-b", worktree);
      const harness = yield* makeHarness({
        workspaceRoot: path.join(repo, "app"),
        plainRoot,
        worktrees: { [THREAD_B]: path.join(worktree, "app") },
      });

      // Turn diff paths are relative to the repo root; README.md is outside the project.
      yield* harness.publish(turnDiff(THREAD_A, ["app/src/a.ts", "README.md"]));
      const fromA = yield* harness.nextSaved;
      assert.deepEqual(fromA.files, ["src/a.ts"]);

      writeFile(worktree, "app/src/b.ts", "b\n");
      yield* harness.publish(turnDiff(THREAD_B, ["app/src/b.ts"]));
      const fromB = yield* harness.nextSaved;
      assert.notEqual(fromB.handoffId, fromA.handoffId);
      assert.deepEqual(fromB.files, ["src/b.ts"]);
      assert.deepEqual(fromB.fileHashes, {
        "src/b.ts": git(worktree, "hash-object", "app/src/b.ts"),
      });
      assert.lengthOf(yield* harness.teams.listHandoffs(TEAM_ID), 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
