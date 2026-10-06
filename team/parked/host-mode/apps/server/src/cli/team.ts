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
 * `t3 team invite` makes a one-time invite to a hosted team (M2.3): a pairing
 * link with only `team:read` and `team:write`, printed once as a URL. The
 * member's server joins with it (`t3 team join`, M2.4). `t3 team invites`
 * lists invites and revokes them.
 */
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveServerEnvironmentLabel } from "../environment/ServerEnvironmentLabel.ts";
import { expandHomePath } from "../os-jank.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import * as TeamInvites from "../team/TeamInvites.ts";
import {
  findRepoRoot,
  initTeamProject,
  readTeamFile,
  TeamProjectRegisterError,
  type TeamProjectInitResult,
} from "../team/TeamProjectFiles.ts";
import * as TeamService from "../team/TeamService.ts";
import { baseDirFlag, DurationFromString, resolveCliAuthConfig } from "./config.ts";
import { discoverPairTarget, resolveDirectPairingBaseUrl } from "./pair.ts";

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
  `This repo is already team "${teamName}", and the T3 home at ${baseDir} does not host it. Its host is another T3 server: ask the host for an invite. Nothing was written or registered.`;

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

/** The host's team state plus its auth store, for invites: one database, as the server has. */
export const teamInviteLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    TeamInvites.layer.pipe(Layer.provideMerge(TeamService.layer)),
    EnvironmentAuth.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(ServerSecretStore.layer, SqlitePersistenceLayerLive)),
    Layer.provideMerge(ServerEnvironment.identityLayer),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
  );

/**
 * The web app takes a `#token=` from any page it opens and exchanges it for a
 * browser session (`resolveInitialServerAuthGateState`), which would use the
 * invite up if someone clicked the URL. So the credential travels as
 * `#invite=` on its own path, which no web page reads. It stays in the
 * fragment, as with `t3 pair`, so it never reaches a server log.
 */
export const TEAM_INVITE_URL_PATH = "/team-invite";
export const TEAM_INVITE_URL_PARAM = "invite";

export const buildTeamInviteUrl = (baseUrl: string, credential: string) => {
  const url = new URL(baseUrl);
  url.pathname = TEAM_INVITE_URL_PATH;
  url.search = "";
  url.hash = new URLSearchParams([[TEAM_INVITE_URL_PARAM, credential]]).toString();
  return url.toString();
};

const localTime = (iso: string) => {
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed)
    ? DateTime.formatLocal(parsed.value, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : iso;
};

export function formatTeamInvite(input: {
  readonly issued: TeamInvites.IssuedTeamInvite;
  readonly url: string;
  readonly ttl: Duration.Duration;
  readonly baseDir: string;
}): string {
  const { invite, team } = input.issued;
  const expiresAt = DateTime.make(invite.expiresAt);
  const expiresClock = Option.isSome(expiresAt)
    ? DateTime.formatLocal(expiresAt.value, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : invite.expiresAt;
  const loopback = isLoopbackHost(new URL(input.url).hostname);
  return [
    `Invite for ${invite.memberName} to team "${team.name}" (invite ${invite.inviteId}).`,
    "",
    `  ${input.url}`,
    "",
    `Expires at ${expiresClock} (${invite.expiresAt}, ${Duration.format(input.ttl)} from now). It works once.`,
    "It gives team access only (team:read, team:write): no projects, chats, files or terminals on this server.",
    ...(loopback ? ["The URL points at localhost, so it only works from this machine."] : []),
    "",
    `Send it to ${invite.memberName} privately. It is shown only here and saved nowhere; if it is lost, revoke it with \`t3 team invites --revoke ${invite.inviteId} --base-dir ${input.baseDir}\` and make a new one.`,
    `Do not open it in a browser. ${invite.memberName}'s server joins with \`t3 team join\` (M2.4, not built yet).`,
  ].join("\n");
}

export function formatTeamInvites(input: {
  readonly baseDir: string;
  readonly teams: ReadonlyArray<{ readonly teamId: string; readonly name: string }>;
  readonly invites: ReadonlyArray<TeamInvites.TeamInvite>;
}): string {
  if (input.invites.length === 0) return `No invites in the T3 home at ${input.baseDir}.`;
  const lines = [`Invites in the T3 home at ${input.baseDir}, newest first:`];
  for (const team of input.teams) {
    const invites = input.invites.filter((invite) => invite.teamId === team.teamId);
    if (invites.length === 0) continue;
    lines.push("", `  ${team.name} (teamId ${team.teamId})`);
    for (const invite of invites) {
      const detail =
        invite.status === "used"
          ? `joined ${localTime(invite.usedAt ?? "")}`
          : invite.status === "revoked"
            ? `revoked ${localTime(invite.revokedAt ?? "")}`
            : invite.status === "expired"
              ? `expired ${localTime(invite.expiresAt)}`
              : `expires ${localTime(invite.expiresAt)}`;
      lines.push(
        `    ${invite.status.padEnd(8)} ${invite.memberName}  invite ${invite.inviteId}  made ${localTime(invite.createdAt)}, ${detail}`,
      );
    }
  }
  return lines.join("\n");
}

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

const teamInviteCommand = Command.make("invite", {
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription(
      "A folder inside the team's Git repo, to find its .team/team.json. Default: current directory.",
    ),
    Argument.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription(
      "The new member's name, as the team will see it. Only the host names members.",
    ),
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "How long the invite works, for example `30m` or `2h`. Default 30 minutes, at most 24 hours.",
    ),
    Flag.optional,
  ),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Invite a member to a team the T3 home in --base-dir hosts: a one-time URL with team access only. Its server must be running.",
  ),
  Command.withHandler(
    Effect.fn("teamInviteCommand")(function* (flags) {
      const path = yield* Path.Path;
      const config = yield* resolveTeamCliConfig("invite", flags.baseDir);
      const cwd = yield* HostProcessWorkingDirectory;
      const rawStart = Option.getOrUndefined(flags.workspaceRoot) ?? cwd;
      const startDirectory = path.resolve(yield* expandHomePath(rawStart));
      const repoRoot = yield* findRepoRoot(startDirectory);
      const teamFile = Option.isSome(repoRoot)
        ? yield* readTeamFile(repoRoot.value)
        : Option.none();
      if (Option.isNone(teamFile)) {
        return yield* new TeamCliError({
          detail: `No .team/team.json in the Git repo at ${startDirectory}. Pass a folder of the team's repo: t3 team invite <path> --name <name> --base-dir <home>.`,
        });
      }

      // The URL points at the host's running server, the way `t3 pair` finds it.
      const target = yield* discoverPairTarget(config.baseDir).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catchTag("NoRunningServerError", () =>
          Effect.fail(
            new TeamCliError({
              detail: `No running T3 server uses the home ${config.baseDir}. Start the host's server first (for example \`vp run dev --home-dir ${config.baseDir}\`): the invite URL points at it. Nothing was created.`,
            }),
          ),
        ),
      );
      if (target.variant !== "userdata") {
        return yield* new TeamCliError({
          detail: `The server running on ${config.baseDir} keeps its data in ${target.variant}/, not userdata/. Start it with --home-dir ${config.baseDir} and run the invite again. Nothing was created.`,
        });
      }

      const ttl = Option.getOrElse(flags.ttl, () => TeamInvites.TEAM_INVITE_DEFAULT_TTL);
      const issued = yield* Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* TeamInvites.issueTeamInvite({
          teamId: teamFile.value.teamId,
          memberName: flags.name,
          ttl,
          hostEnvironmentId: yield* identity.getEnvironmentId,
        });
      }).pipe(Effect.provide(teamInviteLayer(config)));
      const url = buildTeamInviteUrl(resolveDirectPairingBaseUrl(target.state), issued.credential);
      yield* Console.log(formatTeamInvite({ issued, url, ttl, baseDir: config.baseDir }));
    }),
  ),
);

const teamInvitesCommand = Command.make("invites", {
  revoke: Flag.String("revoke").pipe(
    Flag.withDescription("Revoke this invite (its id from the list), so its URL stops working."),
    Flag.optional,
  ),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "List the invites of the teams the T3 home in --base-dir hosts: pending, used, expired, revoked. --revoke <id> revokes one.",
  ),
  Command.withHandler(
    Effect.fn("teamInvitesCommand")(function* (flags) {
      const config = yield* resolveTeamCliConfig("invites", flags.baseDir);
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(config.dbPath))) {
        yield* Console.log(`No T3 data at ${config.baseDir} yet, so it has no invites.`);
        return;
      }
      yield* Effect.gen(function* () {
        if (Option.isSome(flags.revoke)) {
          const { invite, alreadyRevoked } = yield* TeamInvites.revokeTeamInvite(
            flags.revoke.value.trim(),
          );
          yield* Console.log(
            alreadyRevoked
              ? `Invite ${invite.inviteId} for ${invite.memberName} was already revoked.`
              : `Revoked invite ${invite.inviteId} for ${invite.memberName}. Its URL no longer works, and the host refuses to join with it.`,
          );
          return;
        }
        const teams = yield* TeamService.TeamService;
        const invites = yield* TeamInvites.TeamInvites;
        yield* Console.log(
          formatTeamInvites({
            baseDir: config.baseDir,
            teams: yield* teams.listTeams(),
            invites: yield* invites.list(),
          }),
        );
      }).pipe(Effect.provide(teamInviteLayer(config)));
    }),
  ),
);

export const teamCommand = Command.make("team").pipe(
  Command.withDescription("Team layer commands."),
  Command.withSubcommands([
    teamInitCommand,
    teamStatusCommand,
    teamInviteCommand,
    teamInvitesCommand,
  ]),
);
