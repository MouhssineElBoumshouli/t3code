#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a dev script: synchronous Git and file setup.

/**
 * Team layer cold start test (fork-only, team/DESIGN.md D8, team/COLD_START_TEST.md).
 *
 * Builds a fresh demo project with a local bare remote and seeds its team
 * state on that remote (`refs/t3-team/state`, team/STORAGE_PLAN.md):
 *
 * - the repo: a tiny app ("Pinboard"), `.team/team.json`, a rulebook, one
 *   decision file, and `t3.json` with worktrees on; its `origin` is
 *   `<project>-remote.git` next to it;
 * - the team state, written by three T3 servers as the real ones would: you
 *   (the dev home's server, as the login `--you`) and two teammates, Sara and
 *   Omar, on their own servers; two tasks; claims from Sara's and Omar's
 *   chats; two handoffs, one of them outdated by a later commit.
 *
 * Teammates live on other servers because claims of this server's threads
 * that do not exist are released when the server starts (claim lifetime, D5).
 *
 * A remote on this computer has no GitHub account, so the dev server must act
 * as `--you` through `T3CODE_TEAM_LOGIN_OVERRIDE` (the script prints the command).
 *
 * Safe to re-run: the project and its remote are rebuilt only if this script
 * made them (it refuses any other folder), and the dev home's copy of this
 * team's state is deleted so the server fetches the new one. Stop the dev
 * server first.
 *
 *   node apps/server/scripts/team-cold-start-seed.ts [--home-dir ~/.t3-dev]
 *     [--project ~/code/team-demo5] [--you login]
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_SCHEMA_URL,
  TeamFile,
  TeamId,
  TeamLogin,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../src/config.ts";
import * as GitTeamService from "../src/team/state/GitTeamService.ts";
import * as TeamHost from "../src/team/state/TeamHost.ts";
import type * as TeamService from "../src/team/TeamService.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import {
  APP_FILES,
  commitAll,
  expandHome,
  git,
  inside,
  T3CODE_REPO,
  writeFiles,
} from "./teamDemoRepo.ts";

const TEAM_FILE = TeamFile.make({
  teamId: TeamId.make("team-demo5-cold-start"),
  name: "Demo team 5",
});
const SARA_ENVIRONMENT = EnvironmentId.make("demo5-sara-server");
const OMAR_ENVIRONMENT = EnvironmentId.make("demo5-omar-server");
const SARA_CHAT = ThreadId.make("demo5-sara-chat");
const OMAR_CHAT = ThreadId.make("demo5-omar-chat");
/** Your earlier chat on this task. It ended, so it holds no claims. */
const YOUR_OLD_CHAT = ThreadId.make("demo5-your-earlier-chat");

class SeedRefusedError extends Schema.TaggedError<SeedRefusedError>()("SeedRefusedError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const refuse = (detail: string) => Effect.fail(new SeedRefusedError({ detail }));

const usage =
  "Usage: node apps/server/scripts/team-cold-start-seed.ts [--home-dir ~/.t3-dev] [--project ~/code/team-demo5] [--you login]";

/** Marks a remote this script made, so a re-run may rebuild it. */
const REMOTE_MARKER = "t3-team-cold-start-seed";
const isLogin = Schema.is(TeamLogin);
/** Your login when `--you` is not given: this computer's user name, if it can be a login. */
const defaultLogin = () => {
  const user = NodeOS.userInfo().username;
  return isLogin(user) ? user : "me";
};

function readArgs() {
  const args = process.argv.slice(2);
  const options = {
    homeDir: "~/.t3-dev",
    project: "~/code/team-demo5",
    you: undefined as string | undefined,
  };
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (value === undefined) return null;
    if (flag === "--home-dir") options.homeDir = value;
    else if (flag === "--project") options.project = value;
    else if (flag === "--you") options.you = value;
    else return null;
  }
  const project = expandHome(options.project);
  return {
    homeDir: expandHome(options.homeDir),
    project,
    remote: `${project}-remote.git`,
    you: options.you ?? defaultLogin(),
  };
}

const RULEBOOK = `# Project rulebook

Keep this file under 1,500 words. Every agent on the team reads all of it before its first change.

## What this project is

Pinboard: a small web app to save links ("pins") with tags and search them. TypeScript on Node 24, no framework, no database: pins live in \`data/pins.json\`.

## How we work

- One chat per task, each in its own worktree. Small pull requests into \`main\`.
- Claim files with team_claim before editing them.
- Write a handoff when you stop, saying what is left.

## Code rules

- No new dependencies without a decision file in \`.team/decisions/\`.
- Every route in \`src/api/routes.ts\` checks its input.
- Keep auth code in \`src/auth/\`.

## Do not touch

- \`data/\`: the sample data. A human updates it.

## Decisions

One short file per decision in \`.team/decisions/NNNN-short-title.md\`. Code always wins over these notes.
`;

const decisionFile = (commit: string) => `---
title: Signed cookies for sessions
author: Sara
date: 2026-09-28
files: [src/auth/session.ts]
commit: ${commit}
---

# Signed cookies for sessions

We keep the session in a signed cookie (HMAC-SHA256 with SESSION_SECRET) instead of a server-side session store. Pinboard is one small Node process with no database, so a cookie needs no storage, survives restarts, and is easy to test.

Trade-off we accept: one session cannot be revoked early. Rotating SESSION_SECRET logs everyone out.
`;

/** The later commit that makes Sara's handoff on search outdated. */
const SEARCH_IGNORES_CASE = APP_FILES["src/pins/search.ts"]
  .replace("  const q = query.trim();", "  const q = query.trim().toLowerCase();")
  .replace(
    "pin.title.includes(q) || pin.tags.some((tag) => tag.includes(q))",
    "pin.title.toLowerCase().includes(q) || pin.tags.some((tag) => tag.toLowerCase().includes(q))",
  );

function buildRemote(remote: string) {
  if (NodeFS.existsSync(remote)) {
    if (!NodeFS.existsSync(NodePath.join(remote, REMOTE_MARKER))) {
      return `${remote} exists and was not made by this script. Pick another --project or remove it yourself.`;
    }
    NodeFS.rmSync(remote, { recursive: true, force: true });
  }
  git(NodePath.dirname(remote), "init", "--quiet", "--bare", "-b", "main", remote);
  NodeFS.writeFileSync(NodePath.join(remote, REMOTE_MARKER), "Made by team-cold-start-seed.ts.\n");
  return null;
}

function buildRepo(project: string, remote: string) {
  if (NodeFS.existsSync(project)) {
    const teamJson = NodePath.join(project, ".team", "team.json");
    const ours =
      NodeFS.existsSync(teamJson) &&
      JSON.parse(NodeFS.readFileSync(teamJson, "utf8")).teamId === TEAM_FILE.teamId;
    if (!ours && NodeFS.readdirSync(project).length > 0) {
      return `${project} exists and was not made by this script. Pick another --project or remove it yourself.`;
    }
    NodeFS.rmSync(project, { recursive: true, force: true });
  }
  NodeFS.mkdirSync(project, { recursive: true });
  git(project, "init", "--quiet", "-b", "main");
  git(project, "remote", "add", "origin", `file://${remote}`);
  writeFiles(project, APP_FILES);
  const first = commitAll(project, "Pinboard: first version");
  writeFiles(project, {
    ".team/team.json": `${JSON.stringify(TEAM_FILE, null, 2)}\n`,
    ".team/rulebook.md": RULEBOOK,
    ".team/decisions/0001-signed-cookie-sessions.md": decisionFile(first),
    [T3_PROJECT_FILE_NAME]: `${JSON.stringify(
      { $schema: T3_PROJECT_FILE_SCHEMA_URL, defaultThreadEnvMode: "worktree" },
      null,
      2,
    )}\n`,
  });
  const teamSetup = commitAll(project, "Set up team Demo team 5");
  return { first, teamSetup };
}

/** Blob hashes, with the content kept by Git, as team_handoff stores them. */
const hashOf = (project: string, file: string) => git(project, "hash-object", "-w", file);

/** A host that knows only this login; the state goes to a remote on this computer. */
const hostFor = (login: TeamLogin) =>
  TeamHost.TeamHost.of({
    login: () => Effect.succeed({ status: "signedIn", login, override: true }),
    repoAccess: () => Effect.succeed({ status: "found", canPush: true, isPublic: false }),
    refChanged: () => Effect.die("not used by the seed"),
  });

/** One T3 server writing team state, with its state repos under `stateRoot`. */
const server = (input: {
  readonly login: TeamLogin;
  readonly environmentId: EnvironmentId;
  readonly stateRoot: string;
}) =>
  GitTeamService.make({
    environmentId: input.environmentId,
    stateDirectory: NodePath.join(input.stateRoot, `${input.login}-${input.environmentId}`),
  }).pipe(Effect.provideService(TeamHost.TeamHost, hostFor(input.login)));

/** Opens the team as a member and returns the member id, or fails with the reason. */
const join = (teams: TeamService.TeamService["Service"], project: string, create: boolean) =>
  Effect.gen(function* () {
    const input = { teamFile: TEAM_FILE, checkout: project };
    const membership = create
      ? (yield* teams.ensureTeam(input)).membership
      : yield* teams.openTeam(input);
    if (membership.status !== "member") {
      return yield* refuse(
        `Could not open the team: ${membership.status}${"detail" in membership ? ` (${membership.detail})` : ""}.`,
      );
    }
    return membership.member.memberId;
  });

const seedTeam = (input: {
  readonly project: string;
  readonly environmentId: EnvironmentId;
  readonly you: TeamLogin;
  readonly stateRoot: string;
  readonly commits: { readonly teamSetup: string };
}) =>
  Effect.gen(function* () {
    const yours = yield* server({
      login: input.you,
      environmentId: input.environmentId,
      stateRoot: input.stateRoot,
    });
    const saras = yield* server({
      login: TeamLogin.make("Sara"),
      environmentId: SARA_ENVIRONMENT,
      stateRoot: input.stateRoot,
    });
    const omars = yield* server({
      login: TeamLogin.make("Omar"),
      environmentId: OMAR_ENVIRONMENT,
      stateRoot: input.stateRoot,
    });
    // You start the team, so you are its owner; the others join.
    const you = yield* join(yours, input.project, true);
    const sara = yield* join(saras, input.project, false);
    const omar = yield* join(omars, input.project, false);
    const saraChat = { environmentId: SARA_ENVIRONMENT, threadId: SARA_CHAT };
    const omarChat = { environmentId: OMAR_ENVIRONMENT, threadId: OMAR_CHAT };
    const yourOldChat = { environmentId: input.environmentId, threadId: YOUR_OLD_CHAT };

    const yourTask = yield* yours.createTask({
      teamId: TEAM_FILE.teamId,
      actorMemberId: you,
      title: "Rate-limit the login endpoint",
      ownerMemberId: you,
      status: "in_progress",
      paths: ["src/auth/rateLimit.ts", "src/auth/login.ts"],
      note: "Limiter done in src/auth/rateLimit.ts. Left: call allowLoginAttempt in handleLogin (src/auth/login.ts) and answer 429 when it says no; add tests.",
    });
    const saraTask = yield* saras.createTask({
      teamId: TEAM_FILE.teamId,
      actorMemberId: sara,
      title: "Add tag filters to search",
      ownerMemberId: sara,
      status: "in_progress",
      paths: ["src/pins/search.ts", "src/api/routes.ts"],
      note: "Adding ?tag= to /search.",
      thread: saraChat,
    });

    yield* saras.claimPaths({
      teamId: TEAM_FILE.teamId,
      memberId: sara,
      thread: saraChat,
      paths: ["src/pins/search.ts", "src/api/routes.ts"],
      note: "tag filters",
    });
    yield* omars.claimPaths({
      teamId: TEAM_FILE.teamId,
      memberId: omar,
      thread: omarChat,
      paths: ["src/auth/session.ts"],
      note: "shorter session expiry",
    });

    const commit = input.commits.teamSetup;
    yield* saras.writeHandoff({
      teamId: TEAM_FILE.teamId,
      memberId: sara,
      thread: saraChat,
      taskId: saraTask.taskId,
      changed:
        "Search now matches tags as well as titles, in src/pins/search.ts. Matching is case-sensitive.",
      left: "Tag filter (?tag=) in src/api/routes.ts.",
      files: ["src/pins/search.ts"],
      commit,
      fileHashes: { "src/pins/search.ts": hashOf(input.project, "src/pins/search.ts") },
    });
    yield* yours.writeHandoff({
      teamId: TEAM_FILE.teamId,
      memberId: you,
      thread: yourOldChat,
      taskId: yourTask.taskId,
      changed:
        "Added src/auth/rateLimit.ts: allowLoginAttempt(ip) allows 5 tries a minute per IP, in memory.",
      left: "Call it in handleLogin (src/auth/login.ts), answer 429 when it says no, add tests.",
      risks: "In memory only: limits reset on restart.",
      files: ["src/auth/rateLimit.ts"],
      commit,
      fileHashes: { "src/auth/rateLimit.ts": hashOf(input.project, "src/auth/rateLimit.ts") },
    });

    // Let each server's batched push run, then push and fetch once more: every
    // server's file is on the remote, and each saw the others'.
    yield* Effect.sleep(Duration.sum(GitTeamService.TEAM_SYNC_DELAY, Duration.seconds(1)));
    for (const teams of [yours, saras, omars, yours]) {
      const synced = yield* teams.sync(TEAM_FILE.teamId);
      if (!synced.confirmed) {
        return yield* refuse(`A push to the remote did not land (${synced.reason}).`);
      }
    }
    const members = yield* yours.listMembers(TEAM_FILE.teamId);
    const claims = yield* yours.listActiveClaims(TEAM_FILE.teamId);
    return { members: members.map((member) => member.memberId), claims: claims.length };
  }).pipe(Effect.scoped);

const main = Effect.gen(function* () {
  const args = readArgs();
  if (args === null) return yield* refuse(usage);
  const { homeDir, project, remote, you } = args;
  if (!isLogin(you)) {
    return yield* refuse(`--you must be a GitHub-style login (letters, digits, -): "${you}".`);
  }
  if (inside(homeDir, NodePath.join(NodeOS.homedir(), ".t3"))) {
    return yield* refuse("Refusing the real T3 home (~/.t3). Use a dev home like ~/.t3-dev.");
  }
  if (inside(homeDir, T3CODE_REPO) || inside(project, T3CODE_REPO)) {
    return yield* refuse(
      `Refusing a folder inside ${T3CODE_REPO}: agents there would read its rules.`,
    );
  }
  const environmentIdPath = NodePath.join(homeDir, "userdata", "environment-id");
  if (!NodeFS.existsSync(environmentIdPath)) {
    return yield* refuse(
      `${homeDir} has no server data yet. Start the dev server once with --home-dir ${homeDir}, then stop it and run this again.`,
    );
  }
  const environmentId = EnvironmentId.make(NodeFS.readFileSync(environmentIdPath, "utf8").trim());

  const remoteRefused = buildRemote(remote);
  if (remoteRefused !== null) return yield* refuse(remoteRefused);
  const commits = buildRepo(project, remote);
  if (typeof commits === "string") return yield* refuse(commits);
  // The dev server's copy of the old run's team state: it would push the old claims back.
  const homeCopy = NodePath.join(homeDir, "userdata", "team", `${TEAM_FILE.teamId}.git`);
  NodeFS.rmSync(homeCopy, { recursive: true, force: true });

  // The three servers' own state repos are scratch: the remote is what counts.
  const stateRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-seed-"));
  const seeded = yield* seedTeam({
    project,
    environmentId,
    you: TeamLogin.make(you),
    stateRoot,
    commits,
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(project, stateRoot)),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateRoot, { recursive: true, force: true }))),
  );
  // After the handoffs: Sara's note on search is now outdated.
  writeFiles(project, { "src/pins/search.ts": SEARCH_IGNORES_CASE });
  const last = commitAll(project, "Search ignores case");
  git(project, "push", "--quiet", "origin", "main");

  yield* Console.log(
    [
      `Seeded ${project} (main at ${last.slice(0, 7)}, origin ${remote})`,
      `and team "${TEAM_FILE.name}" on the remote's refs/t3-team/state: members ${seeded.members.join(", ")}, ${seeded.claims} active claims.`,
      `You are "${you}". Teammates: Sara and Omar, on their own servers.`,
      "Next: start the dev server as you (a remote on this computer has no GitHub login):",
      `  T3CODE_TEAM_LOGIN_OVERRIDE=${you} vp run dev --home-dir ${homeDir}`,
      "Then add the project in T3 and open a new chat.",
      "If you ran this before, archive that project's old chats: their worktrees belonged to the old repo.",
    ].join("\n"),
  );
});

NodeRuntime.runMain(main);
