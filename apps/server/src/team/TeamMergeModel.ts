/**
 * The pure part of merging help (fork-only, team/MERGE_HELP_PLAN.md slice 1):
 * how a fresh merge-tree result becomes a pair the feed shows, and what counts
 * as a change of state.
 *
 * - A pair keeps its record while both commits stay the same; nothing is checked twice.
 * - Only a change of status (clean, regenerate, clash) moves `since` and `previous`.
 * - A clean pair where one side already holds the other has nothing to say and
 *   is hidden, except right after a clash ended, so the person sees it ended.
 *
 * @module TeamMergeModel
 */
import {
  TEAM_MERGE_LIMITS,
  type TeamMergeMine,
  type TeamMergeOther,
  type TeamMergePair,
  type TeamMergeStatus,
  type TeamMerging,
  type ProjectId,
} from "@t3tools/contracts";

import { mergeStatusOf, type MergeTreeResult } from "./mergeTree.ts";

export interface PairSides {
  readonly projectId: ProjectId;
  readonly mine: TeamMergeMine;
  readonly other: TeamMergeOther;
  readonly mineTree: string;
  readonly otherTree: string;
  /** The newer of the two commits' times, ISO. */
  readonly newerCommitAt: string;
}

export interface CheckedPair {
  readonly pair: TeamMergePair;
  /** False when the pair has nothing to say (one side already holds the other). */
  readonly shown: boolean;
}

/** Results are cached by the two commits, in this order. */
export const commitPairKey = (mine: string, other: string) => `${mine}|${other}`;

/** A pair's identity across commits: which chat (or the shared checkout) and what it is merged with. */
export const pairKey = (projectId: ProjectId, mine: TeamMergeMine, other: TeamMergeOther) => {
  const ours = mine.worktree ? `chat:${mine.thread.threadId}` : "checkout";
  const theirs =
    other._tag === "chat"
      ? `chat:${other.thread.threadId}`
      : other._tag === "branch"
        ? `branch:${other.memberId}/${other.branch}`
        : `base:${other.branch}`;
  return `${projectId}|${ours}|${theirs}`;
};

/** Whether the pair's status differs from what was known before (a first sighting counts). */
export const isChangeOfState = (previous: CheckedPair | undefined, status: TeamMergeStatus) =>
  previous === undefined || previous.pair.status !== status;

/**
 * The pair after a check. `toTeamPath` turns a repo path into a team path, or
 * undefined when the file is outside the team's folder.
 */
export function nextPair(input: {
  readonly previous: CheckedPair | undefined;
  readonly sides: PairSides;
  readonly result: MergeTreeResult;
  readonly toTeamPath: (repoPath: string) => string | undefined;
  readonly now: string;
}): CheckedPair {
  const { previous, sides, result } = input;
  if (
    previous !== undefined &&
    previous.pair.mine.commit === sides.mine.commit &&
    previous.pair.other.commit === sides.other.commit
  ) {
    // Same commits: same result. Titles may have changed.
    return { ...previous, pair: { ...previous.pair, mine: sides.mine, other: sides.other } };
  }
  const status = mergeStatusOf(result.conflicts);
  const changed = isChangeOfState(previous, status);
  const holdsTheOther =
    status === "clean" && (result.tree === sides.mineTree || result.tree === sides.otherTree);
  const endedAClash = changed && previous !== undefined && previous.pair.status !== "clean";
  const files = result.conflicts.flatMap((conflict) => {
    const path = input.toTeamPath(conflict.path);
    return path === undefined
      ? []
      : [{ path, places: conflict.places, regenerate: conflict.regenerate }];
  });
  const bothChanged = result.bothChanged.flatMap((repoPath) => {
    const path = input.toTeamPath(repoPath);
    return path === undefined ? [] : [path];
  });
  return {
    shown: !holdsTheOther || endedAClash,
    pair: {
      projectId: sides.projectId,
      mine: sides.mine,
      other: sides.other,
      status,
      files: files.slice(0, TEAM_MERGE_LIMITS.files),
      fileCount: result.conflicts.length,
      bothChanged: bothChanged.slice(0, TEAM_MERGE_LIMITS.files),
      previous: changed ? (previous?.pair.status ?? null) : previous!.pair.previous,
      since: changed ? sides.newerCommitAt : previous!.pair.since,
      checkedAt: input.now,
    },
  };
}

/**
 * The clashes a chat's turn note has not told yet, marked told in `told`
 * (`<pair>|<since>`, so a clash that ended and came back is told again). A
 * chat is in a pair as its own side, as the other chat, or, in the shared
 * checkout, through the checkout's side.
 */
export function newClashes(input: {
  readonly pairs: ReadonlyMap<string, CheckedPair>;
  readonly threadId: string;
  readonly sharedCheckout: boolean;
  readonly told: Set<string>;
}): ReadonlyArray<TeamMergePair> {
  const fresh: Array<TeamMergePair> = [];
  for (const [key, { pair, shown }] of input.pairs) {
    if (pair.status !== "clash" || !shown) continue;
    const involved =
      (pair.mine.worktree ? pair.mine.thread.threadId === input.threadId : input.sharedCheckout) ||
      (pair.other._tag === "chat" && pair.other.thread.threadId === input.threadId);
    const id = `${key}|${pair.since}`;
    if (!involved || input.told.has(id)) continue;
    input.told.add(id);
    fresh.push(pair);
  }
  return fresh;
}

const CLASH_LINE_FILES = 2;

/** "Sara's pushed branch `search`", "`main`", "the chat "B"", seen from `threadId`'s chat. */
const otherSideOf = (
  pair: TeamMergePair,
  threadId: string,
  nameOf: (memberId: string) => string,
) => {
  if (pair.other._tag === "chat" && pair.other.thread.threadId === threadId) {
    return `the chat "${pair.mine.title}"`;
  }
  switch (pair.other._tag) {
    case "chat":
      return `the chat "${pair.other.title}"`;
    case "branch":
      return `${nameOf(pair.other.memberId)}'s pushed branch \`${pair.other.branch}\``;
    case "base":
      return `\`${pair.other.branch}\``;
  }
};

/** The turn note's line for new clashes: what clashes, where, and that the person can fix it. */
export function clashLine(input: {
  readonly pairs: ReadonlyArray<TeamMergePair>;
  readonly threadId: string;
  readonly nameOf: (memberId: string) => string;
  readonly solo: boolean;
}): string {
  const where = (pair: TeamMergePair) => {
    const regenerate = pair.files.filter((file) => file.regenerate).length;
    const named = pair.files
      .filter((file) => !file.regenerate)
      .slice(0, CLASH_LINE_FILES)
      .map((file) => `\`${file.path}\``);
    const more = pair.fileCount - regenerate - named.length;
    return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(" and ");
  };
  const clashes = input.pairs
    .map((pair) => `${otherSideOf(pair, input.threadId, input.nameOf)} in ${where(pair)}`)
    .join("; and with ");
  return `<team_merge>Merge check: this chat's work clashes with ${clashes}. Tell the user; they can choose "Fix it" on ${input.solo ? "Today" : "Team home"}.</team_merge>`;
}

const STATUS_ORDER: Record<TeamMergeStatus, number> = { clash: 0, regenerate: 1, clean: 2 };

/** One team's merging view: shown pairs, clashes first, newest first; undefined when empty. */
export function mergingView(
  pairs: Iterable<CheckedPair>,
  unavailable: string | undefined,
): TeamMerging | undefined {
  if (unavailable !== undefined) return { unavailable, pairs: [] };
  const shown = [...pairs]
    .filter((checked) => checked.shown)
    .map((checked) => checked.pair)
    .toSorted(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        Date.parse(b.since) - Date.parse(a.since),
    )
    .slice(0, TEAM_MERGE_LIMITS.pairs);
  return shown.length === 0 ? undefined : { pairs: shown };
}

/** A map that forgets its least recently used entries past `limit`, for merge results by commit pair. */
export class BoundedCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  /** A read keeps the entry: the least recently used goes first. */
  get(key: string) {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
  get size() {
    return this.entries.size;
  }
}
