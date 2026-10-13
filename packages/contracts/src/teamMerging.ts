/**
 * Merging help, slice 1 (fork-only, team/MERGE_HELP_PLAN.md): whether each of
 * the person's chats would merge cleanly with a teammate's pushed branch, with
 * the base branch, and (own worktrees only) with another of their chats.
 * Git combines the two commits in its object store (`git merge-tree`); no
 * working copy is touched. The server checks on events and sends the result
 * in the team feed.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamMemberId, TeamPath, TeamThreadRef } from "./team.ts";

/**
 * - `clean`: Git merges the two.
 * - `regenerate`: they conflict only in lockfiles or generated files.
 * - `clash`: they conflict in at least one other file.
 */
export const TeamMergeStatus = Schema.Literals(["clean", "regenerate", "clash"]);
export type TeamMergeStatus = typeof TeamMergeStatus.Type;

export const TeamMergeFile = Schema.Struct({
  /** Relative to the team's root, like claim paths. */
  path: TeamPath,
  /** Conflicting places (marker blocks); 0 when the file has none, e.g. deleted on one side. */
  places: NonNegativeInt,
  /** A lockfile or generated file: regenerate it after merging. */
  regenerate: Schema.Boolean,
});
export type TeamMergeFile = typeof TeamMergeFile.Type;

/** One of the person's chats: its latest checkpoint, uncommitted edits included. */
export const TeamMergeMine = Schema.Struct({
  thread: TeamThreadRef,
  title: Schema.String,
  /** False for the shared checkout, which is one side for all its chats (the newest one is named). */
  worktree: Schema.Boolean,
  commit: TrimmedNonEmptyString,
});
export type TeamMergeMine = typeof TeamMergeMine.Type;

export const TeamMergeOther = Schema.Union([
  /** Another of the person's chats with its own worktree. */
  Schema.TaggedStruct("chat", {
    thread: TeamThreadRef,
    title: Schema.String,
    commit: TrimmedNonEmptyString,
  }),
  /** A teammate's pushed branch, as their claim names it. */
  Schema.TaggedStruct("branch", {
    memberId: TeamMemberId,
    branch: TrimmedNonEmptyString,
    commit: TrimmedNonEmptyString,
  }),
  /** The remote's base branch. */
  Schema.TaggedStruct("base", {
    branch: TrimmedNonEmptyString,
    commit: TrimmedNonEmptyString,
  }),
]);
export type TeamMergeOther = typeof TeamMergeOther.Type;

export const TeamMergePair = Schema.Struct({
  projectId: ProjectId,
  mine: TeamMergeMine,
  other: TeamMergeOther,
  status: TeamMergeStatus,
  /** Conflicting files, clashes first, capped. */
  files: Schema.Array(TeamMergeFile),
  /** Conflicting files in all. */
  fileCount: NonNegativeInt,
  /** A clean pair: files both sides changed, which Git merged; capped. Empty otherwise. */
  bothChanged: Schema.Array(TeamPath),
  /** The status before the last change of state; null when first seen. */
  previous: Schema.NullOr(TeamMergeStatus),
  /** When this status began: the newer side's commit time. */
  since: IsoDateTime,
  checkedAt: IsoDateTime,
});
export type TeamMergePair = typeof TeamMergePair.Type;

export const TeamMerging = Schema.Struct({
  /** Why nothing is checked, e.g. Git is older than 2.38. */
  unavailable: Schema.optionalKey(TrimmedNonEmptyString),
  /** Clashes first. Pairs with nothing new on one side are left out. */
  pairs: Schema.Array(TeamMergePair),
});
export type TeamMerging = typeof TeamMerging.Type;

export const TEAM_MERGE_LIMITS = {
  /** Pairs in one team's view. */
  pairs: 30,
  /** Files listed per pair. */
  files: 10,
} as const;
