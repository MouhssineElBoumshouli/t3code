// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TeamChoiceMadePayload,
  TeamFile,
  TeamId,
  TeamMemberId,
  type TeamPath,
  type TeamPlanFile,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TestTeamGitLayer,
  testTeamServiceLayer,
  useTeamOrigin,
} from "./testing/teamState.ts";
import * as TeamCards from "./TeamCards.ts";
import * as TeamChoices from "./TeamChoices.ts";
import * as TeamOrchestrator from "./teamOrchestrator.testkit.ts";
import * as TeamService from "./TeamService.ts";
import * as TeamWait from "./TeamWait.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OMAR_SERVER = EnvironmentId.make("omar-server");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const LOGIN = "src/auth/login.ts";

let originRoot = "";
let originUrl = "";
beforeEach(() => {
  originRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-wait-origin-"));
  originUrl = makeTeamOrigin(originRoot);
});
afterEach(() => NodeFS.rmSync(originRoot, { recursive: true, force: true }));

const RUN_A = RunId.make("run-a");
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);

/**
 * A team project on this test's origin (`team`), or a solo one. Thread A runs
 * in its own worktree in team mode, in the project folder when solo.
 */
const makeHarness = Effect.fn("makeTeamWaitHarness")(function* (team: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-wait-" });
  initRepo(root, {
    [LOGIN]: "export const login = 1;\n",
    "src/format.ts": "export const format = 1;\n",
    ...(team ? { ".team/team.json": `{ "teamId": "${TEAM_ID}", "name": "Core" }` } : {}),
  });
  let worktree: string | null = null;
  if (team) {
    useTeamOrigin(root, originUrl);
    git(root, "push", "--quiet", "origin", "main");
    worktree = NodePath.join(originRoot, "worktree-a");
    git(root, "worktree", "add", "--quiet", "-b", "t3/a", worktree, "main");
  }

  // The real v2 orchestrator; thread A is in a run while it plans.
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
      threadId: THREAD_B,
      workspaceRoot: root,
    });
    yield* TeamOrchestrator.setRun({
      threadId: THREAD_A,
      runId: RUN_A,
      ordinal: 1,
      status: "running",
    });
  }).pipe(Effect.provide(orchestration));

  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: ENVIRONMENT_ID,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-wait-state-" }),
    }),
    TestTeamGitLayer,
    TeamCards.layer.pipe(Layer.provide(Layer.succeedContext(orchestration))),
    Layer.succeedContext(orchestration),
    // After the orchestration's own: the team's turns stop at the recorded dispatch.
    TeamOrchestrator.layerRecordingDispatch(dispatched, orchestration),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(TeamChoices.layer.pipe(Layer.provideMerge(dependencies)));
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  const membership = team
    ? (yield* teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root })).membership
    : yield* teams.openSolo({ projectRoot: root, name: "Project" });
  if (membership.status !== "member") return yield* Effect.die("not a member");
  const teamId = membership.team.teamId;
  const choices = yield* TeamChoices.TeamChoices.pipe(Effect.provide(context));
  const { checkWaits } = yield* TeamWait.make.pipe(Effect.provide(context));
  const holds = yield* choices.subscribeHolds;

  /** Thread A's `team_plan` call on `files`. */
  const ask = (files: ReadonlyArray<TeamPlanFile>) =>
    choices.ask({
      context: {
        teamFile: { teamId, name: "Core" },
        solo: !team,
        member: membership.member,
        thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_A },
        teamRoot: worktree ?? root,
        workingFolder: worktree ?? root,
      },
      files,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
  /** Thread A plans `files`: shows the card and returns the held call once it waits. */
  const plan = (files: ReadonlyArray<TeamPlanFile>) =>
    Effect.gen(function* () {
      const call = yield* ask(files).pipe(Effect.forkChild({ startImmediately: true }));
      const choiceId = yield* PubSub.take(holds);
      return { call, choiceId };
    });
  const cards = yield* TeamCards.TeamCards.pipe(Effect.provide(context));
  const made = (choiceId: string) =>
    cards
      .forThread(THREAD_A)
      .pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.kind === TEAM_CHOICE_MADE_ACTIVITY_KIND
              ? Option.toArray(decodeMade(entry.payload)).filter(
                  (payload) => payload.choiceId === choiceId,
                )
              : [],
          ),
        ),
      );
  const turnStarts = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) => (command.type === "message.dispatch" ? [command.text] : [])),
    ),
  );
  /** Every turn T3 started is T3 Code's own message (a `system` notification, D2). */
  const turnsFromApp = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.every(
        (command) =>
          command.type !== "message.dispatch" || command.notification?.source.kind === "system",
      ),
    ),
  );
  const cardCount = cards
    .forThread(THREAD_A)
    .pipe(
      Effect.map(
        (entries) => entries.filter((entry) => entry.kind === TEAM_CHOICE_ACTIVITY_KIND).length,
      ),
    );
  const endTurn = TeamOrchestrator.setRun({
    threadId: THREAD_A,
    runId: RUN_A,
    ordinal: 1,
    status: "completed",
  }).pipe(Effect.provide(orchestration));
  return {
    root,
    worktree,
    teams,
    teamId,
    memberId: membership.member.memberId,
    choices,
    checkWaits,
    ask,
    plan,
    made,
    turnStarts,
    turnsFromApp,
    cardCount,
    endTurn,
  };
}, Effect.provide(NodeServices.layer));

/** Omar, on his own server, holding `paths`. */
const omarHolding = Effect.fn("omarHolding")(function* (
  root: string,
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const omar = yield* Layer.build(
    testTeamServiceLayer({
      environmentId: OMAR_SERVER,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-wait-omar-" }),
      host: fakeTeamHost("Omar"),
    }),
  ).pipe(Effect.flatMap((built) => TeamService.TeamService.pipe(Effect.provide(built))));
  yield* omar.openTeam({ teamFile: TEAM_FILE, checkout: root });
  const thread = { environmentId: OMAR_SERVER, threadId: ThreadId.make("omar-1") };
  yield* omar.claimPaths({
    teamId: TEAM_ID,
    memberId: TeamMemberId.make("Omar"),
    thread,
    paths: paths as ReadonlyArray<TeamPath>,
  });
  /** His work merges into `main` on the origin, and he lets go of the files. */
  const mergeAndRelease = (contents: string) =>
    Effect.gen(function* () {
      const clone = NodePath.join(originRoot, "omar-clone");
      git(originRoot, "clone", "--quiet", originUrl, clone);
      writeFile(clone, LOGIN, contents);
      commitAll(clone, "Omar: login");
      git(clone, "push", "--quiet", "origin", "main");
      yield* omar.releasePaths({
        teamId: TEAM_ID,
        memberId: TeamMemberId.make("Omar"),
        thread,
        paths: paths as ReadonlyArray<TeamPath>,
      });
      // His poller would push it within 15 s.
      yield* omar.sync(TEAM_ID);
    });
  /** He archives his chat without merging: his claim is released, nothing lands on `main`. */
  const releaseOnly = omar
    .releaseThreadClaims({ thread, reason: "its chat was archived" })
    .pipe(Effect.andThen(omar.sync(TEAM_ID)));
  return { mergeAndRelease, releaseOnly };
}, Effect.provide(NodeServices.layer));

const omarHolds = (path: string): TeamPlanFile => ({
  path: path as TeamPath,
  holders: [{ kind: "member", memberId: TeamMemberId.make("Omar"), name: "Omar" }],
});

describe("TeamWait", () => {
  it.effect("waits for Omar, can stop and wait again, then goes on top of his merged work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      const omar = yield* omarHolding(h.root, [LOGIN]);
      yield* h.teams.refresh(TEAM_ID);

      const { call, choiceId } = yield* h.plan([omarHolds(LOGIN)]);
      assert.deepEqual(yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "wait" }), {
        delivery: "held",
      });
      const answer = yield* Fiber.join(call);
      assert.equal(answer._tag, "Chosen");
      assert.equal(
        answer.instruction,
        "User chose: wait for Omar. Do not edit `src/auth/login.ts`. End your turn now; T3 starts your next turn when Omar lets go of it.",
      );
      // While it waits: not open (no "Awaiting Input"), and the guard has its own reason.
      assert.isFalse((yield* h.choices.openPaths(THREAD_A)).has(LOGIN));
      assert.isTrue((yield* h.choices.waitingPaths(THREAD_A)).has(LOGIN));
      // Planning the file again answers at once, on the same card.
      const again = yield* h.ask([omarHolds(LOGIN)]);
      assert.include(again.instruction, "The user chose to wait for Omar");
      assert.equal(yield* h.cardCount, 1);

      yield* h.endTurn;
      assert.deepEqual(yield* h.checkWaits, [], "Omar still holds it");

      // Stop waiting: the card is open again and takes a new choice.
      assert.deepEqual(
        yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "cancelWait" }),
        { delivery: "none" },
      );
      assert.isTrue((yield* h.choices.openPaths(THREAD_A)).has(LOGIN));
      assert.deepEqual(yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "wait" }), {
        delivery: "none",
      });

      // Omar's work merges and he lets go; this chat's worktree goes on top of it.
      yield* omar.mergeAndRelease("export const login = 2;\n");
      yield* h.teams.refresh(TEAM_ID);
      assert.deepEqual(yield* h.checkWaits, [choiceId]);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(h.worktree!, LOGIN), "utf8"),
        "export const login = 2;\n",
      );
      assert.deepEqual(yield* h.turnStarts, [
        "Done waiting: Omar let go of `src/auth/login.ts`. Your copy is now on top of `origin/main`, with their work. Re-read it, then continue the task. Call team_plan before editing.",
      ]);
      assert.deepEqual(
        (yield* h.made(choiceId)).map((record) => record.wait),
        ["waiting", "cancelled", "waiting", "done"],
      );
      assert.isTrue(yield* h.turnsFromApp);
      // Told once.
      assert.deepEqual(yield* h.checkWaits, []);
      assert.lengthOf(yield* h.turnStarts, 1);
    }).pipe(Effect.scoped),
  );

  it.effect('does not say "with their work" when Omar lets go without merging', () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      const omar = yield* omarHolding(h.root, [LOGIN]);
      yield* h.teams.refresh(TEAM_ID);
      const { call, choiceId } = yield* h.plan([omarHolds(LOGIN)]);
      yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "wait" });
      yield* Fiber.join(call);
      yield* h.endTurn;
      yield* omar.releaseOnly;
      yield* h.teams.refresh(TEAM_ID);
      assert.deepEqual(yield* h.checkWaits, [choiceId]);
      assert.deepEqual(yield* h.turnStarts, [
        "Done waiting: Omar let go of `src/auth/login.ts` without merging a change to it. Your copy is now on top of `origin/main`. Re-read it, then continue the task. Call team_plan before editing.",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the user, not the agent, when the copy conflicts with the merged work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      const omar = yield* omarHolding(h.root, [LOGIN]);
      yield* h.teams.refresh(TEAM_ID);
      // This chat committed its own change to the same line before it planned.
      writeFile(h.worktree!, LOGIN, "export const login = 3;\n");
      const before = commitAll(h.worktree!, "mine");

      const { call, choiceId } = yield* h.plan([omarHolds(LOGIN)]);
      yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "wait" });
      yield* Fiber.join(call);
      yield* h.endTurn;
      yield* omar.mergeAndRelease("export const login = 2;\n");
      yield* h.teams.refresh(TEAM_ID);

      assert.deepEqual(yield* h.checkWaits, [choiceId]);
      assert.deepEqual(yield* h.turnStarts, []);
      assert.equal((yield* h.made(choiceId)).at(-1)?.wait, "conflict");
      // The rebase was undone: same commit, nothing half-done.
      assert.equal(git(h.worktree!, "rev-parse", "HEAD"), before);
      assert.equal(git(h.worktree!, "status", "--porcelain"), "");
    }).pipe(Effect.scoped),
  );

  it.effect("solo: waits for the other chat to let go, not for a chat that came later", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(false);
      const chatB = { environmentId: ENVIRONMENT_ID, threadId: THREAD_B };
      yield* h.teams.claimPaths({
        teamId: h.teamId,
        memberId: h.memberId,
        thread: chatB,
        paths: ["src/format.ts" as TeamPath],
      });
      const { call, choiceId } = yield* h.plan([
        { path: "src/format.ts" as TeamPath, holders: [{ kind: "chat", thread: chatB }] },
      ]);
      yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "wait" });
      const answer = yield* Fiber.join(call);
      assert.include(answer.instruction, "wait for the other chat");

      // A chat busy with a turn is checked later.
      yield* h.teams.releasePaths({
        teamId: h.teamId,
        memberId: h.memberId,
        thread: chatB,
        paths: ["src/format.ts" as TeamPath],
      });
      assert.deepEqual(yield* h.checkWaits, []);
      // A third chat claims it meanwhile; the user waited for chat B, who let go.
      yield* h.teams.claimPaths({
        teamId: h.teamId,
        memberId: h.memberId,
        thread: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-c") },
        paths: ["src/format.ts" as TeamPath],
      });
      yield* h.endTurn;
      assert.deepEqual(yield* h.checkWaits, [choiceId]);
      assert.deepEqual(yield* h.turnStarts, [
        "Done waiting: the other chat let go of `src/format.ts`. Re-read it, then continue the task. Call team_plan before editing.",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to wait on a change already made, and to stop a wait that is not on", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(false);
      const { call, choiceId } = yield* h.plan([
        {
          path: "src/format.ts" as TeamPath,
          holders: [
            { kind: "chat", thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_B } },
          ],
        },
      ]);
      const stop = yield* h.choices
        .choose({ threadId: THREAD_A, choiceId, choice: "cancelWait" })
        .pipe(Effect.flip);
      assert.equal(stop.detail, "This card is not waiting.");
      yield* h.choices.choose({ threadId: THREAD_A, choiceId, choice: "goAnyway" });
      yield* Fiber.join(call);
      const late = yield* h.choices
        .choose({ threadId: THREAD_A, choiceId, choice: "wait" })
        .pipe(Effect.flip);
      assert.equal(late.detail, "This card was already answered.");
    }).pipe(Effect.scoped),
  );
});
