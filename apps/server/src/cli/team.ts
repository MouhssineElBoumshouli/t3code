/**
 * `t3 team` commands (fork-only, see team/DESIGN.md).
 *
 * `t3 team init` writes the team's checked-in files into the current repo and
 * never commits them.
 */
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { expandHomePath } from "../os-jank.ts";
import { initTeamProject, type TeamProjectInitResult } from "../team/TeamProjectFiles.ts";

export function formatTeamInitResult(result: TeamProjectInitResult): string {
  const changed = result.files.some((file) => file.status !== "unchanged");
  const lines = [
    `Team "${result.teamFile.name}" (teamId ${result.teamFile.teamId}) in ${result.repoRoot}`,
    "",
    ...result.files.map((file) => `  ${file.status.padEnd(9)} ${file.path}  ${file.detail}`),
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
}).pipe(
  Command.withDescription(
    "Make this Git repo a team: write .team/team.json and .team/rulebook.md, and set worktrees as the default in t3.json.",
  ),
  Command.withHandler(
    Effect.fn("teamInitCommand")(function* (flags) {
      const path = yield* Path.Path;
      const rawStart =
        Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcessWorkingDirectory);
      const startDirectory = path.resolve(yield* expandHomePath(rawStart));
      const result = yield* initTeamProject({
        startDirectory,
        name: Option.getOrUndefined(flags.name),
      });
      yield* Console.log(formatTeamInitResult(result));
    }),
  ),
);

export const teamCommand = Command.make("team").pipe(
  Command.withDescription("Team layer commands."),
  Command.withSubcommands([teamInitCommand]),
);
