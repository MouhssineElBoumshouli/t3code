/**
 * TeamService - the team's live state in this server's `team_*` tables:
 * teams, members, claims, task cards, handoff notes and the activity feed.
 *
 * In M1 the team lives on the owner's own server (solo host mode, see
 * team/DESIGN.md D1). Building the service runs the team migrations first.
 *
 * @module TeamService
 */
import {
  countTeamWords,
  EnvironmentId,
  normalizeTeamPath,
  type Team,
  type TeamActivity,
  TeamActivityKind,
  TeamActivityId,
  type TeamClaim,
  TeamClaimId,
  type TeamClaimOverlap,
  type TeamFile,
  type TeamHandoff,
  TeamHandoffId,
  TEAM_AUTOMATIC_NOTE_MAX_FILES,
  TEAM_HANDOFF_MAX_WORDS,
  TeamId,
  type TeamMember,
  TeamMemberId,
  TeamMemberRole,
  TeamPath,
  teamPathsOverlap,
  type TeamTask,
  TeamTaskId,
  TeamTaskStatus,
  type TeamThreadRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import {
  TeamClaimPathsInvalidError,
  TeamHandoffTooLongError,
  TeamMemberNotFoundError,
  TeamNotFoundError,
  type TeamServiceError,
  TeamStorageError,
  TeamTaskNotFoundError,
} from "./TeamErrors.ts";
import { runTeamMigrations } from "./TeamMigrations.ts";

export interface EnsureTeamInput {
  readonly teamFile: TeamFile;
  readonly canonicalKey: string | null;
  readonly owner: { readonly environmentId: EnvironmentId; readonly displayName: string };
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
     * Records the team named by a `.team/team.json`, with this server's owner
     * as its first member. Safe to call again: an existing team and owner are
     * returned unchanged, with `created: false`.
     */
    readonly ensureTeam: (
      input: EnsureTeamInput,
    ) => Effect.Effect<
      { readonly team: Team; readonly owner: TeamMember; readonly created: boolean },
      TeamServiceError
    >;
    readonly getTeam: (teamId: TeamId) => Effect.Effect<Option.Option<Team>, TeamServiceError>;
    /** Every team this server hosts (has the row of), oldest first. */
    readonly listTeams: () => Effect.Effect<ReadonlyArray<Team>, TeamServiceError>;
    readonly listMembers: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamMember>, TeamServiceError>;
    readonly findMemberByEnvironment: (
      teamId: TeamId,
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<TeamMember>, TeamServiceError>;
    /** Adds a claim and returns other threads' active claims that overlap it. */
    readonly claimPaths: (
      input: ClaimPathsInput,
    ) => Effect.Effect<
      { readonly claim: TeamClaim; readonly overlaps: ReadonlyArray<TeamClaimOverlap> },
      TeamServiceError
    >;
    /** Releases paths this thread holds; returns the claims it changed. */
    readonly releasePaths: (
      input: ReleasePathsInput,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    readonly listActiveClaims: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    /**
     * Releases every active claim of a thread, in any team, when its work is
     * merged or dropped (team/DESIGN.md D5). Returns the claims it released.
     */
    readonly releaseThreadClaims: (
      input: ReleaseThreadClaimsInput,
    ) => Effect.Effect<ReadonlyArray<TeamClaim>, TeamServiceError>;
    /** Threads of this environment that hold active claims. */
    readonly listClaimedThreads: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, TeamServiceError>;
    readonly createTask: (input: CreateTaskInput) => Effect.Effect<TeamTask, TeamServiceError>;
    readonly updateTask: (input: UpdateTaskInput) => Effect.Effect<TeamTask, TeamServiceError>;
    readonly getTask: (
      teamId: TeamId,
      taskId: TeamTaskId,
    ) => Effect.Effect<Option.Option<TeamTask>, TeamServiceError>;
    readonly findTaskForThread: (
      teamId: TeamId,
      thread: TeamThreadRef,
    ) => Effect.Effect<Option.Option<TeamTask>, TeamServiceError>;
    readonly listTasks: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamTask>, TeamServiceError>;
    readonly writeHandoff: (
      input: WriteHandoffInput,
    ) => Effect.Effect<TeamHandoff, TeamServiceError>;
    /**
     * Saves the thread's automatic note (D7): one per thread, updated in place,
     * never an activity line. This turn's files come first with their new
     * hashes; files of earlier turns keep theirs, up to
     * {@link TEAM_AUTOMATIC_NOTE_MAX_FILES}. No word cap: it is not the
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
  }
>()("t3/team/TeamService") {}

const DEFAULT_LIST_LIMIT = 50;

const PathsJson = Schema.fromJsonString(Schema.Array(TeamPath));
const encodePaths = Schema.encodeSync(PathsJson);
const NullableText = Schema.NullOr(TrimmedNonEmptyString);
const FileHashesJson = Schema.NullOr(
  Schema.fromJsonString(Schema.Record(TeamPath, Schema.NullOr(TrimmedNonEmptyString))),
);
const encodeFileHashes = Schema.encodeSync(FileHashesJson);

const TeamRow = Schema.Struct({
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  canonicalKey: NullableText,
  createdAt: Schema.String,
});

const MemberRow = Schema.Struct({
  memberId: TeamMemberId,
  teamId: TeamId,
  displayName: TrimmedNonEmptyString,
  role: TeamMemberRole,
  environmentId: EnvironmentId,
  joinedAt: Schema.String,
});

const ClaimRow = Schema.Struct({
  claimId: TeamClaimId,
  teamId: TeamId,
  memberId: TeamMemberId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  paths: PathsJson,
  note: NullableText,
  claimedAt: Schema.String,
  releasedAt: Schema.NullOr(Schema.String),
});

const TaskRow = Schema.Struct({
  taskId: TeamTaskId,
  teamId: TeamId,
  title: TrimmedNonEmptyString,
  status: TeamTaskStatus,
  note: NullableText,
  paths: PathsJson,
  ownerMemberId: Schema.NullOr(TeamMemberId),
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const HandoffRow = Schema.Struct({
  handoffId: TeamHandoffId,
  teamId: TeamId,
  memberId: TeamMemberId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  taskId: Schema.NullOr(TeamTaskId),
  changed: TrimmedNonEmptyString,
  left: NullableText,
  risks: NullableText,
  files: PathsJson,
  commit: NullableText,
  fileHashes: FileHashesJson,
  automatic: Schema.Number,
  createdAt: Schema.String,
});

const ActivityRow = Schema.Struct({
  activityId: TeamActivityId,
  teamId: TeamId,
  memberId: Schema.NullOr(TeamMemberId),
  kind: TeamActivityKind,
  summary: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
});

const ClaimedThreadRow = Schema.Struct({ threadId: ThreadId });

const decodeTeamRows = Schema.decodeUnknownEffect(Schema.Array(TeamRow));
const decodeMemberRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));
const decodeClaimRows = Schema.decodeUnknownEffect(Schema.Array(ClaimRow));
const decodeTaskRows = Schema.decodeUnknownEffect(Schema.Array(TaskRow));
const decodeHandoffRows = Schema.decodeUnknownEffect(Schema.Array(HandoffRow));
const decodeActivityRows = Schema.decodeUnknownEffect(Schema.Array(ActivityRow));
const decodeClaimedThreadRows = Schema.decodeUnknownEffect(Schema.Array(ClaimedThreadRow));

const decodeRows =
  <A, E>(decode: (rows: unknown) => Effect.Effect<A, E>, operation: string) =>
  (rows: unknown) =>
    decode(rows).pipe(Effect.mapError((cause) => new TeamStorageError({ operation, cause })));

const toClaim = (row: typeof ClaimRow.Type): TeamClaim => ({
  claimId: row.claimId,
  teamId: row.teamId,
  memberId: row.memberId,
  thread: { environmentId: row.environmentId, threadId: row.threadId },
  paths: row.paths,
  note: row.note,
  claimedAt: row.claimedAt,
  releasedAt: row.releasedAt,
});

const toTask = (row: typeof TaskRow.Type): TeamTask => ({
  taskId: row.taskId,
  teamId: row.teamId,
  title: row.title,
  status: row.status,
  note: row.note,
  paths: row.paths,
  ownerMemberId: row.ownerMemberId,
  thread:
    row.environmentId !== null && row.threadId !== null
      ? { environmentId: row.environmentId, threadId: row.threadId }
      : null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toHandoff = (row: typeof HandoffRow.Type): TeamHandoff => ({
  handoffId: row.handoffId,
  teamId: row.teamId,
  memberId: row.memberId,
  thread: { environmentId: row.environmentId, threadId: row.threadId },
  taskId: row.taskId,
  changed: row.changed,
  left: row.left,
  risks: row.risks,
  files: row.files,
  commit: row.commit,
  fileHashes: row.fileHashes,
  automatic: row.automatic === 1,
  createdAt: row.createdAt,
});

const toActivity = (row: typeof ActivityRow.Type): TeamActivity => ({
  activityId: row.activityId,
  teamId: row.teamId,
  memberId: row.memberId,
  kind: row.kind,
  summary: row.summary,
  thread:
    row.environmentId !== null && row.threadId !== null
      ? { environmentId: row.environmentId, threadId: row.threadId }
      : null,
  createdAt: row.createdAt,
});

/** Trimmed text, or null when empty. */
const optionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/** Normalized, de-duplicated paths. Fails on a path that names the whole repo. */
const normalizeClaimPaths = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const normalized: Array<string> = [];
    for (const raw of paths) {
      const path = normalizeTeamPath(raw);
      if (path === "" || path === ".") {
        return yield* new TeamClaimPathsInvalidError({
          detail: `"${raw}" names the whole repo. Name the files or folders instead.`,
        });
      }
      if (path.split("/").includes("..")) {
        return yield* new TeamClaimPathsInvalidError({
          detail: `"${raw}" leaves the repo. Use repo-relative paths.`,
        });
      }
      if (!normalized.includes(path)) normalized.push(path);
    }
    return normalized;
  });

/** The hashes of the note's own files, keyed like `files`; null when there are none. */
const keepHashesOf = (
  files: ReadonlyArray<string>,
  hashes: Readonly<Record<string, string | null>> | undefined,
) => {
  if (hashes === undefined) return null;
  const kept: Record<string, string | null> = {};
  for (const [raw, hash] of Object.entries(hashes)) {
    const path = normalizeTeamPath(raw);
    if (files.includes(path)) kept[path] = hash?.trim() || null;
  }
  return Object.keys(kept).length === 0 ? null : kept;
};

const sameThread = (left: TeamThreadRef, right: TeamThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

const describePaths = (paths: ReadonlyArray<string>) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  yield* runTeamMigrations().pipe(
    Effect.mapError((cause) => new TeamStorageError({ operation: "runTeamMigrations", cause })),
  );

  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storage =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TeamStorageError({ operation, cause })));

  const selectTeam = (teamId: TeamId) =>
    sql`
      SELECT team_id AS "teamId", name, canonical_key AS "canonicalKey", created_at AS "createdAt"
      FROM team_teams WHERE team_id = ${teamId}
    `.pipe(
      storage("getTeam"),
      Effect.flatMap(decodeRows(decodeTeamRows, "getTeam")),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const selectTeams = () =>
    sql`
      SELECT team_id AS "teamId", name, canonical_key AS "canonicalKey", created_at AS "createdAt"
      FROM team_teams ORDER BY created_at, team_id
    `.pipe(storage("listTeams"), Effect.flatMap(decodeRows(decodeTeamRows, "listTeams")));

  const selectMembers = (teamId: TeamId) =>
    sql`
      SELECT member_id AS "memberId", team_id AS "teamId", display_name AS "displayName",
        role, environment_id AS "environmentId", joined_at AS "joinedAt"
      FROM team_members WHERE team_id = ${teamId}
      ORDER BY joined_at, member_id
    `.pipe(storage("listMembers"), Effect.flatMap(decodeRows(decodeMemberRows, "listMembers")));

  const requireTeam = (teamId: TeamId) =>
    selectTeam(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TeamNotFoundError({ teamId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireMember = (teamId: TeamId, memberId: TeamMemberId) =>
    selectMembers(teamId).pipe(
      Effect.flatMap((members) => {
        const member = members.find((candidate) => candidate.memberId === memberId);
        return member
          ? Effect.succeed(member)
          : Effect.fail(new TeamMemberNotFoundError({ teamId, memberId }));
      }),
    );

  const recordActivity = (input: {
    readonly teamId: TeamId;
    readonly memberId: TeamMemberId | null;
    readonly kind: TeamActivityKind;
    readonly summary: string;
    readonly thread: TeamThreadRef | null;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const activityId = yield* newId;
      yield* sql`
        INSERT INTO team_activity (
          activity_id, team_id, member_id, kind, summary, environment_id, thread_id, created_at
        ) VALUES (
          ${activityId}, ${input.teamId}, ${input.memberId}, ${input.kind}, ${input.summary},
          ${input.thread?.environmentId ?? null}, ${input.thread?.threadId ?? null}, ${input.createdAt}
        )
      `.pipe(storage("recordActivity"));
    });

  const selectActiveClaims = (scope: TeamId | TeamThreadRef) =>
    sql`
      SELECT claim_id AS "claimId", team_id AS "teamId", member_id AS "memberId",
        environment_id AS "environmentId", thread_id AS "threadId", paths_json AS "paths",
        note, claimed_at AS "claimedAt", released_at AS "releasedAt"
      FROM team_claims
      WHERE released_at IS NULL
        ${
          typeof scope === "string"
            ? sql`AND team_id = ${scope}`
            : sql`AND environment_id = ${scope.environmentId} AND thread_id = ${scope.threadId}`
        }
      -- rowid keeps claim order for claims made in the same millisecond.
      ORDER BY claimed_at, rowid
    `.pipe(
      storage("listActiveClaims"),
      Effect.flatMap(decodeRows(decodeClaimRows, "listActiveClaims")),
      Effect.map((rows) => rows.map(toClaim)),
    );

  const selectTasks = (
    teamId: TeamId,
    filter?: { readonly taskId?: TeamTaskId; readonly thread?: TeamThreadRef },
  ) =>
    sql`
      SELECT task_id AS "taskId", team_id AS "teamId", title, status, note,
        paths_json AS "paths", owner_member_id AS "ownerMemberId",
        environment_id AS "environmentId", thread_id AS "threadId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM team_tasks
      WHERE team_id = ${teamId}
        ${filter?.taskId === undefined ? sql`` : sql`AND task_id = ${filter.taskId}`}
        ${
          filter?.thread === undefined
            ? sql``
            : sql`AND environment_id = ${filter.thread.environmentId} AND thread_id = ${filter.thread.threadId}`
        }
      ORDER BY created_at, task_id
    `.pipe(
      storage("listTasks"),
      Effect.flatMap(decodeRows(decodeTaskRows, "listTasks")),
      Effect.map((rows) => rows.map(toTask)),
    );

  const ensureTeam: TeamService["Service"]["ensureTeam"] = Effect.fn("TeamService.ensureTeam")(
    function* (input) {
      const { teamId, name } = input.teamFile;
      const displayName = optionalText(input.owner.displayName) ?? "Owner";
      const canonicalKey = optionalText(input.canonicalKey);
      return yield* Effect.gen(function* () {
        const existingTeam = yield* selectTeam(teamId);
        const createdAt = yield* nowIso;
        if (Option.isNone(existingTeam)) {
          yield* sql`
            INSERT INTO team_teams (team_id, name, canonical_key, created_at)
            VALUES (${teamId}, ${name}, ${canonicalKey}, ${createdAt})
          `.pipe(storage("ensureTeam"));
        }
        const members = yield* selectMembers(teamId);
        let owner = members.find((member) => member.environmentId === input.owner.environmentId);
        if (!owner) {
          const memberId = TeamMemberId.make(yield* newId);
          const role = members.some((member) => member.role === "owner") ? "member" : "owner";
          yield* sql`
            INSERT INTO team_members (
              member_id, team_id, display_name, role, environment_id, joined_at
            ) VALUES (
              ${memberId}, ${teamId}, ${displayName}, ${role}, ${input.owner.environmentId}, ${createdAt}
            )
          `.pipe(storage("ensureTeam"));
          owner = {
            memberId,
            teamId,
            displayName: displayName as TeamMember["displayName"],
            role,
            environmentId: input.owner.environmentId,
            joinedAt: createdAt,
          };
        }
        if (Option.isNone(existingTeam)) {
          yield* recordActivity({
            teamId,
            memberId: owner.memberId,
            kind: "team.created",
            summary: `${owner.displayName} created team ${name}.`,
            thread: null,
            createdAt,
          });
        }
        const team = yield* requireTeam(teamId);
        return { team, owner, created: Option.isNone(existingTeam) };
      }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("ensureTeam")));
    },
  );

  const claimPaths: TeamService["Service"]["claimPaths"] = Effect.fn("TeamService.claimPaths")(
    function* (input) {
      const paths = yield* normalizeClaimPaths(input.paths);
      if (paths.length === 0) {
        return yield* new TeamClaimPathsInvalidError({
          detail: "Name at least one path to claim.",
        });
      }
      return yield* Effect.gen(function* () {
        const member = yield* requireMember(input.teamId, input.memberId);
        const claimId = TeamClaimId.make(yield* newId);
        const claimedAt = yield* nowIso;
        const note = optionalText(input.note);
        yield* sql`
          INSERT INTO team_claims (
            claim_id, team_id, member_id, environment_id, thread_id, paths_json, note, claimed_at, released_at
          ) VALUES (
            ${claimId}, ${input.teamId}, ${input.memberId}, ${input.thread.environmentId},
            ${input.thread.threadId}, ${encodePaths(paths)}, ${note}, ${claimedAt}, NULL
          )
        `.pipe(storage("claimPaths"));
        yield* recordActivity({
          teamId: input.teamId,
          memberId: input.memberId,
          kind: "claim.added",
          summary: `${member.displayName} claimed ${describePaths(paths)}.`,
          thread: input.thread,
          createdAt: claimedAt,
        });
        const active = yield* selectActiveClaims(input.teamId);
        const claim = active.find((candidate) => candidate.claimId === claimId);
        if (!claim) {
          return yield* new TeamStorageError({
            operation: "claimPaths",
            cause: new Error("The new claim was not found after insert."),
          });
        }
        const overlaps = active.flatMap((other): Array<TeamClaimOverlap> => {
          if (sameThread(other.thread, input.thread)) return [];
          const overlapping = other.paths.filter((otherPath) =>
            paths.some((path) => teamPathsOverlap(path, otherPath)),
          );
          return overlapping.length > 0 ? [{ claim: other, paths: overlapping }] : [];
        });
        return { claim, overlaps };
      }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("claimPaths")));
    },
  );

  const releasePaths: TeamService["Service"]["releasePaths"] = Effect.fn(
    "TeamService.releasePaths",
  )(function* (input) {
    const releasing =
      input.paths === undefined ? undefined : yield* normalizeClaimPaths(input.paths);
    return yield* Effect.gen(function* () {
      const member = yield* requireMember(input.teamId, input.memberId);
      const releasedAt = yield* nowIso;
      const held = (yield* selectActiveClaims(input.teamId)).filter((claim) =>
        sameThread(claim.thread, input.thread),
      );
      const changed: Array<TeamClaim> = [];
      const releasedPaths: Array<string> = [];
      for (const claim of held) {
        // Releasing a folder also releases paths claimed inside it.
        const kept =
          releasing === undefined
            ? []
            : claim.paths.filter(
                (path) =>
                  !releasing.some((release) => path === release || path.startsWith(`${release}/`)),
              );
        if (kept.length === claim.paths.length) continue;
        releasedPaths.push(...claim.paths.filter((path) => !kept.includes(path)));
        if (kept.length === 0) {
          yield* sql`
            UPDATE team_claims SET released_at = ${releasedAt} WHERE claim_id = ${claim.claimId}
          `.pipe(storage("releasePaths"));
          changed.push({ ...claim, releasedAt });
        } else {
          yield* sql`
            UPDATE team_claims SET paths_json = ${encodePaths(kept)} WHERE claim_id = ${claim.claimId}
          `.pipe(storage("releasePaths"));
          changed.push({ ...claim, paths: kept as TeamClaim["paths"] });
        }
      }
      if (releasedPaths.length > 0) {
        yield* recordActivity({
          teamId: input.teamId,
          memberId: input.memberId,
          kind: "claim.released",
          summary: `${member.displayName} released ${describePaths(releasedPaths)}.`,
          thread: input.thread,
          createdAt: releasedAt,
        });
      }
      return changed;
    }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("releasePaths")));
  });

  const releaseThreadClaims: TeamService["Service"]["releaseThreadClaims"] = Effect.fn(
    "TeamService.releaseThreadClaims",
  )(function* (input) {
    return yield* Effect.gen(function* () {
      // No time, or one that does not parse: release them all.
      const parsed = Date.parse(input.claimedBefore ?? "");
      const before = Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
      const held = (yield* selectActiveClaims(input.thread)).filter(
        (claim) => Date.parse(claim.claimedAt) <= before,
      );
      if (held.length === 0) return [];
      const releasedAt = yield* nowIso;
      for (const claim of held) {
        yield* sql`
          UPDATE team_claims SET released_at = ${releasedAt} WHERE claim_id = ${claim.claimId}
        `.pipe(storage("releaseThreadClaims"));
      }
      // A thread works for one member, but its claims could span teams.
      for (const claims of Map.groupBy(held, (claim) => claim.teamId).values()) {
        const { teamId, memberId } = claims[0]!;
        const members = yield* selectMembers(teamId);
        const name = members.find((member) => member.memberId === memberId)?.displayName;
        yield* recordActivity({
          teamId,
          memberId,
          kind: "claim.released",
          summary: `Released ${name ?? "a teammate"}'s claims on ${describePaths(
            claims.flatMap((claim) => claim.paths),
          )}: ${input.reason}.`,
          thread: input.thread,
          createdAt: releasedAt,
        });
      }
      return held.map((claim) => ({ ...claim, releasedAt }));
    }).pipe(
      sql.withTransaction,
      Effect.catchTag("SqlError", storageFailure("releaseThreadClaims")),
    );
  });

  const createTask: TeamService["Service"]["createTask"] = Effect.fn("TeamService.createTask")(
    function* (input) {
      const paths = yield* normalizeClaimPaths(input.paths ?? []);
      return yield* Effect.gen(function* () {
        yield* requireTeam(input.teamId);
        const actor = yield* requireMember(input.teamId, input.actorMemberId);
        if (input.ownerMemberId !== undefined) {
          yield* requireMember(input.teamId, input.ownerMemberId);
        }
        const taskId = TeamTaskId.make(yield* newId);
        const createdAt = yield* nowIso;
        const title = input.title.trim();
        yield* sql`
          INSERT INTO team_tasks (
            task_id, team_id, title, status, note, paths_json, owner_member_id,
            environment_id, thread_id, created_at, updated_at
          ) VALUES (
            ${taskId}, ${input.teamId}, ${title}, ${input.status ?? "todo"}, ${optionalText(input.note)},
            ${encodePaths(paths)}, ${input.ownerMemberId ?? null},
            ${input.thread?.environmentId ?? null}, ${input.thread?.threadId ?? null},
            ${createdAt}, ${createdAt}
          )
        `.pipe(storage("createTask"));
        yield* recordActivity({
          teamId: input.teamId,
          memberId: actor.memberId,
          kind: "task.created",
          summary: `${actor.displayName} created task "${title}".`,
          thread: input.thread ?? null,
          createdAt,
        });
        const [task] = yield* selectTasks(input.teamId, { taskId });
        if (!task) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId });
        }
        return task;
      }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("createTask")));
    },
  );

  const updateTask: TeamService["Service"]["updateTask"] = Effect.fn("TeamService.updateTask")(
    function* (input) {
      return yield* Effect.gen(function* () {
        const actor = yield* requireMember(input.teamId, input.actorMemberId);
        const [current] = yield* selectTasks(input.teamId, { taskId: input.taskId });
        if (!current) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId: input.taskId });
        }
        if (input.ownerMemberId !== undefined && input.ownerMemberId !== null) {
          yield* requireMember(input.teamId, input.ownerMemberId);
        }
        const updatedAt = yield* nowIso;
        const status = input.status ?? current.status;
        const note = input.note === undefined ? current.note : optionalText(input.note);
        const thread = input.thread === undefined ? current.thread : input.thread;
        const ownerMemberId =
          input.ownerMemberId === undefined ? current.ownerMemberId : input.ownerMemberId;
        yield* sql`
          UPDATE team_tasks SET
            status = ${status},
            note = ${note},
            owner_member_id = ${ownerMemberId},
            environment_id = ${thread?.environmentId ?? null},
            thread_id = ${thread?.threadId ?? null},
            updated_at = ${updatedAt}
          WHERE team_id = ${input.teamId} AND task_id = ${input.taskId}
        `.pipe(storage("updateTask"));
        yield* recordActivity({
          teamId: input.teamId,
          memberId: actor.memberId,
          kind: "task.updated",
          summary:
            status === current.status
              ? `${actor.displayName} updated task "${current.title}".`
              : `${actor.displayName} moved task "${current.title}" to ${status}.`,
          thread,
          createdAt: updatedAt,
        });
        const [task] = yield* selectTasks(input.teamId, { taskId: input.taskId });
        if (!task) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId: input.taskId });
        }
        return task;
      }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("updateTask")));
    },
  );

  const selectHandoffs = (
    teamId: TeamId,
    options?: {
      readonly thread?: TeamThreadRef;
      readonly handoffId?: TeamHandoffId;
      readonly automatic?: boolean;
      readonly limit?: number;
    },
  ) =>
    sql`
      SELECT handoff_id AS "handoffId", team_id AS "teamId", member_id AS "memberId",
        environment_id AS "environmentId", thread_id AS "threadId", task_id AS "taskId",
        changed, left_text AS "left", risks, files_json AS "files", commit_sha AS "commit",
        file_hashes_json AS "fileHashes", automatic, created_at AS "createdAt"
      FROM team_handoffs
      WHERE team_id = ${teamId}
        ${options?.handoffId === undefined ? sql`` : sql`AND handoff_id = ${options.handoffId}`}
        ${options?.automatic === undefined ? sql`` : sql`AND automatic = ${options.automatic ? 1 : 0}`}
        ${
          options?.thread === undefined
            ? sql``
            : sql`AND environment_id = ${options.thread.environmentId} AND thread_id = ${options.thread.threadId}`
        }
      ORDER BY created_at DESC, handoff_id DESC
      LIMIT ${options?.limit ?? DEFAULT_LIST_LIMIT}
    `.pipe(
      storage("listHandoffs"),
      Effect.flatMap(decodeRows(decodeHandoffRows, "listHandoffs")),
      Effect.map((rows) => rows.map(toHandoff)),
    );

  const writeHandoff: TeamService["Service"]["writeHandoff"] = Effect.fn(
    "TeamService.writeHandoff",
  )(function* (input) {
    const changed = input.changed.trim();
    const left = optionalText(input.left);
    const risks = optionalText(input.risks);
    const words = countTeamWords([changed, left ?? "", risks ?? ""].join(" "));
    if (words > TEAM_HANDOFF_MAX_WORDS) {
      return yield* new TeamHandoffTooLongError({ words, maxWords: TEAM_HANDOFF_MAX_WORDS });
    }
    const files = yield* normalizeClaimPaths(input.files);
    const fileHashes = keepHashesOf(files, input.fileHashes);
    return yield* Effect.gen(function* () {
      const member = yield* requireMember(input.teamId, input.memberId);
      if (input.taskId !== undefined) {
        const [task] = yield* selectTasks(input.teamId, { taskId: input.taskId });
        if (!task) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId: input.taskId });
        }
      }
      const handoffId = TeamHandoffId.make(yield* newId);
      const createdAt = yield* nowIso;
      yield* sql`
        INSERT INTO team_handoffs (
          handoff_id, team_id, member_id, environment_id, thread_id, task_id,
          changed, left_text, risks, files_json, commit_sha, file_hashes_json, created_at
        ) VALUES (
          ${handoffId}, ${input.teamId}, ${input.memberId}, ${input.thread.environmentId},
          ${input.thread.threadId}, ${input.taskId ?? null}, ${changed}, ${left}, ${risks},
          ${encodePaths(files)}, ${optionalText(input.commit)}, ${encodeFileHashes(fileHashes)},
          ${createdAt}
        )
      `.pipe(storage("writeHandoff"));
      yield* recordActivity({
        teamId: input.teamId,
        memberId: input.memberId,
        kind: "handoff.written",
        summary: `${member.displayName} wrote a handoff note.`,
        thread: input.thread,
        createdAt,
      });
      const [handoff] = yield* selectHandoffs(input.teamId, { handoffId });
      if (!handoff) {
        return yield* new TeamStorageError({
          operation: "writeHandoff",
          cause: new Error("The new handoff was not found after insert."),
        });
      }
      return handoff;
    }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("writeHandoff")));
  });

  const saveAutomaticNote: TeamService["Service"]["saveAutomaticNote"] = Effect.fn(
    "TeamService.saveAutomaticNote",
  )(function* (input) {
    const turnFiles = yield* normalizeClaimPaths(input.files);
    const turnHashes = keepHashesOf(turnFiles, input.fileHashes) ?? {};
    return yield* Effect.gen(function* () {
      yield* requireMember(input.teamId, input.memberId);
      const [existing] = yield* selectHandoffs(input.teamId, {
        thread: input.thread,
        automatic: true,
        limit: 1,
      });
      const files = [
        ...turnFiles,
        ...(existing?.files ?? []).filter((file) => !turnFiles.includes(file)),
      ].slice(0, TEAM_AUTOMATIC_NOTE_MAX_FILES);
      const hashes: Record<string, string | null> = {};
      for (const file of files) {
        // A file of this turn that could not be hashed loses its old hash too.
        const hash = turnFiles.includes(file) ? turnHashes[file] : existing?.fileHashes?.[file];
        if (hash !== undefined) hashes[file] = hash;
      }
      const task =
        input.taskId === undefined
          ? undefined
          : (yield* selectTasks(input.teamId, { taskId: input.taskId }))[0];
      const changed = `Automatic note, not written by the agent: this chat changed ${files.length} ${
        files.length === 1 ? "file" : "files"
      }${task === undefined ? "" : ` for task "${task.title}"`}.`;
      const fileHashes = Object.keys(hashes).length === 0 ? null : hashes;
      const savedAt = yield* nowIso;
      const handoffId = existing?.handoffId ?? TeamHandoffId.make(yield* newId);
      if (existing === undefined) {
        yield* sql`
          INSERT INTO team_handoffs (
            handoff_id, team_id, member_id, environment_id, thread_id, task_id,
            changed, left_text, risks, files_json, commit_sha, file_hashes_json, automatic, created_at
          ) VALUES (
            ${handoffId}, ${input.teamId}, ${input.memberId}, ${input.thread.environmentId},
            ${input.thread.threadId}, ${task?.taskId ?? null}, ${changed}, NULL, NULL,
            ${encodePaths(files)}, ${optionalText(input.commit)}, ${encodeFileHashes(fileHashes)},
            1, ${savedAt}
          )
        `.pipe(storage("saveAutomaticNote"));
      } else {
        yield* sql`
          UPDATE team_handoffs SET
            member_id = ${input.memberId},
            task_id = ${task?.taskId ?? null},
            changed = ${changed},
            files_json = ${encodePaths(files)},
            commit_sha = ${optionalText(input.commit)},
            file_hashes_json = ${encodeFileHashes(fileHashes)},
            created_at = ${savedAt}
          WHERE handoff_id = ${handoffId}
        `.pipe(storage("saveAutomaticNote"));
      }
      const [note] = yield* selectHandoffs(input.teamId, { handoffId });
      if (!note) {
        return yield* new TeamStorageError({
          operation: "saveAutomaticNote",
          cause: new Error("The automatic note was not found after saving."),
        });
      }
      return note;
    }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure("saveAutomaticNote")));
  });

  return TeamService.of({
    ensureTeam,
    getTeam: selectTeam,
    listTeams: selectTeams,
    listMembers: selectMembers,
    findMemberByEnvironment: (teamId, environmentId) =>
      selectMembers(teamId).pipe(
        Effect.map((members) =>
          Option.fromNullishOr(members.find((member) => member.environmentId === environmentId)),
        ),
      ),
    claimPaths,
    releasePaths,
    listActiveClaims: selectActiveClaims,
    releaseThreadClaims,
    listClaimedThreads: (environmentId) =>
      sql`
        SELECT DISTINCT thread_id AS "threadId" FROM team_claims
        WHERE environment_id = ${environmentId} AND released_at IS NULL
        ORDER BY thread_id
      `.pipe(
        storage("listClaimedThreads"),
        Effect.flatMap(decodeRows(decodeClaimedThreadRows, "listClaimedThreads")),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      ),
    createTask,
    updateTask,
    getTask: (teamId, taskId) =>
      selectTasks(teamId, { taskId }).pipe(Effect.map((tasks) => Option.fromNullishOr(tasks[0]))),
    findTaskForThread: (teamId, thread) =>
      selectTasks(teamId, { thread }).pipe(
        Effect.map((tasks) => Option.fromNullishOr(tasks.at(-1))),
      ),
    listTasks: (teamId) => selectTasks(teamId),
    writeHandoff,
    saveAutomaticNote,
    listHandoffs: (teamId, options) => selectHandoffs(teamId, options),
    listActivity: (teamId, options) =>
      sql`
        SELECT activity_id AS "activityId", team_id AS "teamId", member_id AS "memberId",
          kind, summary, environment_id AS "environmentId", thread_id AS "threadId",
          created_at AS "createdAt"
        FROM team_activity
        WHERE team_id = ${teamId}
        -- rowid keeps insertion order for entries written in the same millisecond.
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${options?.limit ?? DEFAULT_LIST_LIMIT}
      `.pipe(
        storage("listActivity"),
        Effect.flatMap(decodeRows(decodeActivityRows, "listActivity")),
        Effect.map((rows) => rows.map(toActivity)),
      ),
  });
});

/** `withTransaction` adds `SqlError` for BEGIN/COMMIT; team errors raised inside pass through. */
const storageFailure = (operation: string) => (cause: SqlError.SqlError) =>
  Effect.fail(new TeamStorageError({ operation, cause }));

/** Needs the `SqlClient` from the SQLite persistence layer, and `Crypto`. */
export const layer = Layer.effect(TeamService, make);
