// team-layer: the team feed for the web client (team/UI_PLAN.md slice 0).
import { createTeamFeedAtoms } from "@t3tools/client-runtime/state/teamFeed";
import type { EnvironmentId, TeamFeedTeam } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const teamFeed = createTeamFeedAtoms(connectionAtomRuntime);

const NO_TEAMS: ReadonlyArray<TeamFeedTeam> = [];

/** Every team and solo project the environment has open, kept current by the server. */
export function useTeamFeed(environmentId: EnvironmentId | null): ReadonlyArray<TeamFeedTeam> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : teamFeed.teams({ environmentId, input: {} }),
  );
  return query.data ?? NO_TEAMS;
}
