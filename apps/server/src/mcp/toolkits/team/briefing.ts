/**
 * Installs the team briefing resolver (team/DESIGN.md D4). Adapters call
 * `readTeamBriefing(threadId)` when they build runtime instructions; this
 * resolves the thread's team the same way the team tools do.
 *
 * No briefing when the session has no `t3-code` MCP server (the agent could
 * not call the tools it names), when the project is not in a team, or when
 * this server is not a member. A failure or a slow lookup also means no
 * briefing: it must never hold up or break a turn.
 */
import { TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { installTeamBriefingResolver, renderTeamBriefing } from "../../../team/TeamBriefing.ts";
import * as McpProviderSession from "../../McpProviderSession.ts";
import { makeTeamResolver } from "./resolve.ts";

const BRIEFING_TIMEOUT = "2 seconds";

export const makeTeamBriefingResolver = Effect.gen(function* () {
  const { resolve } = yield* makeTeamResolver;
  const path = yield* Path.Path;

  return (threadId: ThreadId): Effect.Effect<string | undefined> => {
    const mcp = McpProviderSession.readMcpProviderSession(threadId);
    if (mcp === undefined) return Effect.succeed(undefined);
    return resolve({ environmentId: mcp.environmentId, threadId }).pipe(
      Effect.map((resolved) => {
        if (resolved._tag === "NotInTeam") return undefined;
        const { teamFile, member, teamRoot, workingFolder } = resolved.context;
        const rulebook = path.join(teamRoot, TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME);
        return renderTeamBriefing({
          teamName: teamFile.name,
          memberName: member.displayName,
          rulebookPath: path.relative(workingFolder, rulebook),
        });
      }),
      Effect.timeoutOption(BRIEFING_TIMEOUT),
      Effect.tap((briefing) =>
        Option.isNone(briefing)
          ? Effect.logWarning(
              `Team briefing skipped for this turn: the team lookup took longer than ${BRIEFING_TIMEOUT}.`,
              { threadId },
            )
          : briefing.value === undefined
            ? Effect.void
            : Effect.logInfo("Team briefing added.", { threadId }),
      ),
      Effect.map(Option.getOrUndefined),
      Effect.catch((cause) =>
        Effect.logWarning("Team briefing skipped for this turn.", { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("Team briefing skipped for this turn.", { threadId, defect }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  };
});

export const TeamBriefingLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const resolver = yield* makeTeamBriefingResolver;
    const uninstall = installTeamBriefingResolver(resolver);
    yield* Effect.addFinalizer(() => Effect.sync(uninstall));
  }),
);
