/**
 * Whether a holder's branch is pushed, for "Build on top" (fork-only,
 * team/PREVENTION_PLAN.md section 2, slice 3d). A claim made from a chat with
 * its own worktree records its branch; every {@link PUSHED_CHECK_INTERVAL}
 * this server looks at its own claims' branches and records the commit
 * `origin/<branch>` is at locally (Git updates it on push, so no network),
 * or that it is not pushed. Teammates read it from the team state: their
 * card's "Build on top" is enabled once it is set.
 *
 * @module TeamPushedBranches
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TeamService from "./TeamService.ts";

export const PUSHED_CHECK_INTERVAL = "15 seconds";

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  /** The commit `origin/<branch>` is at in this worktree; undefined when it is not pushed. */
  const pushedCommitOf = (folder: string, branch: string) =>
    git
      .execute({
        operation: "TeamPushedBranches.check",
        cwd: folder,
        args: ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && result.stdout.trim().length > 0
            ? result.stdout.trim()
            : undefined,
        ),
      );

  /** One round over this server's claims with a branch, in every team. */
  const checkPushed = Effect.gen(function* () {
    for (const team of yield* teams.listTeams()) {
      if (yield* teams.isSolo(team.teamId)) continue;
      const me = yield* teams.currentMember(team.teamId);
      if (Option.isNone(me)) continue;
      const claims = (yield* teams.listActiveClaims(team.teamId)).filter(
        (claim) =>
          claim.memberId === me.value.memberId &&
          claim.thread.environmentId === environmentId &&
          claim.branch !== undefined,
      );
      const seen = new Set<string>();
      for (const claim of claims) {
        const branch = claim.branch!;
        const key = `${claim.thread.threadId}|${branch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const shell = Option.getOrUndefined(
          yield* snapshots.getThreadShellById(claim.thread.threadId),
        );
        if (shell?.worktreePath === null || shell?.worktreePath === undefined) continue;
        // A no-op when nothing changed: only a change is written and shared.
        const pushedCommit = yield* pushedCommitOf(shell.worktreePath, branch);
        yield* teams.setClaimsPushed({
          teamId: team.teamId,
          memberId: me.value.memberId,
          thread: claim.thread,
          branch,
          pushedCommit,
        });
      }
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Team pushed-branch check failed.", { cause })),
  );

  return { checkPushed, pushedCommitOf };
});

export const TeamPushedBranchesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { checkPushed } = yield* make;
    yield* forkParked(checkPushed.pipe(Effect.repeat(Schedule.spaced(PUSHED_CHECK_INTERVAL))));
  }),
);
