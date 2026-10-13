import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
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
        assert.equal(mergeStatusOf(result!.conflicts), "clean");
        // The working copy is untouched.
        assert.equal(git(root, "status", "--porcelain"), "");
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
