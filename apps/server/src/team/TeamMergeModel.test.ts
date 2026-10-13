import {
  EnvironmentId,
  ProjectId,
  TeamMemberId,
  type TeamMergeMine,
  type TeamMergeOther,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { MergeTreeResult } from "./mergeTree.ts";
import { MERGE_CHECK_DEBOUNCE, makeBatcher } from "./TeamMergeCheck.ts";
import {
  BoundedCache,
  type CheckedPair,
  mergingView,
  nextPair,
  pairKey,
  type PairSides,
} from "./TeamMergeModel.ts";

const PROJECT = ProjectId.make("project-1");
const mine = (commit: string): TeamMergeMine => ({
  thread: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("login") },
  title: "login",
  worktree: true,
  commit,
});
const sara = (commit: string): TeamMergeOther => ({
  _tag: "branch",
  memberId: TeamMemberId.make("sara"),
  branch: "search",
  commit,
});

const sides = (ours: string, theirs: string, at: string): PairSides => ({
  projectId: PROJECT,
  mine: mine(ours),
  other: sara(theirs),
  mineTree: `tree-${ours}`,
  otherTree: `tree-${theirs}`,
  newerCommitAt: at,
});

const CLASH: MergeTreeResult = {
  tree: "merged",
  conflicts: [{ path: "src/routes.ts", places: 2, regenerate: false }],
};
const CLEAN: MergeTreeResult = { tree: "merged", conflicts: [] };

const step = (
  previous: CheckedPair | undefined,
  pairSides: PairSides,
  result: MergeTreeResult,
  now = "2026-10-13T10:00:00.000Z",
) => nextPair({ previous, sides: pairSides, result, toTeamPath: (path) => path, now });

describe("TeamMergeModel", () => {
  it("dates a first clash from the newer commit and keeps it while the status stays", () => {
    const first = step(undefined, sides("a1", "b1", "2026-10-13T09:00:00.000Z"), CLASH);
    assert.deepEqual(
      [first.shown, first.pair.status, first.pair.previous, first.pair.since, first.pair.files],
      [
        true,
        "clash",
        null,
        "2026-10-13T09:00:00.000Z",
        [{ path: "src/routes.ts", places: 2, regenerate: false }],
      ],
    );
    // A new commit with the same clash: not a change of state.
    const again = step(first, sides("a2", "b1", "2026-10-13T09:30:00.000Z"), CLASH);
    assert.deepEqual(
      [again.pair.since, again.pair.previous, again.pair.mine.commit],
      ["2026-10-13T09:00:00.000Z", null, "a2"],
    );
    // It ends: a change of state.
    const ended = step(again, sides("a3", "b1", "2026-10-13T09:45:00.000Z"), CLEAN);
    assert.deepEqual(
      [ended.pair.status, ended.pair.previous, ended.pair.since],
      ["clean", "clash", "2026-10-13T09:45:00.000Z"],
    );
  });

  it("keeps the record when both commits are the same, without checking", () => {
    const first = step(undefined, sides("a1", "b1", "2026-10-13T09:00:00.000Z"), CLASH);
    // Even a different result is ignored: same commits, same answer.
    const same = step(first, sides("a1", "b1", "2026-10-13T09:00:00.000Z"), CLEAN, "later");
    assert.deepEqual(same, first);
  });

  it("hides a clean pair where one side holds the other, except when a clash just ended", () => {
    const holds: MergeTreeResult = { tree: "tree-a1", conflicts: [] };
    assert.isFalse(step(undefined, sides("a1", "b1", "t"), holds).shown);
    assert.isTrue(step(undefined, sides("a1", "b1", "t"), CLEAN).shown);
    const clash = step(undefined, sides("a0", "b1", "t"), CLASH);
    const merged = step(clash, sides("a1", "b1", "t2"), holds);
    assert.isTrue(merged.shown);
    const later = step(merged, sides("a2", "b1", "t3"), { tree: "tree-a2", conflicts: [] });
    assert.isFalse(later.shown);
  });

  it("names a pair by its chat and what it merges with, not by commits", () => {
    assert.equal(
      pairKey(PROJECT, mine("a1"), sara("b1")),
      pairKey(PROJECT, mine("a2"), sara("b2")),
    );
    assert.notEqual(
      pairKey(PROJECT, { ...mine("a1"), worktree: false }, sara("b1")),
      pairKey(PROJECT, mine("a1"), sara("b1")),
    );
  });

  it("orders the view clashes first, newest first, and leaves out hidden pairs", () => {
    const clean = step(undefined, sides("a1", "b1", "2026-10-13T09:50:00.000Z"), CLEAN);
    const old = step(undefined, sides("a2", "b2", "2026-10-13T08:00:00.000Z"), CLASH);
    const recent = step(undefined, sides("a3", "b3", "2026-10-13T09:00:00.000Z"), CLASH);
    const hidden = step(undefined, sides("a4", "b4", "t"), { tree: "tree-a4", conflicts: [] });
    assert.deepEqual(
      mergingView([clean, old, recent, hidden], undefined)?.pairs.map((pair) => pair.mine.commit),
      ["a3", "a2", "a1"],
    );
    assert.equal(mergingView([hidden], undefined), undefined);
    assert.deepEqual(mergingView([clean], "Git too old"), {
      unavailable: "Git too old",
      pairs: [],
    });
  });

  it("forgets the least recently used result past its limit", () => {
    const cache = new BoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    assert.deepEqual(
      [cache.get("a"), cache.get("b"), cache.get("c"), cache.size],
      [1, undefined, 3, 2],
    );
  });

  it.effect("batches requests for 30 seconds, and starts a new batch after", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = [];
      const { request } = yield* makeBatcher(MERGE_CHECK_DEBOUNCE, (keys: ReadonlyArray<string>) =>
        Effect.sync(() => void batches.push(keys)),
      );
      yield* request("project-a");
      yield* TestClock.adjust(Duration.seconds(10));
      yield* request("project-b");
      yield* request("project-a");
      yield* TestClock.adjust(Duration.seconds(19));
      assert.deepEqual(batches, []);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.deepEqual(batches, [["project-a", "project-b"]]);
      yield* request("project-a");
      yield* TestClock.adjust(MERGE_CHECK_DEBOUNCE);
      assert.deepEqual(batches, [["project-a", "project-b"], ["project-a"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("never runs two batches at once", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const { request } = yield* makeBatcher(Duration.seconds(1), (keys: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          log.push(`start ${keys.join(",")}`);
          yield* Effect.sleep(Duration.seconds(5));
          log.push(`end ${keys.join(",")}`);
        }),
      );
      yield* request("a");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* request("b");
      yield* TestClock.adjust(Duration.seconds(2));
      assert.deepEqual(log, ["start a"]);
      yield* TestClock.adjust(Duration.seconds(10));
      assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
    }).pipe(Effect.scoped),
  );
});
