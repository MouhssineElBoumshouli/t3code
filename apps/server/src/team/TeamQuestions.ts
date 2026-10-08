/**
 * "Ask" on the warning card (fork-only, team/PREVENTION_PLAN.md section 2,
 * slice 3d), both sides. The asker's click writes the question to the team
 * state (`TeamChoices.choose`); this module does the rest.
 *
 * - The asked person's server: each question to them shows on their chats of
 *   this server that hold one of its files (a `team.question` activity) and
 *   in the presence popover (the team feed). {@link TeamQuestions.answer}
 *   saves the answer to the team state and closes the chats' cards; an answer
 *   given on another of their servers, or a question the asker dropped,
 *   closes them on the next check.
 * - The asker's server: when every asked person said yes, or one said no,
 *   the card gets the answer (`TeamChoices.answered`).
 *
 * Checks run every {@link QUESTION_CHECK_INTERVAL} on the team state the
 * poller already fetched.
 *
 * @module TeamQuestions
 */
import {
  CommandId,
  EventId,
  TEAM_QUESTION_ACTIVITY_KIND,
  TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
  type TeamAnswer,
  TeamAnswerError,
  type TeamAnswerInput,
  type TeamAnswerResult,
  type TeamId,
  type TeamMemberId,
  type TeamQuestion,
  TeamQuestionActivityPayload,
  TeamQuestionClosedPayload,
  type TeamQuestionOutcome,
  teamPathsOverlap,
  teamQuestionClosedSummary,
  teamQuestionSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as TeamChoices from "./TeamChoices.ts";
import * as TeamService from "./TeamService.ts";

export const QUESTION_CHECK_INTERVAL = "15 seconds";

export class TeamQuestions extends Context.Service<
  TeamQuestions,
  {
    /** The asked person answers, on any of their clients. */
    readonly answer: (input: TeamAnswerInput) => Effect.Effect<TeamAnswerResult, TeamAnswerError>;
    /** One round of both sides; returns the asker's cards that got their answer. */
    readonly checkQuestions: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/team/TeamQuestions") {}

const decodeQuestion = Schema.decodeUnknownOption(TeamQuestionActivityPayload);
const decodeClosed = Schema.decodeUnknownOption(TeamQuestionClosedPayload);

/** "Sara", "Sara and Omar". */
const namesOf = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Where a question stands for the asker: every asked person said yes, or
 * someone said no (their names and lines), or not yet.
 */
export const answerOf = (
  question: Pick<TeamQuestion, "questionId" | "to">,
  answers: ReadonlyArray<TeamAnswer>,
  names: ReadonlyMap<string, string>,
) => {
  const latest = new Map<TeamMemberId, TeamAnswer>();
  for (const answer of answers) {
    if (answer.questionId === question.questionId && question.to.includes(answer.by)) {
      latest.set(answer.by, answer);
    }
  }
  const noes = [...latest.values()].filter((answer) => !answer.yes);
  const counted = noes.length > 0 ? noes : [...latest.values()];
  if (noes.length === 0 && latest.size < question.to.length) return undefined;
  const lines = counted.flatMap((answer) => (answer.text === null ? [] : [answer.text]));
  return {
    yes: noes.length === 0,
    by: namesOf(counted.map((answer) => names.get(answer.by) ?? answer.by)),
    text: lines.length === 0 ? null : lines.join(" / "),
  };
};

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const choices = yield* TeamChoices.TeamChoices;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  // An answer and a check must not both close the same card.
  const lock = yield* Semaphore.make(1);

  const append = (
    threadId: ThreadId,
    id: string,
    kind: string,
    summary: string,
    payload: unknown,
  ) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
      if (thread === undefined || thread.archivedAt !== null) return;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const turn = thread.latestTurn;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:${id}`),
        threadId,
        activity: {
          id: EventId.make(id),
          tone: "info",
          kind,
          summary,
          payload,
          turnId: turn?.state === "running" ? turn.turnId : null,
          createdAt,
        },
        createdAt,
      });
    });

  /** The question cards on this server's chats, and which of them are closed. */
  const shownCards = Effect.gen(function* () {
    const shown = (yield* snapshots.listActivitiesByKind(TEAM_QUESTION_ACTIVITY_KIND)).flatMap(
      (activity) => Option.toArray(decodeQuestion(activity.payload)),
    );
    const closed = new Set(
      (yield* snapshots.listActivitiesByKind(TEAM_QUESTION_CLOSED_ACTIVITY_KIND)).flatMap(
        (activity) =>
          Option.toArray(decodeClosed(activity.payload)).map(
            (payload) => `${payload.questionId}|${payload.threadId}`,
          ),
      ),
    );
    return { shown, closed };
  });

  const close = (
    card: TeamQuestionActivityPayload,
    outcome: TeamQuestionOutcome,
    text: string | null,
  ) =>
    append(
      card.threadId,
      `team-question-closed:${card.questionId}:${card.threadId}`,
      TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
      teamQuestionClosedSummary(outcome),
      {
        questionId: card.questionId,
        threadId: card.threadId,
        outcome,
        text,
      } satisfies TeamQuestionClosedPayload,
    );

  /** The asked side, for one team: show new questions, close answered or dropped ones. */
  const holderSide = (teamId: TeamId, me: TeamMemberId) =>
    Effect.gen(function* () {
      const [questions, answers, claims, members] = yield* Effect.all([
        teams.listQuestions(teamId),
        teams.listAnswers(teamId),
        teams.listActiveClaims(teamId),
        teams.listMembers(teamId),
      ]);
      const { shown, closed } = yield* shownCards;
      const mine = (questionId: string) =>
        answers.findLast((answer) => answer.questionId === questionId && answer.by === me);
      for (const question of questions) {
        if (!question.to.includes(me) || mine(question.questionId) !== undefined) continue;
        const threads = new Set(
          claims
            .filter(
              (claim) =>
                claim.memberId === me &&
                claim.thread.environmentId === environmentId &&
                claim.paths.some((held) =>
                  question.paths.some((path) => teamPathsOverlap(held, path)),
                ),
            )
            .map((claim) => claim.thread.threadId),
        );
        for (const threadId of threads) {
          if (
            shown.some(
              (card) => card.questionId === question.questionId && card.threadId === threadId,
            )
          ) {
            continue;
          }
          const name =
            members.find((member) => member.memberId === question.from)?.displayName ??
            question.from;
          yield* append(
            threadId,
            `team-question:${question.questionId}:${threadId}`,
            TEAM_QUESTION_ACTIVITY_KIND,
            teamQuestionSummary(name),
            {
              questionId: question.questionId,
              teamId,
              threadId,
              from: { memberId: question.from, name },
              paths: question.paths,
              text: question.text,
              askedAt: question.askedAt,
            } satisfies TeamQuestionActivityPayload,
          );
        }
      }
      for (const card of shown) {
        if (card.teamId !== teamId || closed.has(`${card.questionId}|${card.threadId}`)) continue;
        const answer = mine(card.questionId);
        if (answer !== undefined) {
          yield* close(card, answer.yes ? "yes" : "no", answer.text);
        } else if (!questions.some((question) => question.questionId === card.questionId)) {
          yield* close(card, "withdrawn", null);
        }
      }
    });

  /** The asking side: each card whose question has its answer gets it. */
  const askerSide = Effect.gen(function* () {
    const ended: Array<string> = [];
    for (const { card, questionId } of yield* choices.askedCards) {
      for (const team of yield* teams.listTeams()) {
        const questions = yield* teams.listQuestions(team.teamId);
        const question = questions.find((candidate) => candidate.questionId === questionId);
        if (question === undefined) continue;
        const members = yield* teams.listMembers(team.teamId);
        const answer = answerOf(
          question,
          yield* teams.listAnswers(team.teamId),
          new Map(members.map((member) => [member.memberId, member.displayName])),
        );
        if (answer === undefined) break;
        if (
          yield* choices.answered({
            threadId: card.threadId,
            choiceId: card.choiceId,
            questionId,
            answer,
          })
        ) {
          ended.push(card.choiceId);
        }
        break;
      }
    }
    return ended;
  });

  const checkQuestions = lock.withPermits(1)(
    Effect.gen(function* () {
      for (const team of yield* teams.listTeams()) {
        if (yield* teams.isSolo(team.teamId)) continue;
        const me = yield* teams.currentMember(team.teamId);
        if (Option.isNone(me)) continue;
        yield* holderSide(team.teamId, me.value.memberId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Team questions skipped a team.", { teamId: team.teamId, cause }),
          ),
        );
      }
      const ended = yield* askerSide;
      if (ended.length > 0) yield* Effect.logInfo("Team questions answered.", { choiceIds: ended });
      return ended;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team questions check failed.", { cause }).pipe(
          Effect.as<ReadonlyArray<string>>([]),
        ),
      ),
    ),
  );

  const answer = (input: TeamAnswerInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const me = yield* teams.currentMember(input.teamId);
        if (Option.isNone(me)) {
          return yield* new TeamAnswerError({ detail: "This team is not open here." });
        }
        const memberId = me.value.memberId;
        const question = (yield* teams.listQuestions(input.teamId)).find(
          (candidate) => candidate.questionId === input.questionId,
        );
        if (question === undefined || !question.to.includes(memberId)) {
          return yield* new TeamAnswerError({
            detail: "This question is gone: it was answered or is no longer needed.",
          });
        }
        if (
          (yield* teams.listAnswers(input.teamId)).some(
            (answer) => answer.questionId === input.questionId && answer.by === memberId,
          )
        ) {
          return yield* new TeamAnswerError({ detail: "You already answered this question." });
        }
        const saved = yield* teams.answerQuestion({
          teamId: input.teamId,
          memberId,
          questionId: input.questionId,
          yes: input.yes,
          text: input.text,
        });
        const { shown, closed } = yield* shownCards;
        for (const card of shown) {
          if (
            card.questionId !== input.questionId ||
            closed.has(`${card.questionId}|${card.threadId}`)
          ) {
            continue;
          }
          yield* close(card, saved.yes ? "yes" : "no", saved.text);
        }
        return {};
      }).pipe(
        Effect.catch((error) =>
          error._tag === "TeamAnswerError"
            ? Effect.fail(error)
            : Effect.logWarning("A team answer could not be saved.", { error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new TeamAnswerError({ detail: "Your answer could not be saved. Try again." }),
                  ),
                ),
              ),
        ),
      ),
    );

  return TeamQuestions.of({ answer, checkQuestions });
});

export const layer = Layer.effect(
  TeamQuestions,
  Effect.gen(function* () {
    const service = yield* make;
    yield* forkParked(
      service.checkQuestions.pipe(
        Effect.repeat(Schedule.spaced(QUESTION_CHECK_INTERVAL)),
        Effect.asVoid,
      ),
    );
    return service;
  }),
);
