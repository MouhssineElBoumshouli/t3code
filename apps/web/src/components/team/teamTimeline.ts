/**
 * team-layer: a chat's team cards among its timeline entries (team/V2_PORT_PLAN.md
 * D1). The cards come from the team feed, not the thread's history, so the
 * timeline gets them here, each where it stands in time.
 */
import type { TeamCardRow } from "@t3tools/client-runtime/work-log/team-cards";

import type { TimelineEntry } from "../../session-logic";

/** `entries` with each card before the first entry newer than it; the same array when there are none. */
export function withTeamCardEntries(
  entries: ReadonlyArray<TimelineEntry>,
  cards: ReadonlyArray<TeamCardRow>,
): ReadonlyArray<TimelineEntry> {
  if (cards.length === 0) return entries;
  const merged: Array<TimelineEntry> = [];
  let next = 0;
  for (const entry of entries) {
    while (next < cards.length && cards[next]!.createdAt < entry.createdAt) {
      merged.push(cardEntry(cards[next]!));
      next += 1;
    }
    merged.push(entry);
  }
  for (; next < cards.length; next += 1) merged.push(cardEntry(cards[next]!));
  return merged;
}

const cardEntry = (card: TeamCardRow): TimelineEntry => ({
  id: `team-card:${card.id}`,
  kind: "team-card",
  createdAt: card.createdAt,
  runId: card.runId,
  teamCard: card,
});
