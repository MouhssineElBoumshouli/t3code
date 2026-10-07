/**
 * TeamService - the team's live state: members, claims, task cards, handoff
 * notes and the activity feed. Every team reader and writer (the team tools,
 * the briefing, automatic notes, claim release, `t3 team`) goes through it.
 *
 * The one implementation is `GitTeamService` (./state/GitTeamService.ts): the
 * state lives on the hidden ref `refs/t3-team/state` of the project's own Git
 * remote, one writer file per (GitHub login, T3 server) (team/STORAGE_PLAN.md).
 * The SQLite service it replaced is parked in team/parked/sqlite-service/.
 *
 * @module TeamService
 */
import type {
  EnvironmentId,
  Team,
  TeamActivity,
  TeamClaim,
  TeamClaimOverlap,
  TeamFile,
  TeamHandoff,
  TeamId,
  TeamMember,
  TeamMemberId,
  TeamTask,
  TeamTaskId,
  TeamTaskStatus,
  TeamThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { TeamLateOverlap } from "./state/TeamStateModel.ts";
import type { TeamStateFetchResult, TeamStateSyncResult } from "./state/TeamStateRepo.ts";
import type { TeamNotFoundError, TeamServiceError, TeamStorageError } from "./TeamErrors.ts";

/** Whether this server can use a team, and if not, why. */
export type TeamMembership =
  | { readonly status: "member"; readonly team: Team; readonly member: TeamMember }
  /** The checkout has no `origin` remote. */
  | { readonly status: "noRemote" }
  | { readonly status: "signedOut"; readonly detail: string }
  /** The host says no such repo, which is also what it says without read access. */
  | { readonly status: "noAccess" }
  | { readonly status: "noPushAccess" }
  /** The remote has no team state yet: `t3 team init` starts it. */
  | { readonly status: "noTeamState" }
  /** The remote's team state belongs to another team than `.team/team.json` names. */
  | { readonly status: "otherTeam"; readonly teamId: TeamId }
  | { readonly status: "unavailable"; readonly detail: string };

export interface OpenTeamInput {
  readonly teamFile: TeamFile;
  /** A checkout of the project; its `origin` remote holds the team state. */
  readonly checkout: string;
}

export interface ClaimPathsInput {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly thread: TeamThreadRef;
  readonly paths: ReadonlyArray<string>;
  readonly note?: string | undefined;
}

export interface ReleasePathsInput {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly thread: TeamThreadRef;
  /** Omit to release everything this thread holds. */
  readonly paths?: ReadonlyArray<string> | undefined;
}

export interface ReleaseThreadClaimsInput {
  readonly thread: TeamThreadRef;
  /** Why, for the activity feed, e.g. "its pull request merged". */
  readonly reason: string;
  /** Only claims made at or before this time (ISO); omit to release all. */
  readonly claimedBefore?: string | undefined;
}

export interface CreateTaskInput {
  readonly teamId: TeamId;
  readonly actorMemberId: TeamMemberId;
  readonly title: string;
  readonly paths?: ReadonlyArray<string> | undefined;
  readonly note?: string | undefined;
  readonly ownerMemberId?: TeamMemberId | undefined;
  /** Default: todo. */
  readonly status?: TeamTaskStatus | undefined;
  /** The thread working on the card, when it starts with one. */
  readonly thread?: TeamThreadRef | undefined;
}

export interface UpdateTaskInput {
  readonly teamId: TeamId;
  readonly taskId: TeamTaskId;
  readonly actorMemberId: TeamMemberId;
  readonly status?: TeamTaskStatus | undefined;
  /** Null clears the note. */
  readonly note?: string | null | undefined;
  /** Null unlinks the thread. */
  readonly thread?: TeamThreadRef | null | undefined;
  readonly ownerMemberId?: TeamMemberId | null | undefined;
}

export interface WriteHandoffInput {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly thread: TeamThreadRef;
  readonly taskId?: TeamTaskId | undefined;
  readonly changed: string;
  readonly left?: string | undefined;
  readonly risks?: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly commit?: string | undefined;
  /** Blob hash per file at writing time, null for a missing file. Keys must be in `files`. */
  readonly fileHashes?: Readonly<Record<string, string | null>> | undefined;
}

export interface SaveAutomaticNoteInput {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly thread: TeamThreadRef;
  readonly taskId?: TeamTaskId | undefined;
  /** The files this turn changed. */
  readonly files: ReadonlyArray<string>;
  readonly commit?: string | undefined;
  /** Blob hash per file now, null for a missing file. Keys must be in `files`. */
  readonly fileHashes?: Readonly<Record<string, string | null>> | undefined;
}

export class TeamService extends Context.Service<
  TeamService,
  {
    /**
     * Opens the team a checkout names and says whether this server can use it.
     * The first open of a team in this process reads the remote; the first
     * open by this server writes its writer file (joining the team).
     */
    readonly openTeam: (input: OpenTeamInput) => Effect.Effect<TeamMembership, TeamServiceError>;
    /**
     * Like {@link openTeam}, but starts the team state when the remote has
     * none: `team.json` and this server's writer file, pushed at once.
     */
    readonly ensureTeam: (
      input: OpenTeamInput,
    ) => Effect.Effect<
      { readonly membership: TeamMembership; readonly created: boolean },
      TeamServiceError
    >;
    readonly getTeam: (teamId: TeamId) => Effect.Effect<Option.Option<Team>>;
    /** Teams this server has opened, by name. */
    readonly listTeams: () => Effect.Effect<ReadonlyArray<Team>>;
    /** By login. */
    readonly listMembers: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamMember>, TeamServiceError>;
    /** Who this server writes as, once {@link openTeam} said `member`. */
    readonly currentMember: (teamId: TeamId) => Effect.Effect<Option.Option<TeamMember>>;
    /**
     * Adds a claim, shares it at once and returns other threads' active claims
     * that overlap it, including claims pushed from elsewhere. `confirmed` is
     * false when the push did not land: the claim is kept on this computer and
     * the overlaps are only those known before.
     */
    readonly claimPaths: (input: ClaimPathsInput) => Effect.Effect<
      {
        readonly claim: TeamClaim;
        readonly overlaps: ReadonlyArray<TeamClaimOverlap>;
        readonly confirmed: boolean;
      },
      TeamServiceError
    >;
    /** Releases paths this thread holds; returns the claims it changed. */
    readonly releasePaths: (
      input: ReleasePathsInput,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    /** Oldest first. */
    readonly listActiveClaims: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    /**
     * Releases this server's active claims of a thread, in every team, when its
     * work is merged or dropped (team/DESIGN.md D5). Returns the claims it released.
     */
    readonly releaseThreadClaims: (
      input: ReleaseThreadClaimsInput,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    /** Threads of this server that hold active claims, in any team. */
    readonly listClaimedThreads: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly createTask: (input: CreateTaskInput) => Effect.Effect<TeamTask, TeamServiceError>;
    readonly updateTask: (input: UpdateTaskInput) => Effect.Effect<TeamTask, TeamServiceError>;
    readonly getTask: (
      teamId: TeamId,
      taskId: TeamTaskId,
    ) => Effect.Effect<Option.Option<TeamTask>, TeamServiceError>;
    /** The newest task linked to the thread. */
    readonly findTaskForThread: (
      teamId: TeamId,
      thread: TeamThreadRef,
    ) => Effect.Effect<Option.Option<TeamTask>, TeamServiceError>;
    /** Oldest first. */
    readonly listTasks: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamTask>, TeamServiceError>;
    readonly writeHandoff: (
      input: WriteHandoffInput,
    ) => Effect.Effect<TeamHandoff, TeamServiceError>;
    /**
     * Saves the thread's automatic note (D7): one per thread, updated in place,
     * never an activity line. This turn's files come first with their new
     * hashes; files of earlier turns keep theirs. No word cap: it is not the
     * agent's handoff.
     */
    readonly saveAutomaticNote: (
      input: SaveAutomaticNoteInput,
    ) => Effect.Effect<TeamHandoff, TeamServiceError>;
    /** Newest first; automatic notes included. */
    readonly listHandoffs: (
      teamId: TeamId,
      options?: { readonly thread?: TeamThreadRef; readonly limit?: number },
    ) => Effect.Effect<ReadonlyArray<TeamHandoff>, TeamServiceError>;
    /** Newest first. */
    readonly listActivity: (
      teamId: TeamId,
      options?: { readonly limit?: number },
    ) => Effect.Effect<ReadonlyArray<TeamActivity>, TeamServiceError>;
    /**
     * Late overlaps of the thread's claims not handed out yet: a teammate's
     * claim that overlaps one of the thread's, found after both were made
     * (STORAGE_PLAN.md Q4). Each is handed out once.
     */
    readonly takeLateOverlaps: (
      teamId: TeamId,
      thread: TeamThreadRef,
    ) => Effect.Effect<ReadonlyArray<TeamLateOverlap>>;
    /** Fetches the others' files now, without pushing this server's. */
    readonly refresh: (
      teamId: TeamId,
    ) => Effect.Effect<TeamStateFetchResult, TeamNotFoundError | TeamStorageError>;
    /** Pushes this server's files and fetches the others' now. */
    readonly sync: (
      teamId: TeamId,
    ) => Effect.Effect<TeamStateSyncResult, TeamNotFoundError | TeamStorageError>;
  }
>()("t3/team/TeamService") {}
