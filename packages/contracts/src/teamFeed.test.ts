import { describe, expect, it } from "vite-plus/test";

import { TeamId } from "./team.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  applyTeamFeedEvent,
  applyTeamFeedStateEvent,
  EMPTY_TEAM_FEED_STATE,
  type TeamFeedTeam,
} from "./teamFeed.ts";

const team = (id: string, name: string, solo = false): TeamFeedTeam => ({
  teamId: TeamId.make(id),
  name,
  solo,
  projects: [],
  me: null,
  members: [],
  claims: [],
  tasks: [],
  handoffs: [],
  sync: { status: solo ? "solo" : "synced", unshared: false, readAt: null },
});

describe("applyTeamFeedEvent", () => {
  it("starts from the snapshot, replaces or adds one team by name, and removes one", () => {
    const start = applyTeamFeedEvent([team("x", "Old")], {
      _tag: "snapshot",
      teams: [team("b", "Beta"), team("c", "Core")],
    });
    expect(start.map((item) => item.teamId)).toEqual(["b", "c"]);

    const renamed = applyTeamFeedEvent(start, { _tag: "team", team: team("c", "Alpha") });
    expect(renamed.map((item) => item.name)).toEqual(["Alpha", "Beta"]);

    const added = applyTeamFeedEvent(renamed, { _tag: "team", team: team("s", "Notes", true) });
    expect(added.map((item) => item.teamId)).toEqual(["c", "b", "s"]);

    const removed = applyTeamFeedEvent(added, { _tag: "removed", teamId: TeamId.make("b") });
    expect(removed.map((item) => item.teamId)).toEqual(["c", "s"]);
  });
});

describe("applyTeamFeedStateEvent", () => {
  const card = (id: string) => ({
    id,
    kind: "team.plan" as const,
    summary: "Plan",
    payload: {},
    runId: null,
    createdAt: "2026-10-12T10:00:00.000Z",
  });

  it("keeps each chat's cards, and the part an event does not change", () => {
    const snapshot = applyTeamFeedStateEvent(EMPTY_TEAM_FEED_STATE, {
      _tag: "snapshot",
      teams: [],
      threadCards: [
        { threadId: ThreadId.make("thread-a"), entries: [card("a1")] },
        { threadId: ThreadId.make("thread-empty"), entries: [] },
      ],
    });
    expect([...snapshot.threadCards.keys()]).toEqual(["thread-a"]);

    const added = applyTeamFeedStateEvent(snapshot, {
      _tag: "threadCards",
      cards: { threadId: ThreadId.make("thread-b"), entries: [card("b1")] },
    });
    expect(added.teams).toBe(snapshot.teams);
    expect(added.threadCards.get("thread-a")).toBe(snapshot.threadCards.get("thread-a"));
    expect(added.threadCards.get("thread-b")?.map((entry) => entry.id)).toEqual(["b1"]);

    const removed = applyTeamFeedStateEvent(added, {
      _tag: "threadCards",
      cards: { threadId: ThreadId.make("thread-a"), entries: [] },
    });
    expect([...removed.threadCards.keys()]).toEqual(["thread-b"]);

    const teamChanged = applyTeamFeedStateEvent(removed, {
      _tag: "removed",
      teamId: TeamId.make("t1"),
    });
    expect(teamChanged.threadCards).toBe(removed.threadCards);
  });
});
