// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  RunId,
  TeamFile,
  TeamId,
  TeamMemberId,
  type TeamCombinedCheck,
  type TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TestTeamGitLayer,
  testTeamServiceLayer,
  useTeamOrigin,
} from "./testing/teamState.ts";
import * as TeamCombineCheck from "./TeamCombineCheck.ts";
import * as TeamMergeCheck from "./TeamMergeCheck.ts";
import * as TeamMergeFix from "./TeamMergeFix.ts";
import * as TeamOrchestrator from "./teamOrchestrator.testkit.ts";
import * as TeamService from "./TeamService.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });
const THREAD_A = ThreadId.make("thread-a");
const THREAD_SHARED = ThreadId.make("thread-shared");
const SARA = TeamMemberId.make("Sara");
const ROUTES = "src/api/routes.ts";
const RUN_FIX = RunId.make("run-fix");

let originRoot = "";
let originUrl = "";
beforeEach(() => {
  originRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-fix-origin-"));
  originUrl = makeTeamOrigin(originRoot);
});
afterEach(() => NodeFS.rmSync(originRoot, { recursive: true, force: true }));

const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");

/**
 * A team project; Sara's pushed `search` branch changes the routes line that
 * thread A (its own worktree, branch `t3/a` pushed) changed without committing.
 */
const makeHarness = Effect.fn("makeTeamMergeFixHarness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-fix-" });
  initRepo(root, {
    [ROUTES]: "get /search\nget /login\n",
    ".team/team.json": `{ "teamId": "${TEAM_ID}", "name": "Core" }`,
    ".team/rulebook.md": "# Rules\n\n## Check\n\n`pnpm typecheck`\n",
  });
  useTeamOrigin(root, originUrl);
  git(root, "push", "--quiet", "origin", "main");
  git(root, "checkout", "--quiet", "-b", "search", "main");
  writeFile(root, ROUTES, "get /search?tag\nget /login\n");
  const saraCommit = commitAll(root, "Sara: search by tag");
  git(root, "checkout", "--quiet", "main");
  const worktree = NodePath.join(originRoot, "worktree-a");
  git(root, "worktree", "add", "--quiet", "-b", "t3/a", worktree, "main");
  git(worktree, "push", "--quiet", "-u", "origin", "t3/a");
  writeFile(worktree, ROUTES, "get /search/trimmed\nget /login\n");
  const headBefore = git(worktree, "rev-parse", "HEAD");

  const orchestration = yield* Layer.build(TeamOrchestrator.layer);
  yield* Effect.gen(function* () {
    yield* TeamOrchestrator.seedThread({
      projectId: PROJECT_ID,
      threadId: THREAD_A,
      workspaceRoot: root,
      worktreePath: worktree,
    });
    yield* TeamOrchestrator.seedThread({
      projectId: PROJECT_ID,
      threadId: THREAD_SHARED,
      workspaceRoot: root,
    });
  }).pipe(Effect.provide(orchestration));

  const pair = (threadId: ThreadId): TeamMergePair => ({
    projectId: PROJECT_ID,
    mine: {
      thread: { environmentId: ENVIRONMENT_ID, threadId },
      title: "Trim",
      worktree: threadId === THREAD_A,
      commit: "mine-checkpoint",
    },
    other: { _tag: "branch", memberId: SARA, branch: "search", commit: saraCommit },
    status: "clash",
    files: [{ path: ROUTES, places: 1, regenerate: false }],
    fileCount: 1,
    bothChanged: [],
    previous: null,
    since: "2026-10-13T10:00:00.000Z",
    checkedAt: "2026-10-13T10:00:30.000Z",
  });
  const usedCommits = yield* Ref.make<ReadonlyArray<string>>([]);
  /** The pair the merge check returns instead of the clash with Sara, when set. */
  const pairOverride = yield* Ref.make<TeamMergePair | undefined>(undefined);
  const mergeCheck = TeamMergeCheck.TeamMergeCheck.of({
    forTeam: () => Effect.succeed(undefined),
    subscribeChanges: Effect.die("not used"),
    request: () => Effect.void,
    findPair: (_projectId, threadId) =>
      Ref.get(pairOverride).pipe(Effect.map((override) => override ?? pair(threadId))),
    useCommitUntilNextTurn: (input) => Ref.update(usedCommits, (all) => [...all, input.commit]),
    takeClashLine: () => Effect.succeed(undefined),
    placeOf: () => Effect.succeedNone,
    setCombined: () => Effect.void,
    combinedOf: () => Effect.succeed(undefined),
  });
  /** What the combined check before an update finds; clean when unset. */
  const combinedResult = yield* Ref.make<TeamCombinedCheck | undefined>(undefined);
  const combinedRuns = yield* Ref.make(0);
  const combineCheck = TeamCombineCheck.TeamCombineCheck.of({
    start: () => Effect.void,
    run: (request) =>
      Ref.update(combinedRuns, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(combinedResult)),
        Effect.map(
          (found): TeamCombinedCheck =>
            found ?? {
              mineCommit: "mine",
              otherCommit: request.other.commit,
              status: "clean",
              errors: [],
              errorCount: 0,
              checkedAt: "2026-10-14T10:00:00.000Z",
            },
        ),
      ),
  });

  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: ENVIRONMENT_ID,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-fix-state-" }),
    }),
    TestTeamGitLayer,
    Layer.succeedContext(orchestration),
    TeamOrchestrator.layerRecordingDispatch(dispatched, orchestration),
    Layer.succeed(TeamMergeCheck.TeamMergeCheck, mergeCheck),
    Layer.succeed(TeamCombineCheck.TeamCombineCheck, combineCheck),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-fix-home-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.build(TeamMergeFix.layer.pipe(Layer.provideMerge(dependencies)));
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  yield* teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root });

  // Sara joins from her own server.
  const sara = yield* Layer.build(
    testTeamServiceLayer({
      environmentId: EnvironmentId.make("sara-server"),
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-fix-sara-" }),
      host: fakeTeamHost("Sara"),
    }),
  ).pipe(Effect.flatMap((built) => TeamService.TeamService.pipe(Effect.provide(built))));
  yield* sara.openTeam({ teamFile: TEAM_FILE, checkout: root });
  yield* sara.sync(TEAM_ID);
  yield* teams.refresh(TEAM_ID);

  const fixes = yield* TeamMergeFix.TeamMergeFix.pipe(Effect.provide(context));
  const start = (threadId: ThreadId) =>
    fixes.act({ _tag: "start", projectId: PROJECT_ID, threadId, other: pair(threadId).other });
  const endTurn = TeamOrchestrator.setRun({
    threadId: THREAD_A,
    runId: RUN_FIX,
    ordinal: 1,
    status: "completed",
  }).pipe(Effect.provide(orchestration));
  const turnTexts = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) => (command.type === "message.dispatch" ? [command.text] : [])),
    ),
  );
  return {
    root,
    worktree,
    headBefore,
    saraCommit,
    teams,
    fixes,
    start,
    endTurn,
    orchestration,
    turnTexts,
    usedCommits: Ref.get(usedCommits),
    setPair: (next: TeamMergePair | undefined) => Ref.set(pairOverride, next),
    setCombined: (next: TeamCombinedCheck | undefined) => Ref.set(combinedResult, next),
    combinedRuns: Ref.get(combinedRuns),
    pair,
    /** The service again, as after a server restart: it reads the saved fixes. */
    restarted: TeamMergeFix.make.pipe(Effect.provide(context)),
  };
}, Effect.provide(NodeServices.layer));

describe("TeamMergeFix", () => {
  it.effect("starts the fix's turn, then approve commits, pushes and tells Sara", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start(THREAD_A);

      const [text] = yield* h.turnTexts;
      assert.include(text, "A merge of Sara's pushed branch `search` into this copy");
      assert.include(text, `- \`${ROUTES}\``);
      assert.include(text, "run `pnpm typecheck`");
      assert.include(read(h.worktree, ROUTES), "<<<<<<< ");
      const [working] = yield* h.fixes.forTeam(TEAM_ID);
      assert.equal(working?.status, "working");
      assert.isTrue(working?.savedWork);
      assert.include(
        (yield* Effect.flip(h.fixes.act({ _tag: "approve", threadId: THREAD_A }))).detail,
        "still working",
      );

      // The agent's turn resolves the file and ends.
      writeFile(h.worktree, ROUTES, "get /search/trimmed?tag\nget /login\n");
      yield* h.endTurn;
      assert.equal((yield* h.fixes.forTeam(TEAM_ID))[0]?.status, "ready");

      const result = yield* h.fixes.act({ _tag: "approve", threadId: THREAD_A });
      assert.deepEqual(result, { push: "pushed" });
      const head = git(h.worktree, "rev-parse", "HEAD");
      assert.equal(git(h.worktree, "log", "-1", "--format=%s"), "Merge Sara's search branch");
      assert.equal(git(h.root, "ls-remote", "origin", "t3/a").split("\t")[0], head);
      // Sara's branch is only read.
      assert.equal(git(h.root, "rev-parse", "search"), h.saraCommit);
      assert.deepEqual(yield* h.usedCommits, [head]);
      assert.deepEqual(yield* h.fixes.forTeam(TEAM_ID), []);
      const notes = yield* h.teams.listNotes(TEAM_ID);
      assert.equal(notes[0]?.to, SARA);
      assert.equal(
        notes[0]?.text,
        "Mouhssine's agent merged your search changes into their branch t3/a; see src/api/routes.ts.",
      );
    }),
  );

  it.effect("undo puts the copy back as it was before the fix", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start(THREAD_A);
      writeFile(h.worktree, ROUTES, "resolved\n");
      writeFile(h.worktree, "src/extra.ts", "added by the fix\n");
      yield* h.endTurn;

      yield* h.fixes.act({ _tag: "undo", threadId: THREAD_A });
      assert.equal(git(h.worktree, "rev-parse", "HEAD"), h.headBefore);
      assert.equal(read(h.worktree, ROUTES), "get /search/trimmed\nget /login\n");
      assert.equal(git(h.worktree, "status", "--porcelain"), `M ${ROUTES}`);
      assert.deepEqual(yield* h.fixes.forTeam(TEAM_ID), []);
      assert.deepEqual(yield* h.teams.listNotes(TEAM_ID), []);
    }),
  );

  it.effect("a turn that ends with markers left waits for the person's answer", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start(THREAD_A);
      // The agent asked which side to keep and ended its turn without resolving.
      yield* h.endTurn;
      assert.equal((yield* h.fixes.forTeam(TEAM_ID))[0]?.status, "asking");
      assert.include(
        (yield* Effect.flip(h.fixes.act({ _tag: "approve", threadId: THREAD_A }))).detail,
        "waiting for your answer",
      );

      // The person answers; the next turn resolves the file.
      writeFile(h.worktree, ROUTES, "get /search/trimmed?tag\nget /login\n");
      yield* TeamOrchestrator.setRun({
        threadId: THREAD_A,
        runId: RunId.make("run-answer"),
        ordinal: 2,
        status: "completed",
      }).pipe(Effect.provide(h.orchestration));
      assert.equal((yield* h.fixes.forTeam(TEAM_ID))[0]?.status, "ready");
    }),
  );

  it.effect("a restart still offers the waiting fix, and Undo works while it asks", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start(THREAD_A);
      yield* h.endTurn;
      const again = yield* h.restarted;
      assert.equal((yield* again.forTeam(TEAM_ID))[0]?.status, "asking");
      yield* again.act({ _tag: "undo", threadId: THREAD_A });
      assert.equal(git(h.worktree, "rev-parse", "HEAD"), h.headBefore);
    }),
  );

  it.effect(
    "update moves a clean chat on top of main; never with uncommitted work or a clash",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        // `main` moved: a change to another file.
        writeFile(h.root, "src/api/me.ts", "get /me\n");
        const base = commitAll(h.root, "main: add me");
        const onMain: TeamMergePair = {
          ...h.pair(THREAD_A),
          other: { _tag: "base", branch: "main", commit: base },
          status: "clean",
          files: [],
          fileCount: 0,
          bothChanged: [ROUTES],
        };
        yield* h.setPair(onMain);
        const update = h.fixes.act({
          _tag: "update",
          projectId: PROJECT_ID,
          threadId: THREAD_A,
          other: onMain.other,
        });

        // The chat's work is uncommitted: nothing moves.
        assert.include((yield* Effect.flip(update)).detail, "uncommitted changes");
        assert.equal(git(h.worktree, "rev-parse", "HEAD"), h.headBefore);

        // A turn runs: not now either.
        const mine = commitAll(h.worktree, "Trim the search route");
        yield* TeamOrchestrator.setRun({
          threadId: THREAD_A,
          runId: RunId.make("run-busy"),
          ordinal: 1,
          status: "running",
        }).pipe(Effect.provide(h.orchestration));
        assert.include((yield* Effect.flip(update)).detail, "agent is working");
        yield* TeamOrchestrator.setRun({
          threadId: THREAD_A,
          runId: RunId.make("run-busy"),
          ordinal: 1,
          status: "completed",
        }).pipe(Effect.provide(h.orchestration));

        // The combined check finds a new error: nothing moves until the person updates anyway.
        yield* h.setCombined({
          mineCommit: mine,
          otherCommit: base,
          status: "broken",
          errors: [{ path: "src/api/me.ts", message: "Cannot find name 'getUser'.", side: "mine" }],
          errorCount: 1,
          checkedAt: "2026-10-14T10:00:00.000Z",
        });
        const stopped = yield* update;
        assert.equal(stopped.update, "checked");
        assert.include(stopped.detail, "a new error");
        assert.equal(git(h.worktree, "rev-parse", "HEAD"), mine);
        const runs = yield* h.combinedRuns;

        assert.deepEqual(
          yield* h.fixes.act({
            _tag: "update",
            projectId: PROJECT_ID,
            threadId: THREAD_A,
            other: onMain.other,
            anyway: true,
          }),
          { update: "updated" },
        );
        // Anyway skips the check.
        assert.equal(yield* h.combinedRuns, runs);
        yield* h.setCombined(undefined);
        const head = git(h.worktree, "rev-parse", "HEAD");
        assert.notEqual(head, mine);
        assert.equal(git(h.worktree, "merge-base", base, "HEAD"), base);
        assert.equal(read(h.worktree, "src/api/me.ts"), "get /me\n");
        assert.equal(read(h.worktree, ROUTES), "get /search/trimmed\nget /login\n");
        // The merge check reads the moved copy until the chat's next turn.
        assert.deepEqual(yield* h.usedCommits, [head]);

        yield* h.setPair({ ...onMain, status: "clash" });
        assert.include((yield* Effect.flip(update)).detail, "Use Fix it");
      }),
  );

  it.effect("an update that stops on a conflict changes nothing, and Fix it merges instead", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      writeFile(h.root, ROUTES, "get /search/all\nget /login\n");
      const base = commitAll(h.root, "main: search all");
      const mine = commitAll(h.worktree, "Trim the search route");
      // Checked clean, but replaying the chat's commit conflicts.
      const onMain: TeamMergePair = {
        ...h.pair(THREAD_A),
        other: { _tag: "base", branch: "main", commit: base },
        status: "clean",
        files: [],
        fileCount: 0,
        bothChanged: [ROUTES],
      };
      yield* h.setPair(onMain);
      const result = yield* h.fixes.act({
        _tag: "update",
        projectId: PROJECT_ID,
        threadId: THREAD_A,
        other: onMain.other,
      });
      assert.equal(result.update, "conflict");
      assert.include(result.detail, "Fix it");
      assert.equal(git(h.worktree, "rev-parse", "HEAD"), mine);
      assert.equal(git(h.worktree, "status", "--porcelain"), "");

      yield* h.fixes.act({
        _tag: "start",
        projectId: PROJECT_ID,
        threadId: THREAD_A,
        other: onMain.other,
      });
      assert.include(read(h.worktree, ROUTES), "<<<<<<< ");
      assert.equal((yield* h.fixes.forTeam(TEAM_ID))[0]?.status, "working");
    }),
  );

  it.effect("refuses a chat in the shared checkout, and a second fix in one chat", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const shared = yield* Effect.flip(h.start(THREAD_SHARED));
      assert.include(shared.detail, "shared checkout");
      yield* h.start(THREAD_A);
      assert.include((yield* Effect.flip(h.start(THREAD_A))).detail, "already waiting");
      assert.lengthOf(yield* h.turnTexts, 1);
    }),
  );
});
