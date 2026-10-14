/**
 * The pure part of the combined check (fork-only, team/MERGE_HELP_PLAN.md
 * section 2): which command to run, the errors in its output, which of them
 * are new, and whether a check may start.
 *
 * - Command: the rulebook's `## Check` section wins; else a `typecheck`
 *   script, `tsc --noEmit`, `cargo check` or `go vet ./...`; else none (Git
 *   conflicts only).
 * - New errors: in the combined result, but not in either side alone. Errors
 *   are matched by file and message, not line, since lines move in a merge.
 *
 * @module combineCheck
 */
import type { TeamCombinedSkip } from "@t3tools/contracts";

/** At least this much free memory, or the check does not start. */
export const COMBINE_MIN_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;
/** The whole check (install, combined, each side) stops after this. */
export const COMBINE_TIMEOUT_MS = 10 * 60 * 1000;
/** Output lines kept from a run. */
export const COMBINE_TAIL_LINES = 200;
/** Errors read from one run; past this the rest are counted only. */
const MAX_PARSED_ERRORS = 2000;
const MESSAGE_LENGTH = 200;

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/** Lockfiles at the check folder, the first found decides the package manager. */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

const runScript = (manager: PackageManager, script: string) =>
  manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;

/**
 * The command when the rulebook names none. `has` says whether a file exists
 * in the check folder; `packageJson` is its text when there is one.
 */
export function detectCheckCommand(input: {
  readonly packageJson: string | undefined;
  readonly has: (file: string) => boolean;
}): string | undefined {
  if (input.packageJson !== undefined) {
    const manager = LOCKFILES.find(([file]) => input.has(file))?.[1] ?? "npm";
    let scripts: unknown;
    try {
      scripts = (JSON.parse(input.packageJson) as { scripts?: unknown }).scripts;
    } catch {
      scripts = undefined;
    }
    if (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).typecheck === "string"
    ) {
      return runScript(manager, "typecheck");
    }
  }
  // `--no` never downloads a missing TypeScript.
  if (input.has("tsconfig.json")) return "npx --no -- tsc --noEmit";
  if (input.has("Cargo.toml")) return "cargo check";
  if (input.has("go.mod")) return "go vet ./...";
  return undefined;
}

/** The install a JavaScript project needs before its check; undefined when it needs none. */
export function installCommand(input: {
  readonly packageJson: string | undefined;
  readonly has: (file: string) => boolean;
}): string | undefined {
  if (input.packageJson === undefined) return undefined;
  const manager = LOCKFILES.find(([file]) => input.has(file))?.[1];
  switch (manager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    case "npm":
      return "npm ci";
    case undefined: {
      let deps = false;
      try {
        const parsed = JSON.parse(input.packageJson) as Record<string, unknown>;
        deps = ["dependencies", "devDependencies"].some(
          (key) => typeof parsed[key] === "object" && Object.keys(parsed[key] as object).length > 0,
        );
      } catch {
        deps = false;
      }
      return deps ? "npm install" : undefined;
    }
  }
}

export interface CheckError {
  /** Relative to the check folder, with `/`. */
  readonly path: string | undefined;
  readonly line: number | undefined;
  readonly code: string | undefined;
  readonly message: string;
}

const TSC = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/u;
/** `path:line[:col]: message`, as ESLint's unix format, Go and most compilers write it. */
const PLAIN = /^([^\s:][^:]*\.[A-Za-z0-9]+):(\d+)(?::\d+)?:\s*(?:error:?\s*)?(.+)$/u;
const RUST_ERROR = /^error(?:\[(E\d+)\])?: (.+)$/u;
const RUST_AT = /^\s*--> (.+?):(\d+):\d+$/u;

/** A path as the tool wrote it, relative to the check folder with `/`. */
const relativePath = (raw: string, folder: string) => {
  const slashed = raw.trim().replaceAll("\\", "/");
  const base = `${folder.replaceAll("\\", "/").replace(/\/+$/u, "")}/`;
  const relative = slashed.toLowerCase().startsWith(base.toLowerCase())
    ? slashed.slice(base.length)
    : slashed;
  return relative.replace(/^\.\//u, "");
};

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MESSAGE_LENGTH ? `${flat.slice(0, MESSAGE_LENGTH - 1)}…` : flat;
};

/**
 * Reads a run's output line by line: its errors (tsc, `path:line: message`,
 * Rust) and the last lines. `folder` is where the command ran, so absolute
 * paths become relative.
 */
export class CheckOutput {
  readonly errors: Array<CheckError> = [];
  readonly tail: Array<string> = [];
  /** Errors past the parsed cap. */
  uncounted = 0;
  private partial = "";
  private rust: { code: string | undefined; message: string } | undefined;
  private readonly folder: string;

  constructor(folder: string) {
    this.folder = folder;
  }

  write(chunk: string) {
    const lines = (this.partial + chunk).split(/\r?\n/u);
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  end() {
    if (this.partial.length > 0) this.line(this.partial);
    this.partial = "";
    this.flushRust(undefined, undefined);
  }

  private add(error: CheckError) {
    if (this.errors.length < MAX_PARSED_ERRORS) this.errors.push(error);
    else this.uncounted++;
  }

  private flushRust(path: string | undefined, line: number | undefined) {
    if (this.rust === undefined) return;
    this.add({ path, line, code: this.rust.code, message: this.rust.message });
    this.rust = undefined;
  }

  private line(raw: string) {
    // Colors, if a tool ignores that it writes to a pipe.
    // oxlint-disable-next-line no-control-regex
    const text = raw.replace(/\u001b\[[0-9;]*m/gu, "");
    this.tail.push(text);
    if (this.tail.length > COMBINE_TAIL_LINES) this.tail.shift();

    const at = RUST_AT.exec(text);
    if (at !== null && this.rust !== undefined) {
      return this.flushRust(relativePath(at[1]!, this.folder), Number(at[2]));
    }
    const rust = RUST_ERROR.exec(text);
    if (rust !== null) {
      this.flushRust(undefined, undefined);
      // Cargo's closing summary is not an error of its own.
      if (/^could not compile|^aborting due to/u.test(rust[2]!)) return;
      this.rust = { code: rust[1], message: oneLine(rust[2]!) };
      return;
    }
    const tsc = TSC.exec(text);
    if (tsc !== null) {
      return this.add({
        path: relativePath(tsc[1]!, this.folder),
        line: Number(tsc[2]),
        code: tsc[3],
        message: oneLine(tsc[4]!),
      });
    }
    const plain = PLAIN.exec(text);
    if (plain !== null) {
      this.add({
        path: relativePath(plain[1]!, this.folder),
        line: Number(plain[2]),
        code: undefined,
        message: oneLine(plain[3]!),
      });
    }
  }
}

const errorKey = (error: CheckError) => `${error.path ?? ""}|${error.code ?? ""}|${error.message}`;

/**
 * Errors in the combined result that neither side has alone. Matched by file,
 * code and message; an error that shows up more often combined than on
 * either side counts for the extra times.
 */
export function newErrors(
  combined: ReadonlyArray<CheckError>,
  mine: ReadonlyArray<CheckError>,
  other: ReadonlyArray<CheckError>,
): ReadonlyArray<CheckError> {
  const counts = (errors: ReadonlyArray<CheckError>) => {
    const map = new Map<string, number>();
    for (const error of errors) map.set(errorKey(error), (map.get(errorKey(error)) ?? 0) + 1);
    return map;
  };
  const mineCounts = counts(mine);
  const otherCounts = counts(other);
  const seen = new Map<string, number>();
  return combined.filter((error) => {
    const key = errorKey(error);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > Math.max(mineCounts.get(key) ?? 0, otherCounts.get(key) ?? 0);
  });
}

/** The name an error says is missing, and the one it suggests: "Cannot find name 'getUser'. Did you mean 'fetchUser'?". */
export function missingName(message: string): { name: string; suggestion?: string } | undefined {
  const missing =
    /^(?:Cannot find name|Module .+ has no exported member(?: named)?|Property) '([^']+)'/u.exec(
      message,
    ) ?? /^cannot find (?:value|function|type|struct) `([^`]+)`/u.exec(message);
  if (missing === null) return undefined;
  const suggestion = /Did you mean '([^']+)'\?/u.exec(message)?.[1];
  return suggestion === undefined ? { name: missing[1]! } : { name: missing[1]!, suggestion };
}

/**
 * Whether a check may start; undefined when it may. Checked before the
 * combine copy is touched: one check at a time, no agent working in the
 * project, enough free memory. "Check now" skips no rule here.
 */
export function startGate(input: {
  readonly busy: boolean;
  readonly turnRunning: boolean;
  readonly freeBytes: number;
}): TeamCombinedSkip | undefined {
  if (input.busy) return "busy";
  if (input.turnRunning) return "turnRunning";
  if (input.freeBytes < COMBINE_MIN_FREE_BYTES) return "memory";
  return undefined;
}

/**
 * Whether the check can run once the combined result is in the copy: a
 * command was found, and the dependencies are installed (`install` is true for
 * "Check now", which installs them; the check before an update does not).
 */
export function runGate(input: {
  readonly command: string | undefined;
  readonly dependenciesChanged: boolean;
  readonly install: boolean;
}): TeamCombinedSkip | undefined {
  if (input.command === undefined) return "noCommand";
  if (input.dependenciesChanged && !input.install) return "dependencies";
  return undefined;
}
