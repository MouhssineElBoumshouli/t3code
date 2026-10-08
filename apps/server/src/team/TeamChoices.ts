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
  CommandId,
  EventId,
  MessageId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  type TeamChoice,
  TeamChoiceActivityPayload,
  TeamChoiceError,
  TeamChoiceMadePayload,
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
import * as TeamService from "./TeamService.ts";

/**
 * How long each provider lets a tool call wait (PREVENTION_PLAN.md section 1).
 * Claude's SDK has no MCP tool timeout by default; Codex gets
 * `tool_timeout_sec=3600` from CodexAdapter; the rest are not known, so they
 * get less than the MCP SDK's 60 s default.
 */
export const holdCap = (driver: ProviderDriverKind | string): Duration.Duration => {
  switch (driver) {
    case "claudeAgent":
      return Duration.hours(24);
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

export class TeamChoices extends Context.Service<
  TeamChoices,
  {
    /** Shows the card and waits for the click, up to the provider's cap. */
    readonly ask: (input: AskInput) => Effect.Effect<AskOutcome>;
    /** Each card id when a call starts waiting on it: a receipt for tests and logs. */
    readonly subscribeHolds: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
    /** Paths this thread's user already chose "Go anyway" for. */
    readonly wentAhead: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
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

/** What the agent is told: as the held call's answer, or as the user's next message. */
export const choiceInstruction = (
  choice: TeamChoice,
  files: ReadonlyArray<TeamPlanFile>,
  voice: "tool" | "message",
) => {
  const paths = quoted(files.map((file) => file.path));
  const who = holderWords(files);
  if (choice === "anotherWay") {
    return voice === "tool"
      ? `User chose: find another way. Do the task without changing ${paths}; your claims on them are released. Call team_plan again with your new plan before editing.`
      : `Find another way: do the task without changing ${paths} (your claims on them are released). Call team_plan again with your new plan before editing, then continue the task.`;
  }
  return voice === "tool"
    ? `User chose: go anyway. You may edit ${paths}; ${who} will see that you went ahead. Mention these files in your team_handoff.`
    : `Go anyway: you may edit ${paths}; ${who} will see that you went ahead. Continue the task, and mention these files in your team_handoff.`;
};

export const notYetInstruction = (files: ReadonlyArray<TeamPlanFile>) => {
  const paths = files.map((file) => file.path);
  return `Paused: ${quoted(paths)} ${paths.length === 1 ? "is" : "are"} held by ${holderWords(files)}, and the user has not chosen yet. Do not edit ${paths.length === 1 ? "it" : "them"}. End your turn now; the user's choice comes as the next message.`;
};

interface Waiter {
  readonly threadId: ThreadId;
  /** The turn that made the call. Once it stops, nothing reads the call's answer. */
  readonly turnId: TurnId | null;
  /** The click's choice, or none when the cap passes first. */
  readonly deferred: Deferred.Deferred<Option.Option<TeamChoice>>;
}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
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
  }) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(input.threadId);
      const latestTurn = Option.getOrUndefined(thread)?.latestTurn ?? null;
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
          turnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
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
          !made.has(card.choiceId) &&
          files.every((file) => card.files.some((shown) => shown.path === file.path)),
      )?.choiceId;
    });

  const ask = (input: AskInput): Effect.Effect<AskOutcome> => {
    const notYet: AskOutcome = { _tag: "NotYet", instruction: notYetInstruction(input.files) };
    const threadId = input.context.thread.threadId;
    return Effect.gen(function* () {
      const reused = yield* openCardFor(threadId, input.files);
      const choiceId = reused ?? `team-choice:${yield* crypto.randomUUIDv4}`;
      const cap = yield* capFor(threadId, input.providerInstanceId);
      const waiter: Waiter = {
        threadId,
        turnId: yield* runningTurn(threadId),
        deferred: yield* Deferred.make<Option.Option<TeamChoice>>(),
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
          if (made !== undefined) return Option.some(made.choice);
        }
        yield* PubSub.publish(holds, choiceId);
        return yield* Deferred.await(waiter.deferred);
      }).pipe(Effect.ensuring(release));
      return Option.match(chosen, {
        onNone: () => notYet,
        onSome: (choice): AskOutcome => ({
          _tag: "Chosen",
          choice,
          instruction: choiceInstruction(choice, input.files, "tool"),
        }),
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
  const sideEffect = (choice: TeamChoice, threadId: ThreadId, files: ReadonlyArray<TeamPlanFile>) =>
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
      yield* teams.recordActivity({
        teamId: context.teamFile.teamId,
        memberId: context.member.memberId,
        thread: context.thread,
        kind: "overlap.accepted",
        summary: `${context.member.displayName} went ahead on ${paths.join(", ")}, held by ${holderWords(files)}.`,
      });
    });

  const startTurn = (threadId: ThreadId, choiceId: string, text: string) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread)) {
        return yield* new TeamChoiceError({ detail: "This chat was not found." });
      }
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:${choiceId}:turn`),
        threadId,
        message: {
          messageId: MessageId.make(`${choiceId}:message`),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.value.runtimeMode,
        interactionMode: thread.value.interactionMode,
        createdAt: yield* nowIso,
      });
    });

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
        if ((yield* madeChoices.pipe(Effect.catch(unreadable))).has(input.choiceId)) {
          return yield* new TeamChoiceError({ detail: "This card was already answered." });
        }
        yield* sideEffect(input.choice, input.threadId, card.files).pipe(
          Effect.catchCause(failed("The choice could not be saved to the team.")),
        );
        // A call whose cap just passed is done already, and one whose turn was stopped
        // is still waiting but nobody reads its answer (Codex does not cancel it): then
        // a turn carries the choice. The stopped one is freed with "not yet".
        const running = yield* runningTurn(input.threadId);
        let delivery: "held" | "turn" = "turn";
        for (const waiter of waiting.get(input.choiceId) ?? []) {
          const live = running !== null && (waiter.turnId ?? running) === running;
          const answer = live ? Option.some(input.choice) : Option.none();
          if ((yield* Deferred.succeed(waiter.deferred, answer)) && live) delivery = "held";
        }
        if (delivery === "turn") {
          yield* startTurn(
            input.threadId,
            input.choiceId,
            choiceInstruction(input.choice, card.files, "message"),
          ).pipe(
            Effect.catchCause(failed("The choice was saved, but the agent could not be started.")),
          );
        }
        yield* appendActivity({
          threadId: input.threadId,
          kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
          summary: teamChoiceMadeSummary(input.choice),
          payload: {
            choiceId: input.choiceId,
            choice: input.choice,
            delivery,
          } satisfies TeamChoiceMadePayload,
          id: `${input.choiceId}:made`,
        }).pipe(Effect.catchCause(failed("The choice was sent, but not recorded on the card.")));
        return { delivery } satisfies TeamChooseResult;
      }),
    );

  const wentAhead = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const made = yield* madeChoices;
      return new Set(
        (yield* listChoices(threadId))
          .filter((card) => made.get(card.choiceId)?.choice === "goAnyway")
          .flatMap((card) => card.files.map((file) => file.path)),
      );
    }).pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set()));

  return TeamChoices.of({ ask, subscribeHolds: PubSub.subscribe(holds), wentAhead, choose });
});

export const layer = Layer.effect(TeamChoices, make);
