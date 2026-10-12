import { RunId, type TeamCardEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { teamCardRows } from "./teamCards.ts";

const entry = (id: string, kind: TeamCardEntry["kind"], payload: unknown): TeamCardEntry => ({
  id,
  kind,
  summary: kind,
  payload,
  runId: RunId.make("run-1"),
  createdAt: "2026-10-12T00:00:00.000Z",
});

const card = {
  choiceId: "team-choice:1",
  threadId: "thread-1",
  solo: false,
  files: [{ path: "src/a.ts", holders: [{ kind: "member", memberId: "omar", name: "Omar" }] }],
};

describe("teamCardRows", () => {
  it("draws an unanswered warning card as it is", () => {
    expect(teamCardRows([entry("a", "team.choice", card)])).toEqual([
      {
        id: "a",
        createdAt: "2026-10-12T00:00:00.000Z",
        runId: "run-1",
        key: "a|",
        card: { kind: "choice", card: { ...card, made: null } },
      },
    ]);
  });

  it("folds the newest choice into its card, at the card's place, and changes the key", () => {
    const open = entry("a", "team.choice", card);
    const plan = entry("p", "team.plan", { solo: false, shared: true, files: [] });
    const made = (id: string, choice: string, extra: object = {}) =>
      entry(id, "team.choice.made", {
        choiceId: "team-choice:1",
        choice,
        delivery: "held",
        ...extra,
      });
    const rows = teamCardRows([
      open,
      plan,
      made("m1", "wait", { wait: "waiting" }),
      made("m2", "wait", { wait: "cancelled" }),
    ]);
    expect(rows.map((row) => [row.id, row.key])).toEqual([
      ["a", "a|m2"],
      ["p", "p|"],
    ]);
    expect(rows[0]!.card.kind === "choice" && rows[0]!.card.card.made?.wait).toBe("cancelled");
  });

  it("folds a question's answer, and draws nothing for a malformed record", () => {
    const question = {
      questionId: "q1",
      teamId: "team-1",
      threadId: "thread-1",
      from: { memberId: "sara", name: "Sara" },
      paths: ["src/a.ts"],
      text: null,
      askedAt: "2026-10-12T00:00:00.000Z",
    };
    const rows = teamCardRows([
      entry("q", "team.question", question),
      entry("c", "team.question.closed", {
        questionId: "q1",
        threadId: "thread-1",
        outcome: "yes",
        text: "ok",
      }),
      entry("bad", "team.choice", { nope: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card.kind === "question" && rows[0]!.card.card.closed?.outcome).toBe("yes");
  });
});
