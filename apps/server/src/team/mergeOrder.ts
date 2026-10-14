/**
 * Merge order (fork-only, team/MERGE_HELP_PLAN.md section 4): of two pieces
 * of work that clash or overlap, which to merge first. A pure function of
 * data both people have (claims carry each branch's pull request), so both
 * servers suggest the same one. The first rule that tells them apart decides:
 *
 * 1. A pull request is open and not a draft.
 * 2. Its checks are green.
 * 3. It is mergeable and approved.
 * 4. The smaller diff (only when both sizes are known).
 * 5. The earlier one: started earlier (a teammate's branch), or finished
 *    first (two of the person's chats).
 * 6. A tie goes to the key that sorts first (the login, or the chat's title).
 *
 * @module mergeOrder
 */
import type {
  TeamClaimPullRequest,
  TeamMergeOrderReason,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

export interface MergeOrderSide {
  /** Breaks a tie: the login, or the chat's title. */
  readonly key: string;
  readonly pullRequest: TeamClaimPullRequest | null;
  /** When the work started, or when the chat finished; null while it runs. */
  readonly at: string | null;
}

type Rule = {
  readonly reason: TeamMergeOrderReason;
  /** Lower goes first; undefined when the rule cannot be read for this side. */
  readonly score: (side: MergeOrderSide) => number | undefined;
};

const ready = (pullRequest: TeamClaimPullRequest | null) =>
  pullRequest !== null && pullRequest.state === "open" && !pullRequest.draft;

const RULES: ReadonlyArray<Rule> = [
  { reason: "pullRequestOpen", score: (side) => (ready(side.pullRequest) ? 0 : 1) },
  {
    reason: "checksGreen",
    score: (side) => (ready(side.pullRequest) && side.pullRequest?.checks === "passing" ? 0 : 1),
  },
  {
    reason: "approved",
    score: (side) =>
      ready(side.pullRequest) && side.pullRequest?.mergeable && side.pullRequest.approved ? 0 : 1,
  },
  { reason: "smaller", score: (side) => side.pullRequest?.size ?? undefined },
  {
    reason: "earlier",
    score: (side) => {
      if (side.at === null) return Number.POSITIVE_INFINITY;
      const ms = Date.parse(side.at);
      return Number.isNaN(ms) ? undefined : ms;
    },
  },
];

/** Which side to merge first, and the rule that decided it. */
export function mergeOrder(
  a: MergeOrderSide,
  b: MergeOrderSide,
): { readonly first: "a" | "b"; readonly reason: TeamMergeOrderReason } {
  for (const rule of RULES) {
    const scoreA = rule.score(a);
    const scoreB = rule.score(b);
    if (scoreA === undefined || scoreB === undefined || scoreA === scoreB) continue;
    return { first: scoreA < scoreB ? "a" : "b", reason: rule.reason };
  }
  // Plain code-unit order, the same on every machine.
  return { first: a.key <= b.key ? "a" : "b", reason: "tie" };
}

/** A thread's current pull request as merge order reads it; null when T3 has no synced one. */
export function claimPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
): TeamClaimPullRequest | null {
  const link = resolveThreadCurrentPullRequestLink(links ?? []);
  const snapshot = link?.snapshot;
  if (link === null || snapshot == null) return null;
  return {
    number: link.number,
    state: snapshot.state,
    draft: snapshot.isDraft,
    checks: snapshot.checksState ?? null,
    mergeable: snapshot.mergeability === "mergeable",
    approved: snapshot.reviewDecision === "approved",
    size:
      snapshot.additions === undefined || snapshot.deletions === undefined
        ? null
        : snapshot.additions + snapshot.deletions,
  };
}
