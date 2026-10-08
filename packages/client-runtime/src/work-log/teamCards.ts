/**
 * The team cards in the agent's message (fork-only, team/UI_PLAN.md slices 2
 * and 3): the plan card, and the warning card with the user's choice once made.
 * Web and mobile read thread activities through these, so both draw the same.
 */
import {
  type OrchestrationThreadActivity,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  TEAM_PLAN_ACTIVITY_KIND,
  TeamChoiceActivityPayload,
  TeamChoiceMadePayload,
  TeamPlanActivityPayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface TeamChoiceCard extends TeamChoiceActivityPayload {
  /** The user's choice, once made; null while the card waits. */
  readonly made: TeamChoiceMadePayload | null;
}

export type TeamCard =
  | { readonly kind: "plan"; readonly plan: TeamPlanActivityPayload }
  | { readonly kind: "choice"; readonly card: TeamChoiceCard };

const decodePlan = Schema.decodeUnknownOption(TeamPlanActivityPayload);
const decodeChoice = Schema.decodeUnknownOption(TeamChoiceActivityPayload);
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);

/** The same folded activity while neither the card nor its choice changes, so its row is kept. */
const folded = new WeakMap<
  OrchestrationThreadActivity,
  {
    readonly made: OrchestrationThreadActivity | null;
    readonly activity: OrchestrationThreadActivity;
  }
>();

/**
 * Keeps each warning card at its place in the thread with its choice folded
 * in (`payload.made`), and drops the choice's own activity.
 */
export function foldTeamChoiceActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const madeByChoice = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (activity.kind !== TEAM_CHOICE_MADE_ACTIVITY_KIND) continue;
    const made = decodeMade(activity.payload);
    if (Option.isSome(made)) madeByChoice.set(made.value.choiceId, activity);
  }
  if (madeByChoice.size === 0) return activities;
  return activities.flatMap((activity) => {
    if (activity.kind === TEAM_CHOICE_MADE_ACTIVITY_KIND) return [];
    if (activity.kind !== TEAM_CHOICE_ACTIVITY_KIND) return [activity];
    const choice = decodeChoice(activity.payload);
    const made = Option.isSome(choice) ? (madeByChoice.get(choice.value.choiceId) ?? null) : null;
    if (made === null) return [activity];
    const cached = folded.get(activity);
    if (cached?.made === made) return [cached.activity];
    const next = {
      ...activity,
      payload: { ...(activity.payload as object), made: made.payload },
    };
    folded.set(activity, { made, activity: next });
    return [next];
  });
}

/** The card an activity draws, if it is one; a malformed payload draws none. */
export function teamCardOf(activity: OrchestrationThreadActivity): TeamCard | undefined {
  if (activity.kind === TEAM_PLAN_ACTIVITY_KIND) {
    const plan = decodePlan(activity.payload);
    return Option.isSome(plan) ? { kind: "plan", plan: plan.value } : undefined;
  }
  if (activity.kind !== TEAM_CHOICE_ACTIVITY_KIND) return undefined;
  const choice = decodeChoice(activity.payload);
  if (Option.isNone(choice)) return undefined;
  const made = decodeMade((activity.payload as { readonly made?: unknown }).made);
  return {
    kind: "choice",
    card: { ...choice.value, made: Option.getOrNull(made) },
  };
}
