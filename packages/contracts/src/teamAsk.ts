/**
 * "Ask" on the warning card (fork-only, team/PREVENTION_PLAN.md section 2,
 * slice 3d). The asker's server writes a question to the team state; each
 * asked person's servers show it in the presence popover and, as a thread
 * activity of kind {@link TEAM_QUESTION_ACTIVITY_KIND}, on their chat that
 * holds those files. The answer goes back through the team state, and
 * {@link TEAM_QUESTION_CLOSED_ACTIVITY_KIND} closes the chat's card.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamId, TeamMemberId, TeamPath, TeamThreadRef } from "./team.ts";

export const TEAM_QUESTION_ACTIVITY_KIND = "team.question";
export const TEAM_QUESTION_CLOSED_ACTIVITY_KIND = "team.question.closed";

/** A question as every reader sees it: who asked, whom, about which files. */
export const TeamQuestion = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  from: TeamMemberId,
  to: Schema.Array(TeamMemberId),
  paths: Schema.Array(TeamPath),
  text: Schema.NullOr(TrimmedNonEmptyString),
  thread: TeamThreadRef,
  askedAt: IsoDateTime,
});
export type TeamQuestion = typeof TeamQuestion.Type;

export const TeamAnswer = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  by: TeamMemberId,
  yes: Schema.Boolean,
  text: Schema.NullOr(TrimmedNonEmptyString),
  answeredAt: IsoDateTime,
});
export type TeamAnswer = typeof TeamAnswer.Type;

/** On the asked person's chat that holds the files. */
export const TeamQuestionActivityPayload = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  teamId: TeamId,
  /** The chat the card is on. */
  threadId: ThreadId,
  from: Schema.Struct({ memberId: TeamMemberId, name: Schema.String }),
  paths: Schema.Array(TeamPath),
  text: Schema.NullOr(TrimmedNonEmptyString),
  askedAt: IsoDateTime,
});
export type TeamQuestionActivityPayload = typeof TeamQuestionActivityPayload.Type;

/** "yes" or "no" from this person (on any of their clients), or "withdrawn" by the asker. */
export const TeamQuestionOutcome = Schema.Literals(["yes", "no", "withdrawn"]);
export type TeamQuestionOutcome = typeof TeamQuestionOutcome.Type;

export const TeamQuestionClosedPayload = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  threadId: ThreadId,
  outcome: TeamQuestionOutcome,
  text: Schema.NullOr(TrimmedNonEmptyString),
});
export type TeamQuestionClosedPayload = typeof TeamQuestionClosedPayload.Type;

export const teamQuestionSummary = (askerName: string) =>
  `${askerName} asks to change files this chat holds`;

export const teamQuestionClosedSummary = (outcome: TeamQuestionOutcome) =>
  outcome === "yes" ? "Answered: yes" : outcome === "no" ? "Answered: no" : "Question withdrawn";

export const TeamAnswerInput = Schema.Struct({
  teamId: TeamId,
  questionId: TrimmedNonEmptyString,
  yes: Schema.Boolean,
  /** An optional line for the asker. */
  text: Schema.optionalKey(Schema.String),
});
export type TeamAnswerInput = typeof TeamAnswerInput.Type;

export const TeamAnswerResult = Schema.Struct({});
export type TeamAnswerResult = typeof TeamAnswerResult.Type;

/** The question is gone or already answered, or the team could not be written; shown as is. */
export class TeamAnswerError extends Schema.TaggedError<TeamAnswerError>()("TeamAnswerError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
