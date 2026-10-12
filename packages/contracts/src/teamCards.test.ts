import { describe, expect, it } from "vite-plus/test";

import { RunId } from "./baseSchemas.ts";
import { TEAM_CHOICE_ACTIVITY_KIND, TEAM_CHOICE_MADE_ACTIVITY_KIND } from "./teamChoice.ts";
import { countOpenTeamChoices } from "./teamCards.ts";

const run = (id: string) => RunId.make(id);
type Entry = Parameters<typeof countOpenTeamChoices>[0][number];

const card = (choiceId: string, runId: string | null): Entry => ({
  kind: TEAM_CHOICE_ACTIVITY_KIND,
  runId: runId === null ? null : run(runId),
  payload: {
    choiceId,
    threadId: "thread-1",
    solo: true,
    files: [{ path: "src/a.ts", holders: [] }],
  },
});
const made = (payload: Record<string, unknown>): Entry => ({
  kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
  runId: null,
  payload: { choiceId: "c1", delivery: "held", ...payload },
});

describe("countOpenTeamChoices", () => {
  it("counts a card until its choice is made or a newer run starts", () => {
    expect(countOpenTeamChoices([card("c1", "r1")], "r1")).toBe(1);
    expect(countOpenTeamChoices([card("c1", "r1"), made({ choice: "goAnyway" })], "r1")).toBe(0);
    // The user moved on with a message: the card still takes a click, but no longer waits.
    expect(countOpenTeamChoices([card("c1", "r1")], "r2")).toBe(0);
    expect(countOpenTeamChoices([card("c1", null)], "r2")).toBe(1);
    // Planning again before the choice reuses the card: one wait, not two.
    expect(countOpenTeamChoices([card("c1", "r1"), card("c1", "r1")], "r1")).toBe(1);
    const malformed: Entry = { ...card("c1", "r1"), payload: { bad: 1 } };
    expect(countOpenTeamChoices([malformed], "r1")).toBe(0);
  });

  it("does not count a card that asked a teammate, and counts it again after a no", () => {
    const ask = (status: string) => made({ choice: "ask", ask: status, questionId: "q1" });
    expect(countOpenTeamChoices([card("c1", "r1"), ask("asked")], "r1")).toBe(0);
    expect(countOpenTeamChoices([card("c1", "r1"), ask("asked"), ask("declined")], "r1")).toBe(1);
  });

  it("does not count a card that waits for its holder, and counts it again when the wait stops", () => {
    const wait = (status: string) => made({ choice: "wait", wait: status });
    expect(countOpenTeamChoices([card("c1", "r1"), wait("waiting")], "r1")).toBe(0);
    expect(countOpenTeamChoices([card("c1", "r1"), wait("waiting"), wait("cancelled")], "r1")).toBe(
      1,
    );
    // The newest record wins: waiting again after the cancel.
    expect(
      countOpenTeamChoices(
        [card("c1", "r1"), wait("waiting"), wait("cancelled"), wait("waiting")],
        "r1",
      ),
    ).toBe(0);
  });
});
