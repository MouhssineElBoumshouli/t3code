import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { foldTeamChoiceActivities, teamCardOf } from "./teamCards.ts";

const activity = (id: string, kind: string, payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-10-08T00:00:00.000Z",
});

const card = {
  choiceId: "team-choice:1",
  threadId: "thread-1",
  solo: false,
  files: [{ path: "src/a.ts", holders: [{ kind: "member", memberId: "omar", name: "Omar" }] }],
};

describe("team cards", () => {
  it("keeps an unanswered warning card as it is", () => {
    const activities = [activity("a", "team.choice", card)];
    expect(foldTeamChoiceActivities(activities)).toBe(activities);
    expect(teamCardOf(activities[0]!)).toEqual({ kind: "choice", card: { ...card, made: null } });
  });

  it("folds the choice into its card, at the card's place, and keeps the folded card stable", () => {
    const open = activity("a", "team.choice", card);
    const other = activity("b", "tool.completed", {});
    const made = activity("c", "team.choice.made", {
      choiceId: "team-choice:1",
      choice: "goAnyway",
      delivery: "turn",
    });
    const first = foldTeamChoiceActivities([open, other, made]);
    expect(first.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(teamCardOf(first[0]!)).toEqual({
      kind: "choice",
      card: { ...card, made: { choiceId: "team-choice:1", choice: "goAnyway", delivery: "turn" } },
    });
    // Same inputs, same object: the timeline row is not redrawn.
    expect(foldTeamChoiceActivities([open, other, made])[0]).toBe(first[0]);
  });

  it("shows a card's newest record: waiting, then stopped, then waiting again", () => {
    const open = activity("a", "team.choice", card);
    const record = (id: string, wait: string) =>
      activity(id, "team.choice.made", {
        choiceId: "team-choice:1",
        choice: "wait",
        delivery: "none",
        wait,
      });
    const waitOf = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
      const drawn = teamCardOf(foldTeamChoiceActivities(activities)[0]!);
      return drawn?.kind === "choice" ? drawn.card.made?.wait : undefined;
    };
    expect(waitOf([open, record("b", "waiting")])).toBe("waiting");
    expect(waitOf([open, record("b", "waiting"), record("c", "cancelled")])).toBe("cancelled");
    expect(
      waitOf([open, record("b", "waiting"), record("c", "cancelled"), record("d", "waiting")]),
    ).toBe("waiting");
  });

  it("ignores a choice for another card and draws nothing for a malformed card", () => {
    const open = activity("a", "team.choice", card);
    const stray = activity("c", "team.choice.made", {
      choiceId: "team-choice:2",
      choice: "anotherWay",
      delivery: "held",
    });
    const folded = foldTeamChoiceActivities([open, stray]);
    expect(folded).toEqual([open]);
    expect(teamCardOf(activity("d", "team.choice", { choiceId: "x" }))).toBeUndefined();
  });
});
