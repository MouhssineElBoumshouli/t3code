/**
 * `t3 team` commands (fork-only, see team/DESIGN.md).
 *
 * `t3 team init` writes the team's checked-in files into the current repo and
 * never commits them. Starting the team state on the project's remote
 * (`refs/t3-team/state`) is not built yet: team/STORAGE_PLAN.md slice 6.
 *
 * `t3 team status` lists the teams a T3 home has opened, from its local copy
 * of each team's state (no network).
 *
 * Host mode's `t3 team invite` and `invites` are parked in
 * team/parked/host-mode/ (team/STORAGE_PLAN.md 3.6).
 */
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { expandHomePath } from "../os-jank.ts";
import * as GitTeamService from "../team/state/GitTeamService.ts";
import * as TeamHost from "../team/state/TeamHost.ts";
import { initTeamProject, type TeamProjectInitResult } from "../team/TeamProjectFiles.ts";
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

/** Until slice 6 of team/STORAGE_PLAN.md, `init` writes the files only. */
export const TEAM_STATE_NOT_STARTED =
  "Not done yet: starting the team's shared state on the project's remote (refs/t3-team/state). Until a later t3 team init does it, team tools in this repo say the remote has no team state.";

export function formatTeamInitResult(
  result: TeamProjectInitResult,
  registration: string | undefined,
): string {
  const changed = result.files.some((file) => file.status !== "unchanged");
  const lines = [
    `Team "${result.teamFile.name}" (teamId ${result.teamFile.teamId}) in ${result.repoRoot}`,
    "",
    ...result.files.map((file) => `  ${file.status.padEnd(9)} ${file.path}  ${file.detail}`),
    ...(registration === undefined ? [] : ["", registration]),
    "",
    changed
      ? "t3 team init does not commit. Review these files, then commit them so the whole team gets them."
      : "Nothing changed. t3 team init does not commit; commit the files if you have not yet.",
  ];
  return lines.join("\n");
}

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
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Make this Git repo a team: write .team/team.json and .team/rulebook.md and set worktrees as the default in t3.json.",
  ),
  Command.withHandler(
    Effect.fn("teamInitCommand")(function* (flags) {
      const path = yield* Path.Path;
      yield* resolveTeamCliConfig("init", flags.baseDir);
      const cwd = yield* HostProcessWorkingDirectory;
      const rawStart = Option.getOrUndefined(flags.workspaceRoot) ?? cwd;
      const startDirectory = path.resolve(yield* expandHomePath(rawStart));
      const result = yield* initTeamProject({
        startDirectory,
        name: Option.getOrUndefined(flags.name),
      });
      yield* Console.log(formatTeamInitResult(result, TEAM_STATE_NOT_STARTED));
    }),
  ),
);

const teamStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "List the teams the T3 home in --base-dir has opened, with their members, as last fetched.",
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
        const lines = [`Teams the T3 home at ${config.baseDir} has opened, as last fetched:`];
        for (const team of opened) {
          const members = yield* teams.listMembers(team.teamId);
          lines.push(
            "",
            `  ${team.name} (teamId ${team.teamId}), created ${team.createdAt}`,
            `    members: ${members
              .map(
                (member) =>
                  `${member.displayName} (${member.role}, last seen ${member.lastSeenAt})`,
              )
              .join(", ")}`,
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
