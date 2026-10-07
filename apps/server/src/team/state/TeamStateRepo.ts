/**
 * TeamStateRepo - one team's state on this server: a bare Git repo used only
 * for the hidden ref {@link TEAM_STATE_REF} (team/STORAGE_PLAN.md 3.3). Its
 * `origin` is the project's own remote, so pushes use the person's normal
 * Git credentials. The person's checkout is never touched.
 *
 * This server's own files ("mine") live as plain files next to the repo and
 * are the truth for this server's part: a save is local and instant, and a
 * sync makes the remote match them. A sync takes the newest remote tree,
 * replaces only this server's files, commits on top of the remote tip and
 * pushes without force. Nobody else writes those files, so when a push is
 * refused for being behind, doing it again on the new tip always works.
 * Offline needs no queue: the next sync that lands carries everything.
 *
 * @module TeamStateRepo
 */
import { TEAM_STATE_REF } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { TeamStorageError } from "../TeamErrors.ts";

/** Pushes refused for being behind are redone this many times in all. */
export const TEAM_STATE_PUSH_ATTEMPTS = 5;

const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
/** Above the default 1 MB, so a full writer file is never cut off. */
const MAX_FILE_BYTES = 16_000_000;
/** Fail fast instead of waiting on a credential prompt nobody can answer; English messages to match on. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
const MINE_DIRECTORY = "mine";

export type TeamStateFetchResult =
  | { readonly status: "fetched"; readonly tip: string }
  /** The remote has no team state. */
  | { readonly status: "missing" }
  /** Offline, no access, or too slow. */
  | { readonly status: "unreachable" };

export type TeamStateSyncResult =
  | {
      readonly confirmed: true;
      /** The remote tip, which now holds this server's files. */
      readonly tip: string;
      /** Pushes tried; 0 when the remote already matched. */
      readonly attempts: number;
    }
  | {
      readonly confirmed: false;
      /**
       * - `unreachable`: offline, no access, or too slow.
       * - `behind`: someone pushed first every time.
       * - `refused`: the remote turned the push down (a hook or rule).
       * - `missing`: the remote has no team state, and `create` was not set.
       */
      readonly reason: "unreachable" | "behind" | "refused" | "missing";
      readonly attempts: number;
    };

export interface TeamStateSnapshot {
  /** The remote tip as last fetched or pushed; null before the first. */
  readonly tip: string | null;
  /** The tree at `tip`, with this server's own files on top. Path → contents. */
  readonly files: ReadonlyMap<string, string>;
}

export interface TeamStateRepoOptions {
  /** The bare repo, `<T3 home>/team/<teamId>.git`. Made when missing. */
  readonly directory: string;
  /** The project's remote URL. */
  readonly remoteUrl: string;
}

export interface TeamStateSyncInput {
  readonly message: string;
  /** Author and committer of the state commit. */
  readonly author: { readonly name: string; readonly email: string };
  /** Start the team state when the remote has none (team creation only). */
  readonly create?: boolean | undefined;
  /** Per network call. */
  readonly timeoutMs?: number | undefined;
}

/** A tree path this repo may write: relative, `/`-separated, no `.` or `..` parts. */
const isSafeTreePath = (file: string) =>
  file.length > 0 &&
  file.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

export const make = Effect.fn("TeamStateRepo.make")(function* (options: TeamStateRepoOptions) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory } = options;
  const mineRoot = path.join(directory, MINE_DIRECTORY);
  // One fetch or sync at a time: they move the same ref and share the index file.
  const remoteLock = yield* Semaphore.make(1);
  // Saves never wait on the network, only on each other.
  const saveLock = yield* Semaphore.make(1);

  const storage =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TeamStorageError({ operation, cause })));

  /** A local Git command that must work; its trimmed stdout. */
  const local = (
    operation: string,
    args: ReadonlyArray<string>,
    extra?: { readonly stdin?: string; readonly env?: Record<string, string> },
  ) =>
    git
      .execute({
        operation: `TeamStateRepo.${operation}`,
        cwd: directory,
        args,
        env: { ...GIT_ENV, ...extra?.env },
        ...(extra?.stdin === undefined ? {} : { stdin: extra.stdin }),
        timeoutMs: LOCAL_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        storage(operation),
      );

  /** A Git command that talks to `origin`. Null when it failed to run or timed out. */
  const network = (operation: string, args: ReadonlyArray<string>, timeoutMs: number | undefined) =>
    git
      .execute({
        operation: `TeamStateRepo.${operation}`,
        cwd: directory,
        args,
        env: GIT_ENV,
        allowNonZeroExit: true,
        timeoutMs: timeoutMs ?? NETWORK_TIMEOUT_MS,
      })
      .pipe(Effect.orElseSucceed(() => null));

  if (!(yield* fs.exists(path.join(directory, "HEAD")).pipe(storage("init")))) {
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(storage("init"));
    yield* local("init", ["init", "--bare", "--quiet"]);
  }
  yield* fs.makeDirectory(mineRoot, { recursive: true }).pipe(storage("init"));
  yield* local("init", ["config", "remote.origin.url", options.remoteUrl]);

  const localTip = local("localTip", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${TEAM_STATE_REF}^{commit}`,
  ]).pipe(Effect.orElseSucceed(() => ""));

  const fetchUnlocked = (timeoutMs: number | undefined) =>
    Effect.gen(function* () {
      const result = yield* network(
        "fetch",
        // `+`: the local ref only mirrors the remote, which is never rewritten by us.
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--depth=1",
          "origin",
          `+${TEAM_STATE_REF}:${TEAM_STATE_REF}`,
        ],
        timeoutMs,
      );
      if (result === null) return { status: "unreachable" } as const;
      if (result.exitCode !== 0) {
        if (!/couldn't find remote ref/u.test(result.stderr))
          return { status: "unreachable" } as const;
        yield* local("fetch", ["update-ref", "-d", TEAM_STATE_REF]);
        return { status: "missing" } as const;
      }
      return {
        status: "fetched",
        tip: yield* local("fetch", ["rev-parse", TEAM_STATE_REF]),
      } as const;
    });

  /** Paths of this server's files, `/`-separated. */
  const minePaths = fs.readDirectory(mineRoot, { recursive: true }).pipe(
    Effect.flatMap((entries) =>
      Effect.filter(
        entries
          .map((entry) => entry.replaceAll("\\", "/"))
          .filter((entry) => entry.endsWith(".json")),
        (entry) =>
          fs.stat(path.join(mineRoot, entry)).pipe(Effect.map((info) => info.type === "File")),
      ),
    ),
    Effect.map((entries) => entries.toSorted()),
    storage("readMine"),
  );

  const readMine = minePaths.pipe(
    Effect.flatMap((paths) =>
      Effect.forEach(paths, (file) =>
        fs.readFileString(path.join(mineRoot, file)).pipe(
          Effect.map((contents) => [file, contents] as const),
          storage("readMine"),
        ),
      ),
    ),
  );

  const readTree = (tip: string) =>
    Effect.gen(function* () {
      const listing = yield* local("read", ["ls-tree", "-r", "-z", tip]);
      const blobs = listing
        .split("\0")
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          const [meta = "", file = ""] = line.split("\t");
          const [, type, oid] = meta.split(" ");
          return type === "blob" && oid !== undefined ? [{ file, oid }] : [];
        });
      return yield* Effect.forEach(
        blobs,
        ({ file, oid }) =>
          git
            .execute({
              operation: "TeamStateRepo.read",
              cwd: directory,
              args: ["cat-file", "blob", oid],
              env: GIT_ENV,
              timeoutMs: LOCAL_TIMEOUT_MS,
              maxOutputBytes: MAX_FILE_BYTES,
            })
            .pipe(
              storage("read"),
              Effect.flatMap((result) =>
                result.stdoutTruncated
                  ? Effect.fail(
                      new TeamStorageError({
                        operation: "read",
                        cause: new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes.`),
                      }),
                    )
                  : Effect.succeed([file, result.stdout] as const),
              ),
            ),
        { concurrency: 4 },
      );
    });

  /** The tree of `base` with this server's files put in; returns the tree id. */
  const buildTree = (base: string | null, mine: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const indexFile = path.join(directory, "t3-team-index");
      const env = { GIT_INDEX_FILE: indexFile };
      yield* local("buildTree", base === null ? ["read-tree", "--empty"] : ["read-tree", base], {
        env,
      });
      for (const [file, contents] of mine) {
        const oid = yield* local("buildTree", ["hash-object", "-w", "--stdin"], {
          stdin: contents,
        });
        yield* local(
          "buildTree",
          ["update-index", "--add", "--cacheinfo", `100644,${oid},${file}`],
          {
            env,
          },
        );
      }
      const tree = yield* local("buildTree", ["write-tree"], { env });
      yield* fs.remove(indexFile, { force: true }).pipe(storage("buildTree"));
      return tree;
    });

  const syncUnlocked = (input: TeamStateSyncInput) =>
    Effect.gen(function* () {
      const authorEnv = {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: input.author.name,
        GIT_COMMITTER_EMAIL: input.author.email,
      };
      let attempts = 0;
      while (attempts < TEAM_STATE_PUSH_ATTEMPTS) {
        const fetched = yield* fetchUnlocked(input.timeoutMs);
        if (fetched.status === "unreachable") {
          return { confirmed: false, reason: "unreachable", attempts } as const;
        }
        if (fetched.status === "missing" && input.create !== true) {
          return { confirmed: false, reason: "missing", attempts } as const;
        }
        const base = fetched.status === "fetched" ? fetched.tip : null;
        const tree = yield* buildTree(base, yield* readMine);
        if (base !== null && tree === (yield* local("sync", ["rev-parse", `${base}^{tree}`]))) {
          return { confirmed: true, tip: base, attempts } as const;
        }
        const commit = yield* local(
          "sync",
          [
            "commit-tree",
            "--no-gpg-sign",
            tree,
            ...(base === null ? [] : ["-p", base]),
            "-m",
            input.message,
          ],
          { env: authorEnv },
        );
        attempts += 1;
        // No `+` and no --force: the remote takes it only as a fast-forward.
        const pushed = yield* network(
          "push",
          ["push", "--porcelain", "origin", `${commit}:${TEAM_STATE_REF}`],
          input.timeoutMs,
        );
        if (pushed !== null && pushed.exitCode === 0) {
          yield* local("sync", ["update-ref", TEAM_STATE_REF, commit]);
          return { confirmed: true, tip: commit, attempts } as const;
        }
        const refLine = pushed?.stdout.split("\n").find((line) => line.startsWith("!")) ?? "";
        // A push that lands in the same instant as another can lose the race for the ref lock.
        const lostLock =
          refLine.includes("[remote rejected]") &&
          /lock|failed to update ref|incorrect old value/u.test(refLine);
        if (refLine.includes("[remote rejected]") && !lostLock) {
          return { confirmed: false, reason: "refused", attempts } as const;
        }
        if (!refLine.includes("[rejected]") && !lostLock) {
          return { confirmed: false, reason: "unreachable", attempts } as const;
        }
        // Behind: someone pushed since the fetch. Fetch and do it again.
      }
      return { confirmed: false, reason: "behind", attempts } as const;
    });

  return {
    /** Fetches the state ref (only that ref, depth 1). */
    fetch: (fetchOptions?: { readonly timeoutMs?: number | undefined }) =>
      remoteLock.withPermits(1)(fetchUnlocked(fetchOptions?.timeoutMs)),

    /** The state as last fetched or pushed, with this server's files on top. No network. */
    read: Effect.gen(function* () {
      const tip = (yield* localTip) || null;
      const files = new Map<string, string>(tip === null ? [] : yield* readTree(tip));
      for (const [file, contents] of yield* readMine) files.set(file, contents);
      return { tip, files } satisfies TeamStateSnapshot;
    }),

    /** Saves one of this server's files locally; the next sync shares it. */
    saveMine: (file: string, contents: string) =>
      saveLock.withPermits(1)(
        Effect.gen(function* () {
          if (!isSafeTreePath(file)) {
            return yield* new TeamStorageError({
              operation: "saveMine",
              cause: new Error(`Not a state tree path: ${file}`),
            });
          }
          const target = path.join(mineRoot, ...file.split("/"));
          const temporary = path.join(directory, "mine.tmp");
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(temporary, contents);
          yield* fs.rename(temporary, target);
        }).pipe(storage("saveMine")),
      ),

    /** Makes the remote hold this server's files. Never forces. */
    sync: (input: TeamStateSyncInput): Effect.Effect<TeamStateSyncResult, TeamStorageError> =>
      remoteLock.withPermits(1)(syncUnlocked(input)),
  };
});

export type TeamStateRepo = Effect.Success<ReturnType<typeof make>>;
