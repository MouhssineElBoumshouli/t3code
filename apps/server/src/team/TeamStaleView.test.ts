// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  EnvironmentId,
  type OrchestrationCheckpointSummary,
  ProjectId,
  ProviderInstanceId,
  TeamFile,
  TeamId,
  TeamMemberId,
  type TeamPath,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TEST_TEAM_LOGIN,
  TestTeamGitLayer,
  testTeamServiceLayer,
  useTeamOrigin,
} from "./testing/teamState.ts";
import * as TeamService from "./TeamService.ts";
import * as TeamStaleView from "./TeamStaleView.ts";
import { installTeamTurnNote, withTeamTurnNote } from "./teamTurnNote.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });
const ME = TeamMemberId.make(TEST_TEAM_LOGIN);
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

let originRoot = "";
let originUrl = "";
beforeEach(() => {
  originRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stale-view-origin-"));
  originUrl = makeTeamOrigin(originRoot);
});
afterEach(() => NodeFS.rmSync(originRoot, { recursive: true, force: true }));

const blobOf = (root: string, file: string) => git(root, "hash-object", file);

const checkpoint = (
  turn: number,
  ref: string,
  files: ReadonlyArray<string>,
  completedAt: string,
): OrchestrationCheckpointSummary => ({
  turnId: TurnId.make(`turn-${turn}`),
  checkpointTurnCount: turn,
  checkpointRef: CheckpointRef.make(ref),
  status: "ready",
  files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 1 })),
  assistantMessageId: null,
  completedAt,
});

/** A project folder with four files; `team` adds `.team/team.json`, else it is solo. */
const makeHarness = Effect.fn("makeStaleViewHarness")(function* (team: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-view-" });
  initRepo(root, {
    "src/a.ts": "a1\n",
    "src/b.ts": "b1\n",
    "src/c.ts": "c1\n",
    "src/d.ts": "d1\n",
    ...(team ? { ".team/team.json": `{ "teamId": "${TEAM_ID}", "name": "Core" }` } : {}),
  });
  if (team) useTeamOrigin(root, originUrl);

  let checkpoints: ReadonlyArray<OrchestrationCheckpointSummary> = [];
  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: ENVIRONMENT_ID,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-view-state-" }),
    }),
    TestTeamGitLayer,
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeedSome({
          id: threadId,
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          latestTurn: null,
          createdAt: "2026-10-08T10:00:00.000Z",
          updatedAt: "2026-10-08T10:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        }),
      getProjectShellById: () =>
        Effect.succeedSome({
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: root,
          defaultModelSelection: null,
          scripts: [],
          repositoryIdentity: null,
          createdAt: "2026-10-08T10:00:00.000Z",
          updatedAt: "2026-10-08T10:00:00.000Z",
        }),
      getThreadCheckpointContext: (threadId) =>
        Effect.succeed(
          threadId === THREAD_A && checkpoints.length > 0
            ? Option.some({
                threadId,
                projectId: PROJECT_ID,
                workspaceRoot: root,
                worktreePath: null,
                checkpoints,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(dependencies);
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  const membership = team
    ? (yield* teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root })).membership
    : yield* teams.openSolo({ projectRoot: root, name: "Project" });
  if (membership.status !== "member") return yield* Effect.die("not a member");
  const teamId = membership.team.teamId;
  const memberId = membership.member.memberId;
  const { read } = yield* TeamStaleView.make.pipe(Effect.provide(context));

  /** Thread A's turn ends now (test clock): its checkpoint is the folder as it is. */
  const endTurnOfA = (files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      writeFile(root, `.checkpoint-${checkpoints.length}`, "");
      const ref = commitAll(root, `checkpoint ${checkpoints.length + 1}`);
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      checkpoints = [...checkpoints, checkpoint(checkpoints.length + 1, ref, files, completedAt)];
    });
  /** Another thread's automatic note on `file` as it is now in `folder`. */
  const noteBy = (
    service: TeamService.TeamService["Service"],
    memberId: string,
    thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    file: string,
    hash: string,
  ) =>
    service.saveAutomaticNote({
      teamId,
      memberId: TeamMemberId.make(memberId),
      thread,
      files: [file],
      fileHashes: { [file]: hash },
    });
  return { root, teams, teamId, memberId, read, endTurnOfA, noteBy };
}, Effect.provide(NodeServices.layer));

describe("renderStaleView", () => {
  it("names each file once, who changed it and whether it is in this copy", () => {
    assert.isUndefined(TeamStaleView.renderStaleView([]));
    assert.equal(
      TeamStaleView.renderStaleView([
        { path: "src/a.ts", by: ["Sara", "Omar"], inCopy: true },
        { path: "src/b.ts", by: [], inCopy: true },
      ]),
      "<team_changes>Changed since your last turn: `src/a.ts` (by Sara and Omar, in your copy); `src/b.ts` (outside this chat, in your copy). Re-read them before editing them.</team_changes>",
    );
    const many = Array.from({ length: 7 }, (_, index) => ({
      path: `src/${index}.ts`,
      by: ["Omar"],
      inCopy: false,
    }));
    assert.equal(
      TeamStaleView.renderStaleView(many),
      "<team_changes>Changed since your last turn: `src/0.ts` (by Omar, not merged into your copy); `src/1.ts` (by Omar, not merged into your copy); `src/2.ts` (by Omar, not merged into your copy); `src/3.ts` (by Omar, not merged into your copy); `src/4.ts` (by Omar, not merged into your copy) and 2 more. Unmerged changes may conflict with yours.</team_changes>",
    );
  });
});

describe("TeamStaleView", () => {
  it.effect(
    "tells a team thread which of its files changed since its last turn, by whom, once",
    () =>
      Effect.gen(function* () {
        const { root, teams, read, endTurnOfA, noteBy } = yield* makeHarness(true);
        // A changed a.ts and c.ts, and plans b.ts.
        writeFile(root, "src/a.ts", "a2\n");
        writeFile(root, "src/c.ts", "c2\n");
        yield* teams.claimPaths({
          teamId: TEAM_ID,
          memberId: ME,
          thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_A },
          paths: ["src/b.ts" as TeamPath],
        });
        yield* endTurnOfA(["src/a.ts", "src/c.ts"]);
        assert.isUndefined(yield* read(THREAD_A), "nothing changed since");
        yield* TestClock.adjust("1 minute");

        // My other chat B, same checkout, changes a.ts and its turn saves a note.
        writeFile(root, "src/a.ts", "a3\n");
        yield* noteBy(
          teams,
          TEST_TEAM_LOGIN,
          { environmentId: ENVIRONMENT_ID, threadId: THREAD_B },
          "src/a.ts",
          blobOf(root, "src/a.ts"),
        );
        // c.ts is changed by hand; d.ts too, but A never touched or planned it.
        writeFile(root, "src/c.ts", "c3\n");
        writeFile(root, "src/d.ts", "d3\n");
        // Omar, on his own server, changed b.ts in his copy: not merged into this one.
        const omar = yield* Layer.build(
          testTeamServiceLayer({
            environmentId: EnvironmentId.make("omar-server"),
            stateDirectory: NodeFS.mkdtempSync(NodePath.join(originRoot, "omar-")),
            host: fakeTeamHost("Omar"),
          }),
        ).pipe(Effect.flatMap((built) => TeamService.TeamService.pipe(Effect.provide(built))));
        yield* omar.openTeam({ teamFile: TEAM_FILE, checkout: root });
        NodeFS.writeFileSync(NodePath.join(originRoot, "b-omar.ts"), "b-omar\n");
        yield* noteBy(
          omar,
          "Omar",
          { environmentId: EnvironmentId.make("omar-server"), threadId: ThreadId.make("omar-1") },
          "src/b.ts",
          git(originRoot, "hash-object", "b-omar.ts"),
        );
        yield* omar.sync(TEAM_ID);
        yield* teams.refresh(TEAM_ID);

        assert.equal(
          yield* read(THREAD_A),
          "<team_changes>Changed since your last turn: `src/a.ts` (by another chat, in your copy); `src/c.ts` (outside this chat, in your copy); `src/b.ts` (by Omar, not merged into your copy). Re-read them before editing them. Unmerged changes may conflict with yours.</team_changes>",
        );

        // Told once: A's next turn sees the folder as it is now.
        yield* TestClock.adjust("1 minute");
        yield* endTurnOfA([]);
        assert.isUndefined(yield* read(THREAD_A));
      }).pipe(Effect.scoped),
  );

  it.effect("works solo: another chat's edit in the shared checkout", () =>
    Effect.gen(function* () {
      const { root, teams, memberId, read, endTurnOfA, noteBy } = yield* makeHarness(false);
      writeFile(root, "src/a.ts", "a2\n");
      yield* endTurnOfA(["src/a.ts"]);
      writeFile(root, "src/a.ts", "a3\n");
      yield* noteBy(
        teams,
        memberId,
        { environmentId: ENVIRONMENT_ID, threadId: THREAD_B },
        "src/a.ts",
        blobOf(root, "src/a.ts"),
      );
      assert.equal(
        yield* read(THREAD_A),
        "<team_changes>Changed since your last turn: `src/a.ts` (by another chat, in your copy). Re-read them before editing them.</team_changes>",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("adds the line after the message, never after a slash command", () =>
    Effect.gen(function* () {
      const uninstall = installTeamTurnNote(() => Effect.succeed("<team_changes>x</team_changes>"));
      try {
        assert.equal(
          yield* withTeamTurnNote(THREAD_A, "Fix the bug"),
          "Fix the bug\n\n<team_changes>x</team_changes>",
        );
        assert.equal(yield* withTeamTurnNote(THREAD_A, "/compact"), "/compact");
      } finally {
        uninstall();
      }
      assert.equal(yield* withTeamTurnNote(THREAD_A, "Fix the bug"), "Fix the bug");
    }),
  );
});
