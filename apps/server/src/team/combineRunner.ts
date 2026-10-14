// @effect-diagnostics nodeBuiltinImport:off - needs the child's PID for its priority and to kill its tree.
/**
 * Runs one command of the combined check (fork-only, team/MERGE_HELP_PLAN.md
 * section 2) as gently as this laptop needs:
 *
 * - Lowest priority (`os.setPriority`: nice 19, or idle class on Windows): a
 *   small Node launcher lowers its own before it starts the command, so every
 *   child inherits it.
 * - A timeout; then the whole tree is killed by that PID: its process group
 *   on Unix (it is started as a group leader), `taskkill /T` on Windows.
 *   Never by name.
 * - The command runs in the platform's shell (`sh` or `cmd.exe`), since the
 *   rulebook's command is a line a person wrote; it is passed as one argument
 *   and the folder as `cwd`, so spaces in paths need no quoting.
 *
 * @module combineRunner
 */
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { CheckOutput } from "./combineCheck.ts";

export interface CombineRun {
  /** Null when it was killed or could not start. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Why it could not start. */
  readonly spawnError: string | undefined;
  readonly output: CheckOutput;
  /** The PID it ran as, for logs and tests. */
  readonly pid: number | undefined;
}

/** Kills the tree started as `pid`. */
const killTree = (pid: number, windows: boolean) => {
  try {
    if (windows) {
      NodeChildProcess.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
};

/**
 * Lowers its own priority, then runs the command line in the platform's shell
 * with the same output; children inherit the priority, so nothing races it.
 * Under Electron the server's binary runs as Node only for this launcher.
 */
const LAUNCHER = [
  'const os = require("node:os");',
  "try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {}",
  "delete process.env.ELECTRON_RUN_AS_NODE;",
  'const child = require("node:child_process").spawn(process.argv[1], { shell: true, stdio: "inherit", windowsHide: true });',
  'child.on("error", (error) => { console.error(error.message); process.exit(127); });',
  'child.on("exit", (code) => process.exit(code ?? 1));',
].join("\n");

export const runCombineCommand = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}) =>
  Effect.flatMap(HostProcess.isWindows, (windows) =>
    Effect.callback<CombineRun>((resume) => {
      const output = new CheckOutput(input.cwd);
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(process.execPath, ["-e", LAUNCHER, input.command], {
          cwd: input.cwd,
          // A group leader on Unix, so the timeout kills its children too.
          detached: !windows,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            CI: "1",
            FORCE_COLOR: "0",
            NO_COLOR: "1",
          },
        });
      } catch (error) {
        resume(
          Effect.succeed({
            exitCode: null,
            timedOut: false,
            spawnError: String(error),
            output,
            pid: undefined,
          }),
        );
        return;
      }
      const pid = child.pid;
      let timedOut = false;
      let done = false;
      // @effect-diagnostics-next-line globalTimersInEffect:off - a Node callback API; cleared on exit and on interrupt.
      const timer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) killTree(pid, windows);
      }, input.timeoutMs);
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => output.write(chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => output.write(chunk));
      const finish = (exitCode: number | null, spawnError: string | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        output.end();
        resume(Effect.succeed({ exitCode, timedOut, spawnError, output, pid }));
      };
      child.on("error", (error) => finish(null, error.message));
      child.on("close", (code) => finish(timedOut ? null : code, undefined));
      // Interrupted (the server stops): the tree goes too.
      return Effect.sync(() => {
        clearTimeout(timer);
        if (!done && pid !== undefined) killTree(pid, windows);
      });
    }),
  );
