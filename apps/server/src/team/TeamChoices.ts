/**
 * The warning card's hold and click (fork-only, team/PREVENTION_PLAN.md, slice 3a).
 *
 * When `team_plan` finds a planned file someone else holds, {@link TeamChoices.ask}
 * appends a `team.choice` activity to the thread (the card) and holds the tool
 * call until the user picks a choice, the way the preview tools wait for the
 * browser. Each provider waits only so long for a tool call ({@link holdCap});
 * at the cap the agent is told to stop and end its turn.
 *
 * {@link TeamChoices.choose} runs the click: the choice's side effect (release
 * the held files' claims, or tell the team the user went ahead), then delivery:
 * to the held call if one is still waiting, else as a new turn whose message is
 * the choice (cap reached, server restarted, turn stopped). Then a
 * `team.choice.made` activity, so the choice stays on the card.
 *
 * @module TeamChoices
 */
import {
  buildOnTopClaim,
  CommandId,
  EventId,
  MessageId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  type TeamChoice,
  TeamChoiceActivityPayload,
  type TeamChoiceAnswer,
  type TeamChoiceDelivery,
  TeamChoiceError,
  TeamChoiceMadePayload,
  teamChoiceIsAsking,
  teamChoiceIsOpen,
  teamChoiceIsWaiting,
  teamChoiceMadeSummary,
  teamChoiceSummary,
  type TeamChooseInput,
  type TeamChooseResult,
  type TeamPlanFile,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTeamResolver, type TeamContext } from "../mcp/toolkits/team/resolve.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { moveCopyOnto } from "./teamCopy.ts";
import * as TeamService from "./TeamService.ts";

/**
 * How long each provider lets a tool call wait (PREVENTION_PLAN.md section 1).
 * Codex gets `tool_timeout_sec=3600` from CodexAdapter, Claude a 1 h `timeout`
 * on T3's MCP server from ClaudeAdapter (its default drops the call at 60 s).
 * The rest are not known, so they get less than 60 s.
 */
export const holdCap = (driver: ProviderDriverKind | string): Duration.Duration => {
  switch (driver) {
    case "claudeAgent":
    case "codex":
      return Duration.minutes(55);
    default:
      return Duration.seconds(45);
  }
};

export type AskOutcome =
  | { readonly _tag: "Chosen"; readonly choice: TeamChoice; readonly instruction: string }
  | { readonly _tag: "NotYet"; readonly instruction: string };

export interface AskInput {
  readonly context: TeamContext;
  /** The planned files someone else holds, with their holders. */
  readonly files: ReadonlyArray<TeamPlanFile>;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface EndWaitInput {
  readonly threadId: ThreadId;
  readonly choiceId: string;
  readonly outcome: "done" | "conflict";
  /** The new turn's message, for "done". */
  readonly text: string;
}

export interface AskedCard {
  readonly card: TeamChoiceActivityPayload;
  readonly questionId: string;
}

export interface AnsweredInput {
  readonly threadId: ThreadId;
  readonly choiceId: string;
  readonly questionId: string;
  readonly answer: TeamChoiceAnswer;
}

/** A branch name from the team state that is safe to put in a refspec. */
const SAFE_BRANCH = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export interface ShowEditedInput {
  readonly context: TeamContext;
  /** The files the turn changed that someone else holds and this chat did not plan. */
  readonly files: ReadonlyArray<TeamPlanFile>;
  /** The turn whose diff changed them; a newer turn stops the card counting as waiting. */
  readonly turnId: TurnId;
}

export class TeamChoices extends Context.Service<
  TeamChoices,
  {
    /** Shows the card and waits for the click, up to the provider's cap. */
    readonly ask: (input: AskInput) => Effect.Effect<AskOutcome>;
    /** Each card id when a call starts waiting on it: a receipt for tests and logs. */
    readonly subscribeHolds: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
    /** Paths this thread's user already chose "Go anyway" for. */
    readonly wentAhead: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
    /**
     * Each "Undo it, find another way" click of this thread: the message that
     * started the undo turn, and the paths that turn may change back.
     */
    readonly undoRequests: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<UndoRequest>>;
    /** Paths on this thread's cards the user has not answered yet. */
    readonly openPaths: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
    /** Paths on this thread's cards that wait for their holder (slice 3c). */
    readonly waitingPaths: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
    /** Every card that waits for its holder, in any thread. */
    readonly waitingCards: Effect.Effect<ReadonlyArray<TeamChoiceActivityPayload>>;
    /**
     * Ends a wait: "done" starts a turn with `text`; "conflict" starts none
     * (the card tells the user). False when the card no longer waits.
     */
    readonly endWait: (input: EndWaitInput) => Effect.Effect<boolean, TeamChoiceError>;
    /** Every card that asked teammates and has no answer yet ("Ask", slice 3d). */
    readonly askedCards: Effect.Effect<ReadonlyArray<AskedCard>>;
    /**
     * The teammates' answer: a yes goes on as "Go anyway, agreed", a no opens
     * the card again without Ask. False when the card no longer asks it.
     */
    readonly answered: (input: AnsweredInput) => Effect.Effect<boolean, TeamChoiceError>;
    /** The card for files a finished turn already changed (the guard's after-the-turn check). */
    readonly showEdited: (input: ShowEditedInput) => Effect.Effect<void>;
    /** The click: side effect, delivery to the agent, and the record on the card. */
    readonly choose: (input: TeamChooseInput) => Effect.Effect<TeamChooseResult, TeamChoiceError>;
  }
>()("t3/team/TeamChoices") {}

const decodeChoice = Schema.decodeUnknownOption(TeamChoiceActivityPayload);
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);

const quoted = (paths: ReadonlyArray<string>) => paths.map((path) => `\`${path}\``).join(", ");

/** "Omar", "Sara and Omar", "another chat". */
export const holderWords = (files: ReadonlyArray<TeamPlanFile>) => {
  const names = [
    ...new Set(
      files.flatMap((file) =>
        file.holders.map((holder) => (holder.kind === "member" ? holder.name : "another chat")),
      ),
    ),
  ];
  return names.length <= 1
    ? (names[0] ?? "someone")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** Who a wait is for: "Omar", "Sara and Omar", or "the other chat". */
export const waiteeWords = (files: ReadonlyArray<TeamPlanFile>) =>
  files.some((file) => file.holders.some((holder) => holder.kind === "member"))
    ? holderWords(
        files.map((file) => ({
          ...file,
          holders: file.holders.filter((holder) => holder.kind === "member"),
        })),
      )
    : "the other chat";

const itOrThem = (files: ReadonlyArray<unknown>) => (files.length === 1 ? "it" : "them");

/**
 * The turn that ends a wait. `copy`: "updated" when this chat's worktree was
 * moved on top of the base (`touched`: the commits it got change the files,
 * the holder's work merged), "unknown" when it was not touched.
 */
export const waitDoneInstruction = (
  files: ReadonlyArray<TeamPlanFile>,
  copy:
    | { readonly status: "updated"; readonly base: string; readonly touched: boolean }
    | { readonly status: "unknown" },
) => {
  const paths = quoted(files.map((file) => file.path));
  const who = waiteeWords(files);
  const it = itOrThem(files);
  if (copy.status === "updated" && !copy.touched) {
    return `Done waiting: ${who} let go of ${paths} without merging a change to ${it}. Your copy is now on top of \`${copy.base}\`. Re-read ${it}, then continue the task. Call team_plan before editing.`;
  }
  const where =
    copy.status === "updated"
      ? ` Your copy is now on top of \`${copy.base}\`, with their work.`
      : who === "the other chat"
        ? ""
        : " Their work may not be in your copy yet.";
  return `Done waiting: ${who} let go of ${paths}.${where} Re-read ${it}, then continue the task. Call team_plan before editing.`;
};

/** What a choice carries besides itself: a teammate's answer, or the branch built on. */
export interface ChoiceDetails {
  readonly answer?: TeamChoiceAnswer | undefined;
  readonly onTopOf?: { readonly name: string; readonly branch: string } | undefined;
}

const answerLine = (answer: TeamChoiceAnswer) =>
  answer.text === null ? "" : ` (${answer.by}: "${answer.text}")`;

/** What the agent is told: as the held call's answer, or as the user's next message. */
export const choiceInstruction = (
  choice: TeamChoice,
  files: ReadonlyArray<TeamPlanFile>,
  voice: "tool" | "message",
  edited = false,
  details: ChoiceDetails = {},
) => {
  const paths = quoted(files.map((file) => file.path));
  const who = holderWords(files);
  const it = itOrThem(files);
  if (choice === "wait") {
    const waitee = waiteeWords(files);
    return `User chose: wait for ${waitee}. Do not edit ${paths}. End your turn now; T3 starts your next turn when ${waitee} ${waitee.includes(" and ") ? "let" : "lets"} go of ${it}.`;
  }
  if (choice === "ask") {
    return `User chose: ask ${who} whether you may change ${paths}. Do not edit ${it}. End your turn now; T3 starts your next turn with the answer or the user's choice.`;
  }
  if (choice === "buildOnTop" && details.onTopOf !== undefined) {
    const { name, branch } = details.onTopOf;
    const where = `your copy is now on top of ${name}'s branch \`${branch}\`, which is not merged yet: their changes to ${paths} are in it`;
    return voice === "tool"
      ? `User chose: build on top of ${name}'s work. ${where.charAt(0).toUpperCase()}${where.slice(1)}. Read those changes before editing ${it}; you may edit ${it}. Mention these files in your team_handoff.`
      : `Build on top: ${where}. Read those changes before editing ${it}, then continue the task; you may edit ${it}. Mention these files in your team_handoff.`;
  }
  if (choice === "anotherWay" && edited) {
    return `Find another way: you changed ${paths} without planning it, and ${who} ${files.length === 1 ? "holds it" : "hold them"}. Undo only your own changes to ${it} (no team_plan needed for that; others may have changed ${it} too, so do not restore the whole file), then do the task without changing ${it}. Call team_plan with your new plan before other edits.`;
  }
  if (choice === "anotherWay") {
    return voice === "tool"
      ? `User chose: find another way. Do the task without changing ${paths}; your claims on them are released. Call team_plan again with your new plan before editing.`
      : `Find another way: do the task without changing ${paths} (your claims on them are released). Call team_plan again with your new plan before editing, then continue the task.`;
  }
  if (details.answer?.yes === true) {
    const agreed = `${details.answer.by} agreed that you change ${paths}${answerLine(details.answer)}`;
    return voice === "tool"
      ? `User asked, and ${agreed}. You may edit ${it}. Mention these files in your team_handoff.`
      : `${agreed}. You may edit ${it}; continue the task, and mention these files in your team_handoff.`;
  }
  return voice === "tool"
    ? `User chose: go anyway. You may edit ${paths}; ${who} will see that you went ahead. Mention these files in your team_handoff.`
    : `Go anyway: you may edit ${paths}; ${who} will see that you went ahead. Continue the task, and mention these files in your team_handoff.`;
};

/** For an edit or a plan that touches files the user chose to wait on. */
export const waitingInstruction = (files: ReadonlyArray<TeamPlanFile>) => {
  const waitee = waiteeWords(files);
  const it = itOrThem(files);
  return `The user chose to wait for ${waitee} on ${quoted(files.map((file) => file.path))}. Do not edit ${it}; end your turn. T3 starts your next turn when ${waitee} ${waitee.includes(" and ") ? "let" : "lets"} go of ${it}.`;
};

export const notYetInstruction = (files: ReadonlyArray<TeamPlanFile>) => {
  const paths = files.map((file) => file.path);
  return `Paused: ${quoted(paths)} ${paths.length === 1 ? "is" : "are"} held by ${holderWords(files)}, and the user has not chosen yet. Do not edit ${paths.length === 1 ? "it" : "them"}. End your turn now; the user's choice comes as the next message.`;
};

/** The message a click's new turn starts with; its turn is the one that carries the choice. */
export const choiceTurnMessageId = (choiceId: string) => MessageId.make(`${choiceId}:message`);

export interface UndoRequest {
  readonly messageId: MessageId;
  readonly paths: ReadonlyArray<string>;
}

interface Delivered {
  readonly choice: TeamChoice;
  readonly instruction: string;
}

interface Waiter {
  readonly threadId: ThreadId;
  /** The turn that made the call. Once it stops, nothing reads the call's answer. */
  readonly turnId: TurnId | null;
  /** The click's choice and what to tell the agent, or none when the cap passes first. */
  readonly deferred: Deferred.Deferred<Option.Option<Delivered>>;
}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;
  /** Held calls by choice id; a call removes itself when it returns or is cancelled. */
  const waiting = new Map<string, Set<Waiter>>();
  const clicks = yield* Semaphore.make(1);
  const holds = yield* PubSub.unbounded<string>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const listChoices = (threadId: ThreadId) =>
    snapshots.listActivitiesByKind(TEAM_CHOICE_ACTIVITY_KIND).pipe(
      Effect.map((activities) =>
        activities.flatMap((activity) => {
          const payload = decodeChoice(activity.payload);
          return Option.isSome(payload) && payload.value.threadId === threadId
            ? [payload.value]
            : [];
        }),
      ),
    );

  const madeChoices = snapshots.listActivitiesByKind(TEAM_CHOICE_MADE_ACTIVITY_KIND).pipe(
    Effect.map(
      (activities) =>
        new Map(
          activities.flatMap((activity) => {
            const payload = decodeMade(activity.payload);
            return Option.isSome(payload) ? [[payload.value.choiceId, payload.value] as const] : [];
          }),
        ),
    ),
  );

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly id: string;
    /** The turn to file it under; else the running turn, if any. */
    readonly turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(input.threadId);
      const latestTurn = Option.getOrUndefined(thread)?.latestTurn ?? null;
      const runningTurnId = latestTurn?.state === "running" ? latestTurn.turnId : null;
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:${input.id}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(input.id),
          tone: "info",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: input.turnId ?? runningTurnId,
          createdAt,
        },
        createdAt,
      });
    });

  const runningTurn = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map((thread) => {
        const turn = Option.getOrUndefined(thread)?.latestTurn;
        return turn?.state === "running" ? turn.turnId : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  /** The session's driver; a built-in instance is named after its driver when there is none yet. */
  const capFor = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map((thread) =>
        holdCap(Option.getOrUndefined(thread)?.session?.providerName ?? instanceId),
      ),
      Effect.orElseSucceed(() => holdCap(instanceId)),
    );

  /**
   * An unanswered card of this thread that already names every held file
   * (the agent planned again before the user chose): the hold reuses it.
   */
  const openCardFor = (threadId: ThreadId, files: ReadonlyArray<TeamPlanFile>) =>
    Effect.gen(function* () {
      const made = yield* madeChoices;
      return (yield* listChoices(threadId)).findLast(
        (card) =>
          teamChoiceIsOpen(made.get(card.choiceId)) &&
          files.every((file) => card.files.some((shown) => shown.path === file.path)),
      )?.choiceId;
    });

  /** A card of this thread that waits on one of `files`. */
  const waitingCardFor = (threadId: ThreadId, files: ReadonlyArray<TeamPlanFile>) =>
    Effect.gen(function* () {
      const made = yield* madeChoices;
      return (yield* listChoices(threadId)).findLast(
        (card) =>
          teamChoiceIsWaiting(made.get(card.choiceId)) &&
          files.some((file) => card.files.some((shown) => shown.path === file.path)),
      );
    });

  const ask = (input: AskInput): Effect.Effect<AskOutcome> => {
    const notYet: AskOutcome = { _tag: "NotYet", instruction: notYetInstruction(input.files) };
    const threadId = input.context.thread.threadId;
    return Effect.gen(function* () {
      const waitingCard = yield* waitingCardFor(threadId, input.files);
      if (waitingCard !== undefined) {
        return { _tag: "NotYet", instruction: waitingInstruction(waitingCard.files) } as const;
      }
      const reused = yield* openCardFor(threadId, input.files);
      const choiceId = reused ?? `team-choice:${yield* crypto.randomUUIDv4}`;
      const cap = yield* capFor(threadId, input.providerInstanceId);
      const waiter: Waiter = {
        threadId,
        turnId: yield* runningTurn(threadId),
        deferred: yield* Deferred.make<Option.Option<Delivered>>(),
      };
      // Registered before the card shows, so a click always finds this call.
      const set = waiting.get(choiceId) ?? new Set();
      set.add(waiter);
      waiting.set(choiceId, set);
      const timer = yield* Effect.sleep(cap).pipe(
        Effect.andThen(Deferred.succeed(waiter.deferred, Option.none())),
        Effect.forkChild({ startImmediately: true }),
      );
      const release = Effect.andThen(
        Fiber.interrupt(timer),
        Effect.sync(() => {
          set.delete(waiter);
          if (set.size === 0 && waiting.get(choiceId) === set) waiting.delete(choiceId);
        }),
      );
      const chosen = yield* Effect.gen(function* () {
        if (reused === undefined) {
          yield* appendActivity({
            threadId,
            kind: TEAM_CHOICE_ACTIVITY_KIND,
            summary: teamChoiceSummary(input.files.length),
            payload: {
              choiceId,
              threadId,
              solo: input.context.solo,
              files: input.files,
            } satisfies TeamChoiceActivityPayload,
            id: choiceId,
          });
        } else {
          // Answered between the lookup and the registration: that click started a turn.
          const made = (yield* madeChoices).get(choiceId);
          if (!teamChoiceIsOpen(made)) {
            return Option.some<Delivered>({
              choice: made!.choice,
              instruction: choiceInstruction(made!.choice, input.files, "tool", false, made!),
            });
          }
        }
        yield* PubSub.publish(holds, choiceId);
        return yield* Deferred.await(waiter.deferred);
      }).pipe(Effect.ensuring(release));
      return Option.match(chosen, {
        onNone: () => notYet,
        onSome: ({ choice, instruction }): AskOutcome => ({ _tag: "Chosen", choice, instruction }),
      });
    }).pipe(
      // No card means nothing can answer: the agent is told to stop.
      Effect.catchCause((cause) =>
        Effect.logWarning("The warning card could not hold the plan.", { cause }).pipe(
          Effect.as(notYet),
        ),
      ),
    );
  };

  const failed = (detail: string) => (cause: unknown) =>
    Effect.logWarning(detail, { cause }).pipe(
      Effect.andThen(Effect.fail(new TeamChoiceError({ detail }))),
    );

  /** Releases the held files, or tells the team the user went ahead. Outside a team, nothing. */
  const sideEffect = (
    choice: TeamChoice,
    threadId: ThreadId,
    files: ReadonlyArray<TeamPlanFile>,
    details: ChoiceDetails = {},
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolve({ environmentId, threadId });
      if (resolved._tag === "NotInTeam") return;
      const { context } = resolved;
      const paths = files.map((file) => file.path);
      if (choice === "anotherWay") {
        yield* teams.releasePaths({
          teamId: context.teamFile.teamId,
          memberId: context.member.memberId,
          thread: context.thread,
          paths,
        });
        return;
      }
      const me = context.member.displayName;
      yield* teams.recordActivity({
        teamId: context.teamFile.teamId,
        memberId: context.member.memberId,
        thread: context.thread,
        kind: "overlap.accepted",
        summary:
          details.onTopOf !== undefined
            ? `${me} built on top of ${details.onTopOf.name}'s work on ${paths.join(", ")} (branch ${details.onTopOf.branch}).`
            : details.answer?.yes === true
              ? `${me} went ahead on ${paths.join(", ")}, agreed by ${details.answer.by}.`
              : `${me} went ahead on ${paths.join(", ")}, held by ${holderWords(files)}.`,
      });
    });

  /** The team context of a card's thread; a choice that needs a team fails without one. */
  const teamContextOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const resolved = yield* resolve({ environmentId, threadId });
      if (resolved._tag === "NotInTeam" || resolved.context.solo) {
        return yield* new TeamChoiceError({ detail: "This choice needs a team." });
      }
      return resolved.context;
    }).pipe(
      Effect.catchTag("TeamToolError", (error) =>
        Effect.fail(new TeamChoiceError({ detail: error.detail })),
      ),
      Effect.catchTag("TeamToolFailedError", failed("The team could not be read.")),
    );

  /** "Ask": the question goes to the team state for the teammates the card names. */
  const askHolders = (card: TeamChoiceActivityPayload, text: string | undefined) =>
    Effect.gen(function* () {
      const context = yield* teamContextOf(card.threadId);
      const to = [
        ...new Set(
          card.files.flatMap((file) =>
            file.holders.flatMap((holder) => (holder.kind === "member" ? [holder.memberId] : [])),
          ),
        ),
      ];
      if (to.length === 0) {
        return yield* new TeamChoiceError({ detail: "Only your own chats hold these files." });
      }
      return yield* teams
        .askQuestion({
          teamId: context.teamFile.teamId,
          memberId: context.member.memberId,
          thread: context.thread,
          to,
          paths: card.files.map((file) => file.path),
          text,
        })
        .pipe(Effect.catchCause(failed("The question could not be saved to the team.")));
    });

  /** "Build on top": moves this chat's own copy onto the holder's pushed branch. */
  const moveOntoHolder = (card: TeamChoiceActivityPayload) =>
    Effect.gen(function* () {
      const context = yield* teamContextOf(card.threadId);
      const shell = Option.getOrUndefined(
        yield* snapshots
          .getThreadShellById(card.threadId)
          .pipe(Effect.catch(failed("This chat could not be read."))),
      );
      const folder = shell?.worktreePath ?? null;
      if (folder === null) {
        return yield* new TeamChoiceError({
          detail:
            "This chat works in the project's checkout, not a copy of its own, so it cannot move onto a teammate's branch.",
        });
      }
      const teamId = context.teamFile.teamId;
      const [claims, members] = yield* Effect.all([
        teams.listActiveClaims(teamId),
        teams.listMembers(teamId),
      ]).pipe(Effect.catch(failed("The team could not be read.")));
      const target = buildOnTopClaim(claims, card.files);
      if (target === undefined || !SAFE_BRANCH.test(target.branch)) {
        return yield* new TeamChoiceError({ detail: "Their work is not pushed yet." });
      }
      const name =
        members.find((member) => member.memberId === target.memberId)?.displayName ??
        target.memberId;
      const branch = target.branch;
      const moved = yield* moveCopyOnto(git, {
        folder,
        fetch: ["origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        onto: `origin/${branch}`,
        paths: [],
        operation: "TeamChoices.buildOnTop",
      });
      switch (moved.status) {
        case "updated":
          return { name, branch };
        case "dirty":
          return yield* new TeamChoiceError({
            detail:
              "This chat's copy has uncommitted changes. Commit or undo them, then try again.",
          });
        case "conflict":
          return yield* new TeamChoiceError({
            detail: `This chat's work conflicts with ${name}'s branch ${branch}; nothing was changed.`,
          });
        case "unavailable":
          return yield* new TeamChoiceError({
            detail: `${name}'s branch ${branch} could not be fetched. Try again in a moment.`,
          });
      }
    });

  /** A turn whose message comes from the card; `key` keeps each card's turns apart. */
  const startTurn = (threadId: ThreadId, key: string, text: string) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread)) {
        return yield* new TeamChoiceError({ detail: "This chat was not found." });
      }
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:${key}:turn`),
        threadId,
        message: {
          messageId: choiceTurnMessageId(key),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.value.runtimeMode,
        interactionMode: thread.value.interactionMode,
        createdAt: yield* nowIso,
      });
    });

  /** Records a choice, or a wait's change, on the card. A card can get several. */
  const recordMade = (threadId: ThreadId, made: TeamChoiceMadePayload) =>
    Effect.gen(function* () {
      const first = !(yield* madeChoices).has(made.choiceId);
      yield* appendActivity({
        threadId,
        kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
        summary: teamChoiceMadeSummary(made),
        payload: made,
        id: first ? `${made.choiceId}:made` : `${made.choiceId}:made:${yield* crypto.randomUUIDv4}`,
      });
    });

  /**
   * Tells the agent: the held call if one still waits, else a new turn (`key`
   * names it), unless `noTurn`. A call whose cap just passed is done already,
   * and one whose turn was stopped is still waiting but nobody reads its
   * answer (Codex does not cancel it): then a turn carries the choice. The
   * stopped one is freed with "not yet".
   */
  const deliver = (input: {
    readonly threadId: ThreadId;
    readonly choiceId: string;
    readonly key: string;
    readonly choice: TeamChoice;
    readonly tool: string;
    readonly message: string;
    readonly noTurn: boolean;
  }) =>
    Effect.gen(function* () {
      const running = yield* runningTurn(input.threadId);
      let delivery: TeamChoiceDelivery = input.noTurn ? "none" : "turn";
      for (const waiter of waiting.get(input.choiceId) ?? []) {
        const live = running !== null && (waiter.turnId ?? running) === running;
        const answer = live
          ? Option.some<Delivered>({ choice: input.choice, instruction: input.tool })
          : Option.none();
        if ((yield* Deferred.succeed(waiter.deferred, answer)) && live) delivery = "held";
      }
      if (delivery === "turn") {
        yield* startTurn(input.threadId, input.key, input.message).pipe(
          Effect.catchCause(failed("The choice was saved, but the agent could not be started.")),
        );
      }
      return delivery;
    });

  /** Drops the card's open question: it was answered, or the user chose something else. */
  const withdraw = (threadId: ThreadId, questionId: string) =>
    Effect.gen(function* () {
      const resolved = yield* resolve({ environmentId, threadId });
      if (resolved._tag === "NotInTeam") return;
      yield* teams.withdrawQuestion({
        teamId: resolved.context.teamFile.teamId,
        memberId: resolved.context.member.memberId,
        questionId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A team question could not be withdrawn.", { questionId, cause }),
      ),
    );

  const choose = (input: TeamChooseInput) =>
    clicks.withPermits(1)(
      Effect.gen(function* () {
        const unreadable = failed("The warning card could not be read.");
        const card = (yield* listChoices(input.threadId).pipe(Effect.catch(unreadable))).find(
          (candidate) => candidate.choiceId === input.choiceId,
        );
        if (card === undefined) {
          return yield* new TeamChoiceError({ detail: "This warning card was not found." });
        }
        const latest = (yield* madeChoices.pipe(Effect.catch(unreadable))).get(input.choiceId);
        const notRecorded = failed("The choice was sent, but not recorded on the card.");
        if (input.choice === "cancelWait") {
          if (!teamChoiceIsWaiting(latest)) {
            return yield* new TeamChoiceError({ detail: "This card is not waiting." });
          }
          yield* recordMade(input.threadId, {
            choiceId: input.choiceId,
            choice: "wait",
            delivery: "none",
            wait: "cancelled",
          }).pipe(Effect.catchCause(notRecorded));
          return { delivery: "none" } satisfies TeamChooseResult;
        }
        if (!teamChoiceIsOpen(latest)) {
          return yield* new TeamChoiceError({ detail: "This card was already answered." });
        }
        const edited = card.edited === true;
        const choice = input.choice;
        if (choice === "wait" && edited) {
          return yield* new TeamChoiceError({ detail: "A change already made cannot wait." });
        }
        if ((choice === "ask" || choice === "buildOnTop") && (card.solo || edited)) {
          return yield* new TeamChoiceError({
            detail: "This choice is for a teammate's files, before the change is made.",
          });
        }
        if (choice === "ask" && latest?.ask !== undefined) {
          return yield* new TeamChoiceError({
            detail:
              latest.ask === "asked"
                ? "Already asked; the answer comes on this card."
                : "They already answered no.",
          });
        }

        let made: TeamChoiceMadePayload = {
          choiceId: input.choiceId,
          choice,
          delivery: "none",
          ...(choice === "wait" ? { wait: "waiting" as const } : {}),
        };
        if (choice === "ask") {
          const question = yield* askHolders(card, input.text);
          made = {
            ...made,
            ask: "asked",
            questionId: question.questionId,
            askedAt: question.askedAt,
          };
        } else if (choice === "buildOnTop") {
          made = { ...made, onTopOf: yield* moveOntoHolder(card) };
        }
        if (choice !== "wait" && choice !== "ask") {
          yield* sideEffect(choice, input.threadId, card.files, made).pipe(
            Effect.catchCause(failed("The choice could not be saved to the team.")),
          );
        }
        if (latest?.ask === "asked" && latest.questionId !== undefined) {
          yield* withdraw(input.threadId, latest.questionId);
        }
        // An edited card holds no call; "Go anyway" there keeps the change as it is.
        // "Wait" and "Ask" with no call to answer tell the agent nothing now: their end does.
        const delivery = yield* deliver({
          threadId: input.threadId,
          choiceId: input.choiceId,
          key: input.choiceId,
          choice,
          tool: choiceInstruction(choice, card.files, "tool", edited, made),
          message: choiceInstruction(choice, card.files, "message", edited, made),
          noTurn: choice === "wait" || choice === "ask" || (edited && choice === "goAnyway"),
        });
        yield* recordMade(input.threadId, { ...made, delivery }).pipe(
          Effect.catchCause(notRecorded),
        );
        return { delivery } satisfies TeamChooseResult;
      }),
    );

  /**
   * The teammates' answer to the card's question: a yes goes on as "Go
   * anyway, agreed"; a no opens the card again without Ask. False when the
   * card no longer asks that question.
   */
  const answered = (input: AnsweredInput) =>
    clicks.withPermits(1)(
      Effect.gen(function* () {
        const unreadable = failed("The warning card could not be read.");
        const latest = (yield* madeChoices.pipe(Effect.catch(unreadable))).get(input.choiceId);
        if (!teamChoiceIsAsking(latest) || latest?.questionId !== input.questionId) return false;
        const card = (yield* listChoices(input.threadId).pipe(Effect.catch(unreadable))).find(
          (candidate) => candidate.choiceId === input.choiceId,
        );
        if (card === undefined) return false;
        yield* withdraw(input.threadId, input.questionId);
        const notRecorded = failed("The answer came, but it was not recorded on the card.");
        if (!input.answer.yes) {
          yield* recordMade(input.threadId, {
            ...latest,
            delivery: "none",
            ask: "declined",
            answer: input.answer,
          }).pipe(Effect.catchCause(notRecorded));
          return true;
        }
        const details = { answer: input.answer };
        yield* sideEffect("goAnyway", input.threadId, card.files, details).pipe(
          Effect.catchCause(failed("The answer could not be saved to the team.")),
        );
        const delivery = yield* deliver({
          threadId: input.threadId,
          choiceId: input.choiceId,
          key: `${input.choiceId}:answer`,
          choice: "goAnyway",
          tool: choiceInstruction("goAnyway", card.files, "tool", false, details),
          message: choiceInstruction("goAnyway", card.files, "message", false, details),
          noTurn: false,
        });
        yield* recordMade(input.threadId, {
          choiceId: input.choiceId,
          choice: "goAnyway",
          delivery,
          answer: input.answer,
        }).pipe(Effect.catchCause(notRecorded));
        return true;
      }),
    );

  const endWait = (input: EndWaitInput) =>
    clicks.withPermits(1)(
      Effect.gen(function* () {
        const latest = (yield* madeChoices.pipe(
          Effect.catch(failed("The warning card could not be read.")),
        )).get(input.choiceId);
        if (!teamChoiceIsWaiting(latest)) return false;
        if (input.outcome === "done") {
          yield* startTurn(input.threadId, `${input.choiceId}:wait`, input.text).pipe(
            Effect.catchCause(failed("The wait ended, but the agent could not be started.")),
          );
        }
        yield* recordMade(input.threadId, {
          choiceId: input.choiceId,
          choice: "wait",
          delivery: input.outcome === "done" ? "turn" : "none",
          wait: input.outcome,
        }).pipe(Effect.catchCause(failed("The wait ended, but it was not recorded on the card.")));
        return true;
      }),
    );

  const pathsWhere = (
    threadId: ThreadId,
    state: (made: TeamChoiceMadePayload | undefined) => boolean,
  ) =>
    Effect.gen(function* () {
      const made = yield* madeChoices;
      return new Set(
        (yield* listChoices(threadId))
          .filter((card) => state(made.get(card.choiceId)))
          .flatMap((card) => card.files.map((file) => file.path)),
      );
    }).pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set()));

  const openPaths = (threadId: ThreadId) => pathsWhere(threadId, teamChoiceIsOpen);
  const waitingPaths = (threadId: ThreadId) => pathsWhere(threadId, teamChoiceIsWaiting);

  const waitingCards = Effect.gen(function* () {
    const made = yield* madeChoices;
    return (yield* snapshots.listActivitiesByKind(TEAM_CHOICE_ACTIVITY_KIND)).flatMap(
      (activity) => {
        const card = decodeChoice(activity.payload);
        return Option.isSome(card) && teamChoiceIsWaiting(made.get(card.value.choiceId))
          ? [card.value]
          : [];
      },
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<TeamChoiceActivityPayload> => []));

  const askedCards = Effect.gen(function* () {
    const made = yield* madeChoices;
    return (yield* snapshots.listActivitiesByKind(TEAM_CHOICE_ACTIVITY_KIND)).flatMap(
      (activity): Array<AskedCard> => {
        const card = decodeChoice(activity.payload);
        if (Option.isNone(card)) return [];
        const latest = made.get(card.value.choiceId);
        return teamChoiceIsAsking(latest) && latest?.questionId !== undefined
          ? [{ card: card.value, questionId: latest.questionId }]
          : [];
      },
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<AskedCard> => []));

  const showEdited = (input: ShowEditedInput) =>
    Effect.gen(function* () {
      const threadId = input.context.thread.threadId;
      const choiceId = `team-choice:${yield* crypto.randomUUIDv4}`;
      yield* appendActivity({
        threadId,
        kind: TEAM_CHOICE_ACTIVITY_KIND,
        summary: teamChoiceSummary(input.files.length, true),
        payload: {
          choiceId,
          threadId,
          solo: input.context.solo,
          files: input.files,
          edited: true,
        } satisfies TeamChoiceActivityPayload,
        id: choiceId,
        turnId: input.turnId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The warning card for a finished turn could not be shown.", { cause }),
      ),
    );

  const wentAhead = (threadId: ThreadId) =>
    pathsWhere(threadId, (made) => made?.choice === "goAnyway" || made?.choice === "buildOnTop");

  // The undo edits the held file: the guard lets the undo turn through, and its diff asks nothing.
  const undoRequests = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const made = yield* madeChoices;
      return (yield* listChoices(threadId)).flatMap((card): Array<UndoRequest> => {
        const answer = made.get(card.choiceId);
        return card.edited === true && answer?.choice === "anotherWay" && answer.delivery === "turn"
          ? [
              {
                messageId: choiceTurnMessageId(card.choiceId),
                paths: card.files.map((file) => file.path),
              },
            ]
          : [];
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<UndoRequest> => []));

  return TeamChoices.of({
    ask,
    subscribeHolds: PubSub.subscribe(holds),
    wentAhead,
    undoRequests,
    openPaths,
    waitingPaths,
    waitingCards,
    endWait,
    askedCards,
    answered,
    showEdited,
    choose,
  });
});

export const layer = Layer.effect(TeamChoices, make);
