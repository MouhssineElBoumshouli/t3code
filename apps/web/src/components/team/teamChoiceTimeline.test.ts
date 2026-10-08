// team-layer: the timeline while a warning card waits (team/PREVENTION_PLAN.md, slice 3a).
import { EventId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";

describe("the timeline while a warning card waits", () => {
  const turnId = TurnId.make("choice-turn");
  const time = (second: number) => new Date(Date.UTC(2026, 9, 8, 0, 0, second)).toISOString();
  const activity = (second: number, kind: string, payload: unknown) => ({
    id: EventId.make(`activity-${second}`),
    tone: kind.startsWith("team.") ? ("info" as const) : ("tool" as const),
    kind,
    summary: kind,
    payload,
    turnId,
    createdAt: time(second),
  });
  const card = activity(2, "team.choice", {
    choiceId: "team-choice:1",
    threadId: "thread-1",
    solo: true,
    files: [{ path: "src/a.ts", holders: [] }],
  });
  const before = activity(1, "tool.completed", { itemType: "command_execution", detail: "ls" });
  const rows = (activities: ReadonlyArray<ReturnType<typeof activity>>) =>
    deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntries([], [], deriveWorkLogEntries(activities)),
      latestTurn: { turnId, state: "running", startedAt: time(0), completedAt: null },
      runningTurnId: turnId,
      isWorking: true,
      activeTurnStartedAt: time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it("waits for the user instead of thinking, until the choice is made", () => {
    const waiting = rows([before, card]);
    expect(waiting.map((row) => row.kind)).not.toContain("thinking");
    expect(waiting.find((row) => row.kind === "working")).toMatchObject({ awaitingInput: true });

    const made = activity(3, "team.choice.made", {
      choiceId: "team-choice:1",
      choice: "goAnyway",
      delivery: "held",
    });
    const going = rows([before, card, made]);
    expect(going.map((row) => row.kind)).toContain("thinking");
    expect(going.find((row) => row.kind === "working")).not.toHaveProperty("awaitingInput");
  });
});
