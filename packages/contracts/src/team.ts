/**
 * Team layer schemas (fork-only). A team is one Git repo, identified by the
 * `teamId` in the repo's checked-in `.team/team.json`; live state (members,
 * claims, tasks, handoffs, activity) lives in the host's `team_*` tables.
 * See team/DESIGN.md in this fork.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Folder at the project root that holds the team's checked-in files. */
export const TEAM_DIRECTORY_NAME = ".team";
/** Team identity file inside {@link TEAM_DIRECTORY_NAME}. */
export const TEAM_FILE_NAME = "team.json";
/** Project rules file inside {@link TEAM_DIRECTORY_NAME}. */
export const TEAM_RULEBOOK_FILE_NAME = "rulebook.md";
/** Hard cap on the rulebook, so agents can read all of it before their first change. */
export const TEAM_RULEBOOK_MAX_WORDS = 1_500;
/** Cap on a handoff note's text (changed + left + risks). */
export const TEAM_HANDOFF_MAX_WORDS = 150;
/** Folder inside {@link TEAM_DIRECTORY_NAME} that holds one Markdown file per decision. */
export const TEAM_DECISIONS_DIRECTORY_NAME = "decisions";

const teamEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const TeamId = teamEntityId("TeamId");
export type TeamId = typeof TeamId.Type;
export const TeamMemberId = teamEntityId("TeamMemberId");
export type TeamMemberId = typeof TeamMemberId.Type;
export const TeamClaimId = teamEntityId("TeamClaimId");
export type TeamClaimId = typeof TeamClaimId.Type;
export const TeamTaskId = teamEntityId("TeamTaskId");
export type TeamTaskId = typeof TeamTaskId.Type;
export const TeamHandoffId = teamEntityId("TeamHandoffId");
export type TeamHandoffId = typeof TeamHandoffId.Type;
export const TeamActivityId = teamEntityId("TeamActivityId");
export type TeamActivityId = typeof TeamActivityId.Type;

/** A repo-relative path to a file or folder, with `/` separators. */
export const TeamPath = TrimmedNonEmptyString;
export type TeamPath = typeof TeamPath.Type;

/** Contents of `.team/team.json`. Other keys are ignored so newer files still decode. */
export const TeamFile = Schema.Struct({
  teamId: TeamId,
  name: TrimmedNonEmptyString,
});
export type TeamFile = typeof TeamFile.Type;

export const Team = Schema.Struct({
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  /** `canonicalKey` of the repo when the team was created. A sanity check only (D2). */
  canonicalKey: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type Team = typeof Team.Type;

export const TeamMemberRole = Schema.Literals(["owner", "member"]);
export type TeamMemberRole = typeof TeamMemberRole.Type;

export const TeamMember = Schema.Struct({
  memberId: TeamMemberId,
  teamId: TeamId,
  displayName: TrimmedNonEmptyString,
  role: TeamMemberRole,
  /** The member's own T3 server. */
  environmentId: EnvironmentId,
  joinedAt: IsoDateTime,
});
export type TeamMember = typeof TeamMember.Type;

/** Thread ids belong to one environment, so a thread is always named by both. */
export const TeamThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type TeamThreadRef = typeof TeamThreadRef.Type;

export const TeamClaim = Schema.Struct({
  claimId: TeamClaimId,
  teamId: TeamId,
  memberId: TeamMemberId,
  thread: TeamThreadRef,
  paths: Schema.Array(TeamPath),
  note: Schema.NullOr(TrimmedNonEmptyString),
  claimedAt: IsoDateTime,
  /** Null while the claim is active. */
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type TeamClaim = typeof TeamClaim.Type;

/** Another thread's active claim that overlaps paths someone just claimed. */
export const TeamClaimOverlap = Schema.Struct({
  claim: TeamClaim,
  /** The overlapping paths as the other claim names them. */
  paths: Schema.Array(TeamPath),
});
export type TeamClaimOverlap = typeof TeamClaimOverlap.Type;

export const TeamTaskStatus = Schema.Literals(["todo", "in_progress", "in_review", "done"]);
export type TeamTaskStatus = typeof TeamTaskStatus.Type;

export const TeamTask = Schema.Struct({
  taskId: TeamTaskId,
  teamId: TeamId,
  title: TrimmedNonEmptyString,
  status: TeamTaskStatus,
  note: Schema.NullOr(TrimmedNonEmptyString),
  paths: Schema.Array(TeamPath),
  ownerMemberId: Schema.NullOr(TeamMemberId),
  /** The thread working on this card, once one starts. */
  thread: Schema.NullOr(TeamThreadRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamTask = typeof TeamTask.Type;

export const TeamHandoff = Schema.Struct({
  handoffId: TeamHandoffId,
  teamId: TeamId,
  memberId: TeamMemberId,
  thread: TeamThreadRef,
  taskId: Schema.NullOr(TeamTaskId),
  changed: TrimmedNonEmptyString,
  left: Schema.NullOr(TrimmedNonEmptyString),
  risks: Schema.NullOr(TrimmedNonEmptyString),
  /** Files the note is about, so freshness can be checked later (D7). */
  files: Schema.Array(TeamPath),
  /** Commit the note was written at. Null outside a Git checkout. */
  commit: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Git blob hash of each file when the note was written, null for a file
   * that did not exist. Freshness compares these, because the work is often
   * not committed yet (D7). Null for older notes; folders are left out.
   */
  fileHashes: Schema.NullOr(Schema.Record(TeamPath, Schema.NullOr(TrimmedNonEmptyString))),
  createdAt: IsoDateTime,
});
export type TeamHandoff = typeof TeamHandoff.Type;

export const TeamActivityKind = Schema.Literals([
  "team.created",
  "claim.added",
  "claim.released",
  "task.created",
  "task.updated",
  "handoff.written",
]);
export type TeamActivityKind = typeof TeamActivityKind.Type;

export const TeamActivity = Schema.Struct({
  activityId: TeamActivityId,
  teamId: TeamId,
  memberId: Schema.NullOr(TeamMemberId),
  kind: TeamActivityKind,
  summary: TrimmedNonEmptyString,
  thread: Schema.NullOr(TeamThreadRef),
  createdAt: IsoDateTime,
});
export type TeamActivity = typeof TeamActivity.Type;

/** Word count used for the rulebook and handoff caps. */
export function countTeamWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Normalizes a claimed path to repo-relative `/` form: backslashes become `/`,
 * and leading `./`, leading `/` and trailing `/` are dropped. Empty means the
 * whole repo.
 */
export function normalizeTeamPath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

/** True when two claimed paths are the same, or one is a folder containing the other. */
export function teamPathsOverlap(left: string, right: string): boolean {
  const a = normalizeTeamPath(left);
  const b = normalizeTeamPath(right);
  if (a === "" || b === "") return true;
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}
