import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ProjectId,
  RunId,
  TeamFile,
  TeamId,
  type TeamHandoff,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as TeamOrchestrator from "./teamOrchestrator.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { TeamAutoNotesLive } from "./TeamAutoNotes.ts";
import * as TeamService from "./TeamService.ts";
import { git, initRepo, writeFile } from "./testing/gitRepo.ts";
import {
  makeTeamOrigin,
  TEST_TEAM_LOGIN,
  testTeamServiceLayer,
  useTeamOrigin,
} from "./testing/teamState.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
/** Its project has no `.team/`. */
const THREAD_PLAIN = ThreadId.make("thread-plain");

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-auto-notes-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

let sequence = 0;
/**
 * A checkpoint as the capture service writes it: the run's own (with a run
 * id), or a baseline (none). Paths are relative to the repo root.
 */
const checkpointCaptured = (
  threadId: ThreadId,
  files: ReadonlyArray<string>,
  options: { readonly status?: "ready" | "missing"; readonly baseline?: boolean } = {},
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    sequence += 1;
    const now = yield* DateTime.now;
    const nodeId = NodeId.make(`node:auto-notes-${sequence}`);
    const runId = options.baseline ? null : RunId.make(`run:auto-notes-${sequence}`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:auto-notes-${sequence}`),
      events: [
        {
          id: EventId.make(`event:auto-notes-${sequence}`),
          type: "checkpoint.captured",
          threadId,
          ...(runId === null ? {} : { runId }),
          nodeId,
          occurredAt: now,
          payload: {
            id: CheckpointId.make(`checkpoint:auto-notes-${sequence}`),
            threadId,
            scopeId: CheckpointScopeId.make(`scope:auto-notes-${threadId}`),
            runId,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: sequence,
            appRunOrdinal: runId === null ? null : sequence,
            ref: CheckpointRef.make(`refs/t3/checkpoints/auto-notes-${sequence}`),
            status: options.status ?? "ready",
            files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
            capturedAt: now,
          },
        },
      ],
    });
  });

const makeHarness = Effect.fn("makeTeamAutoNotesHarness")(function* (options: {
  readonly workspaceRoot: string;
  readonly plainRoot: string;
  readonly worktrees?: Partial<Record<ThreadId, string>>;
}) {
  // Every saved note, in order.
  const saved = yield* Queue.unbounded<TeamHandoff>();
  const fs = yield* FileSystem.FileSystem;
  // The team state lives on the project's origin, a local bare repo here.
  useTeamOrigin(
    git(options.workspaceRoot, "rev-parse", "--show-toplevel"),
    makeTeamOrigin(yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-origin-" })),
  );
  const teamContext = yield* Layer.build(
    Layer.effect(
      TeamService.TeamService,
      TeamService.TeamService.pipe(
        Effect.map((service) =>
          TeamService.TeamService.of({
            ...service,
            saveAutomaticNote: (input) =>
              service.saveAutomaticNote(input).pipe(Effect.tap((note) => Queue.offer(saved, note))),
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
  // The team state is on origin with this server as owner, as after `t3 team init`.
  yield* teams.ensureTeam({
    teamFile: TeamFile.make({ teamId: TEAM_ID, name: "Core" }),
    checkout: options.workspaceRoot,
  });

  // The real v2 orchestrator, with the threads in the project.
  const orchestration = yield* Layer.build(TeamOrchestrator.layer);
  const seed = (threadId: ThreadId, worktreePath: string | null) =>
    TeamOrchestrator.seedThread({
      projectId: PROJECT_ID,
      threadId,
      workspaceRoot: options.workspaceRoot,
      worktreePath,
    }).pipe(Effect.provide(orchestration));
  yield* seed(THREAD_A, options.worktrees?.[THREAD_A] ?? null);
  yield* seed(THREAD_B, options.worktrees?.[THREAD_B] ?? null);
  yield* seed(THREAD_PLAIN, options.plainRoot);

  yield* Layer.build(
    TeamAutoNotesLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(teamContext),
          GitLayer,
          Layer.succeedContext(orchestration),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
            getDescriptor: Effect.succeed({
              environmentId: ENVIRONMENT_ID,
              label: TEST_TEAM_LOGIN,
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
    publish: (
      threadId: ThreadId,
      files: ReadonlyArray<string>,
      options?: Parameters<typeof checkpointCaptured>[2],
    ) => checkpointCaptured(threadId, files, options).pipe(Effect.provide(orchestration)),
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

      // Skipped: a checkpoint that could not be read, a run with no files, a baseline.
      yield* harness.publish(THREAD_A, ["src/login.ts"], { status: "missing" });
      yield* harness.publish(THREAD_A, []);
      yield* harness.publish(THREAD_A, ["src/login.ts"], { baseline: true });
      // A checkout with no team file: the note goes to the solo team, not the team.
      yield* harness.publish(THREAD_PLAIN, ["src/x.ts"]);
      const plain = yield* harness.nextSaved;
      assert.equal(plain.thread.threadId, THREAD_PLAIN);
      assert.notEqual(plain.teamId, TEAM_ID);
      assert.deepEqual(plain.files, ["src/x.ts"]);

      writeFile(root, "src/login.ts", "v2\n");
      writeFile(root, "src/form.ts", "form\n");
      yield* harness.publish(THREAD_A, ["src/login.ts", "src/form.ts"]);
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
      yield* harness.publish(THREAD_A, ["src/api.ts"]);
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

      // Checkpoint paths are relative to the repo root; README.md is outside the project.
      yield* harness.publish(THREAD_A, ["app/src/a.ts", "README.md"]);
      const fromA = yield* harness.nextSaved;
      assert.deepEqual(fromA.files, ["src/a.ts"]);

      writeFile(worktree, "app/src/b.ts", "b\n");
      yield* harness.publish(THREAD_B, ["app/src/b.ts"]);
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
