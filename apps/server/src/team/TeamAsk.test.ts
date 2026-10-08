// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
/**
 * "Ask" and "Build on top" on the warning card (slice 3d), between two T3
 * servers on one `file://` origin: this one (Mouhssine, thread A in its own
 * worktree) and Omar's (his thread in his own clone, on branch `t3/omar`).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  isTeamAppMessageId,
  ProjectId,
  ProviderInstanceId,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TEAM_QUESTION_ACTIVITY_KIND,
  TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  teamChoiceAwaitsUser,
  teamChoiceIsOpen,
  type TeamChoiceMadePayload,
  TeamFile,
  TeamId,
  TeamMemberId,
  type TeamPath,
  type TeamPlanFile,
  type TeamQuestionActivityPayload,
  type TeamQuestionClosedPayload,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
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
import * as TeamChoices from "./TeamChoices.ts";
import * as TeamPushedBranches from "./TeamPushedBranches.ts";
import * as TeamQuestions from "./TeamQuestions.ts";
import * as TeamService from "./TeamService.ts";

const MY_SERVER = EnvironmentId.make("environment-1");
const OMAR_SERVER = EnvironmentId.make("omar-server");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });
const THREAD_A = ThreadId.make("thread-a");
const OMAR_THREAD = ThreadId.make("omar-1");
const OMAR = TeamMemberId.make("Omar");
const LOGIN = "src/auth/login.ts";

let originRoot = "";
let originUrl = "";
beforeEach(() => {
  originRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-ask-origin-"));
  originUrl = makeTeamOrigin(originRoot);
});
afterEach(() => NodeFS.rmSync(originRoot, { recursive: true, force: true }));

const turn = (id: string, running: boolean): OrchestrationLatestTurn => ({
  turnId: TurnId.make(id),
  state: running ? "running" : "completed",
  requestedAt: "2026-10-08T10:00:00.000Z",
  startedAt: "2026-10-08T10:00:00.000Z",
  completedAt: running ? null : "2026-10-08T10:01:00.000Z",
  assistantMessageId: null,
});

/**
 * One T3 server: its team service, warning cards and questions, with its
 * threads (id to worktree and branch) and what it dispatched.
 */
const makeServer = Effect.fn("makeTeamAskServer")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly login: string;
  readonly checkout: string;
  readonly threads: Readonly<
    Record<string, { readonly worktree: string; readonly branch: string }>
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const turns = yield* Ref.make<Partial<Record<ThreadId, OrchestrationLatestTurn>>>({});
  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: input.environmentId,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-ask-state-" }),
      host: fakeTeamHost(input.login),
    }),
    TestTeamGitLayer,
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(turns).pipe(
          Effect.map((byThread) =>
            Effect.succeedSome({
              id: threadId,
              projectId: PROJECT_ID,
              title: "Thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              branch: input.threads[threadId]?.branch ?? null,
              worktreePath: input.threads[threadId]?.worktree ?? null,
              pullRequests: [],
              latestTurn: byThread[threadId] ?? null,
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
          ),
          Effect.flatten,
        ),
      getProjectShellById: () =>
        Effect.succeedSome({
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: input.checkout,
          defaultModelSelection: null,
          scripts: [],
          repositoryIdentity: null,
          createdAt: "2026-10-08T10:00:00.000Z",
          updatedAt: "2026-10-08T10:00:00.000Z",
        }),
      listActivitiesByKind: (kind) =>
        Ref.get(dispatched).pipe(
          Effect.map((commands) =>
            commands.flatMap((command) =>
              command.type === "thread.activity.append" && command.activity.kind === kind
                ? [command.activity]
                : [],
            ),
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(dispatched, (commands) => [...commands, command]).pipe(
          Effect.as({ sequence: 1 }),
        ),
      subscribeDomainEvents: PubSub.unbounded<never>().pipe(
        Effect.flatMap(PubSub.subscribe),
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(input.environmentId),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(TeamChoices.layer.pipe(Layer.provideMerge(dependencies)));
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  const choices = yield* TeamChoices.TeamChoices.pipe(Effect.provide(context));
  const questions = yield* TeamQuestions.make.pipe(Effect.provide(context));
  const pushed = yield* TeamPushedBranches.make.pipe(Effect.provide(context));

  const activities = <A>(kind: string) =>
    Ref.get(dispatched).pipe(
      Effect.map((commands) =>
        commands.flatMap((command) =>
          command.type === "thread.activity.append" && command.activity.kind === kind
            ? [command.activity.payload as A]
            : [],
        ),
      ),
    );
  const turnStarts = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) =>
        command.type === "thread.turn.start" ? [command.message] : [],
      ),
    ),
  );
  return { teams, choices, questions, pushed, turns, activities, turnStarts };
}, Effect.provide(NodeServices.layer));

const omarHolds = (path: string): TeamPlanFile => ({
  path: path as TeamPath,
  holders: [{ kind: "member", memberId: OMAR, name: "Omar" }],
});

/** The team project, this server with thread A in its worktree, and Omar's server holding LOGIN. */
const makeHarness = Effect.fn("makeTeamAskHarness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-ask-" });
  initRepo(root, {
    [LOGIN]: "export const login = 1;\n",
    ".team/team.json": `{ "teamId": "${TEAM_ID}", "name": "Core" }`,
  });
  useTeamOrigin(root, originUrl);
  git(root, "push", "--quiet", "origin", "main");
  const worktree = NodePath.join(originRoot, "worktree-a");
  git(root, "worktree", "add", "--quiet", "-b", "t3/a", worktree, "main");
  const omarClone = NodePath.join(originRoot, "omar-clone");
  git(originRoot, "clone", "--quiet", originUrl, omarClone);
  git(omarClone, "checkout", "--quiet", "-b", "t3/omar");

  const me = yield* makeServer({
    environmentId: MY_SERVER,
    login: TEST_TEAM_LOGIN,
    checkout: root,
    threads: { [THREAD_A]: { worktree, branch: "t3/a" } },
  });
  yield* Ref.set(me.turns, { [THREAD_A]: turn("turn-a", true) });
  const membership = (yield* me.teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root }))
    .membership;
  if (membership.status !== "member") return yield* Effect.die("not a member");

  const omar = yield* makeServer({
    environmentId: OMAR_SERVER,
    login: "Omar",
    checkout: omarClone,
    threads: { [OMAR_THREAD]: { worktree: omarClone, branch: "t3/omar" } },
  });
  yield* omar.teams.openTeam({ teamFile: TEAM_FILE, checkout: omarClone });
  yield* omar.teams.claimPaths({
    teamId: TEAM_ID,
    memberId: OMAR,
    thread: { environmentId: OMAR_SERVER, threadId: OMAR_THREAD },
    paths: [LOGIN],
    branch: "t3/omar",
  });
  yield* me.teams.refresh(TEAM_ID);

  const holds = yield* me.choices.subscribeHolds;
  /** Thread A plans LOGIN: the card shows and the call is held. */
  const plan = Effect.gen(function* () {
    const call = yield* me.choices
      .ask({
        context: {
          teamFile: TEAM_FILE,
          solo: false,
          member: membership.member,
          thread: { environmentId: MY_SERVER, threadId: THREAD_A },
          teamRoot: worktree,
          workingFolder: worktree,
        },
        files: [omarHolds(LOGIN)],
        providerInstanceId: ProviderInstanceId.make("codex"),
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const choiceId = yield* PubSub.take(holds);
    return { call, choiceId };
  });
  const made = (choiceId: string) =>
    me
      .activities<TeamChoiceMadePayload>(TEAM_CHOICE_MADE_ACTIVITY_KIND)
      .pipe(Effect.map((records) => records.filter((record) => record.choiceId === choiceId)));
  /** Shares this server's writes, then Omar's server reads them (their pollers would). */
  const toOmar = me.teams.sync(TEAM_ID).pipe(Effect.andThen(omar.teams.refresh(TEAM_ID)));
  const fromOmar = omar.teams.sync(TEAM_ID).pipe(Effect.andThen(me.teams.refresh(TEAM_ID)));
  const endTurn = Ref.set(me.turns, { [THREAD_A]: turn("turn-a", false) });
  return { root, worktree, omarClone, me, omar, plan, made, toOmar, fromOmar, endTurn };
}, Effect.provide(NodeServices.layer));

describe("Ask", () => {
  it.effect("Omar sees the question on his chat, says yes, and this chat goes on, agreed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { call, choiceId } = yield* h.plan;
      assert.deepEqual(
        yield* h.me.choices.choose({
          threadId: THREAD_A,
          choiceId,
          choice: "ask",
          text: "Only adding a param",
        }),
        { delivery: "held" },
      );
      const answer = yield* Fiber.join(call);
      assert.equal(answer._tag, "Chosen");
      assert.equal(
        answer.instruction,
        "User chose: ask Omar whether you may change `src/auth/login.ts`. Do not edit it. End your turn now; T3 starts your next turn with the answer or the user's choice.",
      );
      yield* h.endTurn;
      // Asked: the card still takes a click, but it waits on Omar, not on the user.
      const asked = (yield* h.made(choiceId)).at(-1);
      assert.equal(asked?.ask, "asked");
      assert.isTrue(teamChoiceIsOpen(asked));
      assert.isFalse(teamChoiceAwaitsUser(asked));
      assert.isTrue((yield* h.me.choices.openPaths(THREAD_A)).has(LOGIN));

      // Omar's server shows it on his chat that holds the file, once.
      yield* h.toOmar;
      yield* h.omar.questions.checkQuestions;
      yield* h.omar.questions.checkQuestions;
      const shown = yield* h.omar.activities<TeamQuestionActivityPayload>(
        TEAM_QUESTION_ACTIVITY_KIND,
      );
      assert.lengthOf(shown, 1);
      assert.deepInclude(shown[0], {
        threadId: OMAR_THREAD,
        from: { memberId: TeamMemberId.make(TEST_TEAM_LOGIN), name: TEST_TEAM_LOGIN },
        paths: [LOGIN],
        text: "Only adding a param",
      });
      assert.deepEqual(yield* h.me.questions.checkQuestions, [], "no answer yet");

      // He answers yes with a line; his chat's card closes, and he cannot answer twice.
      const questionId = shown[0]!.questionId;
      yield* h.omar.questions.answer({
        teamId: TEAM_ID,
        questionId,
        yes: true,
        text: "Go ahead, I'm done there",
      });
      assert.deepEqual(
        (yield* h.omar.activities<TeamQuestionClosedPayload>(
          TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
        )).map((closed) => [closed.outcome, closed.text]),
        [["yes", "Go ahead, I'm done there"]],
      );
      const twice = yield* h.omar.questions
        .answer({ teamId: TEAM_ID, questionId, yes: false })
        .pipe(Effect.flip);
      assert.equal(twice.detail, "You already answered this question.");

      // This server gets it: "go anyway, agreed", as a new turn the app sent.
      yield* h.fromOmar;
      assert.deepEqual(yield* h.me.questions.checkQuestions, [choiceId]);
      const starts = yield* h.me.turnStarts;
      assert.deepEqual(
        starts.map((message) => message.text),
        [
          'Omar agreed that you change `src/auth/login.ts` (Omar: "Go ahead, I\'m done there"). You may edit it; continue the task, and mention these files in your team_handoff.',
        ],
      );
      assert.isTrue(isTeamAppMessageId(starts[0]!.messageId));
      assert.deepInclude((yield* h.made(choiceId)).at(-1), {
        choice: "goAnyway",
        delivery: "turn",
        answer: { yes: true, by: "Omar", text: "Go ahead, I'm done there" },
      });
      assert.isTrue((yield* h.me.choices.wentAhead(THREAD_A)).has(LOGIN));
      assert.include(
        (yield* h.me.teams.listActivity(TEAM_ID)).map((line) => line.summary),
        `${TEST_TEAM_LOGIN} went ahead on ${LOGIN}, agreed by Omar.`,
      );
      // Told once; the question is gone from the team state.
      assert.deepEqual(yield* h.me.questions.checkQuestions, []);
      assert.deepEqual(yield* h.me.teams.listQuestions(TEAM_ID), []);
    }).pipe(Effect.scoped),
  );

  it.effect("a no opens the card again without Ask; the other choices still work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { call, choiceId } = yield* h.plan;
      yield* h.me.choices.choose({ threadId: THREAD_A, choiceId, choice: "ask" });
      yield* Fiber.join(call);
      yield* h.endTurn;
      yield* h.toOmar;
      yield* h.omar.questions.checkQuestions;
      const [question] = yield* h.omar.teams.listQuestions(TEAM_ID);
      yield* h.omar.questions.answer({
        teamId: TEAM_ID,
        questionId: question!.questionId,
        yes: false,
        text: "Still refactoring it",
      });
      yield* h.fromOmar;
      assert.deepEqual(yield* h.me.questions.checkQuestions, [choiceId]);
      const declined = (yield* h.made(choiceId)).at(-1);
      assert.deepInclude(declined, {
        ask: "declined",
        answer: { yes: false, by: "Omar", text: "Still refactoring it" },
      });
      assert.isTrue(teamChoiceAwaitsUser(declined), "the user chooses again");
      assert.deepEqual(yield* h.me.turnStarts, [], "a no starts no turn");
      const again = yield* h.me.choices
        .choose({ threadId: THREAD_A, choiceId, choice: "ask" })
        .pipe(Effect.flip);
      assert.equal(again.detail, "They already answered no.");
      assert.deepEqual(
        yield* h.me.choices.choose({ threadId: THREAD_A, choiceId, choice: "anotherWay" }),
        { delivery: "turn" },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("choosing something else while asked withdraws the question on Omar's side", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { call, choiceId } = yield* h.plan;
      yield* h.me.choices.choose({ threadId: THREAD_A, choiceId, choice: "ask" });
      yield* Fiber.join(call);
      yield* h.endTurn;
      yield* h.toOmar;
      yield* h.omar.questions.checkQuestions;
      assert.lengthOf(yield* h.omar.teams.listQuestions(TEAM_ID), 1);

      yield* h.me.choices.choose({ threadId: THREAD_A, choiceId, choice: "goAnyway" });
      yield* h.toOmar;
      assert.deepEqual(yield* h.omar.teams.listQuestions(TEAM_ID), []);
      yield* h.omar.questions.checkQuestions;
      assert.deepEqual(
        (yield* h.omar.activities<TeamQuestionClosedPayload>(
          TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
        )).map((closed) => closed.outcome),
        ["withdrawn"],
      );
      const late = yield* h.omar.questions
        .answer({ teamId: TEAM_ID, questionId: "gone", yes: true })
        .pipe(Effect.flip);
      assert.equal(late.detail, "This question is gone: it was answered or is no longer needed.");
    }).pipe(Effect.scoped),
  );

  it("a question to two people: one no is a no; a yes needs both", () => {
    const names = new Map([
      ["Omar", "Omar"],
      ["Sara", "Sara"],
    ]);
    const question = {
      questionId: "q",
      to: [OMAR, TeamMemberId.make("Sara")],
    };
    const answer = (by: string, yes: boolean, text: string | null = null) => ({
      questionId: "q",
      by: TeamMemberId.make(by),
      yes,
      text,
      answeredAt: "2026-10-08T10:00:00.000Z",
    });
    assert.isUndefined(TeamQuestions.answerOf(question, [answer("Omar", true)], names));
    assert.deepEqual(
      TeamQuestions.answerOf(question, [answer("Omar", true, "fine"), answer("Sara", true)], names),
      { yes: true, by: "Omar and Sara", text: "fine" },
    );
    assert.deepEqual(TeamQuestions.answerOf(question, [answer("Sara", false, "not now")], names), {
      yes: false,
      by: "Sara",
      text: "not now",
    });
  });
});

describe("Build on top", () => {
  it.effect("is refused until Omar's branch is pushed, then moves this chat onto it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      writeFile(h.omarClone, LOGIN, "export const login = 'omar';\n");
      const omarCommit = commitAll(h.omarClone, "Omar: login");
      // His branch is only on his computer: his claim says so.
      yield* h.omar.pushed.checkPushed;
      yield* h.fromOmar;
      const claim = (yield* h.me.teams.listActiveClaims(TEAM_ID)).find(
        (candidate) => candidate.memberId === OMAR,
      );
      assert.equal(claim?.branch, "t3/omar");
      assert.isUndefined(claim?.pushedCommit);

      const { call, choiceId } = yield* h.plan;
      const notPushed = yield* h.me.choices
        .choose({ threadId: THREAD_A, choiceId, choice: "buildOnTop" })
        .pipe(Effect.flip);
      assert.equal(notPushed.detail, "Their work is not pushed yet.");

      // He pushes; his server records it and shares it.
      git(h.omarClone, "push", "--quiet", "origin", "t3/omar");
      yield* h.omar.pushed.checkPushed;
      yield* h.fromOmar;
      assert.equal(
        (yield* h.me.teams.listActiveClaims(TEAM_ID)).find(
          (candidate) => candidate.memberId === OMAR,
        )?.pushedCommit,
        omarCommit,
      );

      // A copy with uncommitted changes is left alone.
      writeFile(h.worktree, "notes.md", "draft\n");
      const before = git(h.worktree, "rev-parse", "HEAD");
      const dirty = yield* h.me.choices
        .choose({ threadId: THREAD_A, choiceId, choice: "buildOnTop" })
        .pipe(Effect.flip);
      assert.equal(
        dirty.detail,
        "This chat's copy has uncommitted changes. Commit or undo them, then try again.",
      );
      assert.equal(git(h.worktree, "rev-parse", "HEAD"), before);
      NodeFS.rmSync(NodePath.join(h.worktree, "notes.md"));

      assert.deepEqual(
        yield* h.me.choices.choose({ threadId: THREAD_A, choiceId, choice: "buildOnTop" }),
        { delivery: "held" },
      );
      const answer = yield* Fiber.join(call);
      assert.equal(
        answer.instruction,
        "User chose: build on top of Omar's work. Your copy is now on top of Omar's branch `t3/omar`, which is not merged yet: their changes to `src/auth/login.ts` are in it. Read those changes before editing it; you may edit it. Mention these files in your team_handoff.",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(h.worktree, LOGIN), "utf8"),
        "export const login = 'omar';\n",
      );
      assert.equal(git(h.worktree, "merge-base", "--is-ancestor", omarCommit, "HEAD"), "");
      assert.equal(git(h.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "t3/a");
      assert.deepInclude((yield* h.made(choiceId)).at(-1), {
        choice: "buildOnTop",
        delivery: "held",
        onTopOf: { name: "Omar", branch: "t3/omar" },
      });
      assert.isTrue((yield* h.me.choices.wentAhead(THREAD_A)).has(LOGIN));
    }).pipe(Effect.scoped),
  );
});
