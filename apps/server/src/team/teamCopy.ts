/**
 * Moves a chat's own worktree on top of another commit (fork-only): the base
 * after a "Wait" (team/TeamWait.ts) or a teammate's pushed branch for "Build
 * on top" (team/TeamChoices.ts). A rebase, so the chat's committed work stays;
 * a conflict is aborted and leaves the copy as it was. A copy with uncommitted
 * changes is never touched.
 *
 * @module teamCopy
 */
import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const GIT_TIMEOUT_MS = 60_000;

export type CopyMove =
  /** `touched`: the commits moved in change one of the paths asked about. */
  | { readonly status: "updated"; readonly onto: string; readonly touched: boolean }
  | { readonly status: "conflict"; readonly onto: string }
  /** Uncommitted changes. */
  | { readonly status: "dirty" }
  /** Git failed, or `fetch` found nothing to move onto. */
  | { readonly status: "unavailable" };

export interface MoveCopyInput {
  readonly folder: string;
  /** `git fetch` arguments after `fetch --quiet`. */
  readonly fetch: ReadonlyArray<string>;
  /** The commit to move onto once fetched, e.g. `origin/main`; a function to read it after the fetch. */
  readonly onto: string | ((run: Run) => Effect.Effect<string | undefined, GitCommandError>);
  /** Repo paths whose change in the moved-in commits sets `touched`. */
  readonly paths: ReadonlyArray<string>;
  readonly operation: string;
}

type Run = (
  args: ReadonlyArray<string>,
) => Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError>;

export const moveCopyOnto = (git: GitVcsDriver.GitVcsDriver["Service"], input: MoveCopyInput) => {
  const run: Run = (args) =>
    git.execute({
      operation: input.operation,
      cwd: input.folder,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  return Effect.gen(function* () {
    const status = yield* run(["status", "--porcelain"]);
    if (status.exitCode !== 0) return { status: "unavailable" } as CopyMove;
    if (status.stdout.trim().length > 0) return { status: "dirty" } as CopyMove;
    if ((yield* run(["fetch", "--quiet", ...input.fetch])).exitCode !== 0) {
      return { status: "unavailable" } as CopyMove;
    }
    const onto = typeof input.onto === "string" ? input.onto : yield* input.onto(run);
    if (onto === undefined) return { status: "unavailable" } as CopyMove;
    if ((yield* run(["rev-parse", "--verify", "--quiet", onto])).exitCode !== 0) {
      return { status: "unavailable" } as CopyMove;
    }
    const forkPoint = yield* run(["merge-base", "HEAD", onto]);
    if ((yield* run(["rebase", "--quiet", onto])).exitCode !== 0) {
      yield* run(["rebase", "--abort"]);
      return { status: "conflict", onto } as CopyMove;
    }
    // No fork point (unrelated histories): count it as a change.
    const touched =
      forkPoint.exitCode !== 0 ||
      input.paths.length === 0 ||
      (yield* run([
        "diff",
        "--quiet",
        forkPoint.stdout.trim(),
        onto,
        "--",
        ...input.paths.map((file) => `:(literal)${file}`),
      ])).exitCode !== 0;
    return { status: "updated", onto, touched } as CopyMove;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Team copy could not be moved.", { folder: input.folder, cause }).pipe(
        Effect.as<CopyMove>({ status: "unavailable" }),
      ),
    ),
  );
};
