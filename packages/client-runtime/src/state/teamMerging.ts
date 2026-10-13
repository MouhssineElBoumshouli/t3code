/**
 * Merging help in words (fork-only, team/MERGE_HELP_PLAN.md slice 1): the
 * server's merge checks as sentences and file marks, the same on web and
 * mobile. Lockfiles and generated files are worded "regenerate after
 * merging", never "clash".
 */
import type {
  EnvironmentId,
  ProjectId,
  TeamFeedTeam,
  TeamMergeFile,
  TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";

import { claimPathInProject, type TeamHolder } from "./teamMarkers.ts";

const MAX_NAMED_FILES = 2;

/** The project's pairs, as the server ordered them (clashes first). */
export function projectMergePairs(
  team: TeamFeedTeam,
  projectId: ProjectId | null,
): ReadonlyArray<TeamMergePair> {
  if (projectId === null) return [];
  return (team.merging?.pairs ?? []).filter((pair) => pair.projectId === projectId);
}

/** A team path as the project names it, case kept; the team path when outside the project. */
export function mergePathInProject(path: string, pathPrefix: string): string {
  const inProject = claimPathInProject(path, pathPrefix);
  if (inProject === null || inProject === "") return path;
  return path.slice(path.length - inProject.length);
}

const memberName = (team: TeamFeedTeam, memberId: string) =>
  team.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;

const code = (text: string) => `\`${text}\``;

/** "Your "login" chat and Sara's `search` branch"; "Your chats "A" and "B"". */
export function mergePairSubject(team: TeamFeedTeam, pair: TeamMergePair): string {
  const mine = `"${pair.mine.title}"`;
  switch (pair.other._tag) {
    case "chat":
      return `Your chats ${mine} and "${pair.other.title}"`;
    case "branch":
      return `Your ${mine} chat and ${memberName(team, pair.other.memberId)}'s ${code(pair.other.branch)} branch`;
    case "base":
      return `Your ${mine} chat and ${code(pair.other.branch)}`;
  }
}

/** "`a.ts`", "`a.ts` and `b.ts`", "`a.ts`, `b.ts` and 3 more". */
const fileList = (files: ReadonlyArray<TeamMergeFile>, total: number, pathPrefix: string) => {
  const shown = files
    .slice(0, MAX_NAMED_FILES)
    .map((file) => code(mergePathInProject(file.path, pathPrefix)));
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
};

/** One line for a pair: what clashes and where, what to regenerate, or that it merges cleanly. */
export function mergePairSentence(
  team: TeamFeedTeam,
  pair: TeamMergePair,
  pathPrefix: string,
): string {
  const subject = mergePairSubject(team, pair);
  const clashes = pair.files.filter((file) => !file.regenerate);
  const regenerate = pair.files.filter((file) => file.regenerate);
  // Files past the list's cap are counted as clashes.
  const clashCount = pair.fileCount - regenerate.length;
  const regenerateLine =
    regenerate.length === 0
      ? ""
      : ` Regenerate ${fileList(regenerate, regenerate.length, pathPrefix)} after merging.`;
  switch (pair.status) {
    case "clean":
      return `${subject} merge cleanly${pair.previous !== null && pair.previous !== "clean" ? " now" : ""}.`;
    case "regenerate":
      return `${subject} both changed ${fileList(regenerate, regenerate.length, pathPrefix)}: regenerate ${regenerate.length === 1 ? "it" : "them"} after merging.`;
    case "clash": {
      const only = clashes.length === 1 && clashCount === 1 ? clashes[0]! : undefined;
      const where =
        only !== undefined
          ? `${only.places > 1 ? `${only.places} places in ` : ""}${code(mergePathInProject(only.path, pathPrefix))}`
          : `${clashCount} files: ${fileList(clashes, clashCount, pathPrefix)}`;
      return `${subject} clash in ${where}.${regenerateLine}`;
    }
  }
}

/**
 * Whether a teammate pushed again since the pair was checked (a check is due).
 * Null when the pair is current or is not a teammate's branch.
 */
export function mergePairPending(team: TeamFeedTeam, pair: TeamMergePair): string | null {
  const other = pair.other;
  if (other._tag !== "branch") return null;
  const newer = team.claims.some(
    (claim) =>
      claim.memberId === other.memberId &&
      claim.branch === other.branch &&
      claim.pushedCommit !== undefined &&
      claim.pushedCommit !== other.commit,
  );
  return newer ? `${memberName(team, other.memberId)} pushed since; checking…` : null;
}

export interface MergeViewer {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The chat works in the shared checkout (no worktree of its own). */
  readonly sharedCheckout: boolean;
}

const sameThread = (
  a: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  b: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
) => a.environmentId === b.environmentId && a.threadId === b.threadId;

/** The pairs one chat is in; every pair when no chat is open. */
export function viewerMergePairs(
  pairs: ReadonlyArray<TeamMergePair>,
  viewer: MergeViewer | null,
): ReadonlyArray<TeamMergePair> {
  if (viewer === null) return pairs;
  return pairs.filter(
    (pair) =>
      sameThread(pair.mine.thread, viewer) ||
      (!pair.mine.worktree && viewer.sharedCheckout) ||
      (pair.other._tag === "chat" && sameThread(pair.other.thread, viewer)),
  );
}

export interface FileMergeMark {
  /** Pairs that clash in this file, with the file. */
  readonly clashes: ReadonlyArray<{ readonly pair: TeamMergePair; readonly file: TeamMergeFile }>;
  /** Clean pairs with someone who holds this file: their mark can be quiet. */
  readonly clean: ReadonlyArray<TeamMergePair>;
}

/** What the merge checks say about one file of the project, for the file tree. */
export function fileMergeMark(input: {
  readonly pairs: ReadonlyArray<TeamMergePair>;
  readonly pathPrefix: string;
  readonly path: string;
  /** Who else holds the file (`fileHolders`). */
  readonly holders: ReadonlyArray<TeamHolder>;
}): FileMergeMark | null {
  const target = input.path.replace(/\/+$/u, "").toLowerCase();
  const clashes = input.pairs.flatMap((pair) =>
    pair.files.flatMap((file) =>
      claimPathInProject(file.path, input.pathPrefix) === target ? [{ pair, file }] : [],
    ),
  );
  const clean = input.pairs.filter(
    (pair) =>
      pair.status === "clean" &&
      input.holders.some((holder) =>
        holder.kind === "member"
          ? pair.other._tag === "branch" && pair.other.memberId === holder.memberId
          : (pair.other._tag === "chat" && sameThread(pair.other.thread, holder)) ||
            sameThread(pair.mine.thread, holder),
      ),
  );
  return clashes.length === 0 && clean.length === 0 ? null : { clashes, clean };
}

/** Merge news since the last visit: new warnings, and warnings that ended. */
export function mergeCatchUpSentences(input: {
  readonly team: TeamFeedTeam;
  readonly projectId: ProjectId;
  readonly pathPrefix: string;
  readonly sinceMs: number;
}): ReadonlyArray<string> {
  const news = projectMergePairs(input.team, input.projectId).filter(
    (pair) =>
      Date.parse(pair.since) > input.sinceMs &&
      (pair.status !== "clean" || (pair.previous !== null && pair.previous !== "clean")),
  );
  const sentences = news
    .slice(0, MAX_NAMED_FILES)
    .map((pair) => mergePairSentence(input.team, pair, input.pathPrefix));
  if (news.length > MAX_NAMED_FILES) {
    const more = news.length - MAX_NAMED_FILES;
    sentences.push(`${more} more merge ${more === 1 ? "change" : "changes"}.`);
  }
  return sentences;
}
