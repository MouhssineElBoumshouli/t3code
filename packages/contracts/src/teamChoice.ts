/**
 * The warning card (fork-only, see team/PREVENTION_PLAN.md, slice 3a). When
 * `team_plan` finds a planned file held by someone else, the server appends
 * one thread activity of kind {@link TEAM_CHOICE_ACTIVITY_KIND} and holds the
 * tool call until the user picks a choice on the card. The click appends a
 * {@link TEAM_CHOICE_MADE_ACTIVITY_KIND} activity, so the choice stays in the
 * thread; clients fold it into the card.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamPlanFile } from "./teamPlan.ts";

export const TEAM_CHOICE_ACTIVITY_KIND = "team.choice";
export const TEAM_CHOICE_MADE_ACTIVITY_KIND = "team.choice.made";

/** The choices built so far; the card shows the others as coming soon. */
export const TeamChoice = Schema.Literals(["anotherWay", "goAnyway"]);
export type TeamChoice = typeof TeamChoice.Type;

export const TeamChoiceActivityPayload = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  /** The thread the card is on; the click must name the same one. */
  threadId: ThreadId,
  solo: Schema.Boolean,
  /** Only the planned files someone else holds, each with its holders. */
  files: Schema.Array(TeamPlanFile),
  /**
   * The turn already changed these files without planning them (found in its
   * diff, PREVENTION_PLAN.md section 3). No call is held; the click starts a turn.
   */
  edited: Schema.optionalKey(Schema.Boolean),
});
export type TeamChoiceActivityPayload = typeof TeamChoiceActivityPayload.Type;

/**
 * How the choice reached the agent: the held `team_plan` call, or a new turn.
 * "none": "Go anyway" on a change already made, with nothing to tell the agent.
 */
export const TeamChoiceDelivery = Schema.Literals(["held", "turn", "none"]);
export type TeamChoiceDelivery = typeof TeamChoiceDelivery.Type;

export const TeamChoiceMadePayload = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  choice: TeamChoice,
  delivery: TeamChoiceDelivery,
});
export type TeamChoiceMadePayload = typeof TeamChoiceMadePayload.Type;

/** "1 planned file is held: your choice"; "1 changed file is held: …" for an edited card. */
export const teamChoiceSummary = (fileCount: number, edited = false) =>
  `${fileCount} ${edited ? "changed" : "planned"} ${fileCount === 1 ? "file is" : "files are"} held: your choice`;

export const teamChoiceMadeSummary = (choice: TeamChoice) =>
  choice === "anotherWay" ? "Chose: find another way" : "Chose: go anyway";

export const TeamChooseInput = Schema.Struct({
  threadId: ThreadId,
  choiceId: TrimmedNonEmptyString,
  choice: TeamChoice,
});
export type TeamChooseInput = typeof TeamChooseInput.Type;

export const TeamChooseResult = Schema.Struct({ delivery: TeamChoiceDelivery });
export type TeamChooseResult = typeof TeamChooseResult.Type;

/** The card is gone, already answered, or its side effect failed; shown to the user as is. */
export class TeamChoiceError extends Schema.TaggedError<TeamChoiceError>()("TeamChoiceError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
