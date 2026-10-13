/**
 * Merging help, slice 1 (fork-only, team/MERGE_HELP_PLAN.md): whether each of
 * the person's chats would merge cleanly with a teammate's pushed branch, with
 * the base branch, and (own worktrees only) with another of their chats.
 * Git combines the two commits in its object store (`git merge-tree`); no
 * working copy is touched. The server checks on events and sends the result
 * in the team feed.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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

/**
 * "Fix it" (MERGE_HELP_PLAN.md section 5): a turn in the person's own chat
 * merges the other side and resolves the clash, without committing.
 * - `working`: the merge is in the chat's copy and its turn runs.
 * - `ready`: the turn ended; the person approves (commit, push if pushed) or undoes.
 */
export const TeamMergeFixStatus = Schema.Literals(["working", "ready"]);
export type TeamMergeFixStatus = typeof TeamMergeFixStatus.Type;

export const TeamMergeFix = Schema.Struct({
  projectId: ProjectId,
  mine: TeamMergeMine,
  other: TeamMergeOther,
  status: TeamMergeFixStatus,
  /** The files Git could not combine when the merge started, relative to the team's root. */
  files: Schema.Array(TeamPath),
  /** This chat's uncommitted work was committed first so Git could merge; Undo takes it back. */
  savedWork: Schema.Boolean,
  startedAt: IsoDateTime,
});
export type TeamMergeFix = typeof TeamMergeFix.Type;

export const TeamMerging = Schema.Struct({
  /** Why nothing is checked, e.g. Git is older than 2.38. */
  unavailable: Schema.optionalKey(TrimmedNonEmptyString),
  /** Clashes first. Pairs with nothing new on one side are left out. */
  pairs: Schema.Array(TeamMergePair),
  /** Fixes started with "Fix it" that wait for their turn or for the person. */
  fixes: Schema.optionalKey(Schema.Array(TeamMergeFix)),
});
export type TeamMerging = typeof TeamMerging.Type;

export const TEAM_MERGE_LIMITS = {
  /** Pairs in one team's view. */
  pairs: 30,
  /** Files listed per pair. */
  files: 10,
} as const;

/** What the person does with a clash: start a fix, then approve or undo it. */
export const TeamMergeFixInput = Schema.Union([
  Schema.TaggedStruct("start", {
    projectId: ProjectId,
    /** The pair's chat (its `mine` side). */
    threadId: ThreadId,
    other: TeamMergeOther,
  }),
  Schema.TaggedStruct("approve", { threadId: ThreadId }),
  Schema.TaggedStruct("undo", { threadId: ThreadId }),
]);
export type TeamMergeFixInput = typeof TeamMergeFixInput.Type;

export const TeamMergeFixResult = Schema.Struct({
  /** After approve: what happened to the push. */
  push: Schema.optionalKey(Schema.Literals(["pushed", "notPushed", "failed"])),
  /** A sentence for the person, e.g. why the push failed. */
  detail: Schema.optionalKey(Schema.String),
});
export type TeamMergeFixResult = typeof TeamMergeFixResult.Type;

export class TeamMergeFixError extends Schema.TaggedError<TeamMergeFixError>()(
  "TeamMergeFixError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
