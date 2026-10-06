/**
 * `t3 team` commands (fork-only, see team/DESIGN.md).
 *
 * `t3 team init` writes the team's checked-in files into the current repo,
 * never commits them, and registers the team in the database of the T3 home
 * given with `--base-dir`, which becomes the team's host (M2.1). A repo that
 * already has `.team/team.json` (a clone) is never registered: its team is
 * hosted elsewhere.
 *
 * `t3 team status` lists the teams a T3 home hosts.
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
import { resolveServerEnvironmentLabel } from "../environment/ServerEnvironmentLabel.ts";
import { expandHomePath } from "../os-jank.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  initTeamProject,
  TeamProjectRegisterError,
  type TeamProjectInitResult,
} from "../team/TeamProjectFiles.ts";
import * as TeamService from "../team/TeamService.ts";
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

export const hostedElsewhereMessage = (teamName: string, baseDir: string) =>
  `This repo is already team "${teamName}", and the T3 home at ${baseDir} does not host it. Its host is another T3 server; joining from a clone is not supported yet. Nothing was written or registered.`;

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

/** The host's database and identity, as its server sees them. */
const teamHostLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    TeamService.layer.pipe(Layer.provideMerge(SqlitePersistenceLayerLive)),
    ServerEnvironment.identityLayer,
    RepositoryIdentityResolver.layer,
    ProcessRunner.layer,
  ).pipe(
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
  );

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
    "Make this Git repo a team hosted by the T3 home in --base-dir: write .team/team.json and .team/rulebook.md, set worktrees as the default in t3.json, and register the team with that server as owner.",
  ),
  Command.withHandler(
    Effect.fn("teamInitCommand")(function* (flags) {
      const path = yield* Path.Path;
      const config = yield* resolveTeamCliConfig("init", flags.baseDir);
      const cwd = yield* HostProcessWorkingDirectory;
      const rawStart = Option.getOrUndefined(flags.workspaceRoot) ?? cwd;
      const startDirectory = path.resolve(yield* expandHomePath(rawStart));

      yield* Effect.gen(function* () {
        const teams = yield* TeamService.TeamService;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        // The same name the server shows for itself, as M1's first-use registration used.
        const ownerName = yield* resolveServerEnvironmentLabel({
          cwdBaseName: path.basename(cwd),
        }).pipe(Effect.orElseSucceed(() => "Owner"));
        let registration: string | undefined;

        const register = (input: {
          readonly repoRoot: string;
          readonly teamFile: TeamProjectInitResult["teamFile"];
          readonly created: boolean;
        }) =>
          Effect.gen(function* () {
            const known = yield* teams.getTeam(input.teamFile.teamId);
            if (!input.created && Option.isNone(known)) {
              // A clone: the file came with the repo, so another server hosts the team.
              return yield* new TeamProjectRegisterError({
                detail: hostedElsewhereMessage(input.teamFile.name, config.baseDir),
              });
            }
            if (Option.isSome(known)) {
              registration = `Already hosted by the T3 home at ${config.baseDir}.`;
              return;
            }
            const environmentId = yield* identity.getEnvironmentId;
            const repository = yield* repositories.resolve(input.repoRoot);
            const { owner } = yield* teams.ensureTeam({
              teamFile: input.teamFile,
              canonicalKey: repository?.canonicalKey ?? null,
              owner: { environmentId, displayName: ownerName },
            });
            registration = `Registered in the T3 home at ${config.baseDir}, which now hosts this team, with ${owner.displayName} as owner.`;
          }).pipe(
            Effect.catchIf(
              (error) => error._tag !== "TeamProjectRegisterError",
              (cause) =>
                Effect.fail(
                  new TeamProjectRegisterError({
                    detail: `Could not register the team in ${config.dbPath}. Nothing was written.`,
                    cause,
                  }),
                ),
            ),
          );

        const result = yield* initTeamProject({
          startDirectory,
          name: Option.getOrUndefined(flags.name),
          register,
        });
        yield* Console.log(formatTeamInitResult(result, registration));
      }).pipe(Effect.provide(teamHostLayer(config)));
    }),
  ),
);

const teamStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("List the teams the T3 home in --base-dir hosts, with their members."),
  Command.withHandler(
    Effect.fn("teamStatusCommand")(function* (flags) {
      const config = yield* resolveTeamCliConfig("status", flags.baseDir);
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(config.dbPath))) {
        yield* Console.log(`No T3 data at ${config.baseDir} yet, so it hosts no teams.`);
        return;
      }
      yield* Effect.gen(function* () {
        const teams = yield* TeamService.TeamService;
        const hosted = yield* teams.listTeams();
        if (hosted.length === 0) {
          yield* Console.log(`The T3 home at ${config.baseDir} hosts no teams.`);
          return;
        }
        const lines = [`Teams hosted by the T3 home at ${config.baseDir}:`];
        for (const team of hosted) {
          const members = yield* teams.listMembers(team.teamId);
          lines.push(
            "",
            `  ${team.name} (teamId ${team.teamId}), created ${team.createdAt}`,
            `    members: ${members.map((member) => `${member.displayName} (${member.role})`).join(", ")}`,
          );
        }
        yield* Console.log(lines.join("\n"));
      }).pipe(Effect.provide(teamHostLayer(config)));
    }),
  ),
);

export const teamCommand = Command.make("team").pipe(
  Command.withDescription("Team layer commands."),
  Command.withSubcommands([teamInitCommand, teamStatusCommand]),
);
