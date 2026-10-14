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

/**
 * Merge order (MERGE_HELP_PLAN.md section 4): the rule that decided which
 * side to merge first. `earlier`: started earlier (a teammate's branch) or
 * finished first (two chats). `tie`: nothing told them apart.
 */
export const TeamMergeOrderReason = Schema.Literals([
  "pullRequestOpen",
  "checksGreen",
  "approved",
  "smaller",
  "earlier",
  "tie",
]);
export type TeamMergeOrderReason = typeof TeamMergeOrderReason.Type;

export const TeamMergeOrder = Schema.Struct({
  first: Schema.Literals(["mine", "other"]),
  reason: TeamMergeOrderReason,
});
export type TeamMergeOrder = typeof TeamMergeOrder.Type;

/**
 * Typecheck on the combined result (MERGE_HELP_PLAN.md section 2): one error
 * the combined result has and neither side has alone.
 */
export const TeamCombinedError = Schema.Struct({
  /** Relative to the team's root; absent when the output named no file. */
  path: Schema.optionalKey(TeamPath),
  line: Schema.optionalKey(NonNegativeInt),
  /** The tool's message, one line, capped. */
  message: Schema.String,
  /** A name the error says is missing, e.g. `getUser` in "Cannot find name 'getUser'". */
  name: Schema.optionalKey(Schema.String),
  /** The name the tool suggests instead ("Did you mean 'fetchUser'?"). */
  suggestion: Schema.optionalKey(Schema.String),
  /** Which side changed the file since they split. */
  side: Schema.Literals(["mine", "other", "both", "neither"]),
});
export type TeamCombinedError = typeof TeamCombinedError.Type;

/**
 * Why a combined check did not run (the person may update anyway):
 * - `memory`: less free memory than the floor.
 * - `busy`: another check is running on this server.
 * - `turnRunning`: an agent is working in this project.
 * - `noCommand`: no `## Check` command and none detected.
 * - `dependencies`: the dependencies changed and are installed only on "Check now".
 * - `timeout`: the check ran past its time limit and was stopped.
 * - `failed`: the check or the install could not run.
 */
export const TeamCombinedSkip = Schema.Literals([
  "memory",
  "busy",
  "turnRunning",
  "noCommand",
  "dependencies",
  "timeout",
  "failed",
]);
export type TeamCombinedSkip = typeof TeamCombinedSkip.Type;

/**
 * The project's check command run on the two sides combined, only on "Check
 * now" and once before an update. Its commits say which pair it was for.
 * - `running`: under way. `clean`: nothing new (errors either side already had
 *   are left out). `broken`: new errors. `skipped`: did not run, see `skip`.
 */
export const TeamCombinedCheck = Schema.Struct({
  mineCommit: TrimmedNonEmptyString,
  otherCommit: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "clean", "broken", "skipped"]),
  skip: Schema.optionalKey(TeamCombinedSkip),
  /** What ran, e.g. `npm run typecheck`. */
  command: Schema.optionalKey(Schema.String),
  /** New errors, capped. */
  errors: Schema.Array(TeamCombinedError),
  /** New errors in all. */
  errorCount: NonNegativeInt,
  checkedAt: IsoDateTime,
});
export type TeamCombinedCheck = typeof TeamCombinedCheck.Type;

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
  /** Which to merge first, for a clashing or overlapping pair with a teammate's branch or a chat. */
  order: Schema.optionalKey(TeamMergeOrder),
  /** The combined check for these two commits, when one ran or runs. */
  combined: Schema.optionalKey(TeamCombinedCheck),
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
 * - `asking`: the agent waits for the person's answer: a question during its
 *   turn, or the turn ended with conflict markers still in a file.
 * - `ready`: the turn ended; the person approves (commit, push if pushed) or undoes.
 */
export const TeamMergeFixStatus = Schema.Literals(["working", "asking", "ready"]);
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
  /**
   * The check command on the fix's result, run once its turn ended, when the
   * chat's copy has no dependencies installed (so the agent could not run it).
   */
  check: Schema.optionalKey(TeamCombinedCheck),
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
  /** New errors listed per combined check. */
  combinedErrors: 5,
} as const;

/**
 * What the person does with a pair: start a fix, then approve or undo it;
 * update a chat's copy (a merge of the other side into it) once that side is
 * first (the base after a merge, or the chat that finished first), after one
 * combined check; or run the combined check now.
 */
export const TeamMergeFixInput = Schema.Union([
  Schema.TaggedStruct("start", {
    projectId: ProjectId,
    /** The chat to fix: the pair's `mine` side, or for two chats either one. */
    threadId: ThreadId,
    other: TeamMergeOther,
  }),
  Schema.TaggedStruct("update", {
    projectId: ProjectId,
    /** The chat whose copy moves: the pair's `mine` side, or for two chats either one. */
    threadId: ThreadId,
    /** What it moves on top of: the base or another chat. */
    other: TeamMergeOther,
    /** Skip the combined check (it found new errors or could not run). */
    anyway: Schema.optionalKey(Schema.Boolean),
  }),
  /** "Check now": the combined check for this pair; the result arrives on the pair. */
  Schema.TaggedStruct("check", {
    projectId: ProjectId,
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
  /**
   * After update: moved; Git stopped on a conflict and nothing changed; or
   * `checked`: not moved, the combined check found new errors or could not
   * run (see the pair).
   */
  update: Schema.optionalKey(Schema.Literals(["updated", "conflict", "checked"])),
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
