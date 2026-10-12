// team-layer: the team feed for the web client (team/UI_PLAN.md slice 0).
import { createTeamFeedAtoms } from "@t3tools/client-runtime/state/teamFeed";
import { type TeamCardRow, teamCardRows } from "@t3tools/client-runtime/work-log/team-cards";
import {
  countOpenTeamChoices,
  EMPTY_TEAM_FEED_STATE,
  type EnvironmentId,
  type TeamCardEntry,
  type TeamFeedState,
  type TeamFeedTeam,
  type ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const teamFeed = createTeamFeedAtoms(connectionAtomRuntime);

function useTeamFeedState(environmentId: EnvironmentId | null): TeamFeedState {
  const query = useEnvironmentQuery(
    environmentId === null ? null : teamFeed.feed({ environmentId, input: {} }),
  );
  return query.data ?? EMPTY_TEAM_FEED_STATE;
}

/** Every team and solo project the environment has open, kept current by the server. */
export function useTeamFeed(environmentId: EnvironmentId | null): ReadonlyArray<TeamFeedTeam> {
  return useTeamFeedState(environmentId).teams;
}

const NO_CARDS: ReadonlyArray<TeamCardRow> = [];

/** One chat's team cards (V2_PORT_PLAN.md D1), oldest first; recomputed only when they change. */
export function useTeamThreadCards(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<TeamCardRow> {
  const entries = useTeamFeedState(environmentId).threadCards.get(threadId ?? "");
  return useMemo(() => (entries === undefined ? NO_CARDS : teamCardRows(entries)), [entries]);
}

/** Every chat's card records on one environment, by thread id. */
export function useTeamThreadCardsByThread(
  environmentId: EnvironmentId | null,
): TeamFeedState["threadCards"] {
  return useTeamFeedState(environmentId).threadCards;
}

/**
 * Whether one of the chat's warning cards waits on the user (D4): the chat
 * then counts as awaiting input, like a pending question.
 */
export function teamAwaitsUser(
  entries: ReadonlyArray<TeamCardEntry> | undefined,
  latestRunId: string | null,
): boolean {
  return entries !== undefined && countOpenTeamChoices(entries, latestRunId) > 0;
}

export function useTeamAwaitsUser(
  environmentId: EnvironmentId | null,
  threadId: ThreadId,
  latestRunId: string | null,
): boolean {
  const entries = useTeamThreadCardsByThread(environmentId).get(threadId);
  return useMemo(() => teamAwaitsUser(entries, latestRunId), [entries, latestRunId]);
}
