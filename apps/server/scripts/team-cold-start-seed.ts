#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a dev script: synchronous Git and file setup.

/**
 * Team layer cold start test (fork-only, team/DESIGN.md D8, team/COLD_START_TEST.md).
 *
 * Builds a fresh demo project and seeds its team in a dev T3 home:
 *
 * - the repo: a tiny app ("Pinboard"), `.team/team.json`, a rulebook, one
 *   decision file, and `t3.json` with worktrees on;
 * - the team, in the home's database: you (this server's member) and two
 *   teammates, Sara and Omar, on their own servers; two tasks; claims from
 *   Sara's and Omar's chats; two handoffs, one of them outdated by a later
 *   commit.
 *
 * Teammates live on other servers because claims of this server's threads
 * that do not exist are released when the server starts (claim lifetime, D5).
 *
 * Safe to re-run: the team has a fixed id, so its rows are deleted and seeded
 * again, and the project folder is rebuilt only if it holds this team (it
 * refuses any other folder). Stop the dev server first.
 *
 *   node apps/server/scripts/team-cold-start-seed.ts [--home-dir ~/.t3-dev]
 *     [--project ~/code/team-demo5] [--you "Name"]
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
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import * as TeamService from "../src/team/TeamService.ts";
import {
  APP_FILES,
  commitAll,
  expandHome,
  git,
  inside,
  T3CODE_REPO,
  TEAM_TABLES,
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
  "Usage: node apps/server/scripts/team-cold-start-seed.ts [--home-dir ~/.t3-dev] [--project ~/code/team-demo5] [--you Name]";

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
  return {
    homeDir: expandHome(options.homeDir),
    project: expandHome(options.project),
    you: options.you,
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

function buildRepo(project: string) {
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

const seedTeam = (input: {
  readonly project: string;
  readonly environmentId: EnvironmentId;
  readonly you: string | undefined;
  readonly commits: { readonly teamSetup: string };
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const teams = yield* TeamService.TeamService;
    for (const table of TEAM_TABLES) {
      yield* sql.unsafe(`DELETE FROM ${table} WHERE team_id = ?`, [TEAM_FILE.teamId]);
    }
    // Same name the server would show: reuse this server's name from another team.
    const known = yield* sql<{ readonly name: string }>`
      SELECT display_name AS name FROM team_members
      WHERE environment_id = ${input.environmentId} ORDER BY joined_at DESC LIMIT 1
    `;
    const youName = input.you ?? known[0]?.name ?? NodeOS.hostname();

    const join = (environmentId: EnvironmentId, displayName: string) =>
      teams
        .ensureTeam({
          teamFile: TEAM_FILE,
          canonicalKey: null,
          owner: { environmentId, displayName },
        })
        .pipe(Effect.map(({ owner }) => owner));
    const you = yield* join(input.environmentId, youName);
    const sara = yield* join(SARA_ENVIRONMENT, "Sara");
    const omar = yield* join(OMAR_ENVIRONMENT, "Omar");
    const saraChat = { environmentId: SARA_ENVIRONMENT, threadId: SARA_CHAT };
    const omarChat = { environmentId: OMAR_ENVIRONMENT, threadId: OMAR_CHAT };
    const yourOldChat = { environmentId: input.environmentId, threadId: YOUR_OLD_CHAT };

    const yourTask = yield* teams.createTask({
      teamId: TEAM_FILE.teamId,
      actorMemberId: you.memberId,
      title: "Rate-limit the login endpoint",
      ownerMemberId: you.memberId,
      status: "in_progress",
      paths: ["src/auth/rateLimit.ts", "src/auth/login.ts"],
      note: "Limiter done in src/auth/rateLimit.ts. Left: call allowLoginAttempt in handleLogin (src/auth/login.ts) and answer 429 when it says no; add tests.",
    });
    const saraTask = yield* teams.createTask({
      teamId: TEAM_FILE.teamId,
      actorMemberId: sara.memberId,
      title: "Add tag filters to search",
      ownerMemberId: sara.memberId,
      status: "in_progress",
      paths: ["src/pins/search.ts", "src/api/routes.ts"],
      note: "Adding ?tag= to /search.",
      thread: saraChat,
    });

    yield* teams.claimPaths({
      teamId: TEAM_FILE.teamId,
      memberId: sara.memberId,
      thread: saraChat,
      paths: ["src/pins/search.ts", "src/api/routes.ts"],
      note: "tag filters",
    });
    yield* teams.claimPaths({
      teamId: TEAM_FILE.teamId,
      memberId: omar.memberId,
      thread: omarChat,
      paths: ["src/auth/session.ts"],
      note: "shorter session expiry",
    });

    const commit = input.commits.teamSetup;
    yield* teams.writeHandoff({
      teamId: TEAM_FILE.teamId,
      memberId: sara.memberId,
      thread: saraChat,
      taskId: saraTask.taskId,
      changed:
        "Search now matches tags as well as titles, in src/pins/search.ts. Matching is case-sensitive.",
      left: "Tag filter (?tag=) in src/api/routes.ts.",
      files: ["src/pins/search.ts"],
      commit,
      fileHashes: { "src/pins/search.ts": hashOf(input.project, "src/pins/search.ts") },
    });
    yield* teams.writeHandoff({
      teamId: TEAM_FILE.teamId,
      memberId: you.memberId,
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
    return youName;
  });

const main = Effect.gen(function* () {
  const args = readArgs();
  if (args === null) return yield* refuse(usage);
  const { homeDir, project, you } = args;
  if (inside(homeDir, NodePath.join(NodeOS.homedir(), ".t3"))) {
    return yield* refuse("Refusing the real T3 home (~/.t3). Use a dev home like ~/.t3-dev.");
  }
  if (inside(homeDir, T3CODE_REPO) || inside(project, T3CODE_REPO)) {
    return yield* refuse(
      `Refusing a folder inside ${T3CODE_REPO}: agents there would read its rules.`,
    );
  }
  const environmentIdPath = NodePath.join(homeDir, "userdata", "environment-id");
  const dbPath = NodePath.join(homeDir, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(environmentIdPath) || !NodeFS.existsSync(dbPath)) {
    return yield* refuse(
      `${homeDir} has no server data yet. Start the dev server once with --home-dir ${homeDir}, then stop it and run this again.`,
    );
  }
  const environmentId = EnvironmentId.make(NodeFS.readFileSync(environmentIdPath, "utf8").trim());

  const commits = buildRepo(project);
  if (typeof commits === "string") return yield* refuse(commits);
  const youName = yield* seedTeam({ project, environmentId, you, commits }).pipe(
    Effect.provide(
      TeamService.layer.pipe(
        Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  // After the handoffs: Sara's note on search is now outdated.
  writeFiles(project, { "src/pins/search.ts": SEARCH_IGNORES_CASE });
  const last = commitAll(project, "Search ignores case");

  yield* Console.log(
    [
      `Seeded ${project} (main at ${last.slice(0, 7)}) and team "${TEAM_FILE.name}" in ${dbPath}.`,
      `You are "${youName}". Teammates: Sara and Omar, on their own servers.`,
      "Next: start the dev server with this home dir, add the project in T3, and open a new chat.",
      "If you ran this before, archive that project's old chats: their worktrees belonged to the old repo.",
    ].join("\n"),
  );
});

NodeRuntime.runMain(main);
