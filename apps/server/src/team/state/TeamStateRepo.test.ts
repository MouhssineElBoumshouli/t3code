// @effect-diagnostics nodeBuiltinImport:off - synchronous renames to take origin offline.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TEAM_STATE_REF } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { git } from "../testing/gitRepo.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { TeamStorageError } from "../TeamErrors.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as TeamStateRepo from "./TeamStateRepo.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-state-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const author = { name: "Test", email: "test@example.com" };
const syncInput = { message: "team state", author };

/** A local bare `origin` reached over file:// (real Git protocol, no network), and a place for writers. */
const bench = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-state-" });
  const origin = path.join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", origin);
  // Log every update of the ref, so the test can check each one was a fast-forward.
  git(origin, "config", "core.logAllRefUpdates", "always");
  const pushes: Array<ReadonlyArray<string>> = [];
  /**
   * A writer: its own bare state repo, with a Git driver that records push
   * arguments and can run `beforeFirstPush` once, between its fetch and push.
   */
  const writer = (name: string, beforeFirstPush?: Effect.Effect<unknown, TeamStorageError>) =>
    Effect.gen(function* () {
      const real = yield* GitVcsDriver.GitVcsDriver;
      let pending = beforeFirstPush;
      const recording: GitVcsDriver.GitVcsDriver["Service"] = {
        ...real,
        execute: (input) => {
          if (input.args[0] !== "push") return real.execute(input);
          pushes.push(input.args);
          const before = pending ?? Effect.void;
          pending = undefined;
          return before.pipe(Effect.orDie, Effect.andThen(real.execute(input)));
        },
      };
      return yield* TeamStateRepo.make({
        directory: path.join(root, `${name}.git`),
        remoteUrl: NodeURL.pathToFileURL(origin).href,
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, recording));
    });
  /** The files on origin's state ref. */
  const originFiles = () =>
    git(origin, "ls-tree", "-r", "--name-only", TEAM_STATE_REF).split("\n").filter(Boolean);
  /** Every update of origin's ref was a fast-forward, and no push asked for force. */
  const assertOnlyFastForwards = () => {
    const tips = git(origin, "reflog", "show", "--format=%H", TEAM_STATE_REF)
      .split("\n")
      .toReversed();
    for (const [index, tip] of tips.entries()) {
      const parents = git(origin, "rev-list", "--parents", "-n", "1", tip).split(" ").slice(1);
      if (index === 0) {
        assert.deepEqual(parents, [], "the first commit starts the ref");
      } else {
        assert.deepEqual(parents, [tips[index - 1]], "each commit sits on the one before");
      }
    }
    for (const args of pushes) {
      assert.isFalse(args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("+")));
    }
    return tips.length;
  };
  return { root, origin, writer, originFiles, assertOnlyFastForwards, pushes };
});

/** A writer that starts the team: `team.json` on a new ref. */
const startTeam = (repo: TeamStateRepo.TeamStateRepo) =>
  Effect.gen(function* () {
    yield* repo.saveMine("team.json", '{ "format": 1 }\n');
    return yield* repo.sync({ ...syncInput, create: true });
  });

describe("TeamStateRepo", () => {
  it.effect("starts the state only when asked, and pushes nothing when nothing changed", () =>
    Effect.gen(function* () {
      const { writer, originFiles, assertOnlyFastForwards } = yield* bench;
      const sara = yield* writer("sara");

      yield* sara.saveMine("team.json", '{ "format": 1 }\n');
      assert.deepEqual(yield* sara.sync(syncInput), {
        confirmed: false,
        reason: "missing",
        attempts: 0,
      });
      const started = yield* sara.sync({ ...syncInput, create: true });
      assert.isTrue(started.confirmed);
      assert.deepEqual(originFiles(), ["team.json"]);

      const again = yield* sara.sync(syncInput);
      assert.deepEqual(again, started.confirmed ? { ...started, attempts: 0 } : started);
      assert.equal(assertOnlyFastForwards(), 1, "the second sync made no commit");
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("lands two writers pushing at once, without force", () =>
    Effect.gen(function* () {
      const { writer, originFiles, assertOnlyFastForwards, pushes } = yield* bench;
      const sara = yield* writer("sara");
      const yassine = yield* writer("yassine");
      assert.isTrue((yield* startTeam(sara)).confirmed);

      yield* sara.saveMine("writers/sara/env-a.json", '{ "claims": ["src/a.ts"] }\n');
      yield* yassine.saveMine("writers/yassine/env-b.json", '{ "claims": ["src/b.ts"] }\n');
      const results = yield* Effect.all([sara.sync(syncInput), yassine.sync(syncInput)], {
        concurrency: "unbounded",
      });

      assert.deepEqual(
        results.map((result) => result.confirmed),
        [true, true],
      );
      assert.deepEqual(originFiles(), [
        "team.json",
        "writers/sara/env-a.json",
        "writers/yassine/env-b.json",
      ]);
      assert.equal(assertOnlyFastForwards(), 3);
      assert.isAtLeast(pushes.length, 3);

      // Each reads the other's file after a fetch; its own file comes from disk.
      yield* sara.fetch();
      const seen = yield* sara.read;
      assert.equal(seen.files.get("writers/yassine/env-b.json"), '{ "claims": ["src/b.ts"] }\n');
      assert.equal(seen.files.get("writers/sara/env-a.json"), '{ "claims": ["src/a.ts"] }\n');
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("redoes a push refused for being behind", () =>
    Effect.gen(function* () {
      const { writer, originFiles, assertOnlyFastForwards } = yield* bench;
      const sara = yield* writer("sara");
      assert.isTrue((yield* startTeam(sara)).confirmed);
      yield* sara.saveMine("writers/sara/env-a.json", '{ "claims": ["src/a.ts"] }\n');
      // Sara's push lands after Yassine fetched and before he pushes.
      const yassine = yield* writer("yassine", sara.sync(syncInput));
      yield* yassine.saveMine("writers/yassine/env-b.json", '{ "claims": ["src/b.ts"] }\n');

      const result = yield* yassine.sync(syncInput);

      assert.deepEqual(result.confirmed && result.attempts, 2);
      assert.deepEqual(originFiles(), [
        "team.json",
        "writers/sara/env-a.json",
        "writers/yassine/env-b.json",
      ]);
      assert.equal(assertOnlyFastForwards(), 3);
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("keeps a write while origin is unreachable, and a later sync lands it", () =>
    Effect.gen(function* () {
      const { writer, origin, originFiles, assertOnlyFastForwards } = yield* bench;
      const sara = yield* writer("sara");
      const yassine = yield* writer("yassine");
      assert.isTrue((yield* startTeam(sara)).confirmed);

      NodeFS.renameSync(origin, `${origin}.offline`);
      yield* yassine.saveMine("writers/yassine/env-b.json", '{ "claims": ["src/b.ts"] }\n');
      const offline = yield* yassine.sync(syncInput);
      assert.deepEqual(offline, { confirmed: false, reason: "unreachable", attempts: 0 });
      assert.deepEqual(yield* yassine.fetch(), { status: "unreachable" });
      // Still his on this computer.
      const kept = yield* yassine.read;
      assert.equal(kept.files.get("writers/yassine/env-b.json"), '{ "claims": ["src/b.ts"] }\n');

      NodeFS.renameSync(`${origin}.offline`, origin);
      const online = yield* yassine.sync(syncInput);
      assert.isTrue(online.confirmed);
      assert.deepEqual(originFiles(), ["team.json", "writers/yassine/env-b.json"]);
      assert.equal(assertOnlyFastForwards(), 2);
    }).pipe(Effect.provide(GitLayer)),
  );

  it.effect("refuses to save outside the state tree", () =>
    Effect.gen(function* () {
      const { writer } = yield* bench;
      const sara = yield* writer("sara");
      for (const file of ["../escape.json", "writers//a.json", "/abs.json", "writers/./a.json"]) {
        const error = yield* sara.saveMine(file, "{}").pipe(Effect.flip);
        assert.equal(error._tag, "TeamStorageError");
      }
    }).pipe(Effect.provide(GitLayer)),
  );
});
