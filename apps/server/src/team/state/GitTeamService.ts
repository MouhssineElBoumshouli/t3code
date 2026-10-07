/**
 * GitTeamService - the team service on the Git team state (team/STORAGE_PLAN.md
 * 3.1 to 3.4): the same reads and writes M1's tools use, kept in this server's
 * writer file on `refs/t3-team/state` instead of the host's SQLite tables.
 *
 * - Membership comes from the host: the GitHub login, push access to the
 *   project's repo, and team state on its remote ({@link GitTeamService.openTeam}).
 *   A member exists once their writer file does; opening a team writes it.
 * - Reads are filters on the state as last fetched, plus this server's own
 *   file, so they never wait on the network.
 * - Writes change this server's writer file on disk. A claim syncs right away
 *   (fetch, then push) so its overlaps include claims made elsewhere; other
 *   writes are pushed together about 2 seconds later (STORAGE_PLAN.md 4.9).
 * - Every sync looks for late overlaps: a teammate's claim that overlaps one of
 *   this server's, found after both were made. Each is handed out once.
 * - A poller per team checks every 15 seconds whether the state ref moved
 *   (an ETag request through gh, free when nothing changed; `git ls-remote`
 *   every 60 seconds without gh) and fetches only when it did. While this
 *   server has writes that did not land (made offline, say), it syncs
 *   instead, so they are shared once the network is back. It backs off after
 *   failures and stops with the server.
 *
 * - A project without `.team/team.json` gets a solo team (./SoloTeam.ts): the
 *   same state repo with no remote, so no fetch, push or poller. When the
 *   project becomes a team under the same id, its solo file is renamed to the
 *   person's login and pushed with the team's first sync.
 *
 * The server provides it as `TeamService` ({@link layer}); its state repos
 * live in `<T3 state dir>/team/<teamId>.git`.
 *
 * @module GitTeamService
 */
import {
  countTeamWords,
  type EnvironmentId,
  normalizeTeamPath,
  type Team,
  TeamActivityId,
  type TeamClaim,
  TeamClaimId,
  type TeamHandoff,
  TeamHandoffId,
  TeamId,
  type TeamLogin,
  type TeamMember,
  TEAM_HANDOFF_MAX_WORDS,
  TEAM_STATE_FORMAT,
  TEAM_STATE_TEAM_FILE,
  TeamMemberId,
  type TeamStateClaim,
  type TeamStateTask,
  TeamTaskId,
  type TeamThreadRef,
  type ThreadId,
  type TeamWriterFile,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  TeamClaimPathsInvalidError,
  TeamHandoffTooLongError,
  TeamMemberNotFoundError,
  TeamNotFoundError,
  type TeamServiceError,
  TeamStorageError,
  TeamTaskNotFoundError,
} from "../TeamErrors.ts";
import {
  type ClaimPathsInput,
  type CreateTaskInput,
  type OpenSoloInput,
  type OpenTeamInput,
  type ReleasePathsInput,
  type ReleaseThreadClaimsInput,
  type SaveAutomaticNoteInput,
  type TeamMembership,
  TeamService,
  type UpdateTaskInput,
  type WriteHandoffInput,
} from "../TeamService.ts";
import * as SoloTeam from "./SoloTeam.ts";
import * as TeamHost from "./TeamHost.ts";
import * as Model from "./TeamStateModel.ts";
import * as TeamStateRepo from "./TeamStateRepo.ts";

/** Push access and the login are checked again after this long (upstream's viewer cache time). */
export const TEAM_MEMBERSHIP_TTL = Duration.minutes(10);
/** Writes other than claims wait this long, so writes close together share one push. */
export const TEAM_SYNC_DELAY = Duration.seconds(2);
/** A claim's fetch and push each get this long (STORAGE_PLAN.md Q4). */
export const TEAM_CLAIM_NETWORK_TIMEOUT_MS = 3_000;
/** The poller's ETag check: free on GitHub when nothing changed (STORAGE_PLAN.md Q2). */
export const TEAM_POLL_INTERVAL = Duration.seconds(15);
/** Without gh (or a remote on no Git host), `git ls-remote`, which GitHub does count. */
export const TEAM_POLL_FALLBACK_INTERVAL = Duration.seconds(60);
/** After a failed check the wait doubles from this, up to the max (upstream's SourceControlRateLimit). */
export const TEAM_POLL_BACKOFF = Duration.seconds(30);
export const TEAM_POLL_MAX_BACKOFF = Duration.minutes(15);

export type TeamPollMode = "etag" | "lsRemote";

/** What one check of the poller did, for tests and logs. */
export type TeamPollOutcome =
  /** Not opened in this run, so nothing to watch yet. */
  | "idle"
  | "unchanged"
  | "fetched"
  /** This server's writes that had not landed were pushed. */
  | "pushed"
  /** gh could not check; from now on this team is checked with `git ls-remote`. */
  | "fallback"
  | "failed";

/** The wait before the poller's next check of a team. */
export const nextPollDelay = (input: {
  readonly mode: TeamPollMode;
  readonly failures: number;
}): Duration.Duration => {
  if (input.failures === 0) {
    return input.mode === "etag" ? TEAM_POLL_INTERVAL : TEAM_POLL_FALLBACK_INTERVAL;
  }
  const backoff = Duration.toMillis(TEAM_POLL_BACKOFF) * 2 ** (input.failures - 1);
  return Duration.millis(Math.min(backoff, Duration.toMillis(TEAM_POLL_MAX_BACKOFF)));
};

const DEFAULT_LIST_LIMIT = 50;

export interface GitTeamServiceOptions {
  /** This T3 server. */
  readonly environmentId: EnvironmentId;
  /** `<T3 home>/team`: one bare repo per team, `<teamId>.git`. */
  readonly stateDirectory: string;
  /** The repo on its Git host for a remote URL. Default: {@link TeamHost.parseTeamRemoteUrl}. */
  readonly locate?: ((remoteUrl: string) => TeamHost.TeamRepoLocation | null) | undefined;
  /** Called after each check of the poller; tests wait on it. */
  readonly onPoll?: ((teamId: TeamId, outcome: TeamPollOutcome) => Effect.Effect<void>) | undefined;
}

/** Only ids that are safe as one folder name (team ids are UUIDs). */
const SAFE_TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const optionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/** Normalized, de-duplicated paths. Fails on a path that names the whole repo or leaves it. */
const normalizeClaimPaths = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const normalized: Array<string> = [];
    for (const raw of paths) {
      const path = normalizeTeamPath(raw);
      if (path === "" || path === ".") {
        return yield* new TeamClaimPathsInvalidError({
          detail: `"${raw}" names the whole repo. Name the files or folders instead.`,
        });
      }
      if (path.split("/").includes("..")) {
        return yield* new TeamClaimPathsInvalidError({
          detail: `"${raw}" leaves the repo. Use repo-relative paths.`,
        });
      }
      if (!normalized.includes(path)) normalized.push(path);
    }
    return normalized;
  });

/** The hashes of the note's own files, keyed like `files`; null when there are none. */
const keepHashesOf = (
  files: ReadonlyArray<string>,
  hashes: Readonly<Record<string, string | null>> | undefined,
) => {
  if (hashes === undefined) return null;
  const kept: Record<string, string | null> = {};
  for (const [raw, hash] of Object.entries(hashes)) {
    const path = normalizeTeamPath(raw);
    if (files.includes(path)) kept[path] = hash?.trim() || null;
  }
  return Object.keys(kept).length === 0 ? null : kept;
};

const sameThread = (left: TeamThreadRef, right: TeamThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

const toTeam = (view: Model.TeamStateView): Team => ({
  teamId: view.team.teamId,
  name: view.team.name,
  canonicalKey: null,
  createdAt: view.team.createdAt,
});

const toMember = (view: Model.TeamStateView, member: Model.TeamStateMember): TeamMember => ({
  memberId: TeamMemberId.make(member.login),
  teamId: view.team.teamId,
  displayName: member.displayName,
  role: member.role,
  lastSeenAt: member.lastSyncAt,
});

const toClaim = (teamId: TeamId, login: TeamLogin, claim: TeamStateClaim): TeamClaim => ({
  claimId: claim.claimId,
  teamId,
  memberId: TeamMemberId.make(login),
  thread: claim.thread,
  paths: claim.paths,
  note: claim.note,
  claimedAt: claim.claimedAt,
  releasedAt: claim.releasedAt,
});

/** One team this server has opened: its state repo and what was last read from it. */
interface TeamEntry {
  readonly teamId: TeamId;
  /** Null for a solo team: kept on this computer, never fetched or pushed. */
  remoteUrl: string | null;
  location: TeamHost.TeamRepoLocation | null;
  repo: TeamStateRepo.TeamStateRepo;
  /** Serializes changes to this server's files and to the fields below. */
  readonly lock: Semaphore.Semaphore;
  /**
   * One open at a time: an open that comes while another runs (a turn during
   * the startup warm-up) waits for it and reuses its answer, instead of
   * asking the host again.
   */
  readonly openLock: Semaphore.Semaphore;
  parsed: Model.ParsedTeamState;
  /** Null until `team.json` is there. */
  view: Model.TeamStateView | null;
  /** When the state repo was last read; `parsed` and `view` are from then. */
  readAt: string | null;
  /** The last read failed, so `parsed` and `view` are older than the state repo. */
  readFailed: boolean;
  /** Who this server writes as, once a membership check passed. */
  me: { readonly login: TeamLogin; readonly checkedAt: number } | null;
  /** Overlap keys already reported, by a claim's result or as a late overlap. */
  reported: ReadonlySet<string>;
  /** Late overlaps not handed out yet. */
  late: ReadonlyArray<Model.TeamLateOverlap>;
  syncScheduled: boolean;
  /** This server has writes the remote does not hold yet; the poller pushes them. */
  unshared: boolean;
  /** How the poller checks this team, and the ETag of the host's last answer. */
  pollMode: TeamPollMode;
  etag: string | null;
  /** The poller's fiber; stopped when the entry is replaced. */
  poller: Fiber.Fiber<never> | null;
}

export const make = Effect.fn("GitTeamService.make")(function* (options: GitTeamServiceOptions) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const host = yield* TeamHost.TeamHost;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const environmentId = options.environmentId;

  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const storage =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TeamStorageError({ operation, cause })));

  const teams = new Map<TeamId, TeamEntry>();
  // Opening a team twice at once must not make two entries.
  const registryLock = yield* Semaphore.make(1);

  const repoDirectory = (teamId: TeamId) =>
    SAFE_TEAM_ID.test(teamId)
      ? Effect.succeed(path.join(options.stateDirectory, `${teamId}.git`))
      : Effect.fail(
          new TeamStorageError({
            operation: "openTeam",
            cause: new Error(`Team id "${teamId}" cannot name a folder.`),
          }),
        );

  /**
   * Reads the state repo again and finds late overlaps. Call holding
   * `entry.lock`. When the read fails (a Git call timed out), the last view
   * stays and is marked not fresh, instead of losing the teammates.
   */
  const reload = (entry: TeamEntry) =>
    Effect.gen(function* () {
      const snapshot = yield* entry.repo.read.pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `team ${entry.teamId}: reading the team state failed; keeping the last one read`,
            error,
          ).pipe(Effect.as(null)),
        ),
      );
      if (snapshot === null) {
        entry.readFailed = true;
        return;
      }
      entry.readFailed = false;
      entry.readAt = yield* nowIso;
      entry.parsed = Model.parseTeamState(snapshot.files);
      for (const warning of entry.parsed.warnings) {
        yield* Effect.logDebug(`team ${entry.teamId}: ${warning}`);
      }
      const team = entry.parsed.team;
      entry.view =
        team !== null && team.teamId === entry.teamId
          ? Model.buildTeamView(team, entry.parsed.writers)
          : null;
      if (entry.view !== null && entry.me !== null) {
        const found = Model.findLateOverlaps(
          entry.view,
          { login: entry.me.login, environmentId },
          entry.reported,
        );
        // Drop waiting ones that no longer overlap (released since).
        entry.late = [
          ...entry.late.filter((overlap) => found.reported.has(overlap.key)),
          ...found.overlaps,
        ];
        entry.reported = found.reported;
      }
    });

  /** This server's writer files in the team: every file with this server's environment. */
  const myFiles = (entry: TeamEntry) =>
    entry.parsed.writers.filter((writer) => writer.file.environmentId === environmentId);

  const myFile = (entry: TeamEntry, login: TeamLogin) =>
    myFiles(entry).find((writer) => writer.file.login === login)?.file;

  /**
   * Saves one of this server's writer files, capped, with `lastSyncAt` set to
   * now: readers show it as when this person was last seen. Call holding
   * `entry.lock`.
   */
  const saveMyFile = (entry: TeamEntry, file: TeamWriterFile) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const next = Model.compactWriterFile({ ...file, lastSyncAt: now }, now);
      const filePath = Model.writerFilePath(next.login, next.environmentId);
      yield* entry.repo.saveMine(filePath, Model.encodeWriterFile(next));
      const key = Model.writerKey(next.login, next.environmentId);
      entry.parsed = {
        ...entry.parsed,
        writers: [
          ...entry.parsed.writers.filter((writer) => writer.key !== key),
          { key, file: next },
        ],
      };
      if (entry.view !== null)
        entry.view = Model.buildTeamView(entry.view.team, entry.parsed.writers);
      return next;
    });

  /** Pushes this server's files and reads the result. Never forces. */
  const syncEntry = (entry: TeamEntry, timeoutMs?: number) =>
    Effect.gen(function* () {
      entry.syncScheduled = false;
      const login = entry.me?.login ?? myFiles(entry)[0]?.file.login ?? "t3-team";
      const result = yield* entry.repo
        .sync({
          message: `team state: ${login}`,
          author: { name: login, email: `${login}@users.noreply.github.com` },
          timeoutMs,
        })
        .pipe(Effect.tapError(() => Effect.sync(() => (entry.unshared = true))));
      // A write made during this sync schedules its own, which sets this again if it fails.
      entry.unshared = !result.confirmed;
      yield* entry.lock.withPermits(1)(reload(entry));
      return result;
    });

  /** Fetches the others' files and reads the result. Pushes nothing. */
  const refreshEntry = (entry: TeamEntry, timeoutMs?: number) =>
    Effect.gen(function* () {
      const fetched = yield* entry.repo.fetch({ timeoutMs });
      if (fetched.status !== "unreachable") yield* entry.lock.withPermits(1)(reload(entry));
      return fetched;
    });

  /** Shares this server's latest writes in {@link TEAM_SYNC_DELAY}, together with any that follow. */
  const scheduleSync = (entry: TeamEntry) =>
    Effect.gen(function* () {
      if (entry.remoteUrl === null || entry.syncScheduled) return;
      entry.syncScheduled = true;
      yield* Effect.sleep(TEAM_SYNC_DELAY).pipe(
        Effect.andThen(syncEntry(entry)),
        Effect.catchCause((cause) =>
          Effect.logWarning(`team ${entry.teamId}: sharing team state failed`, cause),
        ),
        Effect.forkIn(scope),
      );
    });

  /**
   * One check of a team (STORAGE_PLAN.md slice 7): ask the host whether the
   * state ref moved (an ETag request, or `git ls-remote` without gh), fetch
   * only when it did, then read the state again, which finds late overlaps.
   */
  const checkEntry = (entry: TeamEntry): Effect.Effect<TeamPollOutcome, TeamStorageError> =>
    Effect.gen(function* () {
      // A team is watched once this server has opened it in this run.
      if (entry.me === null) return "idle";
      const localTip = yield* entry.repo.localTip;
      const fetchNow = Effect.gen(function* () {
        const fetched = yield* refreshEntry(entry);
        return fetched.status === "unreachable" ? "failed" : "fetched";
      });

      if (entry.pollMode === "etag" && entry.location !== null) {
        const check = yield* host.refChanged(entry.location, entry.etag);
        switch (check.status) {
          case "unchanged":
            return "unchanged";
          case "current": {
            if (check.sha === localTip) {
              entry.etag = check.etag;
              return "unchanged";
            }
            const outcome = yield* fetchNow;
            // Keep the ETag only once the fetch landed, or the next 304 would hide the change.
            if (outcome === "fetched") entry.etag = check.etag;
            return outcome;
          }
          case "missing":
            entry.etag = null;
            return localTip === null ? "unchanged" : yield* fetchNow;
          case "noApi":
            yield* Effect.logInfo(
              `team ${entry.teamId}: ${check.detail} Checking for changes with git ls-remote instead.`,
            );
            entry.pollMode = "lsRemote";
            entry.etag = null;
            return "fallback";
          case "unavailable":
            yield* Effect.logDebug(`team ${entry.teamId}: check failed: ${check.detail}`);
            return "failed";
        }
      }

      const remote = yield* entry.repo.remoteTip();
      if (remote.status === "unreachable") return "failed";
      const remoteTip = remote.status === "tip" ? remote.sha : null;
      return remoteTip === localTip ? "unchanged" : yield* fetchNow;
    });

  /** Pushes this server's writes that did not land; the sync fetches the others' too. */
  const shareEntry = (entry: TeamEntry): Effect.Effect<TeamPollOutcome, TeamStorageError> =>
    Effect.gen(function* () {
      if (entry.me === null) return "idle";
      const synced = yield* syncEntry(entry);
      return synced.confirmed ? "pushed" : "failed";
    });

  /** Checks a team every 15 seconds (60 with `ls-remote`), slower after failures, until the server stops. */
  const pollEntry = (entry: TeamEntry) =>
    Effect.gen(function* () {
      let failures = 0;
      while (true) {
        yield* Effect.sleep(nextPollDelay({ mode: entry.pollMode, failures }));
        const outcome = yield* (entry.unshared ? shareEntry(entry) : checkEntry(entry)).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`team ${entry.teamId}: checking for changes failed`, error).pipe(
              Effect.as("failed" as const),
            ),
          ),
        );
        failures = outcome === "failed" ? failures + 1 : 0;
        if (options.onPoll !== undefined) yield* options.onPoll(entry.teamId, outcome);
      }
    });

  const makeEntry = (teamId: TeamId, remoteUrl: string | null) =>
    Effect.gen(function* () {
      const directory = yield* repoDirectory(teamId);
      const repo = yield* TeamStateRepo.make({ directory, remoteUrl }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, git),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const location =
        remoteUrl === null ? null : (options.locate ?? TeamHost.parseTeamRemoteUrl)(remoteUrl);
      const entry: TeamEntry = {
        teamId,
        remoteUrl,
        location,
        repo,
        lock: yield* Semaphore.make(1),
        openLock: yield* Semaphore.make(1),
        parsed: { team: null, writers: [], warnings: [] },
        view: null,
        readAt: null,
        readFailed: false,
        me: null,
        reported: new Set(),
        late: [],
        syncScheduled: false,
        // Writes a previous run could not push (offline when it stopped, say).
        // When Git cannot tell, a sync finds out.
        unshared:
          remoteUrl !== null && (yield* repo.pending.pipe(Effect.orElseSucceed(() => true))),
        pollMode: location === null ? "lsRemote" : "etag",
        etag: null,
        poller: null,
      };
      yield* reload(entry);
      if (remoteUrl !== null) entry.poller = yield* pollEntry(entry).pipe(Effect.forkIn(scope));
      return entry;
    });

  // Teams opened before a restart: their state repos are the list (STORAGE_PLAN.md 3.3).
  if (yield* fs.exists(options.stateDirectory).pipe(storage("load"))) {
    for (const name of (yield* fs
      .readDirectory(options.stateDirectory)
      .pipe(storage("load"))).toSorted()) {
      if (!name.endsWith(".git")) continue;
      const teamId = TeamId.make(name.slice(0, -".git".length));
      const loaded = yield* Effect.gen(function* () {
        // No origin: a solo team.
        const remoteUrl = yield* git
          .execute({
            operation: "GitTeamService.load",
            cwd: path.join(options.stateDirectory, name),
            args: ["config", "--get", "remote.origin.url"],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? optionalText(result.stdout) : null)),
          );
        return yield* makeEntry(teamId, remoteUrl);
      }).pipe(Effect.option);
      if (Option.isSome(loaded)) teams.set(teamId, loaded.value);
      else yield* Effect.logWarning(`team state repo ${name} could not be read; skipped.`);
    }
  }

  const remoteUrlOf = (checkout: string) =>
    git
      .execute({
        operation: "GitTeamService.remoteUrl",
        cwd: checkout,
        args: ["remote", "get-url", "origin"],
        allowNonZeroExit: true,
      })
      .pipe(
        storage("openTeam"),
        Effect.map((result) => (result.exitCode === 0 ? optionalText(result.stdout) : null)),
      );

  /** The entry for the team, made or pointed at the checkout's remote. */
  const entryFor = (teamId: TeamId, remoteUrl: string | null) =>
    registryLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = teams.get(teamId);
        if (existing !== undefined && existing.remoteUrl === remoteUrl) return existing;
        if (existing?.poller) yield* Fiber.interrupt(existing.poller);
        const entry = yield* makeEntry(teamId, remoteUrl);
        teams.set(teamId, entry);
        return entry;
      }),
    );

  /**
   * The host checks: the login, then push access. On a remote on this
   * computer, the login is all there is. A passing check is kept for
   * {@link TEAM_MEMBERSHIP_TTL}. When gh cannot answer (offline, say), this
   * server goes on as the login it last wrote as: only a clear "no" (no
   * access, no push access) takes membership away.
   */
  const checkAccess = (
    entry: TeamEntry,
  ): Effect.Effect<
    | { readonly ok: true; readonly login: TeamLogin; readonly checkedAt: number }
    | { readonly ok: false; readonly membership: TeamMembership }
  > =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      if (entry.me !== null && now - entry.me.checkedAt < Duration.toMillis(TEAM_MEMBERSHIP_TTL)) {
        return { ok: true, login: entry.me.login, checkedAt: entry.me.checkedAt } as const;
      }
      // The solo login is never a GitHub login to go on as.
      const lastLogin =
        entry.me?.login ??
        myFiles(entry)
          .filter((writer) => writer.file.login !== SoloTeam.SOLO_LOGIN)
          .toSorted((a, b) => (a.file.lastSyncAt < b.file.lastSyncAt ? 1 : -1))[0]?.file.login ??
        null;
      // Not checked yet: the next call checks again.
      const unchecked = (login: TeamLogin) => ({ ok: true, login, checkedAt: 0 }) as const;
      const login = yield* host.login(entry.location);
      if (login.status !== "signedIn") {
        return lastLogin === null ? { ok: false, membership: login } : unchecked(lastLogin);
      }
      if (entry.location !== null) {
        const access = yield* host.repoAccess(entry.location);
        if (access.status === "notFound") return { ok: false, membership: { status: "noAccess" } };
        if (access.status === "found" && !access.canPush) {
          return { ok: false, membership: { status: "noPushAccess" } };
        }
        if (access.status === "unavailable") {
          return lastLogin === login.login
            ? unchecked(login.login)
            : { ok: false, membership: access };
        }
      }
      return { ok: true, login: login.login, checkedAt: now } as const;
    });

  /** The member view of a login that has a writer file. */
  const memberOf = (entry: TeamEntry, login: TeamLogin) => {
    const view = entry.view;
    const member = view?.members.find((candidate) => candidate.login === login);
    return view && member ? toMember(view, member) : null;
  };

  /**
   * Opens a team from a checkout, checks this server may use it, and writes
   * this server's writer file the first time (joining).
   */
  const open = (
    input: OpenTeamInput,
    create: boolean,
  ): Effect.Effect<
    { readonly membership: TeamMembership; readonly created: boolean },
    TeamServiceError
  > =>
    Effect.gen(function* () {
      const result = (membership: TeamMembership, created: boolean) => ({ membership, created });
      const remoteUrl = yield* remoteUrlOf(input.checkout);
      if (remoteUrl === null) return result({ status: "noRemote" }, false);
      const entry = yield* entryFor(input.teamFile.teamId, remoteUrl);
      return yield* entry.openLock.withPermits(1)(openEntry(entry, input, create));
    });

  const openEntry = (
    entry: TeamEntry,
    input: OpenTeamInput,
    create: boolean,
  ): Effect.Effect<
    { readonly membership: TeamMembership; readonly created: boolean },
    TeamServiceError
  > =>
    Effect.gen(function* () {
      const result = (membership: TeamMembership, created: boolean) => ({ membership, created });
      const access = yield* checkAccess(entry);
      if (!access.ok) return result(access.membership, false);
      yield* entry.lock.withPermits(1)(adoptSoloFiles(entry, access.login));

      // The first open in this process, and every ensureTeam, reads the remote;
      // later opens use what syncs brought.
      let remoteMissing = false;
      if (create || entry.me === null || entry.view === null) {
        const fetched = yield* entry.repo.fetch();
        if (fetched.status === "unreachable" && (create || entry.parsed.team === null)) {
          return result(
            { status: "unavailable", detail: "Could not reach the project's remote." },
            false,
          );
        }
        remoteMissing = fetched.status === "missing";
        yield* entry.lock.withPermits(1)(reload(entry));
      }

      // A team.json already in this server's files is from a start whose push failed.
      const created = create && remoteMissing;
      if (created && entry.parsed.team === null) {
        yield* entry.repo.saveMine(
          TEAM_STATE_TEAM_FILE,
          Model.encodeTeamStateTeamFile({
            format: TEAM_STATE_FORMAT,
            teamId: input.teamFile.teamId,
            name: input.teamFile.name,
            createdBy: access.login,
            createdAt: yield* nowIso,
          }),
        );
      } else if (entry.parsed.team === null) {
        return result({ status: "noTeamState" }, false);
      } else if (entry.parsed.team.teamId !== input.teamFile.teamId) {
        return result({ status: "otherTeam", teamId: entry.parsed.team.teamId }, false);
      }

      const joined = yield* entry.lock.withPermits(1)(
        Effect.gen(function* () {
          if (created) yield* reload(entry);
          entry.me = {
            login: access.login,
            checkedAt: access.checkedAt,
          };
          if (myFile(entry, access.login) !== undefined) return false;
          const now = yield* nowIso;
          const empty = Model.emptyWriterFile({
            login: access.login,
            displayName: access.login,
            environmentId,
            now,
          });
          yield* saveMyFile(
            entry,
            Model.addActivity(empty, {
              activityId: TeamActivityId.make(yield* newId),
              kind: created ? "team.created" : "member.joined",
              summary: created
                ? `${access.login} created team ${input.teamFile.name}.`
                : `${access.login} joined the team.`,
              thread: null,
              createdAt: now,
            }),
          );
          return true;
        }),
      );
      if (created) {
        // Starting the team is the one sync that may create the ref.
        const pushed = yield* entry.repo.sync({
          message: `team state: ${access.login} created the team`,
          author: { name: access.login, email: `${access.login}@users.noreply.github.com` },
          create: true,
        });
        yield* entry.lock.withPermits(1)(reload(entry));
        if (!pushed.confirmed) {
          return result(
            {
              status: "unavailable",
              detail: `The team state could not be pushed (${pushed.reason}).`,
            },
            created,
          );
        }
      } else if (joined) {
        yield* scheduleSync(entry);
      }
      const member = memberOf(entry, access.login);
      if (entry.view === null || member === null) {
        return result(
          { status: "unavailable", detail: "The team state could not be read." },
          created,
        );
      }
      return result({ status: "member", team: toTeam(entry.view), member }, created);
    });

  /**
   * A solo team that became a team: renames this server's solo writer file to
   * the login, with the tasks it owned, and names the login as the team's
   * creator. Call holding `entry.lock`; does nothing when there is no solo file.
   */
  const adoptSoloFiles = (entry: TeamEntry, login: TeamLogin) =>
    Effect.gen(function* () {
      const solo = myFile(entry, SoloTeam.SOLO_LOGIN);
      if (solo === undefined) return;
      const mine = myFile(entry, login);
      const asLogin = (owner: TeamLogin | null) => (owner === SoloTeam.SOLO_LOGIN ? login : owner);
      yield* saveMyFile(entry, {
        ...solo,
        ...mine,
        login,
        displayName: mine?.displayName ?? login,
        claims: [...(mine?.claims ?? []), ...solo.claims],
        tasks: [...(mine?.tasks ?? []), ...solo.tasks].map((task) => ({
          ...task,
          owner: asLogin(task.owner),
        })),
        notes: [...(mine?.notes ?? []), ...solo.notes],
        activity: [...(mine?.activity ?? []), ...solo.activity],
      });
      const soloPath = Model.writerFilePath(SoloTeam.SOLO_LOGIN, environmentId);
      yield* entry.repo.removeMine(soloPath);
      const soloKey = Model.writerKey(SoloTeam.SOLO_LOGIN, environmentId);
      entry.parsed = {
        ...entry.parsed,
        writers: entry.parsed.writers.filter((writer) => writer.key !== soloKey),
      };
      const team = entry.parsed.team;
      if (team !== null && team.createdBy === SoloTeam.SOLO_LOGIN) {
        yield* entry.repo.saveMine(
          TEAM_STATE_TEAM_FILE,
          Model.encodeTeamStateTeamFile({ ...team, createdBy: login }),
        );
      }
      yield* reload(entry);
    });

  /**
   * The solo team of a project folder (./SoloTeam.ts), started on first use.
   * Once the folder became a team, a chat whose checkout has no
   * `.team/team.json` yet (an older worktree) gets the team this server opened.
   */
  const openSolo = Effect.fn("GitTeamService.openSolo")(function* (input: OpenSoloInput) {
    const teamId = yield* SoloTeam.soloTeamIdOf(input.projectRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const existing = teams.get(teamId);
    const entry = existing ?? (yield* entryFor(teamId, null));
    if (entry.remoteUrl !== null) {
      const member = entry.me === null ? null : memberOf(entry, entry.me.login);
      return entry.view !== null && member !== null
        ? ({ status: "member", team: toTeam(entry.view), member } as const)
        : ({
            status: "unavailable",
            detail: "this folder became a team; open its team from a checkout with .team/team.json",
          } as const);
    }
    return yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        if (entry.parsed.team === null) {
          yield* entry.repo.saveMine(
            TEAM_STATE_TEAM_FILE,
            Model.encodeTeamStateTeamFile({
              format: TEAM_STATE_FORMAT,
              teamId,
              name: input.name.trim() || "Solo",
              createdBy: SoloTeam.SOLO_LOGIN,
              createdAt: now,
            }),
          );
          yield* reload(entry);
        }
        if (myFile(entry, SoloTeam.SOLO_LOGIN) === undefined) {
          yield* saveMyFile(
            entry,
            Model.emptyWriterFile({
              login: SoloTeam.SOLO_LOGIN,
              displayName: SoloTeam.SOLO_DISPLAY_NAME,
              environmentId,
              now,
            }),
          );
        }
        // Never checked with a host, so never checked again.
        entry.me = { login: SoloTeam.SOLO_LOGIN, checkedAt: Number.POSITIVE_INFINITY };
        const member = memberOf(entry, SoloTeam.SOLO_LOGIN);
        if (entry.view === null || member === null) {
          return yield* new TeamStorageError({
            operation: "openSolo",
            cause: new Error("The solo state could not be read."),
          });
        }
        return { status: "member", team: toTeam(entry.view), member } as const;
      }),
    );
  });

  const requireEntry = (teamId: TeamId) =>
    Effect.gen(function* () {
      const entry = teams.get(teamId);
      if (entry === undefined || entry.view === null) {
        return yield* new TeamNotFoundError({ teamId });
      }
      return { entry, view: entry.view };
    });

  /** The entry and this server's file, when `memberId` is who this server writes as. */
  const requireMe = (teamId: TeamId, memberId: TeamMemberId) =>
    Effect.gen(function* () {
      const { entry } = yield* requireEntry(teamId);
      const login = entry.me?.login;
      const file = login === undefined || login !== memberId ? undefined : myFile(entry, login);
      if (file === undefined) return yield* new TeamMemberNotFoundError({ teamId, memberId });
      return { entry, file };
    });

  const requireMember = (view: Model.TeamStateView, memberId: TeamMemberId) =>
    view.members.some((member) => member.login === memberId)
      ? Effect.void
      : Effect.fail(new TeamMemberNotFoundError({ teamId: view.team.teamId, memberId }));

  const claimPaths = Effect.fn("GitTeamService.claimPaths")(function* (input: ClaimPathsInput) {
    const paths = yield* normalizeClaimPaths(input.paths);
    if (paths.length === 0) {
      return yield* new TeamClaimPathsInvalidError({ detail: "Name at least one path to claim." });
    }
    const claimId = TeamClaimId.make(yield* newId);
    const activityId = TeamActivityId.make(yield* newId);
    const { entry } = yield* requireEntry(input.teamId);
    const claim = yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.memberId);
        const now = yield* nowIso;
        const added = Model.addClaim(file, {
          claimId,
          activityId,
          thread: input.thread,
          paths,
          note: optionalText(input.note),
          now,
        });
        yield* saveMyFile(entry, added.file);
        return toClaim(input.teamId, file.login, added.claim);
      }),
    );

    // The sync fetches first, so the overlaps below include claims pushed from elsewhere.
    // A solo team has only this server's claims, already in the view.
    const confirmed =
      entry.remoteUrl === null
        ? true
        : (yield* syncEntry(entry, TEAM_CLAIM_NETWORK_TIMEOUT_MS)).confirmed;
    const overlaps = Model.claimOverlaps(entry.view?.activeClaims ?? [], claim);
    // This result reports them; they are not late overlaps.
    const keys = new Set(
      overlaps.map((overlap) => Model.overlapKey(claim.claimId, overlap.claim.claimId)),
    );
    entry.reported = new Set([...entry.reported, ...keys]);
    entry.late = entry.late.filter((overlap) => !keys.has(overlap.key));
    return { claim, overlaps, confirmed };
  });

  const releasePaths = Effect.fn("GitTeamService.releasePaths")(function* (
    input: ReleasePathsInput,
  ) {
    const releasing =
      input.paths === undefined ? undefined : yield* normalizeClaimPaths(input.paths);
    const { entry } = yield* requireEntry(input.teamId);
    const activityId = TeamActivityId.make(yield* newId);
    const changed = yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.memberId);
        const result = Model.releasePaths(file, {
          activityId,
          thread: input.thread,
          paths: releasing,
          now: yield* nowIso,
        });
        if (result.changed.length === 0) return [];
        yield* saveMyFile(entry, result.file);
        return result.changed.map((claim) => toClaim(input.teamId, file.login, claim));
      }),
    );
    if (changed.length > 0) yield* scheduleSync(entry);
    return changed;
  });

  const releaseThreadClaims = Effect.fn("GitTeamService.releaseThreadClaims")(function* (
    input: ReleaseThreadClaimsInput,
  ) {
    const released: Array<TeamClaim> = [];
    for (const entry of teams.values()) {
      const changed = yield* entry.lock.withPermits(1)(
        Effect.gen(function* () {
          const changedHere: Array<TeamClaim> = [];
          for (const { file } of myFiles(entry)) {
            const result = Model.releaseThreadClaims(file, {
              activityId: TeamActivityId.make(yield* newId),
              thread: input.thread,
              reason: input.reason,
              claimedBefore: input.claimedBefore,
              now: yield* nowIso,
            });
            if (result.released.length === 0) continue;
            yield* saveMyFile(entry, result.file);
            changedHere.push(
              ...result.released.map((claim) => toClaim(entry.teamId, file.login, claim)),
            );
          }
          return changedHere;
        }),
      );
      if (changed.length > 0) {
        released.push(...changed);
        yield* scheduleSync(entry);
      }
    }
    return released;
  });

  const createTask = Effect.fn("GitTeamService.createTask")(function* (input: CreateTaskInput) {
    const paths = yield* normalizeClaimPaths(input.paths ?? []);
    const { entry } = yield* requireEntry(input.teamId);
    const taskId = TeamTaskId.make(yield* newId);
    const activityId = TeamActivityId.make(yield* newId);
    const task = yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.actorMemberId);
        const view = entry.view!;
        if (input.ownerMemberId !== undefined) yield* requireMember(view, input.ownerMemberId);
        const now = yield* nowIso;
        const task: TeamStateTask = {
          taskId,
          title: input.title.trim(),
          status: input.status ?? "todo",
          note: optionalText(input.note),
          paths,
          owner: input.ownerMemberId ?? null,
          thread: input.thread ?? null,
          createdAt: now,
          updatedAt: now,
        };
        yield* saveMyFile(entry, Model.saveTask(file, { task, previous: null, activityId }));
        return task;
      }),
    );
    yield* scheduleSync(entry);
    return yield* findTask(input.teamId, task.taskId);
  });

  const findTask = (teamId: TeamId, taskId: TeamTaskId) =>
    Effect.gen(function* () {
      const { view } = yield* requireEntry(teamId);
      const task = view.tasks.find((candidate) => candidate.taskId === taskId);
      if (task === undefined) return yield* new TeamTaskNotFoundError({ teamId, taskId });
      return task;
    });

  const updateTask = Effect.fn("GitTeamService.updateTask")(function* (input: UpdateTaskInput) {
    const { entry } = yield* requireEntry(input.teamId);
    const activityId = TeamActivityId.make(yield* newId);
    yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.actorMemberId);
        const view = entry.view!;
        const current = view.tasks.find((task) => task.taskId === input.taskId);
        if (current === undefined) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId: input.taskId });
        }
        if (input.ownerMemberId !== undefined && input.ownerMemberId !== null) {
          yield* requireMember(view, input.ownerMemberId);
        }
        // Newer than the version it edits even when that writer's clock is ahead,
        // or every reader (this one too) would keep the old version.
        const now = Math.max(yield* nowMillis, Date.parse(current.updatedAt) + 1);
        const ownerMemberId =
          input.ownerMemberId === undefined ? current.ownerMemberId : input.ownerMemberId;
        const task: TeamStateTask = {
          taskId: current.taskId,
          title: current.title,
          status: input.status ?? current.status,
          note: input.note === undefined ? current.note : optionalText(input.note),
          paths: current.paths,
          owner: ownerMemberId,
          thread: input.thread === undefined ? current.thread : input.thread,
          createdAt: current.createdAt,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        };
        yield* saveMyFile(entry, Model.saveTask(file, { task, previous: current, activityId }));
      }),
    );
    yield* scheduleSync(entry);
    return yield* findTask(input.teamId, input.taskId);
  });

  const writeHandoff = Effect.fn("GitTeamService.writeHandoff")(function* (
    input: WriteHandoffInput,
  ) {
    const changed = input.changed.trim();
    const left = optionalText(input.left);
    const risks = optionalText(input.risks);
    const words = countTeamWords([changed, left ?? "", risks ?? ""].join(" "));
    if (words > TEAM_HANDOFF_MAX_WORDS) {
      return yield* new TeamHandoffTooLongError({ words, maxWords: TEAM_HANDOFF_MAX_WORDS });
    }
    const files = yield* normalizeClaimPaths(input.files);
    const fileHashes = keepHashesOf(files, input.fileHashes);
    const { entry } = yield* requireEntry(input.teamId);
    const handoffId = TeamHandoffId.make(yield* newId);
    const activityId = TeamActivityId.make(yield* newId);
    const handoff = yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.memberId);
        if (
          input.taskId !== undefined &&
          !entry.view!.tasks.some((task) => task.taskId === input.taskId)
        ) {
          return yield* new TeamTaskNotFoundError({ teamId: input.teamId, taskId: input.taskId });
        }
        const note = {
          handoffId,
          thread: input.thread,
          taskId: input.taskId ?? null,
          changed,
          left,
          risks,
          files,
          commit: optionalText(input.commit),
          fileHashes,
          automatic: false,
          createdAt: yield* nowIso,
        };
        yield* saveMyFile(entry, Model.addHandoff(file, { note, activityId }));
        return { ...note, teamId: input.teamId, memberId: input.memberId } satisfies TeamHandoff;
      }),
    );
    yield* scheduleSync(entry);
    return handoff;
  });

  const saveAutomaticNote = Effect.fn("GitTeamService.saveAutomaticNote")(function* (
    input: SaveAutomaticNoteInput,
  ) {
    const turnFiles = yield* normalizeClaimPaths(input.files);
    const { entry } = yield* requireEntry(input.teamId);
    const handoffId = TeamHandoffId.make(yield* newId);
    const note = yield* entry.lock.withPermits(1)(
      Effect.gen(function* () {
        const { file } = yield* requireMe(input.teamId, input.memberId);
        const task =
          input.taskId === undefined
            ? undefined
            : entry.view!.tasks.find((candidate) => candidate.taskId === input.taskId);
        const saved = Model.saveAutomaticNote(file, {
          handoffId,
          thread: input.thread,
          task: task === undefined ? null : { taskId: task.taskId, title: task.title },
          files: turnFiles,
          fileHashes: keepHashesOf(turnFiles, input.fileHashes) ?? {},
          commit: optionalText(input.commit),
          now: yield* nowIso,
        });
        yield* saveMyFile(entry, saved.file);
        return {
          ...saved.note,
          teamId: input.teamId,
          memberId: input.memberId,
        } satisfies TeamHandoff;
      }),
    );
    yield* scheduleSync(entry);
    return note;
  });

  const view = (teamId: TeamId) => requireEntry(teamId).pipe(Effect.map(({ view }) => view));

  return TeamService.of({
    openTeam: (input) => open(input, false).pipe(Effect.map((result) => result.membership)),
    openSolo,
    isSolo: (teamId) => Effect.sync(() => teams.get(teamId)?.remoteUrl === null),
    ensureTeam: (input) => open(input, true),
    getTeam: (teamId) =>
      Effect.sync(() => {
        const found = teams.get(teamId)?.view;
        return found ? Option.some(toTeam(found)) : Option.none();
      }),
    listTeams: () =>
      Effect.sync(() =>
        [...teams.values()]
          .flatMap((entry) => (entry.view === null ? [] : [toTeam(entry.view)]))
          .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      ),
    listMembers: (teamId) =>
      view(teamId).pipe(
        Effect.map((found) => found.members.map((member) => toMember(found, member))),
      ),
    currentMember: (teamId) =>
      Effect.sync(() => {
        const entry = teams.get(teamId);
        const login = entry?.me?.login;
        return Option.fromNullishOr(entry && login ? memberOf(entry, login) : null);
      }),
    claimPaths,
    releasePaths,
    listActiveClaims: (teamId) => view(teamId).pipe(Effect.map((found) => found.activeClaims)),
    releaseThreadClaims,
    listClaimedThreads: (forEnvironment) =>
      Effect.sync(() => {
        const threads = new Set<ThreadId>();
        for (const entry of teams.values()) {
          for (const { file } of myFiles(entry)) {
            for (const claim of file.claims) {
              if (claim.releasedAt === null && claim.thread.environmentId === forEnvironment) {
                threads.add(claim.thread.threadId);
              }
            }
          }
        }
        return [...threads].toSorted();
      }),
    createTask,
    updateTask,
    getTask: (teamId, taskId) =>
      view(teamId).pipe(
        Effect.map((found) =>
          Option.fromNullishOr(found.tasks.find((task) => task.taskId === taskId)),
        ),
      ),
    findTaskForThread: (teamId, thread) =>
      view(teamId).pipe(
        Effect.map((found) =>
          Option.fromNullishOr(
            found.tasks.findLast((task) => task.thread !== null && sameThread(task.thread, thread)),
          ),
        ),
      ),
    listTasks: (teamId) => view(teamId).pipe(Effect.map((found) => found.tasks)),
    writeHandoff,
    saveAutomaticNote,
    listHandoffs: (teamId, listOptions) =>
      view(teamId).pipe(
        Effect.map((found) =>
          found.notes
            .filter(
              (note) =>
                listOptions?.thread === undefined || sameThread(note.thread, listOptions.thread),
            )
            .slice(0, listOptions?.limit ?? DEFAULT_LIST_LIMIT),
        ),
      ),
    listActivity: (teamId, listOptions) =>
      view(teamId).pipe(
        Effect.map((found) => found.activity.slice(0, listOptions?.limit ?? DEFAULT_LIST_LIMIT)),
      ),
    freshness: (teamId) =>
      Effect.sync(() => {
        const entry = teams.get(teamId);
        return entry === undefined || !entry.readFailed
          ? ({ fresh: true } as const)
          : ({ fresh: false, readAt: entry.readAt } as const);
      }),
    takeLateOverlaps: (teamId, thread) =>
      Effect.sync(() => {
        const entry = teams.get(teamId);
        if (entry === undefined) return [];
        const taken = entry.late.filter((overlap) => sameThread(overlap.mine.thread, thread));
        entry.late = entry.late.filter((overlap) => !taken.includes(overlap));
        return taken;
      }),
    refresh: (teamId) =>
      Effect.gen(function* () {
        const entry = teams.get(teamId);
        if (entry === undefined) return yield* new TeamNotFoundError({ teamId });
        if (entry.remoteUrl === null) return { status: "solo" } as const;
        return yield* refreshEntry(entry);
      }),
    sync: (teamId) =>
      Effect.gen(function* () {
        const entry = teams.get(teamId);
        if (entry === undefined) return yield* new TeamNotFoundError({ teamId });
        if (entry.remoteUrl === null)
          return { confirmed: false, reason: "solo", attempts: 0 } as const;
        return yield* syncEntry(entry);
      }),
  });
});

/**
 * `TeamService` for the server: this server's environment, state repos in
 * `<state dir>/team`, GitHub through `gh`.
 */
export const layer = Layer.effect(
  TeamService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    return yield* make({
      environmentId: yield* environment.getEnvironmentId,
      stateDirectory: path.join(config.stateDir, "team"),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(GitVcsDriver.layer, TeamHost.layer)));
