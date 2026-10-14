// @effect-diagnostics nodeBuiltinImport:off - free memory comes from `os.freemem`.
/**
 * Typecheck on the combined result (fork-only, team/MERGE_HELP_PLAN.md
 * section 2): runs the project's check command on a pair that Git merges
 * cleanly, and reports only the errors that neither side has alone. It runs
 * on "Check now" and once before an update, never on its own.
 *
 * - Where: one combine copy per project, `<stateDir>/team/combine/<project>`,
 *   a detached worktree of the project's repo, kept between runs. Never the
 *   repo itself, never a chat's copy. Each run puts a tree in it with
 *   `git read-tree -u --reset`, which rewrites only the files that differ, so
 *   `node_modules` and incremental build data stay.
 * - Command: the rulebook's `## Check` section (read from the combined
 *   result), else detected (`combineCheck`); none means Git conflicts only.
 * - Dependencies: installed with the lockfile's package manager when the
 *   lockfile changed since the last install; only on "Check now". The check
 *   before an update skips and says so.
 * - Gates: one check at a time, no agent working in the project, at least
 *   1.5 GB free memory. Each command runs at the lowest priority, and the
 *   whole check stops after 10 minutes (`combineRunner`).
 * - New errors only: when the combined result fails, each side runs alone
 *   (cached per commit and command, so the base is checked once) and errors
 *   either side has are left out.
 *
 * Results go on the pair (`TeamMergeCheck.setCombined`) while both commits stay.
 * The same check also runs on a fix's result (`checkResult`): the files a "Fix
 * it" turn left in the chat's copy, against the two sides it merged.
 *
 * @module TeamCombineCheck
 */
import * as NodeOS from "node:os";

import {
  type ProjectId,
  TEAM_MERGE_LIMITS,
  type TeamCombinedCheck as TeamCombinedCheckView,
  type TeamCombinedError,
  type TeamCombinedSkip,
  TeamMergeFixError,
  type TeamMergeOther,
  type TeamMergePair,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { readCheckCommand } from "../mcp/toolkits/team/rulebook.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  type CheckError,
  COMBINE_TIMEOUT_MS,
  detectCheckCommand,
  installCommand,
  LOCKFILES,
  missingName,
  newErrors,
  runGate,
  startGate,
} from "./combineCheck.ts";
import { type CombineRun, runCombineCommand } from "./combineRunner.ts";
import { mergeTree } from "./mergeTree.ts";
import { diffToTeamPaths } from "./TeamAutoNotes.ts";
import { BoundedCache } from "./TeamMergeModel.ts";
import * as TeamMergeCheck from "./TeamMergeCheck.ts";

const GIT_TIMEOUT_MS = 120_000;
const SIDE_CACHE_SIZE = 200;

export interface CombineRequest {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly other: TeamMergeOther;
  /** "Check now": installs changed dependencies. The check before an update does not. */
  readonly install: boolean;
}

/** The two commits a check combines; `tree`, when set, is the result to check instead of their merge. */
interface Sides {
  readonly mine: string;
  readonly other: string;
  readonly tree?: string;
}

export interface ResultRequest {
  readonly projectId: ProjectId;
  /** The result: a tree of the chat copy's files. */
  readonly tree: string;
  readonly mineCommit: string;
  readonly otherCommit: string;
}

export class TeamCombineCheck extends Context.Service<
  TeamCombineCheck,
  {
    /** Starts the check and returns at once; the result arrives on the pair. */
    readonly start: (request: CombineRequest) => Effect.Effect<void, TeamMergeFixError>;
    /** Runs the check, or reuses a finished one for the same commits, and waits for it. */
    readonly run: (
      request: CombineRequest,
    ) => Effect.Effect<TeamCombinedCheckView, TeamMergeFixError>;
    /** Checks a fix's result and waits for it; installs changed dependencies. */
    readonly checkResult: (request: ResultRequest) => Effect.Effect<TeamCombinedCheckView>;
  }
>()("t3/team/TeamCombineCheck") {}

interface SideResult {
  readonly exitCode: number | null;
  readonly errors: ReadonlyArray<CheckError>;
}

export const make = Effect.gen(function* () {
  const mergeCheck = yield* TeamMergeCheck.TeamMergeCheck;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const scope = yield* Effect.scope;

  /** Each side alone, by `<command>|<commit>`. */
  const sideResults = new BoundedCache<SideResult>(SIDE_CACHE_SIZE);
  let busy = false;

  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: "TeamCombineCheck",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  const findPair = (request: CombineRequest) =>
    Effect.gen(function* () {
      const pair = yield* mergeCheck.findPair(request.projectId, request.threadId, request.other);
      if (pair === undefined) {
        return yield* new TeamMergeFixError({
          detail: "This pair is gone or was not checked yet. Look again in a moment.",
        });
      }
      if (pair.status !== "clean") {
        return yield* new TeamMergeFixError({
          detail: "Git cannot combine these yet: they clash. Fix the clash first.",
        });
      }
      return pair;
    });

  /** The combine copy, created as a detached worktree when missing or broken. */
  const ensureCopy = (repoRoot: string, projectId: ProjectId, commit: string) =>
    Effect.gen(function* () {
      const folder = path.join(config.stateDir, "team", "combine", projectId);
      const top = yield* run(folder, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const common = yield* run(folder, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).pipe(Effect.orElseSucceed(() => undefined));
      const repoCommon = yield* run(repoRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (
        top?.exitCode === 0 &&
        common?.exitCode === 0 &&
        path.resolve(top.stdout.trim()) === path.resolve(folder) &&
        path.resolve(common.stdout.trim()) === path.resolve(repoCommon.stdout.trim())
      ) {
        return folder;
      }
      // Only our own folder under the T3 home is ever removed.
      yield* fs.remove(folder, { recursive: true }).pipe(Effect.ignore);
      yield* run(repoRoot, ["worktree", "prune"]);
      yield* fs.makeDirectory(path.dirname(folder), { recursive: true });
      const added = yield* run(repoRoot, [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        folder,
        commit,
      ]);
      if (added.exitCode !== 0) {
        return yield* Effect.fail(`git worktree add failed: ${added.stderr.trim()}`);
      }
      return folder;
    });

  /** Puts a tree in the copy; only the files that differ are written. */
  const putTree = (folder: string, treeish: string) =>
    run(folder, ["read-tree", "-u", "--reset", treeish]).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(`git read-tree failed: ${result.stderr.trim()}`),
      ),
    );

  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  /** The command and the install for the result in the copy. */
  const commandsIn = (checkFolder: string) =>
    Effect.gen(function* () {
      const packageJson = yield* fs
        .readFileString(path.join(checkFolder, "package.json"))
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
      const present = new Set<string>();
      for (const file of [
        ...LOCKFILES.map(([name]) => name),
        "tsconfig.json",
        "Cargo.toml",
        "go.mod",
      ]) {
        if (yield* exists(path.join(checkFolder, file))) present.add(file);
      }
      const facts = { packageJson, has: (file: string) => present.has(file) };
      const fromRulebook = yield* readCheckCommand({
        teamRoot: checkFolder,
        workingFolder: checkFolder,
      }).pipe(Effect.provide(fileContext));
      return {
        command: fromRulebook ?? detectCheckCommand(facts),
        install: installCommand(facts),
      };
    });

  /** The lockfile and package.json blobs: when they change, dependencies are installed again. */
  const dependencyKey = (folder: string, checkFolder: string) =>
    run(checkFolder, [
      "ls-files",
      "-s",
      "--",
      "package.json",
      ...LOCKFILES.map(([name]) => name),
    ]).pipe(
      Effect.map((result) => `${path.relative(folder, checkFolder)}\n${result.stdout.trim()}`),
    );

  /** Which side changed each file since they split, as team paths. */
  const changedBy = (repoRoot: string, teamRoot: string, sides: Sides) =>
    Effect.gen(function* () {
      const base = yield* run(repoRoot, ["merge-base", sides.mine, sides.other]);
      const changed = (commit: string) =>
        base.exitCode !== 0
          ? Effect.succeed(new Set<string>())
          : run(repoRoot, [
              "diff",
              "--name-only",
              "--no-renames",
              "-z",
              base.stdout.trim(),
              commit,
            ]).pipe(
              Effect.map(
                (result) =>
                  new Set(
                    diffToTeamPaths(
                      path,
                      result.stdout.split("\0").filter((entry) => entry.length > 0),
                      repoRoot,
                      teamRoot,
                    ),
                  ),
              ),
            );
      return { mine: yield* changed(sides.mine), other: yield* changed(sides.other) };
    });

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const result = (
    sides: Sides,
    status: TeamCombinedCheckView["status"],
    extra: {
      readonly skip?: TeamCombinedSkip;
      readonly command?: string | undefined;
      readonly errors?: ReadonlyArray<TeamCombinedError>;
      readonly errorCount?: number;
    } = {},
  ) =>
    now.pipe(
      Effect.map((checkedAt): TeamCombinedCheckView => ({
        mineCommit: sides.mine,
        otherCommit: sides.other,
        status,
        ...(extra.skip === undefined ? {} : { skip: extra.skip }),
        ...(extra.command === undefined ? {} : { command: extra.command }),
        errors: extra.errors ?? [],
        errorCount: extra.errorCount ?? 0,
        checkedAt,
      })),
    );

  const sidesOf = (pair: TeamMergePair): Sides => ({
    mine: pair.mine.commit,
    other: pair.other.commit,
  });

  /** The check itself, once the gates let it start. */
  const check = (
    sides: Sides,
    request: { readonly projectId: ProjectId; readonly install: boolean },
  ) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const remaining = Effect.map(
        Clock.currentTimeMillis,
        (at) => COMBINE_TIMEOUT_MS - (at - startedAt),
      );
      const place = yield* mergeCheck.placeOf(request.projectId);
      if (Option.isNone(place)) return yield* result(sides, "skipped", { skip: "failed" });
      const { repoRoot, teamRoot } = place.value;
      const merged =
        sides.tree === undefined
          ? yield* mergeTree(git, repoRoot, sides.mine, sides.other)
          : { tree: sides.tree, conflicts: [] };
      if (merged === undefined || merged.conflicts.length > 0) {
        return yield* result(sides, "skipped", { skip: "failed" });
      }
      const folder = yield* ensureCopy(repoRoot, request.projectId, sides.mine);
      const checkFolder = path.join(folder, path.relative(repoRoot, teamRoot));
      yield* putTree(folder, merged.tree);

      const commands = yield* commandsIn(checkFolder);
      const marker = `${folder}.deps`;
      const wanted =
        commands.install === undefined ? "" : yield* dependencyKey(folder, checkFolder);
      const installed = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
      const skip = runGate({
        command: commands.command,
        dependenciesChanged: commands.install !== undefined && installed !== wanted,
        install: request.install,
      });
      if (skip !== undefined) {
        return yield* result(sides, "skipped", { skip, command: commands.command });
      }
      const command = commands.command!;
      const timed = (line: string) =>
        remaining.pipe(
          Effect.flatMap((ms) =>
            ms <= 0
              ? Effect.succeed(undefined)
              : runCombineCommand({ command: line, cwd: checkFolder, timeoutMs: ms }),
          ),
        );
      const stopped = (ran: CombineRun | undefined) =>
        ran === undefined || ran.timedOut
          ? result(sides, "skipped", { skip: "timeout", command })
          : result(sides, "skipped", { skip: "failed", command });

      if (commands.install !== undefined && installed !== wanted) {
        const ran = yield* timed(commands.install);
        if (ran === undefined || ran.timedOut || ran.exitCode !== 0) {
          yield* Effect.logWarning("Team combined check: installing dependencies failed.", {
            command: commands.install,
            exitCode: ran?.exitCode,
            tail: ran?.output.tail.slice(-20).join("\n"),
          });
          return yield* stopped(ran);
        }
        yield* fs.writeFileString(marker, wanted);
      }

      const combined = yield* timed(command);
      if (combined === undefined || combined.timedOut || combined.spawnError !== undefined) {
        return yield* stopped(combined);
      }
      if (combined.exitCode === 0) return yield* result(sides, "clean", { command });

      // It fails combined: run each side alone to leave out what either already had.
      const alone = (commit: string) =>
        Effect.gen(function* () {
          const key = `${command}|${commit}`;
          const known = sideResults.get(key);
          if (known !== undefined) return { side: known };
          yield* putTree(folder, `${commit}^{tree}`);
          const ran = yield* timed(command);
          if (ran === undefined || ran.timedOut || ran.spawnError !== undefined) {
            return { stopped: ran };
          }
          const side: SideResult = { exitCode: ran.exitCode, errors: ran.output.errors };
          sideResults.set(key, side);
          return { side };
        });
      const mineAlone = yield* alone(sides.mine);
      if (!("side" in mineAlone)) return yield* stopped(mineAlone.stopped);
      const otherAlone = yield* alone(sides.other);
      if (!("side" in otherAlone)) return yield* stopped(otherAlone.stopped);
      const mine = mineAlone.side;
      const other = otherAlone.side;

      let fresh = newErrors(combined.output.errors, mine.errors, other.errors);
      if (combined.output.errors.length === 0) {
        // Nothing readable: new only when both sides pass alone.
        if (mine.exitCode !== 0 || other.exitCode !== 0) {
          return yield* result(sides, "clean", { command });
        }
        const last = combined.output.tail.findLast((line) => line.trim().length > 0);
        fresh = [
          {
            path: undefined,
            line: undefined,
            code: undefined,
            message: last?.trim() || `\`${command}\` failed`,
          },
        ];
      }
      if (fresh.length === 0) return yield* result(sides, "clean", { command });

      const changed = yield* changedBy(repoRoot, teamRoot, sides);
      const errors = fresh
        .slice(0, TEAM_MERGE_LIMITS.combinedErrors)
        .map((error): TeamCombinedError => {
          const inTeam =
            error.path !== undefined &&
            error.path.length > 0 &&
            !error.path.startsWith("../") &&
            !path.isAbsolute(error.path);
          const named = missingName(error.message);
          const mineChanged = inTeam && changed.mine.has(error.path!);
          const otherChanged = inTeam && changed.other.has(error.path!);
          return {
            ...(inTeam ? { path: error.path! } : {}),
            ...(error.line === undefined ? {} : { line: error.line }),
            message:
              inTeam || error.path === undefined
                ? error.message
                : `${error.path}: ${error.message}`,
            ...(named === undefined ? {} : named),
            side:
              mineChanged && otherChanged
                ? "both"
                : mineChanged
                  ? "mine"
                  : otherChanged
                    ? "other"
                    : "neither",
          };
        });
      return yield* result(sides, "broken", {
        command,
        errors,
        errorCount: fresh.length + combined.output.uncounted,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team combined check failed.", { cause }).pipe(
          Effect.andThen(result(sides, "skipped", { skip: "failed" })),
        ),
      ),
    );

  /** Why a check cannot start now, if it cannot. */
  const gate = (projectId: ProjectId) =>
    orchestrator.getShellSnapshot().pipe(
      Effect.orElseSucceed(() => ({ threads: [] as const })),
      Effect.map(({ threads }) =>
        startGate({
          busy,
          turnRunning: threads.some(
            (thread) => thread.projectId === projectId && thread.activeRunId !== null,
          ),
          freeBytes: NodeOS.freemem(),
        }),
      ),
    );

  /** Gates, then the check in the background; its fiber, or the skip. */
  const begin = (request: CombineRequest) =>
    Effect.gen(function* () {
      const pair = yield* findPair(request);
      const skip = yield* gate(request.projectId);
      if (skip !== undefined) {
        const skipped = yield* result(sidesOf(pair), "skipped", { skip });
        // A check running for this pair keeps its line.
        const shown = yield* mergeCheck.combinedOf(pair);
        if (shown?.status !== "running") yield* mergeCheck.setCombined(request.projectId, skipped);
        return { pair, skipped } as const;
      }
      busy = true;
      yield* mergeCheck.setCombined(request.projectId, yield* result(sidesOf(pair), "running"));
      const fiber = yield* check(sidesOf(pair), request).pipe(
        Effect.tap((done) =>
          Effect.logInfo("Team combined check done.", {
            status: done.status,
            skip: done.skip,
            command: done.command,
            errors: done.errorCount,
          }),
        ),
        Effect.tap((done) => mergeCheck.setCombined(request.projectId, done)),
        Effect.ensuring(Effect.sync(() => (busy = false))),
        Effect.forkIn(scope),
      );
      return { pair, fiber } as const;
    });

  return TeamCombineCheck.of({
    start: (request) => begin(request).pipe(Effect.asVoid),
    run: (request) =>
      Effect.gen(function* () {
        const pair = yield* findPair(request);
        const known = yield* mergeCheck.combinedOf(pair);
        if (known?.status === "clean" || known?.status === "broken") return known;
        const begun = yield* begin(request);
        // The check goes on if the caller leaves; its result still lands on the pair.
        return "fiber" in begun ? yield* Fiber.join(begun.fiber) : begun.skipped;
      }),
    checkResult: (request) =>
      Effect.gen(function* () {
        const sides: Sides = {
          mine: request.mineCommit,
          other: request.otherCommit,
          tree: request.tree,
        };
        const skip = yield* gate(request.projectId);
        if (skip !== undefined) return yield* result(sides, "skipped", { skip });
        busy = true;
        return yield* check(sides, { projectId: request.projectId, install: true }).pipe(
          Effect.tap((done) =>
            Effect.logInfo("Team check on a fix's result done.", {
              status: done.status,
              skip: done.skip,
              errors: done.errorCount,
            }),
          ),
          Effect.ensuring(Effect.sync(() => (busy = false))),
        );
      }),
  });
});

export const layer = Layer.effect(TeamCombineCheck, make);
