/**
 * TeamHost - the three things the team state needs from the Git host beyond
 * plain Git (team/STORAGE_PLAN.md Q3): who this person is, whether they can
 * push to the repo (and whether it is public), and whether the state ref
 * moved. GitHub only in v1, through `gh` and its signed-in account; another
 * host needs another implementation of these three calls, not a new store.
 *
 * Every call answers with a status, never an error: the team tools turn each
 * one into a plain reason ("not signed in to GitHub", "no push access").
 *
 * @module TeamHost
 */
import { TEAM_STATE_REF, TeamLogin } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { parseGitHubAuthStatus } from "../../sourceControl/gitHubAuthStatus.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";

/** Dev only: makes this server act as another GitHub login (two people on one laptop). */
export const TEAM_LOGIN_OVERRIDE_ENV = "T3CODE_TEAM_LOGIN_OVERRIDE";

const GH_TIMEOUT_MS = 15_000;
/**
 * A signed-in answer from `gh auth status` is reused this long (upstream's
 * viewer cache time). `gh auth status` takes about half a second, and the
 * first turn after a start must not spend it again for every team.
 */
export const TEAM_LOGIN_CACHE_TTL = Duration.minutes(10);
/** No prompts and no update notices: nobody can answer them. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };

/** A repo on a Git host, from the project's remote URL. */
export interface TeamRepoLocation {
  /** Lower case, e.g. `github.com`. */
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export type TeamHostLogin =
  | { readonly status: "signedIn"; readonly login: TeamLogin; readonly override: boolean }
  | { readonly status: "signedOut"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string };

export type TeamHostRepoAccess =
  | { readonly status: "found"; readonly canPush: boolean; readonly isPublic: boolean }
  /** No such repo, or no access to it: GitHub answers both with 404. */
  | { readonly status: "notFound" }
  | { readonly status: "unavailable"; readonly detail: string };

export type TeamHostRefCheck =
  /** The ref did not move since the ETag was taken. Free on GitHub. */
  | { readonly status: "unchanged" }
  /** The ref as the host has it now; compare `sha` with the local tip. */
  | { readonly status: "current"; readonly sha: string; readonly etag: string | null }
  /** The remote has no team state. */
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly detail: string };

export class TeamHost extends Context.Service<
  TeamHost,
  {
    /**
     * The signed-in account for the repo's host. Null is a remote on this
     * computer (a folder or `file://` URL, for tests and demos): it has no
     * account, so only the dev override can name the person.
     */
    readonly login: (repo: TeamRepoLocation | null) => Effect.Effect<TeamHostLogin>;
    readonly repoAccess: (repo: TeamRepoLocation) => Effect.Effect<TeamHostRepoAccess>;
    /**
     * A conditional request for the state ref. Pass the ETag of the last
     * answer; a `304` is not counted against GitHub's rate limit.
     */
    readonly refChanged: (
      repo: TeamRepoLocation,
      etag: string | null,
    ) => Effect.Effect<TeamHostRefCheck>;
  }
>()("t3/team/state/TeamHost") {}

/**
 * The host, owner and repo of a remote URL: `https://host/owner/repo(.git)`,
 * `ssh://git@host(:port)/owner/repo(.git)` or `git@host:owner/repo(.git)`.
 * Null for anything else (a local path, a `file://` URL).
 */
export const parseTeamRemoteUrl = (url: string): TeamRepoLocation | null => {
  const trimmed = url.trim();
  let host: string;
  let repoPath: string;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/u.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:"].includes(parsed.protocol) || parsed.hostname === "") {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  const parts = repoPath
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part))) return null;
  return { host: host.toLowerCase(), owner: parts[0]!, name: parts[1]! };
};

export interface HttpResponse {
  readonly status: number;
  /** Lower-case names. */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Splits `gh api -i` output into the status, headers and body. Null when it is not a response. */
export const parseHttpResponse = (output: string): HttpResponse | null => {
  const text = output.replaceAll("\r\n", "\n");
  const status = /^HTTP\/[\d.]+ (\d{3})/u.exec(text);
  if (!status) return null;
  const end = text.indexOf("\n\n");
  const head = end === -1 ? text : text.slice(0, end);
  const headers = new Map<string, string>();
  for (const line of head.split("\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body: end === -1 ? "" : text.slice(end + 2) };
};

const RefBody = Schema.fromJsonString(
  Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) }),
);
const decodeRefBody = Schema.decodeUnknownOption(RefBody);

const RepoBody = Schema.fromJsonString(
  Schema.Struct({
    private: Schema.Boolean,
    visibility: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(Schema.Struct({ push: Schema.Boolean })),
  }),
);
const decodeRepoBody = Schema.decodeUnknownOption(RepoBody);
const decodeLogin = Schema.decodeUnknownOption(TeamLogin);

/** Hosts other than github.com need `--hostname` on `gh api`. */
const hostnameArgs = (repo: TeamRepoLocation) =>
  repo.host === "github.com" ? [] : ["--hostname", repo.host];

/** "Not Found (HTTP 404)" and the like, from gh's stderr. */
const firstLine = (text: string) => text.trim().split("\n").at(-1)?.trim() || "no output";

export interface TeamHostOptions {
  /** The value of {@link TEAM_LOGIN_OVERRIDE_ENV}, if set. */
  readonly loginOverride?: string | undefined;
  /** The override is used only when this is true. */
  readonly devMode: boolean;
  /** Where `gh` runs; it reads nothing from there. */
  readonly cwd: string;
}

export const make = Effect.fn("TeamHost.make")(function* (options: TeamHostOptions) {
  const process = yield* VcsProcess.VcsProcess;

  const override = options.loginOverride?.trim() ?? "";
  if (override !== "" && !options.devMode) {
    yield* Effect.logWarning(
      `${TEAM_LOGIN_OVERRIDE_ENV} is set but this server is not in dev mode; using the gh login instead.`,
    );
  }

  /** Runs gh; null when it could not run at all (not installed, timed out). */
  const gh = (operation: string, args: ReadonlyArray<string>) =>
    process
      .run({
        operation: `TeamHost.${operation}`,
        command: "gh",
        args,
        cwd: options.cwd,
        env: GH_ENV,
        allowNonZeroExit: true,
        timeoutMs: GH_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((output) => ({ ok: true, output }) as const),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            detail:
              error._tag === "VcsProcessSpawnError"
                ? "The GitHub CLI (gh) is not installed."
                : `The GitHub CLI (gh) failed: ${error.message}`,
          } as const),
        ),
      );

  /** Signed-in answers by host. Other answers are not kept: signing in works at once. */
  const loginCache = new Map<string, { readonly login: TeamHostLogin; readonly at: number }>();

  const login: TeamHost["Service"]["login"] = Effect.fn("TeamHost.login")(function* (repo) {
    if (override !== "" && options.devMode) {
      const parsed = decodeLogin(override);
      return Option.isSome(parsed)
        ? ({ status: "signedIn", login: parsed.value, override: true } as const)
        : ({
            status: "unavailable",
            detail: `${TEAM_LOGIN_OVERRIDE_ENV} is not a GitHub login: "${override}".`,
          } as const);
    }
    if (repo === null) {
      return {
        status: "signedOut",
        detail: `This project's remote is a folder on this computer, which has no GitHub account. Dev servers can set ${TEAM_LOGIN_OVERRIDE_ENV}.`,
      } as const;
    }
    const now = yield* Clock.currentTimeMillis;
    const cached = loginCache.get(repo.host);
    if (cached !== undefined && now - cached.at < Duration.toMillis(TEAM_LOGIN_CACHE_TTL)) {
      return cached.login;
    }
    const answer = yield* askLogin(repo);
    if (answer.status === "signedIn") loginCache.set(repo.host, { login: answer, at: now });
    else loginCache.delete(repo.host);
    return answer;
  });

  const askLogin = Effect.fnUntraced(function* (
    repo: TeamRepoLocation,
  ): Effect.fn.Return<TeamHostLogin> {
    const result = yield* gh("login", [
      "auth",
      "status",
      "--json",
      "hosts",
      "--hostname",
      repo.host,
    ]);
    if (!result.ok) return { status: "unavailable", detail: result.detail } as const;
    const status = parseGitHubAuthStatus(result.output.stdout);
    if (!status.parsed) {
      return {
        status: "unavailable",
        detail: `Could not read gh auth status: ${firstLine(result.output.stderr)}`,
      } as const;
    }
    // Only the active account: it is the one gh and Git pushes use, so another
    // signed-in account would write files under a name that is not pushing them.
    const active = status.accounts.find((account) => account.host === repo.host && account.active);
    if (active === undefined) {
      return { status: "signedOut", detail: `Not signed in to ${repo.host} in gh.` } as const;
    }
    if (!active.authenticated) {
      return {
        status: "signedOut",
        detail: `The gh sign-in for ${active.account} on ${repo.host} does not work${
          active.error === null ? "" : `: ${active.error}`
        }.`,
      } as const;
    }
    const parsed = decodeLogin(active.account);
    return Option.isSome(parsed)
      ? ({ status: "signedIn", login: parsed.value, override: false } as const)
      : ({ status: "unavailable", detail: `Not a GitHub login: "${active.account}".` } as const);
  });

  const repoAccess: TeamHost["Service"]["repoAccess"] = Effect.fn("TeamHost.repoAccess")(
    function* (repo) {
      const result = yield* gh("repoAccess", [
        "api",
        ...hostnameArgs(repo),
        `repos/${repo.owner}/${repo.name}`,
      ]);
      if (!result.ok) return { status: "unavailable", detail: result.detail } as const;
      const { exitCode, stdout, stderr } = result.output;
      if (exitCode !== 0) {
        return /\(HTTP 404\)/u.test(stderr)
          ? ({ status: "notFound" } as const)
          : ({ status: "unavailable", detail: firstLine(stderr) } as const);
      }
      const body = decodeRepoBody(stdout);
      if (Option.isNone(body)) {
        return {
          status: "unavailable",
          detail: "GitHub sent a repo this app cannot read.",
        } as const;
      }
      return {
        status: "found",
        canPush: body.value.permissions?.push === true,
        isPublic:
          body.value.visibility === undefined
            ? !body.value.private
            : body.value.visibility === "public",
      } as const;
    },
  );

  const refChanged: TeamHost["Service"]["refChanged"] = Effect.fn("TeamHost.refChanged")(
    function* (repo, etag) {
      const result = yield* gh("refChanged", [
        "api",
        "-i",
        ...hostnameArgs(repo),
        ...(etag === null ? [] : ["-H", `If-None-Match: ${etag}`]),
        `repos/${repo.owner}/${repo.name}/git/ref/${TEAM_STATE_REF.replace(/^refs\//u, "")}`,
      ]);
      if (!result.ok) return { status: "unavailable", detail: result.detail } as const;
      // gh exits 1 on a 304 as on any other non-2xx, so the status line decides.
      const response = parseHttpResponse(result.output.stdout);
      if (response === null) {
        return { status: "unavailable", detail: firstLine(result.output.stderr) } as const;
      }
      if (response.status === 304) return { status: "unchanged" } as const;
      if (response.status === 404) return { status: "missing" } as const;
      if (response.status !== 200) {
        return {
          status: "unavailable",
          detail: `GitHub answered HTTP ${response.status}.`,
        } as const;
      }
      const body = decodeRefBody(response.body);
      if (Option.isNone(body)) {
        return {
          status: "unavailable",
          detail: "GitHub sent a ref this app cannot read.",
        } as const;
      }
      return {
        status: "current",
        sha: body.value.object.sha,
        etag: response.headers.get("etag") ?? null,
      } as const;
    },
  );

  return TeamHost.of({ login, repoAccess, refChanged });
});

/** GitHub through `gh`. Dev mode is a dev server (it has a dev URL). */
export const layer = Layer.effect(
  TeamHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make({
      loginOverride: globalThis.process.env[TEAM_LOGIN_OVERRIDE_ENV],
      devMode: config.devUrl !== undefined,
      cwd: config.cwd,
    });
  }),
);
