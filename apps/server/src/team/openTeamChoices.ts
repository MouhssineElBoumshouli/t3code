/**
 * team-layer: an open warning card waits on the user, like a pending
 * `user-input.requested`, so the thread shell counts it in
 * `pendingUserInputCount` (ProjectionPipeline). The sidebar then shows
 * "Awaiting Input" instead of "Working", notifications fire, and the thread
 * does not auto-settle.
 *
 * A card is open until the user picks a choice, or until a newer turn starts
 * (the user moved on with a message; the card still takes a click).
 *
 * @module openTeamChoices
 */
import {
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TeamChoiceActivityPayload,
  TeamChoiceMadePayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The activity kinds the count reads, for the shell summary's query and refresh. */
export const TEAM_CHOICE_LIFECYCLE_KINDS: ReadonlyArray<string> = [
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
];

const decodeChoice = Schema.decodeUnknownOption(TeamChoiceActivityPayload);
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);

export function countOpenTeamChoices(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly turnId: string | null;
  }>,
  latestTurnId: string | null,
): number {
  const made = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== TEAM_CHOICE_MADE_ACTIVITY_KIND) continue;
    const payload = decodeMade(activity.payload);
    if (Option.isSome(payload)) made.add(payload.value.choiceId);
  }
  const open = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== TEAM_CHOICE_ACTIVITY_KIND) continue;
    const payload = decodeChoice(activity.payload);
    if (Option.isNone(payload) || made.has(payload.value.choiceId)) continue;
    // A card shown with no running turn has no turn to be overtaken by.
    if (activity.turnId !== null && activity.turnId !== latestTurnId) continue;
    open.add(payload.value.choiceId);
  }
  return open.size;
}
