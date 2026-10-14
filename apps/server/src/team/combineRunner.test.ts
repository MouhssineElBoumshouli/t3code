// @effect-diagnostics nodeBuiltinImport:off - checks the processes the runner started.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runCombineCommand } from "./combineRunner.ts";

/** A folder with a space in its name, removed after the test. */
const tempFolder = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 combine runner "))),
  (folder) => Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
);

const node = `"${process.execPath}"`;

/** Running, not a zombie waiting to be reaped. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/\) Z /u.test(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

describe("runCombineCommand", () => {
  it.effect("runs in the folder at the lowest priority and reads the errors", () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder;
      NodeFS.writeFileSync(
        NodePath.join(folder, "check.js"),
        [
          'const os = require("node:os");',
          'console.log("priority " + os.getPriority());',
          "console.log(\"src/me.ts(3,10): error TS2304: Cannot find name 'getUser'.\");",
          "process.exit(2);",
        ].join("\n"),
      );
      const ran = yield* runCombineCommand({
        command: `${node} check.js`,
        cwd: folder,
        timeoutMs: 30_000,
      });
      assert.equal(ran.exitCode, 2);
      assert.isFalse(ran.timedOut);
      assert.include(ran.output.tail, `priority ${NodeOS.constants.priority.PRIORITY_LOW}`);
      assert.deepEqual(
        ran.output.errors.map((error) => error.path),
        ["src/me.ts"],
      );
    }),
  );

  it.effect("stops at the timeout and kills the whole tree it started", () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder;
      const pidFile = NodePath.join(folder, "grandchild.pid");
      // The child starts a grandchild that never ends, then never ends itself. The grandchild
      // shares the output pipe, as a tool's children do, so the run ends once it is gone too.
      NodeFS.writeFileSync(
        NodePath.join(folder, "hang.js"),
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] });',
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const ran = yield* runCombineCommand({
        command: `${node} hang.js`,
        cwd: folder,
        timeoutMs: 1_500,
      });
      assert.isTrue(ran.timedOut);
      assert.equal(ran.exitCode, null);
      const grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
      assert.isFalse(alive(ran.pid!));
      assert.isFalse(alive(grandchild));
    }),
  );

  it.effect("says when the command cannot start", () =>
    Effect.gen(function* () {
      const ran = yield* runCombineCommand({
        command: "echo hi",
        cwd: NodePath.join(NodeOS.tmpdir(), "t3-no-such-folder-for-combine"),
        timeoutMs: 5_000,
      });
      assert.equal(ran.exitCode, null);
      assert.isDefined(ran.spawnError);
    }),
  );
});
