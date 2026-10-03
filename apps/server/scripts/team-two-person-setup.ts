#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a dev script: synchronous Git and file setup.

/**
 * Team layer M2 test bench (fork-only, team/DESIGN.md 7.3): two people, one
 * repo, on one laptop.
 *
 * Makes three folders next to each other:
 *
 * - `<demo>-remote.git`: a bare Git repo both people push to and pull from;
 * - `<demo>-host`: the host's clone, with the Pinboard demo app, made a team
 *   with `t3 team init --base-dir <host home>`, so the host's T3 home hosts
 *   the team (M2.1). The team files are committed and pushed;
 * - `<demo>-member`: the member's clone of the remote, made after the push,
 *   so it has `.team/team.json` but its T3 home has no team row.
 *
 * Safe to re-run: each folder holds a marker, and a re-run deletes only
 * folders with the marker, plus the old team's rows in the host's database.
 * It refuses folders it did not make, anything inside the t3code repo, and
 * the real T3 home (~/.t3). It never touches the member's T3 home. The host's
 * dev server may be running.
 *
 *   node apps/server/scripts/team-two-person-setup.ts [--demo ~/code/team-demo6]
 *     [--name "Demo team 6"] [--host-home ~/.t3-dev] [--member-home ~/.t3-dev-member]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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

const MARKER = ".t3-team-two-person-setup";
const say = (text: string) => process.stdout.write(`${text}\n`);
const usage =
  'Usage: node apps/server/scripts/team-two-person-setup.ts [--demo ~/code/team-demo6] [--name "Demo team 6"] [--host-home ~/.t3-dev] [--member-home ~/.t3-dev-member]';

function readArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string | undefined> = {
    "--demo": "~/code/team-demo6",
    "--name": undefined,
    "--host-home": "~/.t3-dev",
    "--member-home": "~/.t3-dev-member",
  };
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (flag === undefined || value === undefined || !(flag in options)) return null;
    options[flag] = value;
  }
  const demo = expandHome(options["--demo"]!);
  const number = /team-demo(\d+)$/u.exec(demo)?.[1];
  return {
    demo,
    name: options["--name"] ?? (number ? `Demo team ${number}` : NodePath.basename(demo)),
    hostHome: expandHome(options["--host-home"]!),
    memberHome: expandHome(options["--member-home"]!),
  };
}

/** Where this script keeps its marker in each folder it makes. */
const markerPath = (folder: string, bare: boolean) =>
  bare ? NodePath.join(folder, MARKER) : NodePath.join(folder, ".git", MARKER);

const tilde = (value: string) =>
  inside(value, NodeOS.homedir()) ? `~/${NodePath.relative(NodeOS.homedir(), value)}` : value;

/** Deletes the old demo team's rows from the host's database, if it has them. */
function forgetOldTeam(hostClone: string, hostHome: string) {
  const teamJson = NodePath.join(hostClone, ".team", "team.json");
  const dbPath = NodePath.join(hostHome, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(teamJson) || !NodeFS.existsSync(dbPath)) return;
  const { teamId } = JSON.parse(NodeFS.readFileSync(teamJson, "utf8")) as { teamId: string };
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    // The host's server may be running: wait for its writes instead of failing.
    db.exec("PRAGMA busy_timeout = 5000");
    const present = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    db.exec("BEGIN IMMEDIATE");
    for (const table of TEAM_TABLES) {
      if (present.has(table)) db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(teamId);
    }
    db.exec("COMMIT");
    say(`Removed the old demo team ${teamId} from ${tilde(dbPath)}.`);
  } finally {
    db.close();
  }
}

function main() {
  const args = readArgs();
  if (args === null) return usage;
  const { demo, name, hostHome, memberHome } = args;
  const realHome = NodePath.join(NodeOS.homedir(), ".t3");
  for (const home of [hostHome, memberHome]) {
    if (inside(home, realHome)) return `Refusing the real T3 home (${home}). Use a dev home.`;
    if (inside(home, T3CODE_REPO)) return `Refusing ${home}: it is inside ${T3CODE_REPO}.`;
  }
  if (inside(hostHome, memberHome) || inside(memberHome, hostHome)) {
    return "The host and the member need two separate T3 homes.";
  }
  if (inside(demo, T3CODE_REPO)) {
    return `Refusing ${demo}: agents there would read the rules of ${T3CODE_REPO}.`;
  }

  const remote = `${demo}-remote.git`;
  const host = `${demo}-host`;
  const member = `${demo}-member`;
  const folders = [
    { path: remote, bare: true },
    { path: host, bare: false },
    { path: member, bare: false },
  ];
  // Check every folder before touching any.
  for (const folder of folders) {
    if (
      NodeFS.existsSync(folder.path) &&
      !NodeFS.existsSync(markerPath(folder.path, folder.bare))
    ) {
      return `${folder.path} exists and was not made by this script. Pick another --demo or remove it yourself.`;
    }
  }

  forgetOldTeam(host, hostHome);
  for (const folder of folders) NodeFS.rmSync(folder.path, { recursive: true, force: true });

  const mark = (folder: string, bare: boolean) =>
    NodeFS.writeFileSync(
      markerPath(folder, bare),
      `Made by ${NodePath.basename(import.meta.filename)}\n`,
    );

  NodeFS.mkdirSync(remote, { recursive: true });
  git(remote, "init", "--quiet", "--bare", "-b", "main");
  mark(remote, true);

  NodeFS.mkdirSync(host, { recursive: true });
  git(host, "init", "--quiet", "-b", "main");
  mark(host, false);
  git(host, "remote", "add", "origin", remote);
  writeFiles(host, APP_FILES);
  commitAll(host, "Pinboard: first version");
  git(host, "push", "--quiet", "-u", "origin", "main");

  // The real command, as the host would run it: writes .team/ and registers the team.
  const init = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(T3CODE_REPO, "apps/server/src/bin.ts"),
      "team",
      "init",
      host,
      "--name",
      name,
      "--base-dir",
      hostHome,
      "--log-level",
      "warn",
    ],
    { encoding: "utf8" },
  );
  if (init.status !== 0) {
    return `t3 team init failed (exit ${init.status}):\n${init.stdout}${init.stderr}`;
  }
  say(init.stdout.trim());
  commitAll(host, `Set up team ${name}`);
  git(host, "push", "--quiet");

  git(NodePath.dirname(member), "clone", "--quiet", remote, member);
  mark(member, false);

  say(
    [
      "",
      `Ready. Team "${name}" is hosted by ${tilde(hostHome)}.`,
      `  remote  ${tilde(remote)}`,
      `  host    ${tilde(host)}`,
      `  member  ${tilde(member)}  (a clone; ${tilde(memberHome)} does not host the team)`,
      "",
      "Next (team/DESIGN.md 7.3), from the t3code repo, one terminal each:",
      `  host:    vp run dev --home-dir ${tilde(hostHome)}`,
      `           then add ${tilde(host)} as a project in T3`,
      `  member:  T3CODE_PORT_OFFSET=20 vp run dev --home-dir ${tilde(memberHome)}`,
      `           then pair a browser with it and add ${tilde(member)} as a project`,
      "Share code like two people: push from one clone, pull in the other.",
    ].join("\n"),
  );
  return undefined;
}

const failure = main();
if (failure !== undefined) {
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}
