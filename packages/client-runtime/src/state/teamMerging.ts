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
  TeamMergeFix,
  TeamMergeOther,
  TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";

import { claimPathInProject, type TeamHolder, teamMemberName } from "./teamMarkers.ts";

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

const memberName = teamMemberName;

const code = (text: string) => `\`${text}\``;

/** "Your "login" chat and Sara's `search` branch"; "Your chats "A" and "B"". */
export function mergePairSubject(
  team: TeamFeedTeam,
  pair: Pick<TeamMergePair, "mine" | "other">,
): string {
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
const fileList = (paths: ReadonlyArray<string>, total: number, pathPrefix: string) => {
  const shown = paths
    .slice(0, MAX_NAMED_FILES)
    .map((path) => code(mergePathInProject(path, pathPrefix)));
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
};

const paths = (files: ReadonlyArray<TeamMergeFile>) => files.map((file) => file.path);

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
      : ` Regenerate ${fileList(paths(regenerate), regenerate.length, pathPrefix)} after merging.`;
  switch (pair.status) {
    case "clean": {
      const now = pair.previous !== null && pair.previous !== "clean" ? " now" : "";
      return pair.bothChanged.length === 0
        ? `${subject} merge cleanly${now}.`
        : `${subject} both changed ${fileList(pair.bothChanged, pair.bothChanged.length, pathPrefix)} and merge cleanly${now}.`;
    }
    case "regenerate":
      return `${subject} both changed ${fileList(paths(regenerate), regenerate.length, pathPrefix)}: regenerate ${regenerate.length === 1 ? "it" : "them"} after merging.`;
    case "clash": {
      const only = clashes.length === 1 && clashCount === 1 ? clashes[0]! : undefined;
      const where =
        only !== undefined
          ? `${only.places > 1 ? `${only.places} places in ` : ""}${code(mergePathInProject(only.path, pathPrefix))}`
          : `${clashCount} files: ${fileList(paths(clashes), clashCount, pathPrefix)}`;
      return `${subject} clash in ${where}.${regenerateLine}`;
    }
  }
}

/**
 * The pairs worth a line, and the clean ones folded into one: a clean pair
 * gets its own line only when both sides changed the same file.
 */
export function foldMergePairs(pairs: ReadonlyArray<TeamMergePair>): {
  readonly shown: ReadonlyArray<TeamMergePair>;
  readonly folded: ReadonlyArray<TeamMergePair>;
} {
  const shown: Array<TeamMergePair> = [];
  const folded: Array<TeamMergePair> = [];
  for (const pair of pairs) {
    (pair.status === "clean" && pair.bothChanged.length === 0 ? folded : shown).push(pair);
  }
  return { shown, folded };
}

/** "4 other pairs merge cleanly"; without "other" when it is the only line. */
export function foldedMergeLine(count: number, alone: boolean): string {
  const other = alone ? "" : "other ";
  return count === 1 ? `1 ${other}pair merges cleanly` : `${count} ${other}pairs merge cleanly`;
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

/** The project's fixes started with "Fix it". */
export function projectMergeFixes(
  team: TeamFeedTeam,
  projectId: ProjectId | null,
): ReadonlyArray<TeamMergeFix> {
  if (projectId === null) return [];
  return (team.merging?.fixes ?? []).filter((fix) => fix.projectId === projectId);
}

const sameOther = (a: TeamMergeOther, b: TeamMergeOther) => {
  switch (a._tag) {
    case "chat":
      return b._tag === "chat" && a.thread.threadId === b.thread.threadId;
    case "branch":
      return b._tag === "branch" && a.memberId === b.memberId && a.branch === b.branch;
    case "base":
      return b._tag === "base" && a.branch === b.branch;
  }
};

/** Whether the fix is for this pair: its chat and the same other side. */
export const fixIsForPair = (fix: TeamMergeFix, pair: TeamMergePair) =>
  fix.mine.thread.threadId === pair.mine.thread.threadId && sameOther(fix.other, pair.other);

/**
 * Whether "Fix it" can start for the pair; otherwise why not. A fix runs in
 * the chat's own worktree, so the shared checkout is merged by hand.
 */
export function mergeFixBlocked(pair: TeamMergePair): string | null {
  if (pair.status === "clean") return "It merges cleanly.";
  if (!pair.mine.worktree) {
    return "This chat works in the shared checkout, where a merge would change every chat there. Merge it by hand.";
  }
  return null;
}

/** One line for a fix: what is being merged, and what the person does next. */
export function mergeFixSentence(
  team: TeamFeedTeam,
  fix: TeamMergeFix,
  pathPrefix: string,
): string {
  const subject = mergePairSubject(team, fix);
  const where =
    fix.files.length === 0 ? "" : ` in ${fileList(fix.files, fix.files.length, pathPrefix)}`;
  switch (fix.status) {
    case "working":
      return `${subject}: the agent is resolving the clash${where}.`;
    case "asking":
      return `${subject}: the agent is waiting for your answer about the clash${where}. Reply in the chat.`;
    case "ready":
      return `${subject}: the agent's fix${where} is ready. Read the diff in the chat, then approve or undo.`;
  }
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
