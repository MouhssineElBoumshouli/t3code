// @effect-diagnostics nodeBuiltinImport:off - synchronous file checks on the combine copy.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  type TeamCombinedCheck,
  TeamMemberId,
  type TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as TeamCombineCheck from "./TeamCombineCheck.ts";
import * as TeamMergeCheck from "./TeamMergeCheck.ts";
import { commitAll, git, initRepo, writeFile } from "./testing/gitRepo.ts";
import { TestTeamGitLayer } from "./testing/teamState.ts";

const PROJECT_ID = ProjectId.make("project-combine");
const THREAD = ThreadId.make("thread-mine");
const ENVIRONMENT_ID = EnvironmentId.make("environment-combine");

/**
 * A stand-in typecheck: every `calls: X` line needs a `defines: X` line in
 * some file under `src`, written as tsc writes errors.
 */
const CHECK_SCRIPT = `
const fs = require("node:fs");
const files = fs.readdirSync("src").map((name) => "src/" + name);
const defined = new Set();
for (const file of files) for (const m of fs.readFileSync(file, "utf8").matchAll(/defines: (\\w+)/g)) defined.add(m[1]);
let failed = false;
for (const file of files) {
  fs.readFileSync(file, "utf8").split("\\n").forEach((line, index) => {
    const call = /calls: (\\w+)/.exec(line);
    if (call && !defined.has(call[1])) {
      failed = true;
      console.log(file + "(" + (index + 1) + ",1): error TS2304: Cannot find name '" + call[1] + "'.");
    }
  });
}
process.exit(failed ? 2 : 0);
`;

const makeHarness = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const root = NodeFS.mkdtempSync(NodePath.join(config.stateDir, "..", "repo with space "));
  initRepo(root, {
    "check.js": CHECK_SCRIPT,
    ".team/rulebook.md": `# Rules\n\n## Check\n\n\`"${process.execPath}" check.js\`\n`,
    "src/user.js": "defines: getUser\n",
    // Already broken on main: never reported as new.
    "src/old.js": "calls: legacy\n",
  });
  git(root, "checkout", "--quiet", "-b", "sara", "main");
  writeFile(root, "src/user.js", "defines: fetchUser\n");
  const saraCommit = commitAll(root, "Sara renames getUser");
  git(root, "checkout", "--quiet", "-b", "mine", "main");
  writeFile(root, "src/me.js", "defines: me\ncalls: getUser\n");
  const mineCommit = commitAll(root, "Me calls getUser");
  git(root, "checkout", "--quiet", "main");

  const pairOf = (mine: string, other: string): TeamMergePair => ({
    projectId: PROJECT_ID,
    mine: {
      thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD },
      title: "Me",
      worktree: true,
      commit: mine,
    },
    other: {
      _tag: "branch",
      memberId: TeamMemberId.make("sara"),
      branch: "sara",
      commit: other,
    },
    status: "clean",
    files: [],
    fileCount: 0,
    bothChanged: [],
    previous: null,
    since: "2026-10-14T10:00:00.000Z",
    checkedAt: "2026-10-14T10:00:00.000Z",
  });
  const current = yield* Ref.make(pairOf(mineCommit, saraCommit));
  const stored = yield* Ref.make<ReadonlyArray<TeamCombinedCheck>>([]);
  const turnRunning = yield* Ref.make(false);

  const mergeCheck = TeamMergeCheck.TeamMergeCheck.of({
    forTeam: () => Effect.succeed(undefined),
    subscribeChanges: Effect.die("not used"),
    request: () => Effect.void,
    findPair: () => Ref.get(current),
    useCommitUntilNextTurn: () => Effect.void,
    takeClashLine: () => Effect.succeed(undefined),
    placeOf: () => Effect.succeedSome({ teamId: "team" as never, teamRoot: root, repoRoot: root }),
    setCombined: (_projectId, check) => Ref.update(stored, (all) => [...all, check]),
    combinedOf: (pair) =>
      Ref.get(stored).pipe(
        Effect.map((all) =>
          all.findLast(
            (check) =>
              check.mineCommit === pair.mine.commit && check.otherCommit === pair.other.commit,
          ),
        ),
      ),
  });
  const service = yield* TeamCombineCheck.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(TeamMergeCheck.TeamMergeCheck, mergeCheck),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getShellSnapshot: () =>
            Ref.get(turnRunning).pipe(
              Effect.map(
                (running) =>
                  ({
                    threads: running ? [{ projectId: PROJECT_ID, activeRunId: "run-1" }] : [],
                  }) as never,
              ),
            ),
        }),
        TestTeamGitLayer,
      ),
    ),
  );
  const request = {
    projectId: PROJECT_ID,
    threadId: THREAD,
    other: pairOf(mineCommit, saraCommit).other,
    install: true,
  };
  return {
    root,
    config,
    service,
    request,
    mineCommit,
    saraCommit,
    pairOf,
    setPair: (pair: TeamMergePair) => Ref.set(current, pair),
    setTurnRunning: (running: boolean) => Ref.set(turnRunning, running),
    stored: Ref.get(stored),
  };
});

const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-combine-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("TeamCombineCheck", () => {
  it.layer(TestLayer)((it) => {
    it.effect(
      "finds the rename on one side and the call on the other, and nothing old; the copy is kept",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const result = yield* h.service.run(h.request);
          assert.equal(result.status, "broken");
          assert.equal(result.errorCount, 1);
          assert.deepEqual(result.errors, [
            {
              path: "src/me.js",
              line: 2,
              message: "Cannot find name 'getUser'.",
              name: "getUser",
              side: "mine",
            },
          ]);
          // The line showed it running first.
          assert.deepEqual(
            (yield* h.stored).map((check) => check.status),
            ["running", "broken"],
          );
          // The person's checkout is untouched.
          assert.equal(git(h.root, "status", "--porcelain"), "");
          assert.equal(git(h.root, "rev-parse", "--abbrev-ref", "HEAD"), "main");

          // A finished check for the same commits is reused.
          assert.deepEqual(yield* h.service.run(h.request), result);
          assert.equal((yield* h.stored).length, 2);

          // The copy stays: installed files remain and unchanged files are not rewritten.
          const copy = NodePath.join(h.config.stateDir, "team", "combine", PROJECT_ID);
          writeFile(copy, "node_modules/kept.txt", "kept\n");
          const before = NodeFS.statSync(NodePath.join(copy, "check.js")).mtimeMs;
          git(h.root, "checkout", "--quiet", "mine");
          writeFile(h.root, "src/me.js", "calls: fetchUser\n");
          const fixedCommit = commitAll(h.root, "Me calls fetchUser");
          git(h.root, "checkout", "--quiet", "main");
          yield* h.setPair(h.pairOf(fixedCommit, h.saraCommit));
          const fixed = yield* h.service.run(h.request);
          assert.equal(fixed.status, "clean");
          assert.isTrue(NodeFS.existsSync(NodePath.join(copy, "node_modules", "kept.txt")));
          assert.equal(NodeFS.statSync(NodePath.join(copy, "check.js")).mtimeMs, before);
        }),
    );

    it.effect("does not start while an agent works in the project", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.setTurnRunning(true);
        const result = yield* h.service.run(h.request);
        assert.equal(result.status, "skipped");
        assert.equal(result.skip, "turnRunning");
        // Nothing ran: the line goes straight to the skip.
        assert.deepEqual(
          (yield* h.stored).map((check) => check.status),
          ["skipped"],
        );
      }),
    );
  });
});
