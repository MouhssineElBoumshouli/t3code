// team-layer: team cards in the timeline (team/V2_PORT_PLAN.md D1, PREVENTION_PLAN.md slice 3a).
import { teamCardRows } from "@t3tools/client-runtime/work-log/team-cards";
import { RunId, type TeamCardEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import { withTeamCardEntries } from "./teamTimeline";

const runId = RunId.make("choice-run");
const time = (second: number) => new Date(Date.UTC(2026, 9, 12, 0, 0, second)).toISOString();
const entry = (second: number, kind: TeamCardEntry["kind"], payload: unknown): TeamCardEntry => ({
  id: `card-${second}`,
  kind,
  summary: kind,
  payload,
  runId,
  createdAt: time(second),
});
const card = entry(2, "team.choice", {
  choiceId: "team-choice:1",
  threadId: "thread-1",
  solo: true,
  files: [{ path: "src/a.ts", holders: [] }],
});
const made = entry(3, "team.choice.made", {
  choiceId: "team-choice:1",
  choice: "goAnyway",
  delivery: "held",
});

describe("team cards in the timeline", () => {
  it("puts each card before the first newer entry", () => {
    const message = (second: number): TimelineEntry => ({
      id: `message-${second}`,
      kind: "message",
      createdAt: time(second),
      message: {} as never,
    });
    const merged = withTeamCardEntries([message(1), message(5)], teamCardRows([card]));
    expect(merged.map((item) => item.id)).toEqual(["message-1", "team-card:card-2", "message-5"]);
    const none: ReadonlyArray<TimelineEntry> = [message(1)];
    expect(withTeamCardEntries(none, [])).toBe(none);
  });

  const rows = (entries: ReadonlyArray<TeamCardEntry>) =>
    deriveMessagesTimelineRows({
      timelineEntries: withTeamCardEntries([], teamCardRows(entries)),
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it("draws the card as its own row, and waits for the user instead of thinking until the choice", () => {
    const waiting = rows([card]);
    expect(waiting.map((row) => row.kind)).toContain("team-card");
    expect(waiting.map((row) => row.kind)).not.toContain("thinking");
    expect(waiting.find((row) => row.kind === "working")).toMatchObject({ awaitingInput: true });

    const going = rows([card, made]);
    expect(going.filter((row) => row.kind === "team-card")).toHaveLength(1);
    expect(going.map((row) => row.kind)).toContain("thinking");
    expect(going.find((row) => row.kind === "working")).not.toHaveProperty("awaitingInput");
  });
});
