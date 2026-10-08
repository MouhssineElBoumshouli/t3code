import { describe, expect, it } from "vite-plus/test";

import { TeamId } from "./team.ts";
import { applyTeamFeedEvent, type TeamFeedTeam } from "./teamFeed.ts";

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
