/**
 * `t3 team` commands (fork-only, see team/DESIGN.md and team/STORAGE_PLAN.md).
 *
 * `t3 team init` writes the team's checked-in files into the current repo and
 * never commits them. A folder used solo before keeps its notes: the team
 * takes the solo team's id, so its state carries over (team/state/SoloTeam.ts). It then starts the team's shared state on the
 * project's remote, the hidden ref `refs/t3-team/state`: it shows what it will
 * create and creates it after `--yes` or a prompt. In a clone whose remote
 * already holds the team's state, it joins instead. On a public repo it
 * refuses unless `--public-ok`, before writing anything (STORAGE_PLAN.md Q1).
 *
 * `t3 team status` lists the teams a T3 home has opened, with their members
 * and claims, fetched from the remote (as last fetched when offline).
 *
 * Host mode's `t3 team invite` and `invites` are parked in
 * team/parked/host-mode/ (team/STORAGE_PLAN.md 3.6).
 */
import {
  type EnvironmentId,
  type TeamClaim,
  type TeamLogin,
  TEAM_STATE_REF,
} from "@t3tools/contracts";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { expandHomePath } from "../os-jank.ts";
import * as GitTeamService from "../team/state/GitTeamService.ts";
import * as SoloTeam from "../team/state/SoloTeam.ts";
import * as TeamHost from "../team/state/TeamHost.ts";
import { writerFilePath } from "../team/state/TeamStateModel.ts";
import {
  findRepoRoot,
  initTeamProject,
  TeamProjectRegisterError,
  type TeamProjectInitResult,
} from "../team/TeamProjectFiles.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

export class TeamCliError extends Schema.TaggedError<TeamCliError>()("TeamCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** For now every `t3 team` command needs `--base-dir`, so a test never lands in the real install. */
export const missingBaseDirMessage = (command: string) =>
  `t3 team ${command} needs --base-dir: the T3 home of the server to use, the same folder as its --home-dir (for example --base-dir ~/.t3-dev). Without it, it would use your real T3 install.`;

const requireBaseDir = (command: string, baseDir: Option.Option<string>) =>
  Option.isSome(baseDir) && baseDir.value.trim().length > 0
    ? Effect.succeed(baseDir)
    : Effect.fail(new TeamCliError({ detail: missingBaseDirMessage(command) }));

const resolveTeamCliConfig = (command: string, baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const explicit = yield* requireBaseDir(command, baseDir);
    const logLevel = yield* GlobalFlag.LogLevel;
    return yield* resolveCliAuthConfig({ baseDir: explicit }, logLevel);
  });

/** The home's identity and Git, as its server sees them. */
const teamStateLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(ServerEnvironment.identityLayer, GitVcsDriver.layer, TeamHost.layer).pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
  );

/** Fail fast instead of waiting on a credential prompt nobody can answer. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

export const PUBLIC_REPO_REFUSAL =
  "This repo is public, so its team state would be public too: anyone could read your GitHub logins, task titles and notes, the files you work on, handoff notes and when you work. Nothing was written. Make the repo private (GitHub Free allows unlimited private repos with collaborators), or run t3 team init --public-ok to accept that.";

export const REMOTE_TEAM_WITHOUT_FILE =
  "The project's remote already holds a team's state, but this checkout has no .team/team.json. Pull the commit that adds it (git pull), then run t3 team init again. Nothing was written.";

/** What `init` can do on the project's remote, decided before any file is written. */
type RemotePlan =
  | { readonly _tag: "localOnly"; readonly reason: string }
  | {
      readonly _tag: "create" | "join";
      readonly remoteUrl: string;
      readonly login: TeamLogin;
      readonly isPublic: boolean;
    };

export function formatTeamInitResult(result: TeamProjectInitResult): string {
  const changed = result.files.some((file) => file.status !== "unchanged");
  const lines = [
    `Team "${result.teamFile.name}" (teamId ${result.teamFile.teamId}) in ${result.repoRoot}`,
    "",
    ...result.files.map((file) => `  ${file.status.padEnd(9)} ${file.path}  ${file.detail}`),
    "",
    changed
      ? "t3 team init does not commit. Review these files, then commit and push them so the whole team gets them."
      : "Nothing changed here. t3 team init does not commit; commit and push the files if you have not yet.",
  ];
  return lines.join("\n");
}

/** What `init` will create on the remote, shown before it asks. */
export function formatTeamStatePreview(input: {
  readonly remoteUrl: string;
  readonly teamName: string;
  readonly teamId: string;
  readonly login: string;
  readonly environmentId: string;
  readonly isPublic: boolean;
}): string {
  const writer = writerFilePath(input.login, input.environmentId);
  const width = Math.max("team.json".length, writer.length) + 2;
  return [
    `On ${input.remoteUrl}, this creates the hidden ref ${TEAM_STATE_REF} with:`,
    `  ${"team.json".padEnd(width)}team "${input.teamName}" (teamId ${input.teamId}), created by ${input.login}`,
    `  ${writer.padEnd(width)}this T3 server's part: your claims, tasks, notes and activity`,
    "Your branches are not touched, and a normal git fetch or pull does not download it.",
    input.isPublic
      ? "The repo is public, so anyone can read it (you passed --public-ok)."
      : "Everyone who can read the repo can read it; everyone who can push can add to it.",
  ].join("\n");
}

export interface TeamInitInput {
  readonly startDirectory: string;
  readonly name: string | undefined;
  /** Create the state ref without asking. */
  readonly yes: boolean;
  /** Allow a public repo. */
  readonly publicOk: boolean;
  /** This T3 server: its writer file and its state repos (`<state dir>/team`). */
  readonly environmentId: EnvironmentId;
  readonly stateDirectory: string;
  /** Asked before the state ref is created, unless `yes`. */
  readonly confirm: Effect.Effect<boolean, TeamCliError>;
}

/** `t3 team init` with its services given, so tests can use a local remote and a fake host. */
export const runTeamInit = Effect.fn("runTeamInit")(function* (input: TeamInitInput) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const host = yield* TeamHost.TeamHost;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The solo team this folder (or its repo root) was used as, if any. */
  const soloTeamOf = Effect.gen(function* () {
    const repoRoot = yield* findRepoRoot(input.startDirectory);
    const folders = [input.startDirectory, ...Option.toArray(repoRoot)];
    for (const folder of folders) {
      const teamId = yield* SoloTeam.soloTeamIdOf(folder);
      if (yield* fs.exists(path.join(input.stateDirectory, `${teamId}.git`))) return teamId;
    }
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
  const soloTeamId = yield* soloTeamOf;

  const localOnly = (reason: string): RemotePlan => ({ _tag: "localOnly", reason });

  /** Runs before any file is written; a failure writes nothing. */
  const planRemote = (repoRoot: string, teamFileIsNew: boolean) =>
    Effect.gen(function* () {
      const remote = yield* git.execute({
        operation: "teamInit.remote",
        cwd: repoRoot,
        args: ["remote", "get-url", "origin"],
        allowNonZeroExit: true,
      });
      const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : "";
      if (remoteUrl === "") {
        return localOnly(
          "this repo has no origin remote, where the team's shared state lives. Add one, then run t3 team init again",
        );
      }
      const location = TeamHost.parseTeamRemoteUrl(remoteUrl);
      const login = yield* host.login(location);
      if (login.status !== "signedIn") return localOnly(login.detail.replace(/\.$/u, ""));

      let isPublic = false;
      if (location !== null) {
        const repo = `${location.owner}/${location.name}`;
        const access = yield* host.repoAccess(location);
        if (access.status === "notFound") {
          return localOnly(`the GitHub account ${login.login} cannot see ${repo}`);
        }
        if (access.status === "unavailable") {
          return localOnly(`could not check ${repo} on ${location.host}: ${access.detail}`);
        }
        if (!access.canPush) return localOnly(`${login.login} cannot push to ${repo}`);
        if (access.isPublic && !input.publicOk) {
          return yield* new TeamProjectRegisterError({ detail: PUBLIC_REPO_REFUSAL });
        }
        isPublic = access.isPublic;
      }

      const state = yield* git
        .execute({
          operation: "teamInit.lsRemote",
          cwd: repoRoot,
          args: ["ls-remote", "origin", TEAM_STATE_REF],
          env: GIT_ENV,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
        })
        .pipe(
          // Timed out, or Git did not run: as unreachable as a failed command.
          Effect.catchTag("GitCommandError", (error) =>
            Effect.succeed({ exitCode: -1, stdout: "", stderr: error.detail }),
          ),
        );
      if (state.exitCode !== 0) {
        return localOnly(
          `could not reach origin (${state.stderr.trim().split("\n").at(-1) || "no answer"})`,
        );
      }
      const exists = state.stdout.trim() !== "";
      if (exists && teamFileIsNew) {
        return yield* new TeamProjectRegisterError({ detail: REMOTE_TEAM_WITHOUT_FILE });
      }
      return {
        _tag: exists ? "join" : "create",
        remoteUrl,
        login: login.login,
        isPublic,
      } satisfies RemotePlan;
    }).pipe(
      Effect.catchTag("GitCommandError", (error) =>
        Effect.fail(new TeamProjectRegisterError({ detail: error.message, cause: error })),
      ),
    );

  let plan: RemotePlan = localOnly("not checked");
  const result = yield* initTeamProject({
    startDirectory: input.startDirectory,
    name: input.name,
    teamId: soloTeamId,
    register: ({ repoRoot, created }) =>
      planRemote(repoRoot, created).pipe(
        Effect.map((planned) => {
          plan = planned;
        }),
      ),
  });
  yield* Console.log(formatTeamInitResult(result));
  yield* Console.log("");
  if (soloTeamId !== undefined && result.teamFile.teamId === soloTeamId) {
    yield* Console.log(
      "This folder was used solo: its notes, tasks and claims become this team's.",
    );
  }

  if (plan._tag === "localOnly") {
    yield* Console.log(
      `The team's shared state on the remote was not started: ${plan.reason}. Until it is, team tools in this repo do nothing.`,
    );
    return;
  }

  const teamFile = result.teamFile;
  if (plan._tag === "create") {
    yield* Console.log(
      formatTeamStatePreview({
        remoteUrl: plan.remoteUrl,
        teamName: teamFile.name,
        teamId: teamFile.teamId,
        login: plan.login,
        environmentId: input.environmentId,
        isPublic: plan.isPublic,
      }),
    );
    if (!input.yes && !(yield* input.confirm)) {
      yield* Console.log(
        "Left the remote as is. Team tools in this repo do nothing until t3 team init creates the team state.",
      );
      return;
    }
  }

  const teams = yield* GitTeamService.make({
    environmentId: input.environmentId,
    stateDirectory: input.stateDirectory,
  });
  const opened = yield* teams.ensureTeam({ teamFile, checkout: result.repoRoot });
  const membership = opened.membership;
  if (membership.status !== "member") {
    const why =
      membership.status === "otherTeam"
        ? `the remote holds the state of another team (${membership.teamId}) than .team/team.json names`
        : "detail" in membership
          ? membership.detail
          : membership.status;
    return yield* new TeamCliError({ detail: `The team state was not started: ${why}` });
  }
  const writer = writerFilePath(membership.member.memberId, input.environmentId);
  if (opened.created) {
    yield* Console.log(
      `Created ${TEAM_STATE_REF} on ${plan.remoteUrl}. Teammates with push access join by pulling .team/ and opening the project in T3 Code (or running t3 team init in their clone).`,
    );
    return;
  }
  // Joining writes this server's writer file; push it now, not after the CLI exits.
  const pushed = yield* teams.sync(teamFile.teamId);
  if (!pushed.confirmed) {
    return yield* new TeamCliError({
      detail: `Could not push this server's writer file to ${plan.remoteUrl} (${pushed.reason}). Run t3 team init again.`,
    });
  }
  yield* Console.log(
    pushed.attempts === 0
      ? `Team "${teamFile.name}" is already on ${plan.remoteUrl}, with ${membership.member.displayName} in it (${writer}). Nothing changed there.`
      : `Joined team "${teamFile.name}" on ${plan.remoteUrl} as ${membership.member.displayName}: added ${writer}.`,
  );
});

/** Asks on a terminal; from a script, `--yes` is the only way. */
const confirmCreate = Effect.gen(function* () {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return yield* new TeamCliError({
      detail:
        "Not a terminal, so the team state was not created. Rerun with --yes to confirm from a script.",
    });
  }
  return yield* Prompt.run(Prompt.Confirm({ message: "Create it?", initial: false })).pipe(
    Effect.catchTag("QuitError", () => Effect.succeed(false)),
  );
});

const teamInitCommand = Command.make("init", {
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("A folder inside the project's Git repo. Default: current directory."),
    Argument.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription(
      "Team name, used only when the team is created. Default: repo folder name.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Create the team state on the remote without asking."),
    Flag.withDefault(false),
  ),
  publicOk: Flag.Boolean("public-ok").pipe(
    Flag.withDescription("Allow a public repo, whose team state anyone can read."),
    Flag.withDefault(false),
  ),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Make this Git repo a team: write .team/team.json and .team/rulebook.md, set worktrees as the default in t3.json, and start the team state on the remote (refs/t3-team/state).",
  ),
  Command.withHandler(
    Effect.fn("teamInitCommand")(function* (flags) {
      const path = yield* Path.Path;
      const config = yield* resolveTeamCliConfig("init", flags.baseDir);
      const cwd = yield* HostProcessWorkingDirectory;
      const rawStart = Option.getOrUndefined(flags.workspaceRoot) ?? cwd;
      const startDirectory = path.resolve(yield* expandHomePath(rawStart));
      const promptContext = yield* Effect.context<Prompt.Environment>();
      yield* Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        yield* runTeamInit({
          startDirectory,
          name: Option.getOrUndefined(flags.name),
          yes: flags.yes,
          publicOk: flags.publicOk,
          environmentId: yield* identity.getEnvironmentId,
          stateDirectory: path.join(config.stateDir, "team"),
          confirm: confirmCreate.pipe(Effect.provideContext(promptContext)),
        });
      }).pipe(Effect.scoped, Effect.provide(teamStateLayer(config)));
    }),
  ),
);

const formatClaim = (claim: TeamClaim) =>
  `${claim.memberId}: ${claim.paths.join(", ")} (since ${claim.claimedAt}${
    claim.note === null ? "" : `, "${claim.note}"`
  })`;

const teamStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "List the teams the T3 home in --base-dir has opened, with their members and claims, fetched from each project's remote.",
  ),
  Command.withHandler(
    Effect.fn("teamStatusCommand")(function* (flags) {
      const config = yield* resolveTeamCliConfig("status", flags.baseDir);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDirectory = path.join(config.stateDir, "team");
      if (!(yield* fs.exists(stateDirectory))) {
        yield* Console.log(`The T3 home at ${config.baseDir} has opened no teams.`);
        return;
      }
      yield* Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const teams = yield* GitTeamService.make({
          environmentId: yield* identity.getEnvironmentId,
          stateDirectory,
        });
        const opened = yield* teams.listTeams();
        if (opened.length === 0) {
          yield* Console.log(`The T3 home at ${config.baseDir} has opened no teams.`);
          return;
        }
        const lines = [`Teams the T3 home at ${config.baseDir} has opened:`];
        for (const team of opened) {
          const fetched = yield* teams.refresh(team.teamId);
          if (fetched.status === "solo") {
            const claims = yield* teams.listActiveClaims(team.teamId);
            lines.push(
              "",
              `  ${team.name} (solo, on this computer only), started ${team.createdAt}`,
              claims.length === 0 ? "    claims: none" : "    claims:",
              ...claims.map((claim) => `      ${formatClaim(claim)}`),
            );
            continue;
          }
          const members = yield* teams.listMembers(team.teamId);
          const claims = yield* teams.listActiveClaims(team.teamId);
          lines.push(
            "",
            `  ${team.name} (teamId ${team.teamId}), created ${team.createdAt}`,
            `    ${
              fetched.status === "unreachable"
                ? "Could not reach the remote: as last fetched."
                : "Fetched from the remote just now."
            }`,
            `    members: ${members
              .map(
                (member) =>
                  `${member.displayName} (${member.role}, last seen ${member.lastSeenAt})`,
              )
              .join(", ")}`,
            claims.length === 0 ? "    claims: none" : "    claims:",
            ...claims.map((claim) => `      ${formatClaim(claim)}`),
          );
        }
        yield* Console.log(lines.join("\n"));
      }).pipe(Effect.scoped, Effect.provide(teamStateLayer(config)));
    }),
  ),
);

export const teamCommand = Command.make("team").pipe(
  Command.withDescription("Team layer commands."),
  Command.withSubcommands([teamInitCommand, teamStatusCommand]),
);
