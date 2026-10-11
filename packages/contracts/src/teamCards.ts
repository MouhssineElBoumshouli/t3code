/**
 * Team cards (fork-only, team/V2_PORT_PLAN.md D1): the plan card, the warning
 * card and its choice, a teammate's question and its answer. They are kept per
 * chat by the team layer, outside upstream's thread history, and reach clients
 * through the team feed.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TEAM_QUESTION_ACTIVITY_KIND, TEAM_QUESTION_CLOSED_ACTIVITY_KIND } from "./teamAsk.ts";
import {
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TeamChoiceActivityPayload,
  TeamChoiceMadePayload,
  teamChoiceAwaitsUser,
} from "./teamChoice.ts";
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

const decodeChoice = Schema.decodeUnknownOption(TeamChoiceActivityPayload);
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);

/**
 * How many of a chat's warning cards wait on the user (V2_PORT_PLAN.md D4):
 * clients count the chat as awaiting input while this is above zero.
 *
 * A card is open until the user picks a choice, or until a newer run starts
 * (the user moved on with a message; the card still takes a click). A card
 * that waits for its holder, or for a teammate's answer, waits on them, not
 * on the user; cancelling the wait, or a "no", opens it again.
 */
export function countOpenTeamChoices(
  entries: ReadonlyArray<Pick<TeamCardEntry, "kind" | "payload" | "runId">>,
  latestRunId: string | null,
): number {
  // Oldest first: the newest record of each card wins. A cancelled wait opens it again.
  const made = new Map<string, TeamChoiceMadePayload>();
  for (const entry of entries) {
    if (entry.kind !== TEAM_CHOICE_MADE_ACTIVITY_KIND) continue;
    const payload = decodeMade(entry.payload);
    if (payload._tag === "Some") made.set(payload.value.choiceId, payload.value);
  }
  const open = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== TEAM_CHOICE_ACTIVITY_KIND) continue;
    const payload = decodeChoice(entry.payload);
    if (payload._tag === "None" || !teamChoiceAwaitsUser(made.get(payload.value.choiceId))) {
      continue;
    }
    // A card shown with no run going has no run to be overtaken by.
    if (entry.runId !== null && entry.runId !== latestRunId) continue;
    open.add(payload.value.choiceId);
  }
  return open.size;
}
