/**
 * Updates a chat's own worktree with another commit (fork-only): the base
 * after a "Wait" (team/TeamWait.ts), a teammate's pushed branch for "Build on
 * top" (team/TeamChoices.ts), or the other side of a merge pair ("Update my
 * copy", team/TeamMergeFix.ts). A merge of that commit into the chat's
 * branch, like GitHub's "Update branch", never a rebase: the chat's commits
 * stay as they are, merge commits from an approved fix included, and it stops
 * only where a 3-way merge does. A conflict is aborted and leaves the copy as
 * it was. A copy with uncommitted changes is never touched.
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
  /** `git fetch` arguments after `fetch --quiet`; empty when the commit is already here. */
  readonly fetch: ReadonlyArray<string>;
  /** The commit to move onto once fetched, e.g. `origin/main`; a function to read it after the fetch. */
  readonly onto: string | ((run: Run) => Effect.Effect<string | undefined, GitCommandError>);
  /** Repo paths whose change in the moved-in commits sets `touched`. */
  readonly paths: ReadonlyArray<string>;
  /** The merge commit's message; Git's own when absent. */
  readonly message?: string;
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
    if (
      input.fetch.length > 0 &&
      (yield* run(["fetch", "--quiet", ...input.fetch])).exitCode !== 0
    ) {
      return { status: "unavailable" } as CopyMove;
    }
    const onto = typeof input.onto === "string" ? input.onto : yield* input.onto(run);
    if (onto === undefined) return { status: "unavailable" } as CopyMove;
    if ((yield* run(["rev-parse", "--verify", "--quiet", onto])).exitCode !== 0) {
      return { status: "unavailable" } as CopyMove;
    }
    const forkPoint = yield* run(["merge-base", "HEAD", onto]);
    // No commit hooks: Git writes this commit, not the person. A fast-forward when the chat has none of its own.
    const merged = yield* run([
      "merge",
      "--quiet",
      "--no-edit",
      "--no-verify",
      ...(input.message === undefined ? [] : ["-m", input.message]),
      onto,
    ]);
    if (merged.exitCode !== 0) {
      const stopped = (yield* run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode === 0;
      if (!stopped) return { status: "unavailable" } as CopyMove;
      yield* run(["merge", "--abort"]);
      return { status: "conflict", onto } as CopyMove;
    }
    // No fork point: count it as a change.
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
