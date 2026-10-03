// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

/** A temp folder that looks like a Git repo root (the command only looks for `.git`). */
const makeRepo = (name = "acme-app") => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-cli-"));
  const repo = NodePath.join(parent, name);
  NodeFS.mkdirSync(NodePath.join(repo, ".git"), { recursive: true });
  return repo;
};

/** A fresh T3 home for `--base-dir`, like a member's new server. */
const makeHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-home-"));

/** Rows in every team table of a home's database. */
const teamRowCounts = (home: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "state.sqlite"), {
    readOnly: true,
  });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 5) = 'team_' AND name != 'team_sql_migrations' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count,
      ]),
    );
  } finally {
    db.close();
  }
};

const read = (repo: string, file: string) => NodeFS.readFileSync(NodePath.join(repo, file), "utf8");
const exists = (repo: string, file: string) => NodeFS.existsSync(NodePath.join(repo, file));
const readTeam = (repo: string) =>
  JSON.parse(read(repo, ".team/team.json")) as { teamId: string; name: string };

const lastOutput = Effect.gen(function* () {
  return (yield* TestConsole.logLines).map(String).join("\n");
});

describe("t3 team init", () => {
  it.effect(
    "writes the team file, the rulebook template and worktree mode, then says to commit",
    () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const home = makeHome();
        yield* runCli(["team", "init", repo, "--base-dir", home]);

        const team = readTeam(repo);
        assert.match(team.teamId, /^[0-9a-f-]{36}$/u);
        assert.equal(team.name, "acme-app");
        assert.deepEqual(Object.keys(team), ["teamId", "name"]);

        const rulebook = read(repo, ".team/rulebook.md");
        assert.include(rulebook, "# Project rulebook");
        assert.include(rulebook, "under 1,500 words");
        assert.include(rulebook, "## Decisions");

        assert.equal(parseT3ProjectFile(read(repo, "t3.json"))?.defaultThreadEnvMode, "worktree");

        const output = yield* lastOutput;
        assert.include(output, "created   .team/team.json");
        assert.include(output, "created   .team/rulebook.md");
        assert.include(output, "created   t3.json");
        assert.include(output, "does not commit");
        assert.include(output, "commit them");
        assert.include(output, `Registered in the T3 home at ${home}, which now hosts this team`);
        assert.deepInclude(teamRowCounts(home), { team_teams: 1, team_members: 1 });
        // It never touches Git itself.
        assert.deepEqual(NodeFS.readdirSync(NodePath.join(repo, ".git")), []);
      }),
  );

  it.effect("keeps everything else in an existing t3.json", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const home = makeHome();
      const original = `{
  // Team scripts
  "$schema": "https://t3.codes/schema/t3.json",
  "iconPath": "assets/logo.svg",
  "scripts": [
    { "name": "Setup", "command": "pnpm install", "runOnWorktreeCreate": true },
  ],
}
`;
      NodeFS.writeFileSync(NodePath.join(repo, "t3.json"), original);

      yield* runCli(["team", "init", repo, "--name", "Core team", "--base-dir", home]);

      const updated = read(repo, "t3.json");
      assert.equal(updated.replace('\n  "defaultThreadEnvMode": "worktree",', ""), original);
      const parsed = parseT3ProjectFile(updated);
      assert.equal(parsed?.defaultThreadEnvMode, "worktree");
      assert.equal(parsed?.iconPath, "assets/logo.svg");
      assert.equal(parsed?.scripts?.[0]?.command, "pnpm install");
      assert.equal(readTeam(repo).name, "Core team");
      assert.include(yield* lastOutput, "updated   t3.json");
    }),
  );

  it.effect("is safe to run twice and keeps the same team", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const home = makeHome();
      yield* runCli(["team", "init", repo, "--base-dir", home]);
      const before = {
        team: read(repo, ".team/team.json"),
        rulebook: read(repo, ".team/rulebook.md"),
        project: read(repo, "t3.json"),
      };
      // A teammate has since edited the rulebook.
      NodeFS.appendFileSync(NodePath.join(repo, ".team/rulebook.md"), "\n- Our own rule.\n");

      yield* runCli(["team", "init", repo, "--name", "Other name", "--base-dir", home]);

      assert.equal(read(repo, ".team/team.json"), before.team);
      assert.equal(read(repo, ".team/rulebook.md"), `${before.rulebook}\n- Our own rule.\n`);
      assert.equal(read(repo, "t3.json"), before.project);
      assert.deepEqual(NodeFS.readdirSync(NodePath.join(repo, ".team")).toSorted(), [
        "rulebook.md",
        "team.json",
      ]);
      const output = yield* lastOutput;
      assert.include(output, "unchanged .team/team.json");
      assert.include(output, 'Kept the existing name "acme-app"');
      assert.include(output, "Nothing changed");
    }),
  );

  it.effect("writes at the repo root when run from a subfolder", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const subfolder = NodePath.join(repo, "packages", "web");
      NodeFS.mkdirSync(subfolder, { recursive: true });

      yield* runCli(["team", "init", subfolder, "--base-dir", makeHome()]);

      assert.isTrue(exists(repo, ".team/team.json"));
      assert.isTrue(exists(repo, "t3.json"));
      assert.isFalse(exists(subfolder, ".team"));
    }),
  );

  it.effect("refuses to run outside a Git repo", () =>
    Effect.gen(function* () {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-cli-norepo-"));
      const failure = yield* runCli(["team", "init", folder, "--base-dir", makeHome()]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "not inside a Git repository");
      assert.deepEqual(NodeFS.readdirSync(folder), []);
    }),
  );

  it.effect("writes nothing when an existing file is broken", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      NodeFS.mkdirSync(NodePath.join(repo, ".team"));
      NodeFS.writeFileSync(NodePath.join(repo, ".team/team.json"), `{ "name": "No id" }\n`);

      const badTeam = yield* runCli(["team", "init", repo, "--base-dir", makeHome()]).pipe(
        Effect.flip,
      );
      assert.include(String(badTeam), "not a valid team file");
      assert.isFalse(exists(repo, ".team/rulebook.md"));
      assert.isFalse(exists(repo, "t3.json"));

      const other = makeRepo();
      NodeFS.writeFileSync(NodePath.join(other, "t3.json"), "[not an object]");
      const badProject = yield* runCli(["team", "init", other, "--base-dir", makeHome()]).pipe(
        Effect.flip,
      );
      assert.include(String(badProject), "t3.json");
      assert.isFalse(exists(other, ".team"));
      assert.equal(read(other, "t3.json"), "[not an object]");
    }),
  );
  it.effect("refuses to run without --base-dir, and writes nothing", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const failure = yield* runCli(["team", "init", repo]).pipe(Effect.flip);
      assert.include(String(failure), "needs --base-dir");
      assert.include(String(failure), "your real T3 install");
      assert.isFalse(exists(repo, ".team"));
      assert.isFalse(exists(repo, "t3.json"));

      const status = yield* runCli(["team", "status"]).pipe(Effect.flip);
      assert.include(String(status), "t3 team status needs --base-dir");
    }),
  );

  it.effect("registers once: running it again keeps one team and one owner", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const home = makeHome();
      yield* runCli(["team", "init", repo, "--name", "Core", "--base-dir", home]);
      yield* runCli(["team", "init", repo, "--base-dir", home]);
      assert.include(yield* lastOutput, `Already hosted by the T3 home at ${home}.`);
      assert.deepInclude(teamRowCounts(home), { team_teams: 1, team_members: 1 });

      yield* runCli(["team", "status", "--base-dir", home]);
      const status = yield* lastOutput;
      assert.include(status, `Teams hosted by the T3 home at ${home}:`);
      assert.include(status, `Core (teamId ${readTeam(repo).teamId})`);
      assert.match(status, /members: .+ \(owner\)/u);
    }),
  );

  // Security (team/DESIGN.md 7.2 S7, M2.1): a member's server must never make
  // itself owner of a team it only found in a cloned repo.
  it.effect("never registers a cloned repo's team on a fresh server, and writes nothing", () =>
    Effect.gen(function* () {
      const hostRepo = makeRepo("host-copy");
      const hostHome = makeHome();
      yield* runCli(["team", "init", hostRepo, "--name", "Core", "--base-dir", hostHome]);

      // The member's clone: the team files came with the repo.
      const clone = makeRepo("member-copy");
      NodeFS.cpSync(NodePath.join(hostRepo, ".team"), NodePath.join(clone, ".team"), {
        recursive: true,
      });
      NodeFS.rmSync(NodePath.join(clone, ".team", "rulebook.md"));
      const memberHome = makeHome();

      const failure = yield* runCli(["team", "init", clone, "--base-dir", memberHome]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), 'This repo is already team "Core"');
      assert.include(String(failure), "ask the host for an invite");
      assert.include(String(failure), "Nothing was written or registered.");
      // Refused before any write: the missing rulebook and t3.json stay missing.
      assert.isFalse(exists(clone, ".team/rulebook.md"));
      assert.isFalse(exists(clone, "t3.json"));
      for (const [table, count] of Object.entries(teamRowCounts(memberHome))) {
        assert.equal(count, 0, table);
      }

      yield* runCli(["team", "status", "--base-dir", memberHome]);
      assert.include(yield* lastOutput, `The T3 home at ${memberHome} hosts no teams.`);
    }),
  );

  it.effect("status says so for a home with no data, without creating a database", () =>
    Effect.gen(function* () {
      const home = makeHome();
      yield* runCli(["team", "status", "--base-dir", home]);
      assert.include(yield* lastOutput, `No T3 data at ${home} yet, so it hosts no teams.`);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "userdata", "state.sqlite")));
    }),
  );
});
