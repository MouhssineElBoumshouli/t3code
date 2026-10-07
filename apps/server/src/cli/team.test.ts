// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GitCommandError,
  TEAM_STATE_REF,
  TeamFile,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import { cli } from "../bin.ts";
import * as TeamHost from "../team/state/TeamHost.ts";
import { commitAll, git } from "../team/testing/gitRepo.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TEST_TEAM_LOGIN,
  TestTeamGitLayer,
  testTeamServiceLayer,
  useTeamOrigin,
} from "../team/testing/teamState.ts";
import * as TeamService from "../team/TeamService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  PUBLIC_REPO_REFUSAL,
  REMOTE_TEAM_WITHOUT_FILE,
  runTeamInit,
  type TeamInitInput,
} from "./team.ts";

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
        assert.include(output, "commit and push them");
        // No origin: nothing to start the team state on.
        assert.include(output, "was not started: this repo has no origin remote");
        assert.isFalse(NodeFS.existsSync(NodePath.join(home, "userdata", "team")));
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

  it.effect(
    "status lists the teams the home has opened, with members and claims from the ref",
    () =>
      Effect.gen(function* () {
        const repo = makeRepo();
        const home = makeHome();
        yield* runCli(["team", "init", repo, "--name", "Core", "--base-dir", home]);
        const teamFile = TeamFile.make({
          teamId: TeamId.make(readTeam(repo).teamId),
          name: "Core",
        });
        // The home's server opened the team, which started its state on origin.
        git(repo, "init", "--quiet");
        useTeamOrigin(repo, makeTeamOrigin(NodePath.dirname(repo)));
        yield* TeamService.TeamService.pipe(
          Effect.flatMap((teams) => teams.ensureTeam({ teamFile, checkout: repo })),
          Effect.provide(
            testTeamServiceLayer({
              environmentId: EnvironmentId.make("environment-1"),
              stateDirectory: NodePath.join(home, "userdata", "team"),
            }),
          ),
        );
        // Sara claims a folder from her own server after this home last fetched.
        yield* Effect.gen(function* () {
          const teams = yield* TeamService.TeamService;
          const membership = yield* teams.openTeam({ teamFile, checkout: repo });
          assert.equal(membership.status, "member");
          yield* teams.claimPaths({
            teamId: teamFile.teamId,
            memberId: membership.status === "member" ? membership.member.memberId : assert.fail(),
            thread: {
              environmentId: EnvironmentId.make("sara-server"),
              threadId: ThreadId.make("sara-thread"),
            },
            paths: ["src/auth"],
            note: "login form",
          });
        }).pipe(
          Effect.provide(
            testTeamServiceLayer({
              environmentId: EnvironmentId.make("sara-server"),
              stateDirectory: NodePath.join(makeHome(), "team"),
              host: fakeTeamHost("Sara"),
            }),
          ),
        );

        yield* runCli(["team", "status", "--base-dir", home]);
        const status = yield* lastOutput;
        assert.include(status, `Teams the T3 home at ${home} has opened:`);
        assert.include(status, `Core (teamId ${teamFile.teamId})`);
        assert.include(status, "Fetched from the remote just now.");
        assert.match(status, /members: Mouhssine \(owner, last seen [^)]+\), Sara \(member, /u);
        assert.match(status, /claims:\n {6}Sara: src\/auth \(since [^,]+, "login form"\)/u);
      }),
  );

  it.effect("status says so for a home with no teams, without creating a database", () =>
    Effect.gen(function* () {
      const home = makeHome();
      yield* runCli(["team", "status", "--base-dir", home]);
      assert.include(yield* lastOutput, `The T3 home at ${home} has opened no teams.`);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "userdata", "state.sqlite")));
    }),
  );
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

/** A real Git repo on `main` with a local bare `origin`; returns both. */
const makeRemoteRepo = () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-init-"));
  const repo = NodePath.join(parent, "acme-app");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  const originUrl = makeTeamOrigin(parent);
  useTeamOrigin(repo, originUrl);
  return { repo, origin: NodePath.join(parent, "origin.git"), originUrl };
};

const originRefs = (origin: string) => git(origin, "for-each-ref", "--format=%(refname)");
const originStateCommits = (origin: string) =>
  git(origin, "rev-list", TEAM_STATE_REF).split("\n").filter(Boolean);
const originStateFiles = (origin: string) =>
  git(origin, "ls-tree", "-r", "--name-only", TEAM_STATE_REF).split("\n").toSorted();

/** Init's `git ls-remote` of the state ref times out, like a stalled network. */
const lsRemoteTimesOut = Layer.effect(
  GitVcsDriver.GitVcsDriver,
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.map((real) => ({
      ...real,
      execute: (input: Parameters<typeof real.execute>[0]) =>
        input.operation === "teamInit.lsRemote"
          ? Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git ls-remote",
                cwd: input.cwd,
                detail: "Git command timed out.",
              }),
            )
          : real.execute(input),
    })),
  ),
).pipe(Layer.provide(TestTeamGitLayer));

/**
 * Init's own lookup of `origin` says GitHub, so it asks the host whether the
 * repo is public and who may push; the team state itself still goes to the
 * local bare origin.
 */
const originLooksLikeGitHub = Layer.effect(
  GitVcsDriver.GitVcsDriver,
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.map((real) => ({
      ...real,
      execute: (input: Parameters<typeof real.execute>[0]) =>
        input.operation === "teamInit.remote"
          ? Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "https://github.com/acme/app.git\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : real.execute(input),
    })),
  ),
).pipe(Layer.provide(TestTeamGitLayer));

/** Runs `t3 team init` on a home's state folder with a fake host; returns what it printed. */
const initRemote = (
  input: Pick<TeamInitInput, "startDirectory" | "stateDirectory"> &
    Partial<Omit<TeamInitInput, "startDirectory" | "stateDirectory">>,
  options: {
    readonly host?: TeamHost.TeamHost["Service"];
    readonly gitHubOrigin?: boolean;
    readonly lsRemoteTimesOut?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const failure = yield* runTeamInit({
      name: undefined,
      yes: true,
      publicOk: false,
      environmentId: ENVIRONMENT_ID,
      confirm: Effect.die("init asked without --yes"),
      ...input,
    }).pipe(Effect.scoped, Effect.flip, Effect.option);
    const output = (yield* TestConsole.logLines).map(String).join("\n");
    return { output, failure: Option.getOrUndefined(failure) };
  }).pipe(
    Effect.provideService(TeamHost.TeamHost, options.host ?? fakeTeamHost(TEST_TEAM_LOGIN)),
    Effect.provide(
      Layer.mergeAll(
        options.gitHubOrigin === true
          ? Layer.merge(originLooksLikeGitHub, NodeServices.layer)
          : options.lsRemoteTimesOut === true
            ? Layer.merge(lsRemoteTimesOut, NodeServices.layer)
            : TestTeamGitLayer,
        TestConsole.layer,
      ),
    ),
  );

const failureText = (failure: unknown) =>
  failure === undefined ? assert.fail("expected init to fail") : String(failure);

describe("t3 team init on the remote", () => {
  it.effect("shows what it will create, asks, then creates the state ref", () =>
    Effect.gen(function* () {
      const { repo, origin } = makeRemoteRepo();
      const home = makeHome();
      let asked = 0;
      const { output, failure } = yield* initRemote({
        startDirectory: repo,
        stateDirectory: NodePath.join(home, "team"),
        name: "Core",
        yes: false,
        confirm: Effect.sync(() => {
          asked += 1;
          return true;
        }),
      });
      assert.isUndefined(failure);
      assert.equal(asked, 1);
      const writer = `writers/${TEST_TEAM_LOGIN}/${ENVIRONMENT_ID}.json`;
      assert.include(output, `this creates the hidden ref ${TEAM_STATE_REF} with:`);
      assert.match(
        output,
        /team\.json +team "Core" \(teamId [0-9a-f-]{36}\), created by Mouhssine/u,
      );
      assert.include(output, `${writer}  this T3 server's part`);
      assert.include(output, `Created ${TEAM_STATE_REF} on file://${origin}.`);

      // One commit with team.json and the creator's writer file; the files are not committed.
      assert.equal(originRefs(origin), TEAM_STATE_REF);
      assert.lengthOf(originStateCommits(origin), 1);
      assert.deepEqual(originStateFiles(origin), ["team.json", writer]);
      const teamJson = git(origin, "show", `${TEAM_STATE_REF}:team.json`);
      assert.include(teamJson, `"teamId": "${readTeam(repo).teamId}"`);
      assert.include(teamJson, `"createdBy": "${TEST_TEAM_LOGIN}"`);
      assert.equal(git(repo, "status", "--porcelain"), "?? .team/\n?? t3.json");
    }),
  );

  it.effect("leaves the remote alone when the answer is no", () =>
    Effect.gen(function* () {
      const { repo, origin } = makeRemoteRepo();
      const { output, failure } = yield* initRemote({
        startDirectory: repo,
        stateDirectory: NodePath.join(makeHome(), "team"),
        yes: false,
        confirm: Effect.succeed(false),
      });
      assert.isUndefined(failure);
      assert.include(output, "Left the remote as is.");
      assert.equal(originRefs(origin), "");
      // The checked-in files are still written: a later init starts the state.
      assert.isTrue(exists(repo, ".team/team.json"));
    }),
  );

  it.effect("is a no-op the second time", () =>
    Effect.gen(function* () {
      const { repo, origin } = makeRemoteRepo();
      const stateDirectory = NodePath.join(makeHome(), "team");
      yield* initRemote({ startDirectory: repo, stateDirectory });
      const tip = git(origin, "rev-parse", TEAM_STATE_REF);

      const { output, failure } = yield* initRemote({
        startDirectory: repo,
        stateDirectory,
        yes: false,
        confirm: Effect.die("a second init must not ask"),
      });
      assert.isUndefined(failure);
      assert.include(output, "Nothing changed here.");
      assert.include(output, "Nothing changed there.");
      assert.equal(git(origin, "rev-parse", TEAM_STATE_REF), tip);
    }),
  );

  it.effect("joins from a clone that already has .team/, instead of creating a team", () =>
    Effect.gen(function* () {
      const { repo, origin, originUrl } = makeRemoteRepo();
      yield* initRemote({
        startDirectory: repo,
        stateDirectory: NodePath.join(makeHome(), "team"),
      });
      commitAll(repo, "Add the team files");
      git(repo, "push", "--quiet", "origin", "main");

      // Sara clones the repo on her own computer, with her own T3 home.
      const saraRepo = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-sara-")),
        "acme-app",
      );
      git(NodePath.dirname(saraRepo), "clone", "--quiet", "--branch", "main", originUrl, saraRepo);
      const saraEnvironment = EnvironmentId.make("sara-server");
      const { output, failure } = yield* initRemote(
        {
          startDirectory: saraRepo,
          stateDirectory: NodePath.join(makeHome(), "team"),
          environmentId: saraEnvironment,
          yes: false,
          confirm: Effect.die("joining must not ask"),
        },
        { host: fakeTeamHost("Sara") },
      );
      assert.isUndefined(failure);
      assert.include(output, "unchanged .team/team.json");
      assert.include(
        output,
        `Joined team "acme-app" on ${originUrl} as Sara: added writers/Sara/sara-server.json.`,
      );

      assert.lengthOf(originStateCommits(origin), 2);
      assert.deepEqual(originStateFiles(origin), [
        "team.json",
        `writers/${TEST_TEAM_LOGIN}/${ENVIRONMENT_ID}.json`,
        "writers/Sara/sara-server.json",
      ]);
      const teamJson = git(origin, "show", `${TEAM_STATE_REF}:team.json`);
      assert.include(teamJson, `"createdBy": "${TEST_TEAM_LOGIN}"`);
      assert.include(teamJson, `"teamId": "${readTeam(saraRepo).teamId}"`);
    }),
  );

  it.effect("refuses on a public repo unless --public-ok, and writes nothing", () =>
    Effect.gen(function* () {
      const { repo, origin } = makeRemoteRepo();
      const stateDirectory = NodePath.join(makeHome(), "team");
      const publicRepo = fakeTeamHost(TEST_TEAM_LOGIN, {
        status: "found",
        canPush: true,
        isPublic: true,
      });

      const refused = yield* initRemote(
        { startDirectory: repo, stateDirectory },
        { host: publicRepo, gitHubOrigin: true },
      );
      assert.include(failureText(refused.failure), PUBLIC_REPO_REFUSAL);
      assert.isFalse(exists(repo, ".team"));
      assert.isFalse(exists(repo, "t3.json"));
      assert.equal(originRefs(origin), "");
      assert.isFalse(NodeFS.existsSync(stateDirectory));

      const accepted = yield* initRemote(
        { startDirectory: repo, stateDirectory, publicOk: true },
        { host: publicRepo, gitHubOrigin: true },
      );
      assert.isUndefined(accepted.failure);
      assert.include(accepted.output, "The repo is public, so anyone can read it");
      assert.include(accepted.output, `Created ${TEAM_STATE_REF}`);
      assert.equal(originRefs(origin), TEAM_STATE_REF);
    }),
  );

  it.effect("refuses when the remote holds a team's state and the checkout has no team file", () =>
    Effect.gen(function* () {
      const { repo, originUrl } = makeRemoteRepo();
      yield* initRemote({
        startDirectory: repo,
        stateDirectory: NodePath.join(makeHome(), "team"),
      });

      const other = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-team-other-")),
        "acme-app",
      );
      NodeFS.mkdirSync(other);
      git(other, "init", "--quiet", "-b", "main");
      useTeamOrigin(other, originUrl);
      const { failure } = yield* initRemote({
        startDirectory: other,
        stateDirectory: NodePath.join(makeHome(), "team"),
      });
      assert.include(failureText(failure), REMOTE_TEAM_WITHOUT_FILE);
      assert.isFalse(exists(other, ".team"));
    }),
  );

  it.effect(
    "writes the files but starts nothing when it cannot push, is signed out or offline",
    () =>
      Effect.gen(function* () {
        const { repo, origin } = makeRemoteRepo();
        const stateDirectory = NodePath.join(makeHome(), "team");
        const noPush = yield* initRemote(
          { startDirectory: repo, stateDirectory },
          {
            host: fakeTeamHost(TEST_TEAM_LOGIN, {
              status: "found",
              canPush: false,
              isPublic: false,
            }),
            gitHubOrigin: true,
          },
        );
        assert.isUndefined(noPush.failure);
        assert.include(noPush.output, "was not started: Mouhssine cannot push to acme/app.");
        assert.isTrue(exists(repo, ".team/team.json"));

        const signedOut = yield* initRemote(
          { startDirectory: repo, stateDirectory },
          { host: fakeTeamHost(null) },
        );
        assert.include(signedOut.output, "was not started: Not signed in.");

        const timedOut = yield* initRemote(
          { startDirectory: repo, stateDirectory },
          { lsRemoteTimesOut: true },
        );
        assert.isUndefined(timedOut.failure);
        assert.include(
          timedOut.output,
          "was not started: could not reach origin (Git command timed out.).",
        );
        assert.equal(originRefs(origin), "");
      }),
  );
});
