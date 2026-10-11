/**
 * Team cards (fork-only, team/V2_PORT_PLAN.md D1): the plan card, the warning
 * card and its choice, a teammate's question and its answer. They are kept per
 * chat by the team layer, outside upstream's thread history, and reach clients
 * through the team feed.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TEAM_QUESTION_ACTIVITY_KIND, TEAM_QUESTION_CLOSED_ACTIVITY_KIND } from "./teamAsk.ts";
import { TEAM_CHOICE_ACTIVITY_KIND, TEAM_CHOICE_MADE_ACTIVITY_KIND } from "./teamChoice.ts";
import { TEAM_PLAN_ACTIVITY_KIND } from "./teamPlan.ts";

export const TeamCardKind = Schema.Literals([
  TEAM_PLAN_ACTIVITY_KIND,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TEAM_QUESTION_ACTIVITY_KIND,
  TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
]);
export type TeamCardKind = typeof TeamCardKind.Type;

/**
 * One record in a chat's cards. A card and its later choice or answer are
 * separate records; clients fold them (client-runtime `work-log/teamCards`).
 */
export const TeamCardEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: TeamCardKind,
  summary: Schema.String,
  /** Decoded by kind: `TeamPlanActivityPayload`, `TeamChoiceActivityPayload`, ... */
  payload: Schema.Unknown,
  /** The run that was going when the record was made; null between runs. */
  runId: Schema.NullOr(RunId),
  createdAt: IsoDateTime,
});
export type TeamCardEntry = typeof TeamCardEntry.Type;

/** A chat's cards, oldest first. Empty when the chat has none (left, or deleted). */
export const TeamThreadCards = Schema.Struct({
  threadId: ThreadId,
  entries: Schema.Array(TeamCardEntry),
});
export type TeamThreadCards = typeof TeamThreadCards.Type;
