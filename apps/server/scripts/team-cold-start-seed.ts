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
import * as NodeChildProcess from "node:child_process";
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

const expandHome = (value: string) =>
  NodePath.resolve(value.replace(/^~(?=$|\/)/u, NodeOS.homedir()));

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

/** This file lives in the t3code repo; nothing here may write inside it. */
const T3CODE_REPO = NodePath.resolve(import.meta.dirname, "../../..");
const inside = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Pinboard team",
  GIT_AUTHOR_EMAIL: "pinboard@example.com",
  GIT_COMMITTER_NAME: "Pinboard team",
  GIT_COMMITTER_EMAIL: "pinboard@example.com",
};
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const writeFiles = (root: string, files: Readonly<Record<string, string>>) => {
  for (const [file, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), contents);
  }
};
const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const APP_FILES = {
  "README.md": `# Pinboard

Save links ("pins") with tags, and search them. TypeScript on Node, no framework.
Data lives in \`data/pins.json\`.

Run: \`node src/server.ts\`, then open http://localhost:4100.
`,
  "package.json": `${JSON.stringify(
    { name: "pinboard", private: true, type: "module", scripts: { start: "node src/server.ts" } },
    null,
    2,
  )}\n`,
  "data/pins.json": `${JSON.stringify(
    [
      { id: "p1", url: "https://example.com/effect", title: "Effect docs", tags: ["typescript"] },
      { id: "p2", url: "https://example.com/sqlite", title: "SQLite notes", tags: ["db"] },
    ],
    null,
    2,
  )}\n`,
  "src/server.ts": `import { createServer } from "node:http";

import { route } from "./api/routes.ts";

createServer((request, response) => void route(request, response)).listen(4100);
`,
  "src/api/routes.ts": `import type { IncomingMessage, ServerResponse } from "node:http";

import { handleLogin } from "../auth/login.ts";
import { searchPins } from "../pins/search.ts";
import { listPins } from "../pins/store.ts";

export async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/login") return handleLogin(request, response);
  if (url.pathname === "/pins") return json(response, listPins());
  if (url.pathname === "/search") return json(response, searchPins(url.searchParams.get("q") ?? ""));
  response.writeHead(404).end();
}

function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}
`,
  "src/auth/login.ts": `import type { IncomingMessage, ServerResponse } from "node:http";

import { createSessionCookie } from "./session.ts";

const USERS = new Map([["demo", "demo"]]);

export async function handleLogin(request: IncomingMessage, response: ServerResponse) {
  const body = new URLSearchParams(await readBody(request));
  const user = body.get("user") ?? "";
  if (USERS.get(user) !== body.get("password")) return response.writeHead(401).end();
  response.writeHead(204, { "set-cookie": createSessionCookie(user) }).end();
}

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
`,
  "src/auth/session.ts": `import { createHmac } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "dev-secret";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** A signed cookie: the user and an expiry, with an HMAC-SHA256 signature. */
export function createSessionCookie(user: string) {
  const value = \`\${user}.\${Date.now() + MAX_AGE_SECONDS * 1000}\`;
  const signature = createHmac("sha256", SECRET).update(value).digest("base64url");
  return \`session=\${value}.\${signature}; HttpOnly; Path=/; Max-Age=\${MAX_AGE_SECONDS}\`;
}
`,
  "src/auth/rateLimit.ts": `/** Login attempts per IP: at most 5 a minute, kept in memory. */
const WINDOW_MS = 60_000;
const MAX_TRIES = 5;
const tries = new Map<string, Array<number>>();

export function allowLoginAttempt(ip: string, now = Date.now()) {
  const recent = (tries.get(ip) ?? []).filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  tries.set(ip, recent);
  return recent.length <= MAX_TRIES;
}
`,
  "src/pins/store.ts": `import { readFileSync } from "node:fs";

export interface Pin {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
}

export function listPins(): ReadonlyArray<Pin> {
  return JSON.parse(readFileSync("data/pins.json", "utf8"));
}
`,
  "src/pins/search.ts": `import { listPins } from "./store.ts";

/** Pins whose title or tags contain the query. */
export function searchPins(query: string) {
  const q = query.trim();
  return listPins().filter((pin) => pin.title.includes(q) || pin.tags.some((tag) => tag.includes(q)));
}
`,
};

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

const TEAM_TABLES = [
  "team_activity",
  "team_handoffs",
  "team_claims",
  "team_tasks",
  "team_members",
  "team_teams",
] as const;

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
