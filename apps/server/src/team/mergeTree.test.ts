import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  alreadyHolds,
  fetchIntoHiddenRef,
  isRegeneratedFile,
  mergeStatusOf,
  mergeTree,
  parseGitVersion,
  supportsMergeTree,
} from "./mergeTree.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-merge-tree-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const tempRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-merge-tree-" });
});

const lines = (count: number, change: Record<number, string> = {}) =>
  `${Array.from({ length: count }, (_, index) => change[index] ?? `line ${index}`).join("\n")}\n`;

/** Commits `files` on a new branch from main, then goes back to main. */
const branchWith = (root: string, branch: string, files: Record<string, string>) => {
  git(root, "checkout", "--quiet", "-b", branch, "main");
  for (const [file, contents] of Object.entries(files)) writeFile(root, file, contents);
  const commit = commitAll(root, branch);
  git(root, "checkout", "--quiet", "main");
  return commit;
};

describe("mergeTree", () => {
  it.layer(GitLayer)((it) => {
    it.effect("merges two branches that change different files", () =>
      Effect.gen(function* () {
        const root = yield* tempRepo;
        initRepo(root, { "src/a.ts": lines(5), "src/b.ts": lines(5) });
        const ours = branchWith(root, "ours", { "src/a.ts": lines(5, { 1: "ours" }) });
        const theirs = branchWith(root, "theirs", { "src/b.ts": lines(5, { 1: "theirs" }) });
        const result = yield* mergeTree(yield* GitVcsDriver.GitVcsDriver, root, ours, theirs);
        assert.deepEqual(result?.conflicts, []);
        assert.deepEqual(result?.bothChanged, []);
        assert.equal(mergeStatusOf(result!.conflicts), "clean");
        // The working copy is untouched.
        assert.equal(git(root, "status", "--porcelain"), "");
      }),
    );

    it.effect("lists the files both sides changed when Git merges them", () =>
      Effect.gen(function* () {
        const root = yield* tempRepo;
        initRepo(root, { "src/a.ts": lines(20), "src/b.ts": lines(5) });
        const ours = branchWith(root, "ours", { "src/a.ts": lines(20, { 1: "ours" }) });
        const theirs = branchWith(root, "theirs", {
          "src/a.ts": lines(20, { 15: "theirs" }),
          "src/b.ts": lines(5, { 1: "theirs" }),
        });
        const result = yield* mergeTree(yield* GitVcsDriver.GitVcsDriver, root, ours, theirs);
        assert.deepEqual(result?.conflicts, []);
        assert.deepEqual(result?.bothChanged, ["src/a.ts"]);
      }),
    );

    it.effect("names the conflicting file and counts its places", () =>
      Effect.gen(function* () {
        const root = yield* tempRepo;
        initRepo(root, { "src/routes.ts": lines(20), "pnpm-lock.yaml": "lock: 1\n" });
        const ours = branchWith(root, "ours", {
          "src/routes.ts": lines(20, { 1: "ours top", 15: "ours bottom" }),
          "pnpm-lock.yaml": "lock: 2\n",
        });
        const theirs = branchWith(root, "theirs", {
          "src/routes.ts": lines(20, { 1: "theirs top", 15: "theirs bottom" }),
          "pnpm-lock.yaml": "lock: 3\n",
        });
        const result = yield* mergeTree(yield* GitVcsDriver.GitVcsDriver, root, ours, theirs);
        assert.deepEqual(result?.conflicts, [
          { path: "src/routes.ts", places: 2, regenerate: false },
          { path: "pnpm-lock.yaml", places: 1, regenerate: true },
        ]);
        assert.equal(mergeStatusOf(result!.conflicts), "clash");
        assert.equal(
          mergeStatusOf(result!.conflicts.filter((conflict) => conflict.regenerate)),
          "regenerate",
        );
      }),
    );

    it.effect("merges a rename on one side with an edit on the other", () =>
      Effect.gen(function* () {
        const root = yield* tempRepo;
        initRepo(root, { "src/search.ts": lines(30) });
        git(root, "checkout", "--quiet", "-b", "ours", "main");
        git(root, "mv", "src/search.ts", "src/find.ts");
        const ours = commitAll(root, "rename");
        git(root, "checkout", "--quiet", "main");
        const theirs = branchWith(root, "theirs", {
          "src/search.ts": lines(30, { 10: "theirs" }),
        });
        const result = yield* mergeTree(yield* GitVcsDriver.GitVcsDriver, root, ours, theirs);
        assert.deepEqual(result?.conflicts, []);
        assert.include(git(root, "show", `${result!.tree}:src/find.ts`), "theirs");
      }),
    );

    it.effect("fetches a teammate's branch into a hidden ref only, not origin/<branch>", () =>
      Effect.gen(function* () {
        const origin = yield* tempRepo;
        initRepo(origin, { "a.txt": "a\n" });
        const pushed = branchWith(origin, "search", { "a.txt": "b\n" });
        const root = yield* tempRepo;
        git(root, "clone", "--quiet", origin, ".");
        git(root, "update-ref", "-d", "refs/remotes/origin/search");
        const fetched = yield* fetchIntoHiddenRef(
          yield* GitVcsDriver.GitVcsDriver,
          root,
          "search",
          "refs/t3-team/peers/sara/search",
        );
        assert.isTrue(fetched);
        assert.equal(git(root, "rev-parse", "refs/t3-team/peers/sara/search"), pushed);
        assert.equal(git(root, "for-each-ref", "refs/remotes/origin/search"), "");
      }),
    );

    it.effect("knows when the base already holds a teammate's branch, merged or squashed", () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* tempRepo;
        initRepo(root, { "src/a.ts": lines(20), "src/b.ts": lines(5) });
        const merged = branchWith(root, "merged", { "src/a.ts": lines(20, { 1: "merged" }) });
        const squashed = branchWith(root, "squashed", { "src/b.ts": lines(5, { 1: "squashed" }) });
        const open = branchWith(root, "open", { "src/a.ts": lines(20, { 15: "open" }) });
        git(root, "merge", "--quiet", "--no-ff", "-m", "merge", "merged");
        git(root, "merge", "--quiet", "--squash", "squashed");
        git(root, "commit", "--quiet", "-m", "squash");
        // Main moves on after both merges.
        writeFile(root, "src/c.ts", "c\n");
        const base = commitAll(root, "later");
        const baseTree = git(root, "rev-parse", `${base}^{tree}`);
        const holds = (commit: string) =>
          mergeTree(driver, root, base, commit).pipe(
            Effect.map((result) => alreadyHolds(baseTree, result)),
          );
        assert.isTrue(yield* holds(merged));
        assert.isTrue(yield* holds(squashed));
        assert.isFalse(yield* holds(open));
        assert.isFalse(alreadyHolds(baseTree, null));
      }),
    );

    it.effect("gives up on commits Git cannot merge", () =>
      Effect.gen(function* () {
        const root = yield* tempRepo;
        const base = initRepo(root, { "a.txt": "a\n" });
        const result = yield* mergeTree(
          yield* GitVcsDriver.GitVcsDriver,
          root,
          base,
          "0000000000000000000000000000000000000001",
        );
        assert.equal(result, undefined);
      }),
    );
  });

  it("reads Git's version and needs 2.38", () => {
    assert.deepEqual(parseGitVersion("git version 2.53.0.windows.1"), { major: 2, minor: 53 });
    assert.equal(parseGitVersion("nothing"), undefined);
    assert.isTrue(supportsMergeTree({ major: 2, minor: 38 }));
    assert.isFalse(supportsMergeTree({ major: 2, minor: 37 }));
    assert.isTrue(supportsMergeTree({ major: 3, minor: 0 }));
  });

  it("knows lockfiles and generated files", () => {
    assert.isTrue(isRegeneratedFile("apps/web/pnpm-lock.yaml"));
    assert.isTrue(isRegeneratedFile("Cargo.lock"));
    assert.isTrue(isRegeneratedFile("src/routeTree.gen.ts"));
    assert.isFalse(isRegeneratedFile("src/lock.ts"));
  });
});
