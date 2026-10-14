/**
 * Merging help in words (fork-only, team/MERGE_HELP_PLAN.md slice 1): the
 * server's merge checks as sentences and file marks, the same on web and
 * mobile. Lockfiles and generated files are worded "regenerate after
 * merging", never "clash".
 */
import type {
  EnvironmentId,
  ProjectId,
  TeamCombinedCheck,
  TeamCombinedError,
  TeamCombinedSkip,
  TeamFeedTeam,
  TeamMergeFile,
  TeamMergeFix,
  TeamMergeOrderReason,
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

/** Whether the pair's combined check has news: it runs, found new errors, or could not run. */
const combinedNews = (pair: TeamMergePair) =>
  pair.combined !== undefined && pair.combined.status !== "clean";

/**
 * The pairs worth a line, and the clean ones folded into one: a clean pair
 * gets its own line only when both sides changed the same file, or its
 * combined check has news.
 */
export function foldMergePairs(pairs: ReadonlyArray<TeamMergePair>): {
  readonly shown: ReadonlyArray<TeamMergePair>;
  readonly folded: ReadonlyArray<TeamMergePair>;
} {
  const shown: Array<TeamMergePair> = [];
  const folded: Array<TeamMergePair> = [];
  for (const pair of pairs) {
    (pair.status === "clean" && pair.bothChanged.length === 0 && !combinedNews(pair)
      ? folded
      : shown
    ).push(pair);
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

/** Whether the fix is for this pair: its chat and the same other side; two chats either way round. */
export const fixIsForPair = (fix: TeamMergeFix, pair: TeamMergePair) =>
  (fix.mine.thread.threadId === pair.mine.thread.threadId && sameOther(fix.other, pair.other)) ||
  (pair.other._tag === "chat" &&
    fix.other._tag === "chat" &&
    fix.mine.thread.threadId === pair.other.thread.threadId &&
    fix.other.thread.threadId === pair.mine.thread.threadId);

/**
 * Whether "Fix it" can start for the pair; otherwise why not. A fix runs in
 * the chat's own worktree, so the shared checkout is merged by hand.
 */
export function mergeFixBlocked(pair: TeamMergePair): string | null {
  if (pair.status === "clean" && pair.combined?.status !== "broken") return "It merges cleanly.";
  if (!pair.mine.worktree) {
    return "This chat works in the shared checkout, where a merge would change every chat there. Merge it by hand.";
  }
  return null;
}

const ORDER_REASONS: Record<Exclude<TeamMergeOrderReason, "tie" | "earlier">, string> = {
  pullRequestOpen: "it has an open pull request",
  checksGreen: "its checks are green",
  approved: "it is approved and mergeable",
  smaller: "its change is smaller",
};

/**
 * The suggested merge order (MERGE_HELP_PLAN.md section 4): "Merge Sara's
 * `search` branch first; its checks are green." Null when the pair has none.
 */
export function mergeOrderSentence(team: TeamFeedTeam, pair: TeamMergePair): string | null {
  const order = pair.order;
  if (order === undefined) return null;
  const other = pair.other;
  const first =
    order.first === "mine"
      ? other._tag === "chat"
        ? `"${pair.mine.title}"`
        : `your "${pair.mine.title}" chat`
      : other._tag === "chat"
        ? `"${other.title}"`
        : other._tag === "branch"
          ? `${memberName(team, other.memberId)}'s ${code(other.branch)} branch`
          : code(other.branch);
  const reason =
    order.reason === "tie"
      ? null
      : order.reason === "earlier"
        ? other._tag === "chat"
          ? "it finished first"
          : "it started earlier"
        : ORDER_REASONS[order.reason];
  return `Merge ${first} first${reason === null ? "" : `; ${reason}`}.`;
}

/** "Update my copy": which chat moves on top of what, the button's words, and why not when it cannot. */
export interface MergeUpdateOffer {
  readonly threadId: ThreadId;
  readonly other: TeamMergeOther;
  readonly label: string;
  readonly blocked: string | null;
  /** The combined check found new errors or could not run: update without it. */
  readonly anyway: boolean;
}

/**
 * Whether the other side can be merged into a chat's copy, once that side
 * is first and they overlap without a clash:
 * - the base, after it took in work that touches this chat's files ("Update my copy");
 * - two chats: the one to merge second takes in the first.
 * A teammate's branch is merged first, then the base pair offers the update.
 */
export function mergeUpdateOffer(pair: TeamMergePair): MergeUpdateOffer | null {
  const offer = updateOfferOf(pair);
  if (offer === null) return null;
  const status = pair.combined?.status;
  return status === "broken" || status === "skipped"
    ? { ...offer, label: "Update anyway", anyway: true }
    : { ...offer, anyway: false };
}

function updateOfferOf(pair: TeamMergePair): Omit<MergeUpdateOffer, "anyway"> | null {
  if (pair.status !== "clean" || pair.bothChanged.length === 0) return null;
  const other = pair.other;
  if (other._tag === "base") {
    return {
      threadId: pair.mine.thread.threadId,
      other,
      label: "Update my copy",
      blocked: pair.mine.worktree
        ? null
        : "This chat works in the shared checkout, where an update would move every chat there. Update it by hand.",
    };
  }
  if (other._tag !== "chat" || pair.order === undefined) return null;
  return pair.order.first === "mine"
    ? {
        threadId: other.thread.threadId,
        other: {
          _tag: "chat",
          thread: pair.mine.thread,
          title: pair.mine.title,
          commit: pair.mine.commit,
        },
        label: `Update "${other.title}" on top of "${pair.mine.title}"`,
        blocked: null,
      }
    : {
        threadId: pair.mine.thread.threadId,
        other,
        label: `Update "${pair.mine.title}" on top of "${other.title}"`,
        blocked: null,
      };
}

/** "Check now" runs the combined check on a pair Git merges cleanly, unless one runs for it. */
export const combinedCheckOffered = (pair: TeamMergePair) =>
  pair.status === "clean" && pair.combined?.status !== "running";

const SKIP_WORDS: Record<TeamCombinedSkip, string> = {
  memory: "less than 1.5 GB of memory is free",
  busy: "another check is running",
  turnRunning: "an agent is working in this project",
  noCommand: "no check command was found (add one under `## Check` in `.team/rulebook.md`)",
  dependencies: "its dependencies changed; Check now installs them",
  timeout: "it ran longer than 10 minutes and was stopped",
  failed: "the check could not run",
};

/** "Sara's `search` branch", "`main`", "the chat "B"". */
const otherName = (team: TeamFeedTeam, other: TeamMergeOther) => {
  switch (other._tag) {
    case "chat":
      return `the chat "${other.title}"`;
    case "branch":
      return `${memberName(team, other.memberId)}'s ${code(other.branch)} branch`;
    case "base":
      return code(other.branch);
  }
};

/** Whose change the file is: "(yours)", "(Sara's)", "(changed on `main`)". */
const ownerWords = (
  team: TeamFeedTeam,
  pair: Pick<TeamMergePair, "mine" | "other">,
  side: TeamCombinedError["side"],
) => {
  switch (side) {
    case "mine":
      return pair.other._tag === "chat" ? ` (in "${pair.mine.title}")` : " (yours)";
    case "other":
      return pair.other._tag === "branch"
        ? ` (${memberName(team, pair.other.memberId)}'s)`
        : pair.other._tag === "base"
          ? ` (changed on ${code(pair.other.branch)})`
          : ` (in "${pair.other.title}")`;
    case "both":
      return " (both changed it)";
    case "neither":
      return "";
  }
};

const errorWords = (
  team: TeamFeedTeam,
  pair: Pick<TeamMergePair, "mine" | "other">,
  error: TeamCombinedError,
  pathPrefix: string,
) => {
  const where = error.path === undefined ? "" : code(mergePathInProject(error.path, pathPrefix));
  const owner = ownerWords(team, pair, error.side);
  if (error.name !== undefined && where !== "") {
    return error.suggestion === undefined
      ? `${code(error.name)} is gone but still used in ${where}${owner}`
      : `${code(error.name)} is renamed (to ${code(error.suggestion)}?) but still used in ${where}${owner}`;
  }
  // The sentence adds its own full stop.
  const message = error.message.replace(/\.+$/u, "");
  return where === "" ? `a new error: ${message}` : `a new error in ${where}${owner}: ${message}`;
};

/** A check's line, after `lead`: "Combined with `main`" or "On the fix". */
function checkLine(
  team: TeamFeedTeam,
  sides: Pick<TeamMergePair, "mine" | "other">,
  check: TeamCombinedCheck,
  lead: string,
  pathPrefix: string,
): string {
  const command = check.command === undefined ? "the check" : code(check.command);
  switch (check.status) {
    case "running":
      // The command is known only once the combined result is in the copy.
      return check.command === undefined
        ? `${lead}: checking…`
        : `${lead}: checking with ${command}…`;
    case "clean":
      return `${lead}, ${command} finds nothing new.`;
    case "skipped":
      return `${lead}: not checked, ${SKIP_WORDS[check.skip ?? "failed"]}.`;
    case "broken": {
      const [first] = check.errors;
      if (first === undefined) return `${lead}, ${command} fails.`;
      const more = check.errorCount - 1;
      return `${lead}, ${errorWords(team, sides, first, pathPrefix)}.${
        more > 0 ? ` And ${more} more new ${more === 1 ? "error" : "errors"}.` : ""
      }`;
    }
  }
}

/**
 * The combined check's line (MERGE_HELP_PLAN.md section 2): "Combined with
 * Sara's `search` branch, `getUser` is renamed (to `fetchUser`?) but still
 * used in `src/api/me.ts` (yours)." Null when none ran for these commits.
 */
export function combinedSentence(
  team: TeamFeedTeam,
  pair: TeamMergePair,
  pathPrefix: string,
): string | null {
  return pair.combined === undefined
    ? null
    : checkLine(
        team,
        pair,
        pair.combined,
        `Combined with ${otherName(team, pair.other)}`,
        pathPrefix,
      );
}

/**
 * The check on a fix's result, run because the agent could not run it in the
 * chat's copy: "On the fix, `npm run typecheck` finds nothing new." Null when
 * none ran.
 */
export function fixCheckSentence(
  team: TeamFeedTeam,
  fix: TeamMergeFix,
  pathPrefix: string,
): string | null {
  return fix.check === undefined ? null : checkLine(team, fix, fix.check, "On the fix", pathPrefix);
}

/** A pair whose update stopped on a conflict: said instead of "merge cleanly". */
export function mergeUpdateStoppedSentence(
  team: TeamFeedTeam,
  pair: Pick<TeamMergePair, "mine" | "other">,
): string {
  return `${mergePairSubject(team, pair)}: the update stopped on a conflict, so nothing changed. Fix it lets the agent resolve it.`;
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
