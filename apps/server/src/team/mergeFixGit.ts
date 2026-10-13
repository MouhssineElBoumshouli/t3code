/**
 * The Git steps of "Fix it" (fork-only, team/MERGE_HELP_PLAN.md section 5),
 * in a chat's own worktree. The other side is only read: its commit is merged
 * in, never changed.
 *
 * - Start: Git refuses to merge over uncommitted edits to the same files, so
 *   the chat's uncommitted work is committed first. Then `git merge
 *   --no-commit`, which leaves the conflicts for the agent's turn.
 * - Approve: stages everything, refuses while a conflicted file still has
 *   markers, commits the merge, and pushes when the branch has an upstream.
 * - Undo: back to the state before the fix, uncommitted work uncommitted again.
 *
 * @module mergeFixGit
 */
import type { GitCommandError } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const GIT_TIMEOUT_MS = 120_000;

type Git = GitVcsDriver.GitVcsDriver["Service"];

export class MergeFixGitError extends Data.TaggedError("MergeFixGitError")<{
  readonly detail: string;
}> {}

export interface StartedMerge {
  /** HEAD before the fix. */
  readonly headBefore: string;
  /** The commit holding the chat's uncommitted work, made before merging; null when there was none. */
  readonly savedWork: string | null;
  /** Files Git could not combine, relative to the worktree. */
  readonly conflicts: ReadonlyArray<string>;
}

export type PushOutcome =
  | { readonly push: "pushed" }
  | { readonly push: "notPushed" }
  | { readonly push: "failed"; readonly detail: string };

const runner = (git: Git, folder: string, operation: string) => {
  const run = (args: ReadonlyArray<string>) =>
    git.execute({
      operation,
      cwd: folder,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  /** Runs Git and fails with `detail` when it exits non-zero. */
  const must = (args: ReadonlyArray<string>, detail: string) =>
    run(args).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.fail(
              new MergeFixGitError({ detail: `${detail} ${lastLine(result.stderr)}`.trim() }),
            ),
      ),
    );
  return { run, must };
};

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

const gitFailed = (error: GitCommandError) =>
  new MergeFixGitError({ detail: `Git could not run: ${error.message}` });

const mergeInProgress = (run: ReturnType<typeof runner>["run"]) =>
  run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).pipe(
    Effect.map((result) => result.exitCode === 0),
  );

/** Puts the folder back to `headBefore`, with `savedWork` uncommitted again. */
const restore = (
  run: ReturnType<typeof runner>["run"],
  must: ReturnType<typeof runner>["must"],
  headBefore: string,
  savedWork: string | null,
) =>
  Effect.gen(function* () {
    if (yield* mergeInProgress(run)) yield* run(["merge", "--abort"]);
    yield* must(["reset", "--hard", "-q", savedWork ?? headBefore], "Could not reset the copy.");
    // Files the fix added. The copy was clean (or saved) when the fix started.
    yield* must(["clean", "-fdq"], "Could not remove the files the fix added.");
    if (savedWork !== null) {
      yield* must(
        ["reset", "-q", "--mixed", headBefore],
        "Could not restore the uncommitted work.",
      );
    }
  });

/** Starts merging `otherCommit` into the folder's branch; the merge is left uncommitted. */
export const startMerge = (
  git: Git,
  input: {
    readonly folder: string;
    readonly otherCommit: string;
    readonly savedWorkMessage: string;
  },
) => {
  const { run, must } = runner(git, input.folder, "TeamMergeFix.start");
  return Effect.gen(function* () {
    if (yield* mergeInProgress(run)) {
      return yield* new MergeFixGitError({
        detail: "A merge is already in progress in this chat's copy. Finish or abort it first.",
      });
    }
    const headBefore = yield* must(["rev-parse", "HEAD"], "This chat's copy has no commit yet.");
    const status = yield* must(["status", "--porcelain"], "Could not read the copy's status.");
    let savedWork: string | null = null;
    if (status.length > 0) {
      yield* must(["add", "-A"], "Could not stage the chat's work.");
      yield* must(
        ["commit", "--no-verify", "-q", "-m", input.savedWorkMessage],
        "Could not commit the chat's work before merging.",
      );
      savedWork = yield* must(["rev-parse", "HEAD"], "Could not read the saved work.");
    }
    const merged = yield* run(["merge", "--no-commit", "--no-ff", "--no-edit", input.otherCommit]);
    if (!(yield* mergeInProgress(run))) {
      // Git stopped before merging (or there was nothing to merge): leave the copy as it was.
      yield* restore(run, must, headBefore, savedWork);
      return yield* new MergeFixGitError({
        detail:
          merged.exitCode === 0
            ? "There is nothing to merge: this chat already has that work."
            : `Git could not start the merge. ${lastLine(merged.stderr || merged.stdout)}`.trim(),
      });
    }
    const unmerged = yield* must(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      "Could not list the conflicts.",
    );
    return {
      headBefore,
      savedWork,
      conflicts: unmerged.split("\0").filter((path) => path.length > 0),
    } satisfies StartedMerge;
  }).pipe(Effect.catchTags({ GitCommandError: (error) => Effect.fail(gitFailed(error)) }));
};

/**
 * Commits the merge the agent resolved, then pushes when the branch has an
 * upstream. Refuses while a file that conflicted still has conflict markers.
 */
export const approveMerge = (
  git: Git,
  input: {
    readonly folder: string;
    readonly message: string;
    /** The files that conflicted, relative to the worktree: checked for leftover markers. */
    readonly conflicts: ReadonlyArray<string>;
  },
) => {
  const { run, must } = runner(git, input.folder, "TeamMergeFix.approve");
  return Effect.gen(function* () {
    if (!(yield* mergeInProgress(run))) {
      return yield* new MergeFixGitError({
        detail: "No merge is waiting in this chat's copy; it was committed or undone already.",
      });
    }
    yield* must(["add", "-A"], "Could not stage the merge.");
    const unmerged = yield* must(["ls-files", "-u"], "Could not check for conflicts.");
    if (unmerged.length > 0) {
      return yield* new MergeFixGitError({ detail: "Some files still have conflicts." });
    }
    if (input.conflicts.length > 0) {
      const markers = yield* run([
        "grep",
        "--cached",
        "-l",
        "-E",
        "^(<<<<<<<|>>>>>>>)( |$)",
        "--",
        ...input.conflicts.map((path) => `:(literal)${path}`),
      ]);
      const left = markers.exitCode === 0 ? markers.stdout.trim().split("\n") : [];
      if (left.length > 0) {
        return yield* new MergeFixGitError({
          detail: `Conflict markers are still in ${left.map((path) => `\`${path}\``).join(", ")}.`,
        });
      }
    }
    yield* must(["commit", "-q", "-m", input.message], "Git could not commit the merge.");
    const upstream = yield* run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.exitCode !== 0) return { push: "notPushed" } satisfies PushOutcome;
    const pushed = yield* run(["push", "--quiet"]);
    return pushed.exitCode === 0
      ? ({ push: "pushed" } satisfies PushOutcome)
      : ({
          push: "failed",
          detail: lastLine(pushed.stderr) || "git push failed.",
        } satisfies PushOutcome);
  }).pipe(Effect.catchTags({ GitCommandError: (error) => Effect.fail(gitFailed(error)) }));
};

/** Undoes the fix: the merge, the agent's edits and files, and the commit of saved work. */
export const undoMerge = (
  git: Git,
  input: {
    readonly folder: string;
    readonly headBefore: string;
    readonly savedWork: string | null;
  },
) => {
  const { run, must } = runner(git, input.folder, "TeamMergeFix.undo");
  return restore(run, must, input.headBefore, input.savedWork).pipe(
    Effect.catchTags({ GitCommandError: (error) => Effect.fail(gitFailed(error)) }),
  );
};
