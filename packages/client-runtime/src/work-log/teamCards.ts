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
  TEAM_QUESTION_ACTIVITY_KIND,
  TEAM_QUESTION_CLOSED_ACTIVITY_KIND,
  TeamChoiceActivityPayload,
  TeamChoiceMadePayload,
  TeamPlanActivityPayload,
  TeamQuestionActivityPayload,
  TeamQuestionClosedPayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface TeamChoiceCard extends TeamChoiceActivityPayload {
  /** The user's choice, once made; null while the card waits. */
  readonly made: TeamChoiceMadePayload | null;
}

/** A teammate's question on the chat that holds the files ("Ask", slice 3d). */
export interface TeamQuestionCard extends TeamQuestionActivityPayload {
  /** The answer, or the asker dropping it; null while it is open. */
  readonly closed: TeamQuestionClosedPayload | null;
}

export type TeamCard =
  | { readonly kind: "plan"; readonly plan: TeamPlanActivityPayload }
  | { readonly kind: "choice"; readonly card: TeamChoiceCard }
  | { readonly kind: "question"; readonly card: TeamQuestionCard };

const decodePlan = Schema.decodeUnknownOption(TeamPlanActivityPayload);
const decodeChoice = Schema.decodeUnknownOption(TeamChoiceActivityPayload);
const decodeMade = Schema.decodeUnknownOption(TeamChoiceMadePayload);
const decodeQuestion = Schema.decodeUnknownOption(TeamQuestionActivityPayload);
const decodeClosed = Schema.decodeUnknownOption(TeamQuestionClosedPayload);

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
 * in (`payload.made`), and drops the choice's own activity. A question card
 * gets its answer the same way (`payload.closed`).
 */
export function foldTeamChoiceActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  // Oldest first: the newest record of each card wins.
  const madeByChoice = new Map<string, OrchestrationThreadActivity>();
  const closedByQuestion = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (activity.kind === TEAM_CHOICE_MADE_ACTIVITY_KIND) {
      const made = decodeMade(activity.payload);
      if (Option.isSome(made)) madeByChoice.set(made.value.choiceId, activity);
    } else if (activity.kind === TEAM_QUESTION_CLOSED_ACTIVITY_KIND) {
      const closed = decodeClosed(activity.payload);
      if (Option.isSome(closed)) closedByQuestion.set(closed.value.questionId, activity);
    }
  }
  if (madeByChoice.size === 0 && closedByQuestion.size === 0) return activities;
  const withRecord = (
    activity: OrchestrationThreadActivity,
    field: "made" | "closed",
    record: OrchestrationThreadActivity,
  ) => {
    const cached = folded.get(activity);
    if (cached?.made === record) return cached.activity;
    const next = {
      ...activity,
      payload: { ...(activity.payload as object), [field]: record.payload },
    };
    folded.set(activity, { made: record, activity: next });
    return next;
  };
  return activities.flatMap((activity) => {
    if (
      activity.kind === TEAM_CHOICE_MADE_ACTIVITY_KIND ||
      activity.kind === TEAM_QUESTION_CLOSED_ACTIVITY_KIND
    ) {
      return [];
    }
    if (activity.kind === TEAM_QUESTION_ACTIVITY_KIND) {
      const question = decodeQuestion(activity.payload);
      const closed = Option.isSome(question)
        ? closedByQuestion.get(question.value.questionId)
        : undefined;
      return [closed === undefined ? activity : withRecord(activity, "closed", closed)];
    }
    if (activity.kind !== TEAM_CHOICE_ACTIVITY_KIND) return [activity];
    const choice = decodeChoice(activity.payload);
    const made = Option.isSome(choice) ? madeByChoice.get(choice.value.choiceId) : undefined;
    return [made === undefined ? activity : withRecord(activity, "made", made)];
  });
}

/** The card an activity draws, if it is one; a malformed payload draws none. */
export function teamCardOf(activity: OrchestrationThreadActivity): TeamCard | undefined {
  if (activity.kind === TEAM_PLAN_ACTIVITY_KIND) {
    const plan = decodePlan(activity.payload);
    return Option.isSome(plan) ? { kind: "plan", plan: plan.value } : undefined;
  }
  if (activity.kind === TEAM_QUESTION_ACTIVITY_KIND) {
    const question = decodeQuestion(activity.payload);
    if (Option.isNone(question)) return undefined;
    const closed = decodeClosed((activity.payload as { readonly closed?: unknown }).closed);
    return { kind: "question", card: { ...question.value, closed: Option.getOrNull(closed) } };
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
