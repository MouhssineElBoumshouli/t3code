/**
 * Who else holds a file, and the guard's one rule (fork-only,
 * team/PREVENTION_PLAN.md section 3), shared by `team_plan`, the edit hooks
 * and the after-the-turn check.
 *
 * @module heldElsewhere
 */
import {
  type TeamClaim,
  type TeamMemberId,
  type TeamPath,
  teamPathsOverlap,
  type TeamPlanFile,
  type TeamPlanHolder,
  type TeamThreadRef,
} from "@t3tools/contracts";

/** The thread asking, and how its holders are named. */
export interface TeamViewer {
  readonly thread: TeamThreadRef;
  readonly memberId: TeamMemberId;
  /** Solo: every holder is another chat of the same person. */
  readonly solo: boolean;
}

type ClaimLike = Pick<TeamClaim, "memberId" | "thread" | "paths">;

export const sameThread = (left: TeamThreadRef, right: TeamThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** Who holds `path` among `claims`: a teammate, or another chat of the same person. */
export const holdersOf = (
  path: string,
  claims: ReadonlyArray<ClaimLike>,
  viewer: Pick<TeamViewer, "memberId" | "solo">,
  names: ReadonlyMap<string, string>,
): Array<TeamPlanHolder> => {
  const seen = new Set<string>();
  const holders: Array<TeamPlanHolder> = [];
  for (const claim of claims) {
    if (!claim.paths.some((held) => teamPathsOverlap(path, held))) continue;
    const mine = viewer.solo || claim.memberId === viewer.memberId;
    const key = mine
      ? `chat:${claim.thread.environmentId}/${claim.thread.threadId}`
      : `member:${claim.memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    holders.push(
      mine
        ? { kind: "chat", thread: claim.thread }
        : {
            kind: "member",
            memberId: claim.memberId,
            name: names.get(claim.memberId) ?? claim.memberId,
          },
    );
  }
  // Teammates first, as the markers order them.
  holders.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "member" ? -1 : 1));
  return holders;
};

/**
 * The paths another thread holds and this one does not. Files nobody else
 * holds, files this thread holds (its plan and later claims), and files the
 * user already chose "Go anyway" for in this thread are never stopped.
 */
export const heldElsewhere = (input: {
  readonly paths: ReadonlyArray<TeamPath>;
  /** The team's active claims, this thread's included. */
  readonly claims: ReadonlyArray<ClaimLike>;
  readonly viewer: TeamViewer;
  readonly names: ReadonlyMap<string, string>;
  readonly wentAhead: ReadonlySet<string>;
}): Array<TeamPlanFile> => {
  const own = input.claims.filter((claim) => sameThread(claim.thread, input.viewer.thread));
  const others = input.claims.filter((claim) => !sameThread(claim.thread, input.viewer.thread));
  return [...new Set(input.paths)].flatMap((path) => {
    if (input.wentAhead.has(path)) return [];
    if (own.some((claim) => claim.paths.some((held) => teamPathsOverlap(path, held)))) return [];
    const holders = holdersOf(path, others, input.viewer, input.names);
    return holders.length === 0 ? [] : [{ path, holders }];
  });
};
