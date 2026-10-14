// @effect-diagnostics nodeBuiltinImport:off - reads test files synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { approveMerge, startMerge, undoMerge } from "./mergeFixGit.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-merge-fix-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-merge-fix-" });
});

const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");
const exists = (root: string, file: string) => NodeFS.existsSync(NodePath.join(root, file));

/**
 * `main` with greet.ts; `theirs` changes its first line and is committed;
 * `mine` (checked out) changes the same line without committing, and has an
 * untracked notes file.
 */
const clashingRepo = (root: string) => {
  initRepo(root, { "src/greet.ts": "hello\nworld\n", "src/other.ts": "x\n" });
  git(root, "checkout", "--quiet", "-b", "theirs");
  writeFile(root, "src/greet.ts", "hi there\nworld\n");
  const theirs = commitAll(root, "theirs");
  git(root, "checkout", "--quiet", "-b", "mine", "main");
  writeFile(root, "src/greet.ts", "welcome\nworld\n");
  writeFile(root, "notes.txt", "mine\n");
  return { theirs, base: git(root, "rev-parse", "HEAD") };
};

const start = (root: string, otherCommit: string) =>
  Effect.gen(function* () {
    return yield* startMerge(yield* GitVcsDriver.GitVcsDriver, {
      folder: root,
      otherCommit,
      savedWorkMessage: "Work before merging theirs",
    });
  });

describe("mergeFixGit", () => {
  it.layer(GitLayer)((it) => {
    it.effect("saves uncommitted work, then leaves the merge's conflicts uncommitted", () =>
      Effect.gen(function* () {
        const root = yield* tempDir;
        const { theirs, base } = clashingRepo(root);
        const started = yield* start(root, theirs);
        assert.equal(started.headBefore, base);
        assert.isNotNull(started.savedWork);
        assert.deepEqual(started.conflicts, ["src/greet.ts"]);
        assert.equal(git(root, "rev-parse", "MERGE_HEAD"), theirs);
        assert.include(read(root, "src/greet.ts"), "<<<<<<< ");
        // The other side's branch is never touched.
        assert.equal(git(root, "rev-parse", "theirs"), theirs);
      }),
    );

    it.effect("approve refuses leftover markers, then commits the resolved merge", () =>
      Effect.gen(function* () {
        const root = yield* tempDir;
        const { theirs } = clashingRepo(root);
        const started = yield* start(root, theirs);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const approve = approveMerge(driver, {
          folder: root,
          message: "Merge theirs",
          conflicts: started.conflicts,
        });

        const refused = yield* Effect.flip(approve);
        assert.include(refused.detail, "`src/greet.ts`");

        writeFile(root, "src/greet.ts", "welcome, hi there\nworld\n");
        const outcome = yield* approve;
        assert.deepEqual(outcome, { push: "notPushed" });
        assert.equal(git(root, "log", "-1", "--format=%P").split(" ").length, 2);
        assert.equal(git(root, "status", "--porcelain"), "");
        assert.equal(git(root, "show", "HEAD:notes.txt"), "mine");
      }),
    );

    it.effect("approve pushes when the branch has an upstream", () =>
      Effect.gen(function* () {
        const root = yield* tempDir;
        const remote = yield* tempDir;
        git(remote, "init", "--quiet", "--bare", "-b", "main");
        const { theirs } = clashingRepo(root);
        git(root, "remote", "add", "origin", remote);
        git(root, "push", "--quiet", "-u", "origin", "mine");
        const started = yield* start(root, theirs);
        writeFile(root, "src/greet.ts", "welcome, hi there\nworld\n");
        const outcome = yield* approveMerge(yield* GitVcsDriver.GitVcsDriver, {
          folder: root,
          message: "Merge theirs",
          conflicts: started.conflicts,
        });
        assert.deepEqual(outcome, { push: "pushed" });
        assert.equal(git(remote, "rev-parse", "mine"), git(root, "rev-parse", "HEAD"));
      }),
    );

    it.effect("undo goes back to before the fix, uncommitted work uncommitted again", () =>
      Effect.gen(function* () {
        const root = yield* tempDir;
        const { theirs, base } = clashingRepo(root);
        const started = yield* start(root, theirs);
        // The agent's turn: resolves, edits another file, adds one.
        writeFile(root, "src/greet.ts", "resolved\nworld\n");
        writeFile(root, "src/other.ts", "changed by the fix\n");
        writeFile(root, "src/new.ts", "new\n");
        yield* undoMerge(yield* GitVcsDriver.GitVcsDriver, {
          folder: root,
          headBefore: started.headBefore,
          savedWork: started.savedWork,
        });
        assert.equal(git(root, "rev-parse", "HEAD"), base);
        assert.equal(read(root, "src/greet.ts"), "welcome\nworld\n");
        assert.equal(read(root, "src/other.ts"), "x\n");
        assert.isFalse(exists(root, "src/new.ts"));
        assert.equal(read(root, "notes.txt"), "mine\n");
        assert.equal(git(root, "status", "--porcelain"), "M src/greet.ts\n?? notes.txt");
        assert.isFalse(exists(root, ".git/MERGE_HEAD"));
      }),
    );

    it.effect("nothing to merge leaves the copy as it was", () =>
      Effect.gen(function* () {
        const root = yield* tempDir;
        const { base } = clashingRepo(root);
        const failed = yield* Effect.flip(start(root, git(root, "rev-parse", "main")));
        assert.include(failed.detail, "nothing to merge");
        assert.equal(git(root, "rev-parse", "HEAD"), base);
        assert.equal(git(root, "status", "--porcelain"), "M src/greet.ts\n?? notes.txt");
      }),
    );
  });
});
