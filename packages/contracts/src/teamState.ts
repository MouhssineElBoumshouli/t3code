/**
 * Team state on Git, format 1 (fork-only, see team/STORAGE_PLAN.md 3.2). The
 * hidden ref {@link TEAM_STATE_REF} in the project's own repo holds
 * `team.json` and one writer file per (GitHub login, T3 server) under
 * `writers/<login>/<environmentId>.json`. Each server writes only its own
 * writer file, so pushes never conflict.
 *
 * Readers ignore fields they do not know, so an older app still reads a
 * newer file. Changing what an existing field means needs a new format.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  TeamActivityId,
  TeamActivityKind,
  TeamClaimId,
  TeamHandoffId,
  TeamId,
  TeamPath,
  TeamTaskId,
  TeamTaskStatus,
  TeamThreadRef,
} from "./team.ts";

/** The hidden ref that holds the team state. Default fetches and branch lists never show it. */
export const TEAM_STATE_REF = "refs/t3-team/state";
/** The format this app writes. */
export const TEAM_STATE_FORMAT = 1;
/** Team identity at the root of the state tree. */
export const TEAM_STATE_TEAM_FILE = "team.json";
/** Folder of the state tree that holds the writer files. */
export const TEAM_STATE_WRITERS_DIRECTORY = "writers";
/** Caps on one writer file (STORAGE_PLAN.md 3.2). */
export const TEAM_STATE_LIMITS = {
  /** Active claims first, then the newest released ones. */
  claims: 200,
  /** Released claims are kept this long, so activity can still name them. */
  releasedClaimDays: 7,
  notes: 200,
  activity: 100,
} as const;

/**
 * A GitHub login. It names a folder of the state tree, so the pattern also
 * keeps it a safe path segment.
 */
export const TeamLogin = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u),
);
export type TeamLogin = typeof TeamLogin.Type;

const TeamStateFormat = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** `team.json` on the state ref. */
export const TeamStateTeamFile = Schema.Struct({
  format: TeamStateFormat,
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  createdBy: TeamLogin,
  createdAt: IsoDateTime,
});
export type TeamStateTeamFile = typeof TeamStateTeamFile.Type;

/** A claim in its writer's file. The writer is the claimer. */
export const TeamStateClaim = Schema.Struct({
  claimId: TeamClaimId,
  thread: TeamThreadRef,
  paths: Schema.Array(TeamPath),
  note: Schema.NullOr(TrimmedNonEmptyString),
  /** The thread's branch, when known, so readers can tell when it merged (STORAGE_PLAN.md 4.5). */
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  claimedAt: IsoDateTime,
  /** Null while the claim is active. */
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type TeamStateClaim = typeof TeamStateClaim.Type;

/**
 * This writer's latest version of a task it created or changed. Readers keep
 * the version with the newest `updatedAt` across all writers.
 */
export const TeamStateTask = Schema.Struct({
  taskId: TeamTaskId,
  title: TrimmedNonEmptyString,
  status: TeamTaskStatus,
  note: Schema.NullOr(TrimmedNonEmptyString),
  paths: Schema.Array(TeamPath),
  /** The owner's login. */
  owner: Schema.NullOr(TeamLogin),
  thread: Schema.NullOr(TeamThreadRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamStateTask = typeof TeamStateTask.Type;

/** A handoff or automatic note this writer saved. Same fields as `TeamHandoff`. */
export const TeamStateNote = Schema.Struct({
  handoffId: TeamHandoffId,
  thread: TeamThreadRef,
  taskId: Schema.NullOr(TeamTaskId),
  changed: TrimmedNonEmptyString,
  left: Schema.NullOr(TrimmedNonEmptyString),
  risks: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(TeamPath),
  commit: Schema.NullOr(TrimmedNonEmptyString),
  fileHashes: Schema.NullOr(Schema.Record(TeamPath, Schema.NullOr(TrimmedNonEmptyString))),
  automatic: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type TeamStateNote = typeof TeamStateNote.Type;

export const TeamStateActivity = Schema.Struct({
  activityId: TeamActivityId,
  kind: TeamActivityKind,
  summary: TrimmedNonEmptyString,
  thread: Schema.NullOr(TeamThreadRef),
  createdAt: IsoDateTime,
});
export type TeamStateActivity = typeof TeamStateActivity.Type;

/** `writers/<login>/<environmentId>.json`: everything one T3 server wrote. */
export const TeamWriterFile = Schema.Struct({
  format: TeamStateFormat,
  login: TeamLogin,
  displayName: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  lastSyncAt: IsoDateTime,
  claims: Schema.Array(TeamStateClaim),
  tasks: Schema.Array(TeamStateTask),
  notes: Schema.Array(TeamStateNote),
  activity: Schema.Array(TeamStateActivity),
});
export type TeamWriterFile = typeof TeamWriterFile.Type;
