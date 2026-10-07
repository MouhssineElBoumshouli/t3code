/**
 * Solo mode (team/WINDOWS_AND_SOLO.md S1, S5): a project without
 * `.team/team.json` still gets memory, notes, claims between the person's own
 * chats and the briefing. It is a team of one kept on this computer: a state
 * repo in T3 home with no `origin`, so nothing is fetched, pushed or polled,
 * and nothing is written into the project.
 *
 * The team id comes from the project folder, so every chat of the project
 * (worktrees included) finds the same state, and `t3 team init` in that
 * folder can make it a team under the same id, notes kept: the solo writer
 * file is renamed to the person's GitHub login when the team opens.
 *
 * @module SoloTeam
 */
// @effect-diagnostics nodeBuiltinImport:off - a synchronous hash of a folder path.
import * as NodeCrypto from "node:crypto";

import { TeamId, TeamLogin } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { folderKey, realFolder } from "../folders.ts";

/** Who writes a solo team's state. Renamed to the GitHub login when it becomes a team. */
export const SOLO_LOGIN = Schema.decodeSync(TeamLogin)("me");
/** How the person shows in their own solo state ("who" in `team_status`). */
export const SOLO_DISPLAY_NAME = "You";
export const SOLO_TEAM_ID_PREFIX = "solo-";

/** The solo team id of a project folder (links already resolved). */
export const soloTeamId = (folder: string, platform: NodeJS.Platform) =>
  TeamId.make(
    `${SOLO_TEAM_ID_PREFIX}${NodeCrypto.createHash("sha256")
      .update(folderKey(folder, platform))
      .digest("hex")
      .slice(0, 32)}`,
  );

/** The solo team id of a project folder, links resolved, on this platform. */
export const soloTeamIdOf = (folder: string) =>
  Effect.gen(function* () {
    return soloTeamId(yield* realFolder(folder), yield* HostProcessPlatform);
  });
