/**
 * `git merge-tree` for merging help (fork-only, team/MERGE_HELP_PLAN.md
 * section 1): combines two commits in the object store and says which files
 * conflict and in how many places. No checkout, no index, no working copy.
 * Needs Git 2.38 or newer (`--write-tree`).
 *
 * @module mergeTree
 */
import type { TeamMergeStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const MERGE_TREE_MIN_GIT = { major: 2, minor: 38 } as const;
const MERGE_TREE_TIMEOUT_MS = 60_000;
/** Conflicting files whose places are counted; the rest count as files only. */
const COUNTED_FILES = 50;

/** "git version 2.53.0.windows.1" → 2.53; undefined when unreadable. */
export const parseGitVersion = (text: string) => {
  const match = /(\d+)\.(\d+)/u.exec(text);
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
};

export const supportsMergeTree = (version: { readonly major: number; readonly minor: number }) =>
  version.major > MERGE_TREE_MIN_GIT.major ||
  (version.major === MERGE_TREE_MIN_GIT.major && version.minor >= MERGE_TREE_MIN_GIT.minor);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "go.sum",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
]);

/** A lockfile or generated file: after merging it is regenerated, not merged by hand. */
export const isRegeneratedFile = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return (
    LOCKFILES.has(name) ||
    /\.(gen|generated)\.[a-z0-9]+$/u.test(name) ||
    /\.min\.(js|css)$/u.test(name) ||
    name.endsWith(".snap")
  );
};

/**
 * Fetches `origin`'s branch into a hidden ref only. `--refmap=` stops Git from
 * also updating `origin/<branch>`, so the person's remote branches stay as
 * they were. True when the fetch worked.
 */
export const fetchIntoHiddenRef = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  branch: string,
  ref: string,
) =>
  git
    .execute({
      operation: "TeamMerging.fetch",
      cwd,
      args: [
        "fetch",
        "--quiet",
        "--no-tags",
        "--refmap=",
        "origin",
        `+refs/heads/${branch}:${ref}`,
      ],
      allowNonZeroExit: true,
      timeoutMs: MERGE_TREE_TIMEOUT_MS,
    })
    .pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

export interface MergeConflict {
  /** Relative to the repo root. */
  readonly path: string;
  /** Conflict marker blocks; 0 when there are none (deleted on one side, binary). */
  readonly places: number;
  readonly regenerate: boolean;
}

export interface MergeTreeResult {
  /** The merged tree (with conflict markers where they clash). */
  readonly tree: string;
  /** Clashes first, then files to regenerate. */
  readonly conflicts: ReadonlyArray<MergeConflict>;
  /** A clean merge: files both sides changed since they split (Git merged them). Empty otherwise. */
  readonly bothChanged: ReadonlyArray<string>;
}

export const mergeStatusOf = (conflicts: ReadonlyArray<MergeConflict>): TeamMergeStatus =>
  conflicts.length === 0
    ? "clean"
    : conflicts.every((conflict) => conflict.regenerate)
      ? "regenerate"
      : "clash";

/**
 * Whether `base` already holds `theirs`: merging `theirs` into `base` (in that
 * order) changes nothing. True for a merged branch, also a squash merge.
 */
export const alreadyHolds = (baseTree: string, merged: MergeTreeResult | undefined | null) =>
  merged != null && merged.conflicts.length === 0 && merged.tree === baseTree;

type Run = (
  args: ReadonlyArray<string>,
) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>;

/** Files changed on both sides since their merge base; empty when Git cannot tell. */
const changedOnBothSides = (run: Run, ours: string, theirs: string) =>
  Effect.gen(function* () {
    const base = yield* run(["merge-base", ours, theirs]);
    if (base.exitCode !== 0) return [];
    const changed = (commit: string) =>
      run(["diff", "--name-only", "--no-renames", "-z", base.stdout.trim(), commit]).pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? result.stdout.split("\0").filter((path) => path.length > 0) : [],
        ),
      );
    const theirsChanged = new Set(yield* changed(theirs));
    return (yield* changed(ours)).filter((path) => theirsChanged.has(path));
  });

/**
 * Merges `ours` and `theirs` (commits or refs) in the repo at `cwd`. Undefined
 * when Git cannot merge them (unrelated histories, a missing commit, a timeout).
 */
export const mergeTree = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  ours: string,
  theirs: string,
) =>
  Effect.gen(function* () {
    const run: Run = (args) =>
      git.execute({
        operation: "TeamMerging.mergeTree",
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: MERGE_TREE_TIMEOUT_MS,
      });
    const merged = yield* run([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      ours,
      theirs,
    ]);
    // 0: clean, 1: conflicts; anything else is an error.
    if (merged.exitCode !== 0 && merged.exitCode !== 1) return undefined;
    const [tree, ...rest] = merged.stdout.split("\0");
    if (tree === undefined || !/^[0-9a-f]{40,64}$/u.test(tree)) return undefined;
    const paths = [...new Set(rest.filter((entry) => entry.length > 0))];
    if (merged.exitCode === 0 || paths.length === 0) {
      return { tree, conflicts: [], bothChanged: yield* changedOnBothSides(run, ours, theirs) };
    }

    // Count marker blocks in the merged tree's copies, in one call.
    const counted = paths.slice(0, COUNTED_FILES);
    const grep = yield* run([
      "grep",
      "-I",
      "-c",
      "-e",
      "^<<<<<<< ",
      tree,
      "--",
      ...counted.map((path) => `:(literal)${path}`),
    ]);
    const places = new Map<string, number>();
    if (grep.exitCode === 0) {
      for (const line of grep.stdout.split("\n")) {
        if (!line.startsWith(`${tree}:`)) continue;
        const entry = line.slice(tree.length + 1);
        const colon = entry.lastIndexOf(":");
        if (colon > 0) places.set(entry.slice(0, colon), Number(entry.slice(colon + 1)) || 0);
      }
    }
    const conflicts = paths.map((path) => ({
      path,
      places: places.get(path) ?? 0,
      regenerate: isRegeneratedFile(path),
    }));
    return {
      tree,
      conflicts: [
        ...conflicts.filter((conflict) => !conflict.regenerate),
        ...conflicts.filter((conflict) => conflict.regenerate),
      ],
      bothChanged: [],
    } satisfies MergeTreeResult;
  }).pipe(Effect.orElseSucceed(() => undefined));
