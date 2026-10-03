// @effect-diagnostics nodeBuiltinImport:off - dev scripts: synchronous Git and file setup.

/**
 * Shared by the team demo scripts (fork-only, team/DESIGN.md D8 and 7.3): the
 * Pinboard demo app, Git helpers, and the folder checks that keep demos out
 * of the t3code repo and the real T3 home.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const expandHome = (value: string) =>
  NodePath.resolve(value.replace(/^~(?=$|\/)/u, NodeOS.homedir()));

/** This file lives in the t3code repo; nothing here may write inside it. */
export const T3CODE_REPO = NodePath.resolve(import.meta.dirname, "../../..");
export const inside = (child: string, parent: string) => {
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
export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

export const writeFiles = (root: string, files: Readonly<Record<string, string>>) => {
  for (const [file, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), contents);
  }
};
export const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/** A tiny app ("Pinboard") for team demos. */
export const APP_FILES = {
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

export const USERS = new Map([["demo", "demo"]]);

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

export const SECRET = process.env.SESSION_SECRET ?? "dev-secret";
export const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** A signed cookie: the user and an expiry, with an HMAC-SHA256 signature. */
export function createSessionCookie(user: string) {
  const value = \`\${user}.\${Date.now() + MAX_AGE_SECONDS * 1000}\`;
  const signature = createHmac("sha256", SECRET).update(value).digest("base64url");
  return \`session=\${value}.\${signature}; HttpOnly; Path=/; Max-Age=\${MAX_AGE_SECONDS}\`;
}
`,
  "src/auth/rateLimit.ts": `/** Login attempts per IP: at most 5 a minute, kept in memory. */
export const WINDOW_MS = 60_000;
export const MAX_TRIES = 5;
export const tries = new Map<string, Array<number>>();

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

/** Every team table, children first, for deleting a demo team's rows. */
export const TEAM_TABLES = [
  "team_activity",
  "team_handoffs",
  "team_claims",
  "team_tasks",
  "team_members",
  "team_teams",
] as const;
