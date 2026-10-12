/**
 * The team cards in the agent's message (fork-only, team/UI_PLAN.md slices 2
 * and 3): the plan card, and the warning card with the user's choice once made.
 * Web and mobile read a chat's card records (the team feed) through these, so
 * both draw the same.
 */
import {
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
  type TeamCardEntry,
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

/** One card where it stands in the chat, with its choice or answer folded in. */
export interface TeamCardRow {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: TeamCardEntry["runId"];
  /** Changes only when the card or its latest record does: rows compare it. */
  readonly key: string;
  readonly card: TeamCard;
}

/**
 * A chat's card records as cards, oldest first: each warning card at its
 * place with its newest choice (`made`), each question with its answer
 * (`closed`); a malformed record draws nothing.
 */
export function teamCardRows(entries: ReadonlyArray<TeamCardEntry>): ReadonlyArray<TeamCardRow> {
  // Oldest first: the newest record of each card wins.
  const made = new Map<string, { readonly id: string; readonly payload: TeamChoiceMadePayload }>();
  const closed = new Map<
    string,
    { readonly id: string; readonly payload: TeamQuestionClosedPayload }
  >();
  for (const entry of entries) {
    if (entry.kind === TEAM_CHOICE_MADE_ACTIVITY_KIND) {
      const payload = decodeMade(entry.payload);
      if (Option.isSome(payload))
        made.set(payload.value.choiceId, { id: entry.id, payload: payload.value });
    } else if (entry.kind === TEAM_QUESTION_CLOSED_ACTIVITY_KIND) {
      const payload = decodeClosed(entry.payload);
      if (Option.isSome(payload)) {
        closed.set(payload.value.questionId, { id: entry.id, payload: payload.value });
      }
    }
  }
  return entries.flatMap((entry): Array<TeamCardRow> => {
    const row = (card: TeamCard, recordId?: string): TeamCardRow => ({
      id: entry.id,
      createdAt: entry.createdAt,
      runId: entry.runId,
      key: `${entry.id}|${recordId ?? ""}`,
      card,
    });
    if (entry.kind === TEAM_PLAN_ACTIVITY_KIND) {
      const plan = decodePlan(entry.payload);
      return Option.isSome(plan) ? [row({ kind: "plan", plan: plan.value })] : [];
    }
    if (entry.kind === TEAM_QUESTION_ACTIVITY_KIND) {
      const question = decodeQuestion(entry.payload);
      if (Option.isNone(question)) return [];
      const record = closed.get(question.value.questionId);
      return [
        row(
          { kind: "question", card: { ...question.value, closed: record?.payload ?? null } },
          record?.id,
        ),
      ];
    }
    if (entry.kind !== TEAM_CHOICE_ACTIVITY_KIND) return [];
    const choice = decodeChoice(entry.payload);
    if (Option.isNone(choice)) return [];
    const record = made.get(choice.value.choiceId);
    return [
      row({ kind: "choice", card: { ...choice.value, made: record?.payload ?? null } }, record?.id),
    ];
  });
}
