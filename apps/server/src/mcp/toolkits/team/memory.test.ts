import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TeamHandoff } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import { commitAll, git, initRepo, writeFile } from "../../../team/testing/gitRepo.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  checkFreshness,
  FRESHNESS,
  handoffEntry,
  hashFiles,
  type MemoryEntry,
  parseDecision,
  queryTerms,
  rankMemory,
  readDecisions,
  TEAM_MEMORY_LIMITS,
  UNKNOWN_WHY,
} from "./memory.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-memory-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-memory-" });
});

const entry = (overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "searchText">): MemoryEntry => ({
  kind: "handoff",
  says: overrides.searchText,
  who: "Ana",
  when: null,
  whenLabel: "unknown",
  files: [],
  commit: null,
  fileHashes: null,
  ...overrides,
});

/**
 * A note written in `root` about `files`: their hashes now and the current
 * commit. With `store`, Git keeps the content, as `team_handoff` does.
 */
const noteNow = (root: string, files: ReadonlyArray<string>, store = false) =>
  Effect.gen(function* () {
    const gitDriver = yield* GitVcsDriver.GitVcsDriver;
    const hashes = yield* hashFiles(gitDriver, root, files, { store });
    return {
      files,
      commit: git(root, "rev-parse", "HEAD"),
      fileHashes: Object.fromEntries(hashes),
    };
  });

const freshness = (
  root: string,
  note: Pick<MemoryEntry, "files" | "commit" | "fileHashes">,
  sameCheckout: boolean,
) =>
  Effect.gen(function* () {
    const gitDriver = yield* GitVcsDriver.GitVcsDriver;
    return yield* checkFreshness(gitDriver, root, note, sameCheckout);
  });

describe("queryTerms", () => {
  it("keeps words and paths, lowercased, without stop words or repeats", () => {
    assert.deepEqual(queryTerms('Why did we choose SQLite for "src/db.ts"? sqlite!'), [
      "choose",
      "sqlite",
      "src/db.ts",
    ]);
    assert.deepEqual(queryTerms("  why is the  "), []);
  });
});

describe("rankMemory", () => {
  it("ranks by distinct terms matched, then newest first, and drops non-matches", () => {
    const oldBoth = entry({ searchText: "login session", when: "2026-09-01T00:00:00.000Z" });
    const newOne = entry({ searchText: "login only", when: "2026-09-30T00:00:00.000Z" });
    const oldOne = entry({ searchText: "Login form", when: "2026-09-02T00:00:00.000Z" });
    const undated = entry({ kind: "decision", searchText: "login rules" });
    const unrelated = entry({ searchText: "payments", when: "2026-10-01T00:00:00.000Z" });
    const { top, matched } = rankMemory(
      [oldOne, undated, unrelated, newOne, oldBoth],
      queryTerms("login session"),
    );
    assert.deepEqual(top, [oldBoth, newOne, oldOne, undated]);
    assert.equal(matched, 4);
  });

  it("returns at most 5 and counts the rest", () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      entry({ searchText: `cache note ${index}`, when: `2026-09-0${index + 1}T00:00:00.000Z` }),
    );
    const { top, matched } = rankMemory(entries, ["cache"]);
    assert.lengthOf(top, TEAM_MEMORY_LIMITS.results);
    assert.equal(matched, 8);
    assert.deepEqual(
      top.map((item) => item.searchText),
      ["cache note 7", "cache note 6", "cache note 5", "cache note 4", "cache note 3"],
    );
  });
});

describe("automatic notes in search", () => {
  it("ranks them below handoffs and decisions, whatever they match", () => {
    const auto = entry({
      kind: "automatic note",
      searchText: "login session src/login.ts",
      when: "2026-10-01T00:00:00.000Z",
    });
    const olderAuto = entry({
      kind: "automatic note",
      searchText: "login",
      when: "2026-09-30T00:00:00.000Z",
    });
    const handoff = entry({ searchText: "login", when: "2026-09-01T00:00:00.000Z" });
    const decision = entry({ kind: "decision", searchText: "session" });
    const { top, matched } = rankMemory(
      [olderAuto, auto, decision, handoff],
      queryTerms("login session"),
    );
    assert.deepEqual(top, [handoff, decision, auto, olderAuto]);
    assert.equal(matched, 4);
  });

  it("marks a saved automatic note as one", () => {
    const base = {
      handoffId: "h1",
      teamId: "t1",
      memberId: "m1",
      thread: { environmentId: "e1", threadId: "th1" },
      taskId: null,
      changed: "Automatic note, not written by the agent: this chat changed 1 file.",
      left: null,
      risks: null,
      files: ["src/a.ts"],
      commit: null,
      fileHashes: null,
      createdAt: "2026-10-01T10:00:00.000Z",
    } as unknown as TeamHandoff;
    assert.equal(handoffEntry({ ...base, automatic: true }, "Ana").kind, "automatic note");
    assert.equal(handoffEntry({ ...base, automatic: false }, "Ana").kind, "handoff");
  });
});

describe("parseDecision", () => {
  it("reads front matter with an inline files list", () => {
    const decision = parseDecision(
      ".team/decisions/0001-use-sqlite.md",
      [
        "---",
        "title: Use SQLite",
        'author: "Ana"',
        "date: 2026-09-20",
        "files: [src/db.ts, ./src/schema.ts, ../outside.ts]",
        "commit: abc1234",
        "---",
        "",
        "# Use SQLite",
        "",
        "One file, no server to run. Postgres later if we need it.",
      ].join("\n"),
    );
    assert.equal(decision.kind, "decision");
    assert.equal(decision.who, "Ana");
    assert.equal(decision.whenLabel, "2026-09-20");
    assert.equal(decision.when, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(decision.files, ["src/db.ts", "src/schema.ts"]);
    assert.equal(decision.commit, "abc1234");
    assert.equal(
      decision.says,
      "Use SQLite: One file, no server to run. Postgres later if we need it.",
    );
    assert.equal(decision.source, ".team/decisions/0001-use-sqlite.md");
  });

  it("reads a dash list, and falls back to the heading or file name without front matter", () => {
    const listed = parseDecision(
      ".team/decisions/0002-x.md",
      "---\ntitle: Tabs\nfiles:\n  - src/a.ts\n  - 'src/b/'\n---\nWe use tabs.\n",
    );
    assert.deepEqual(listed.files, ["src/a.ts", "src/b/"]);
    assert.equal(listed.who, "unknown");
    assert.isNull(listed.when);
    assert.isNull(listed.commit);

    const plain = parseDecision(".team/decisions/0003-no-orm.md", "We write SQL by hand.");
    assert.equal(plain.says, "no orm: We write SQL by hand.");
    const headed = parseDecision(".team/decisions/0004-x.md", "# Keep it small\n\nWhy.");
    assert.equal(headed.says, "Keep it small: Why.");
  });

  it("keeps what it says short", () => {
    const long = parseDecision(".team/decisions/0005-long.md", Array(100).fill("word").join(" "));
    assert.equal(long.says.split(" ").length, TEAM_MEMORY_LIMITS.saysWords);
    assert.isTrue(long.says.endsWith("…"));
  });
});

describe("readDecisions", () => {
  it.effect("reads only Markdown files, and gives nothing without a decisions folder", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      assert.deepEqual(yield* readDecisions(root), []);
      writeFile(root, ".team/decisions/0002-b.md", "---\ntitle: B\n---\nB.");
      writeFile(root, ".team/decisions/0001-a.md", "A.");
      writeFile(root, ".team/decisions/notes.txt", "not a decision");
      writeFile(
        root,
        ".team/decisions/0003-huge.md",
        "x".repeat(TEAM_MEMORY_LIMITS.decisionBytes + 1),
      );
      const decisions = yield* readDecisions(root);
      assert.deepEqual(
        decisions.map((decision) => decision.source),
        [".team/decisions/0001-a.md", ".team/decisions/0002-b.md"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("checkFreshness with file hashes", () => {
  it.effect("is fresh until a file changes, then maybe outdated, in the same checkout", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      initRepo(root, { "src/a.ts": "a1\n" });
      // Uncommitted work, as agents usually leave it: one edited file, one new file.
      writeFile(root, "src/a.ts", "a2\n");
      writeFile(root, "src/new.ts", "new1\n");
      const note = yield* noteNow(root, ["src/a.ts", "src/new.ts"]);
      assert.equal(yield* freshness(root, note, true), FRESHNESS.fresh);

      writeFile(root, "src/new.ts", "new2\n");
      // Hashed without storing the content, so Git cannot count the lines.
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: content of src/new.ts changed since this note was written",
      );
      // Committing the noted content changes nothing; a later change is found from history.
      writeFile(root, "src/new.ts", "new1\n");
      commitAll(root, "work");
      assert.equal(yield* freshness(root, note, false), FRESHNESS.fresh);
      writeFile(root, "src/new.ts", "new1\nnew3\n");
      assert.equal(
        yield* freshness(root, note, false),
        "maybe outdated: content of src/new.ts changed since this note was written (+1 -0 lines)",
      );
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("says not merged yet in another copy until the work arrives there", () =>
    Effect.gen(function* () {
      const main = yield* tempDir;
      const path = yield* Path.Path;
      initRepo(main, { "src/a.ts": "a1\n" });
      const worktree = path.join(yield* tempDir, "chat-a");
      git(main, "worktree", "add", "--quiet", "-b", "chat-a", worktree);
      writeFile(worktree, "src/a.ts", "a2\n");
      writeFile(worktree, "src/new.ts", "new1\n");
      const note = yield* noteNow(worktree, ["src/a.ts", "src/new.ts"]);

      assert.equal(
        yield* freshness(main, note, false),
        "not merged yet: this note's version of src/a.ts is not in your copy's history (another chat's uncommitted or unmerged work)",
      );

      commitAll(worktree, "chat a work");
      git(main, "merge", "--quiet", "--squash", "chat-a");
      git(main, "commit", "--quiet", "-m", "squashed");
      assert.equal(yield* freshness(main, note, false), FRESHNESS.fresh);

      writeFile(main, "src/a.ts", "a3\n");
      assert.equal(
        yield* freshness(main, note, false),
        "maybe outdated: content of src/a.ts changed since this note was written (+1 -1 lines)",
      );
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("lists at most 3 changed files in the reason, with line counts", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
      initRepo(root, Object.fromEntries(files.map((file) => [file, "1\n"])));
      const note = yield* noteNow(root, files);
      for (const file of files) writeFile(root, file, "2\n3\n");
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: content of a.ts (+2 -1 lines), b.ts (+2 -1 lines), c.ts (+2 -1 lines) +2 more changed since this note was written",
      );
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("counts lines from content stored with the note, and names new and deleted files", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      initRepo(root, { "src/login.ts": "base\n", "src/old.ts": "old\n" });
      // Uncommitted work, stored when the note is written (as team_handoff does).
      writeFile(root, "src/login.ts", "one\ntwo\n");
      const note = yield* noteNow(root, ["src/login.ts", "src/old.ts", "src/later.ts"], true);

      writeFile(root, "src/login.ts", "one\ntwo\nthree\n");
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: content of src/login.ts changed since this note was written (+1 -0 lines)",
      );
      writeFile(root, "src/login.ts", "one\ntwo\n");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.remove(path.join(root, "src/old.ts"));
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: src/old.ts was deleted since this note was written",
      );
      writeFile(root, "src/old.ts", "old\n");
      writeFile(root, "src/later.ts", "later\n");
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: src/later.ts is new since this note was written",
      );
      yield* fs.remove(path.join(root, "src/old.ts"));
      writeFile(root, "src/login.ts", "one\n");
      assert.equal(
        yield* freshness(root, note, true),
        "maybe outdated: content of src/login.ts (+0 -1 lines), src/old.ts (deleted), src/later.ts (new) changed since this note was written",
      );
    }).pipe(Effect.provide(GitLayer)),
  );
});

describe("hashFiles", () => {
  it.effect("hashes files from the folder holding .team when it is a subfolder of the repo", () =>
    Effect.gen(function* () {
      const repo = yield* tempDir;
      const path = yield* Path.Path;
      initRepo(repo, { "app/src/db.ts": "db1\n" });
      const note = yield* noteNow(path.join(repo, "app"), ["src/db.ts"]);
      assert.deepEqual(note.fileHashes, { "src/db.ts": git(repo, "hash-object", "app/src/db.ts") });
    }).pipe(Effect.provide(GitLayer)),
  );
});

describe("checkFreshness with a commit only", () => {
  it.effect("is fresh, maybe outdated, or not merged yet from the commit", () =>
    Effect.gen(function* () {
      const root = yield* tempDir;
      const base = initRepo(root, { "src/db.ts": "db1\n", "src/other.ts": "o1\n" });
      const decision = { files: ["src/db.ts"], commit: base, fileHashes: null };
      assert.equal(yield* freshness(root, decision, false), FRESHNESS.fresh);

      writeFile(root, "src/other.ts", "o2\n");
      commitAll(root, "other");
      assert.equal(yield* freshness(root, decision, false), FRESHNESS.fresh);

      // Uncommitted edits count too.
      writeFile(root, "src/db.ts", "db2\n");
      assert.equal(
        yield* freshness(root, decision, false),
        `maybe outdated: content of src/db.ts changed since commit ${base.slice(0, 7)}, when this was written (+1 -1 lines)`,
      );

      git(root, "checkout", "--quiet", "-b", "side", base);
      git(root, "commit", "--quiet", "--allow-empty", "-m", "side");
      const sideCommit = git(root, "rev-parse", "HEAD");
      git(root, "checkout", "--quiet", "main");
      assert.equal(
        yield* freshness(root, { ...decision, commit: sideCommit }, false),
        `not merged yet: commit ${sideCommit.slice(0, 7)}, which this was written at, is not in your copy's history`,
      );
      assert.equal(
        yield* freshness(root, { ...decision, commit: "f".repeat(40) }, false),
        "not merged yet: this repo does not have commit fffffff, which this was written at",
      );
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("checks paths from the folder holding .team when it is a subfolder of the repo", () =>
    Effect.gen(function* () {
      const repo = yield* tempDir;
      const path = yield* Path.Path;
      const base = initRepo(repo, { "app/src/db.ts": "db1\n" });
      writeFile(repo, "app/src/db.ts", "db2\n");
      assert.equal(
        yield* freshness(
          path.join(repo, "app"),
          { files: ["src/db.ts"], commit: base, fileHashes: null },
          false,
        ),
        `maybe outdated: content of src/db.ts changed since commit ${base.slice(0, 7)}, when this was written (+1 -1 lines)`,
      );
    }).pipe(Effect.provide(GitLayer)),
  );
});

describe("checkFreshness when it cannot tell", () => {
  it.effect(
    "says unknown without files, without a commit or hashes, outside Git, or on failure",
    () =>
      Effect.gen(function* () {
        const repo = yield* tempDir;
        const base = initRepo(repo, { "a.ts": "1\n" });
        assert.equal(
          yield* freshness(repo, { files: [], commit: base, fileHashes: null }, false),
          "unknown: the note names no files to check",
        );
        assert.equal(
          yield* freshness(repo, { files: ["a.ts"], commit: null, fileHashes: null }, false),
          "unknown: no commit or file contents were stored to compare with",
        );
        const plain = yield* tempDir;
        writeFile(plain, "a.ts", "1\n");
        assert.equal(
          yield* freshness(plain, { files: ["a.ts"], commit: base, fileHashes: null }, false),
          "unknown: your folder is not a Git checkout",
        );
        assert.equal(
          yield* freshness(
            "/nonexistent/t3-team-memory",
            { files: ["a.ts"], commit: base, fileHashes: { "a.ts": "abc" } },
            false,
          ),
          FRESHNESS.unknown(UNKNOWN_WHY.checkFailed),
        );
      }).pipe(Effect.provide(GitLayer)),
  );
});
