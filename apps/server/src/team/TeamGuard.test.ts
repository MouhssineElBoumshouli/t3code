// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TEAM_CHOICE_ACTIVITY_KIND,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  type TeamChoiceActivityPayload,
  TeamFile,
  TeamId,
  TeamMemberId,
  type TeamPath,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { heldElsewhere } from "./heldElsewhere.ts";
import * as TeamChoices from "./TeamChoices.ts";
import { checkTeamEdit, claudeTeamEditHooks } from "./teamEditCheck.ts";
import * as TeamGuard from "./TeamGuard.ts";
import * as TeamService from "./TeamService.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TEST_TEAM_LOGIN,
  testTeamServiceLayer,
  useTeamOrigin,
} from "./testing/teamState.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });
const ME = TeamMemberId.make(TEST_TEAM_LOGIN);
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const at = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00.000Z`;

let originRoot = "";
let originUrl = "";
beforeEach(() => {
  originRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-guard-origin-"));
  originUrl = makeTeamOrigin(originRoot);
});
afterEach(() => NodeFS.rmSync(originRoot, { recursive: true, force: true }));

const turn = (id: string, start: number, end: number | null): OrchestrationLatestTurn => ({
  turnId: TurnId.make(id),
  state: end === null ? "running" : "completed",
  requestedAt: at(start),
  startedAt: at(start),
  completedAt: end === null ? null : at(end),
  assistantMessageId: null,
});

const shell = (
  id: ThreadId,
  latestTurn: OrchestrationLatestTurn | null,
): OrchestrationThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

/** One team project folder on this test's origin; this server is a member, Omar is a teammate. */
const makeHarness = Effect.fn("makeTeamGuardHarness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-guard-" });
  yield* fs.makeDirectory(NodePath.join(root, ".team"), { recursive: true });
  yield* fs.writeFileString(
    NodePath.join(root, ".team", "team.json"),
    `{ "teamId": "${TEAM_ID}", "name": "Core" }`,
  );
  useTeamOrigin(root, originUrl);

  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const turns = yield* Ref.make<Partial<Record<ThreadId, OrchestrationLatestTurn>>>({
    [THREAD_A]: turn("turn-a", 10, null),
  });
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: ENVIRONMENT_ID,
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-guard-state-" }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(turns).pipe(
          Effect.map((byThread) => Option.some(shell(threadId, byThread[threadId] ?? null))),
        ),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: root,
            defaultModelSelection: null,
            scripts: [],
            repositoryIdentity: null,
            createdAt: at(0),
            updatedAt: at(0),
          }),
        ),
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
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
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
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(TeamChoices.layer.pipe(Layer.provideMerge(dependencies)));
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  yield* teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root });
  const choices = yield* TeamChoices.TeamChoices.pipe(Effect.provide(context));
  const guard = yield* TeamGuard.make.pipe(Effect.provide(context));

  const omar = yield* Layer.build(
    testTeamServiceLayer({
      environmentId: EnvironmentId.make("omar-server"),
      stateDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-guard-omar-" }),
      host: fakeTeamHost("Omar"),
    }),
  ).pipe(Effect.flatMap((built) => TeamService.TeamService.pipe(Effect.provide(built))));
  yield* omar.openTeam({ teamFile: TEAM_FILE, checkout: root });
  // Omar claims; this server reads it on its next poll.
  const omarClaims = (paths: ReadonlyArray<string>) =>
    omar
      .claimPaths({
        teamId: TEAM_ID,
        memberId: TeamMemberId.make("Omar"),
        thread: { environmentId: EnvironmentId.make("omar-server"), threadId: THREAD_B },
        paths: paths as ReadonlyArray<TeamPath>,
      })
      .pipe(Effect.andThen(teams.refresh(TEAM_ID)));
  const claimAs = (threadId: ThreadId, paths: ReadonlyArray<string>) =>
    teams.claimPaths({
      teamId: TEAM_ID,
      memberId: ME,
      thread: { environmentId: ENVIRONMENT_ID, threadId },
      paths: paths as ReadonlyArray<TeamPath>,
    });
  const cards = Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.flatMap((command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === TEAM_CHOICE_ACTIVITY_KIND
          ? [
              {
                ...(command.activity.payload as TeamChoiceActivityPayload),
                turnId: command.activity.turnId,
              },
            ]
          : [],
      ),
    ),
  );
  const turnDiff = (
    threadId: ThreadId,
    turnId: string,
    files: ReadonlyArray<string>,
    end: number,
  ) =>
    guard.afterTurn({
      threadId,
      turnId: TurnId.make(turnId),
      files: files.map((path) => ({ path })),
      completedAt: at(end),
    });
  return { root, guard, choices, cards, dispatched, turns, omarClaims, claimAs, turnDiff };
}, Effect.provide(NodeServices.layer));

describe("heldElsewhere", () => {
  const mine = { environmentId: ENVIRONMENT_ID, threadId: THREAD_A };
  const other = { environmentId: ENVIRONMENT_ID, threadId: THREAD_B };
  const claim = (thread: typeof mine, memberId: string, paths: ReadonlyArray<string>) => ({
    thread,
    memberId: TeamMemberId.make(memberId),
    paths: paths as ReadonlyArray<TeamPath>,
  });
  const run = (
    paths: ReadonlyArray<string>,
    claims: ReadonlyArray<ReturnType<typeof claim>>,
    wentAhead: ReadonlyArray<string> = [],
  ) =>
    heldElsewhere({
      paths: paths as ReadonlyArray<TeamPath>,
      claims,
      viewer: { thread: mine, memberId: ME, solo: false },
      names: new Map([["omar", "Omar"]]),
      wentAhead: new Set(wentAhead),
    }).map((file) => [file.path, file.holders.map((holder) => holder.kind)]);

  it("stops only files another thread holds and this one does not", () => {
    const omar = claim(
      { environmentId: EnvironmentId.make("omar-server"), threadId: THREAD_B },
      "omar",
      ["src/auth/"],
    );
    assert.deepEqual(run(["src/auth/login.ts", "src/free.ts"], [omar]), [
      ["src/auth/login.ts", ["member"]],
    ]);
    // This thread holds it too (its plan or a later claim): never stopped.
    assert.deepEqual(
      run(["src/auth/login.ts"], [omar, claim(mine, ME, ["src/auth/login.ts"])]),
      [],
    );
    // The user already chose "Go anyway" here.
    assert.deepEqual(run(["src/auth/login.ts"], [omar], ["src/auth/login.ts"]), []);
    // Another chat of mine holds it.
    assert.deepEqual(run(["src/a.ts"], [claim(other, ME, ["src/a.ts"])]), [["src/a.ts", ["chat"]]]);
  });
});

describe("TeamGuard", () => {
  it.effect("refuses an edit to a file held elsewhere until this chat plans it", () =>
    Effect.gen(function* () {
      const { root, guard, omarClaims, claimAs } = yield* makeHarness();
      yield* omarClaims(["src/auth/"]);
      const login = NodePath.join(root, "src/auth/login.ts");
      assert.equal(
        yield* guard.checkEdit(THREAD_A, [login]),
        "`src/auth/login.ts` is held by Omar. Call team_plan with this file before editing; it may wait for the user's choice.",
      );
      // Adapters reach it through the installed check, by relative path too.
      assert.isDefined(yield* checkTeamEdit(THREAD_A, ["src/auth/login.ts"]));
      assert.isUndefined(yield* guard.checkEdit(THREAD_A, [NodePath.join(root, "src/free.ts")]));
      assert.isUndefined(yield* guard.checkEdit(THREAD_A, ["/elsewhere/src/auth/login.ts"]));

      // Claude's hook refuses with the same reason, and lets other writes through undecided.
      const hook = claudeTeamEditHooks(THREAD_A, Effect.runPromise).PreToolUse![0]!.hooks[0]!;
      const signal = new AbortController().signal;
      const hookInput = (file: string) =>
        ({
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: file, old_string: "a", new_string: "b" },
          tool_use_id: "tool-1",
          session_id: "session-1",
          transcript_path: "/tmp/transcript",
          cwd: root,
        }) as Parameters<typeof hook>[0];
      const denied = yield* Effect.promise(() => hook(hookInput(login), "tool-1", { signal }));
      assert.deepEqual(denied, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "`src/auth/login.ts` is held by Omar. Call team_plan with this file before editing; it may wait for the user's choice.",
        },
      });
      const free = NodePath.join(root, "src/free.ts");
      assert.deepEqual(
        yield* Effect.promise(() => hook(hookInput(free), "tool-1", { signal })),
        {},
      );

      // Once this chat holds it (team_plan claims it), the edit goes through.
      yield* claimAs(THREAD_A, ["src/auth/login.ts"]);
      assert.isUndefined(yield* guard.checkEdit(THREAD_A, [login]));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "shows the card for a held file a finished turn changed; another way starts a turn, keeping it does not",
    () =>
      Effect.gen(function* () {
        const { root, guard, choices, cards, dispatched, omarClaims, turnDiff } =
          yield* makeHarness();
        yield* omarClaims(["src/auth/"]);
        // A python heredoc through Bash: no edit tool saw it, the diff does.
        yield* turnDiff(THREAD_A, "turn-a", ["src/auth/login.ts", "src/free.ts"], 12);
        const [card] = yield* cards;
        assert.isDefined(card);
        assert.isTrue(card!.edited);
        assert.equal(card!.turnId, "turn-a");
        assert.deepEqual(
          card!.files.map((file) => file.path),
          ["src/auth/login.ts"],
        );
        // While the card waits, the file is refused with the card's reason.
        assert.include(
          yield* guard.checkEdit(THREAD_A, [NodePath.join(root, "src/auth/login.ts")]),
          "The user has not chosen yet",
        );
        // The same file in the next diff waits on that card: no second card.
        yield* turnDiff(THREAD_A, "turn-a2", ["src/auth/login.ts"], 13);
        assert.lengthOf(yield* cards, 1);

        assert.deepEqual(
          yield* choices.choose({
            threadId: THREAD_A,
            choiceId: card!.choiceId,
            choice: "anotherWay",
          }),
          { delivery: "turn" },
        );
        const started = (yield* Ref.get(dispatched)).find(
          (command) => command.type === "thread.turn.start",
        );
        assert.include(
          started?.type === "thread.turn.start" ? started.message.text : "",
          "Undo only your own changes to it (no team_plan needed for that",
        );
        // The undo edits the held file: let through, and its diff asks nothing.
        assert.isUndefined(
          yield* guard.checkEdit(THREAD_A, [NodePath.join(root, "src/auth/login.ts")]),
        );
        yield* turnDiff(THREAD_A, "turn-a-undo", ["src/auth/login.ts"], 13);
        assert.lengthOf(yield* cards, 1);

        // Another turn changes another of Omar's files; this time the user keeps the change: no turn.
        yield* turnDiff(THREAD_A, "turn-a3", ["src/auth/session.ts"], 14);
        const second = (yield* cards).at(-1)!;
        assert.notEqual(second.choiceId, card!.choiceId);
        assert.deepEqual(
          yield* choices.choose({
            threadId: THREAD_A,
            choiceId: second.choiceId,
            choice: "goAnyway",
          }),
          { delivery: "none" },
        );
        const turnStarts = (yield* Ref.get(dispatched)).filter(
          (command) => command.type === "thread.turn.start",
        );
        assert.lengthOf(turnStarts, 1);
        // Kept: not asked again in this chat.
        yield* turnDiff(THREAD_A, "turn-a4", ["src/auth/session.ts"], 15);
        assert.lengthOf(yield* cards, 2);
        assert.isUndefined(
          yield* guard.checkEdit(THREAD_A, [NodePath.join(root, "src/auth/session.ts")]),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "leaves out a file another chat in the same checkout may have changed during the turn",
    () =>
      Effect.gen(function* () {
        const { cards, turns, claimAs, turnDiff } = yield* makeHarness();
        // Chat B, mine, same checkout, holds src/format.ts.
        yield* claimAs(THREAD_B, ["src/format.ts"]);
        // B worked from minute 5 to 11; A's turn ran from 10 to 12: B's edits are in A's diff too.
        yield* Ref.set(turns, {
          [THREAD_A]: turn("turn-a", 10, 12),
          [THREAD_B]: turn("turn-b", 5, 11),
        });
        yield* turnDiff(THREAD_A, "turn-a", ["src/format.ts"], 12);
        assert.lengthOf(yield* cards, 0);
        // B was idle during A's next turn: the change is A's.
        yield* Ref.set(turns, {
          [THREAD_A]: turn("turn-a2", 20, 22),
          [THREAD_B]: turn("turn-b", 5, 11),
        });
        yield* turnDiff(THREAD_A, "turn-a2", ["src/format.ts"], 22);
        const [card] = yield* cards;
        assert.deepEqual(card?.files, [
          {
            path: "src/format.ts" as TeamPath,
            holders: [
              { kind: "chat", thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_B } },
            ],
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("never stops a shared file from the rulebook", () =>
    Effect.gen(function* () {
      const { root, guard, cards, omarClaims, turnDiff } = yield* makeHarness();
      NodeFS.writeFileSync(
        NodePath.join(root, ".team", "rulebook.md"),
        "# Rules\n\n## Shared files\n\n- `src/api/routes.ts`: everyone adds routes.\n",
      );
      yield* omarClaims(["src/api/routes.ts", "src/auth/"]);
      assert.isUndefined(
        yield* guard.checkEdit(THREAD_A, [NodePath.join(root, "src/api/routes.ts")]),
      );
      yield* turnDiff(THREAD_A, "turn-a", ["src/api/routes.ts", "src/auth/login.ts"], 12);
      const [card] = yield* cards;
      assert.deepEqual(
        card?.files.map((file) => file.path),
        ["src/auth/login.ts"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("checks nothing outside a team", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* checkTeamEdit(THREAD_A, ["src/auth/login.ts"]));
    }),
  );
});
