/**
 * The team feed (fork-only, see team/UI_PLAN.md slice 0): a read-only
 * subscription that tells a client what each team or solo project on the
 * server holds, so the UI can mark held files and threads and show who is
 * around. The server pushes one team's view when it changes; nothing is polled.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  TeamClaim,
  TeamHandoffId,
  TeamId,
  TeamMember,
  TeamMemberId,
  TeamPath,
  TeamTask,
  TeamThreadRef,
} from "./team.ts";
import { TeamQuestion } from "./teamAsk.ts";
import { type TeamCardEntry, TeamThreadCards } from "./teamCards.ts";
import { TeamNote } from "./teamNotes.ts";

/**
 * - `solo`: kept on this computer, nothing to sync.
 * - `synced`: the last check with the remote worked.
 * - `offline`: the last check failed; the lists are as last fetched.
 * - `notFresh`: the state could not be read just now; the lists are older.
 */
export const TeamFeedSyncStatus = Schema.Literals(["solo", "synced", "offline", "notFresh"]);
export type TeamFeedSyncStatus = typeof TeamFeedSyncStatus.Type;

export const TeamFeedSync = Schema.Struct({
  status: TeamFeedSyncStatus,
  /** This server has writes the remote does not hold yet. */
  unshared: Schema.Boolean,
  /**
   * While offline or not fresh, when the lists were last read (null if never).
   * Null otherwise, so a read that changed nothing pushes nothing.
   */
  readAt: Schema.NullOr(IsoDateTime),
});
export type TeamFeedSync = typeof TeamFeedSync.Type;

/** A project of this server in the team. Claim paths are relative to the team's root. */
export const TeamFeedProject = Schema.Struct({
  projectId: ProjectId,
  /** The project folder relative to the team's root, `/`-separated; "" when they are the same. */
  pathPrefix: Schema.String,
});
export type TeamFeedProject = typeof TeamFeedProject.Type;

/** A written handoff note, cut short for a list. */
export const TeamFeedHandoff = Schema.Struct({
  handoffId: TeamHandoffId,
  memberId: TeamMemberId,
  thread: TeamThreadRef,
  /** The first line of what changed, cut to a list item. */
  headline: TrimmedNonEmptyString,
  files: Schema.Array(TeamPath),
  createdAt: IsoDateTime,
});
export type TeamFeedHandoff = typeof TeamFeedHandoff.Type;

export const TeamFeedTeam = Schema.Struct({
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  solo: Schema.Boolean,
  projects: Schema.Array(TeamFeedProject),
  /** Who this server writes as; null until it opened the team. */
  me: Schema.NullOr(TeamMemberId),
  members: Schema.Array(TeamMember),
  /** Active claims, oldest first. */
  claims: Schema.Array(TeamClaim),
  /** Tasks not done, oldest first, capped. */
  tasks: Schema.Array(TeamTask),
  /** The newest written handoff notes, newest first, capped. */
  handoffs: Schema.Array(TeamFeedHandoff),
  /** Questions to this server's person not answered yet, oldest first ("Ask", slice 3d). */
  questions: Schema.optionalKey(Schema.Array(TeamQuestion)),
  /**
   * Notes for everyone, for this server's person and from them, newest first:
   * open ones, then done ones not dropped yet. Capped.
   */
  notes: Schema.optionalKey(Schema.Array(TeamNote)),
  sync: TeamFeedSync,
});
export type TeamFeedTeam = typeof TeamFeedTeam.Type;

export const TeamFeedEvent = Schema.Union([
  /**
   * First event: every team the server has open with a project on it, and the
   * cards of every chat that has some (V2_PORT_PLAN.md D1).
   */
  Schema.TaggedStruct("snapshot", {
    teams: Schema.Array(TeamFeedTeam),
    threadCards: Schema.optionalKey(Schema.Array(TeamThreadCards)),
  }),
  /** One team changed, or appeared. */
  Schema.TaggedStruct("team", { team: TeamFeedTeam }),
  /** A team no longer has a project on this server. */
  Schema.TaggedStruct("removed", { teamId: TeamId }),
  /** One chat's cards changed; empty entries when it has none left. */
  Schema.TaggedStruct("threadCards", { cards: TeamThreadCards }),
]);
export type TeamFeedEvent = typeof TeamFeedEvent.Type;

/** Caps on one team's view, so a push stays small. */
export const TEAM_FEED_LIMITS = {
  tasks: 50,
  handoffs: 5,
  handoffFiles: 5,
  headline: 160,
  openNotes: 60,
  doneNotes: 20,
} as const;

/** Folds feed events into the current list of teams, by name. */
export const applyTeamFeedEvent = (
  teams: ReadonlyArray<TeamFeedTeam>,
  event: TeamFeedEvent,
): ReadonlyArray<TeamFeedTeam> => {
  switch (event._tag) {
    case "snapshot":
      return event.teams;
    case "team":
      // Not toSorted: mobile's Hermes does not have it.
      return [...teams.filter((team) => team.teamId !== event.team.teamId), event.team].sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    case "removed":
      return teams.filter((team) => team.teamId !== event.teamId);
    case "threadCards":
      return teams;
  }
};

/** What a client keeps from the feed: the teams, and each chat's cards by thread id. */
export interface TeamFeedState {
  readonly teams: ReadonlyArray<TeamFeedTeam>;
  readonly threadCards: ReadonlyMap<string, ReadonlyArray<TeamCardEntry>>;
}

export const EMPTY_TEAM_FEED_STATE: TeamFeedState = { teams: [], threadCards: new Map() };

/**
 * Folds one feed event into the state. A team event keeps the cards map as it
 * was and a cards event keeps the teams list, so readers of one part do not
 * redraw when the other changes.
 */
export const applyTeamFeedStateEvent = (
  state: TeamFeedState,
  event: TeamFeedEvent,
): TeamFeedState => {
  switch (event._tag) {
    case "snapshot":
      return {
        teams: event.teams,
        threadCards: new Map(
          (event.threadCards ?? []).flatMap((thread) =>
            thread.entries.length === 0 ? [] : [[thread.threadId, thread.entries] as const],
          ),
        ),
      };
    case "threadCards": {
      const threadCards = new Map(state.threadCards);
      if (event.cards.entries.length === 0) threadCards.delete(event.cards.threadId);
      else threadCards.set(event.cards.threadId, event.cards.entries);
      return { teams: state.teams, threadCards };
    }
    default:
      return { teams: applyTeamFeedEvent(state.teams, event), threadCards: state.threadCards };
  }
};
