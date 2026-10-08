/**
 * Installs the team briefing resolver (team/DESIGN.md D4). Adapters call
 * `readTeamBriefing(threadId)` when they build runtime instructions; this
 * resolves the thread's team the same way the team tools do.
 *
 * No briefing when the session has no `t3-code` MCP server (the agent could
 * not call the tools it names), or when the project is in a team this server
 * cannot use. A project with no team gets the solo briefing.
 *
 * A failure or a slow lookup must never hold up or break a turn: it reuses the
 * thread's last briefing (none if it never had one). Dropping it for one turn
 * would change the cached prompt prefix (OpenCode's system text, Codex's
 * context entry) for that turn and the next (team/VISION.md 6.5).
 */
import { TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  installTeamBriefingResolver,
  renderSoloBriefing,
  renderTeamBriefing,
} from "../../../team/TeamBriefing.ts";
import * as McpProviderSession from "../../McpProviderSession.ts";
import { makeTeamResolver } from "./resolve.ts";

const BRIEFING_TIMEOUT = "2 seconds";

export const makeTeamBriefingResolver = Effect.gen(function* () {
  const { resolve } = yield* makeTeamResolver;
  const path = yield* Path.Path;
  /** The last briefing each thread got; only "not in a team" removes it. */
  const lastBriefing = new Map<ThreadId, string>();
  const reuseLast = (threadId: ThreadId) => Effect.sync(() => lastBriefing.get(threadId));

  return (threadId: ThreadId): Effect.Effect<string | undefined> => {
    const mcp = McpProviderSession.readMcpProviderSession(threadId);
    if (mcp === undefined) return Effect.succeed(undefined);
    return resolve({ environmentId: mcp.environmentId, threadId }).pipe(
      Effect.map((resolved) => {
        if (resolved._tag === "NotInTeam") return undefined;
        if (resolved.context.solo) return renderSoloBriefing();
        const { teamFile, member, teamRoot, workingFolder } = resolved.context;
        const rulebook = path.join(teamRoot, TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME);
        return renderTeamBriefing({
          teamName: teamFile.name,
          memberName: member.displayName,
          rulebookPath: path.relative(workingFolder, rulebook),
        });
      }),
      Effect.timeoutOption(BRIEFING_TIMEOUT),
      Effect.flatMap((briefing) => {
        if (Option.isNone(briefing)) {
          return Effect.logWarning(
            `Team briefing reused for this turn: the team lookup took longer than ${BRIEFING_TIMEOUT}.`,
            { threadId },
          ).pipe(Effect.andThen(reuseLast(threadId)));
        }
        if (briefing.value === undefined) {
          lastBriefing.delete(threadId);
          return Effect.succeed(undefined);
        }
        lastBriefing.set(threadId, briefing.value);
        return Effect.logInfo("Team briefing added.", { threadId }).pipe(Effect.as(briefing.value));
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Team briefing reused for this turn: the lookup failed.", {
          threadId,
          cause,
        }).pipe(Effect.andThen(reuseLast(threadId))),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("Team briefing reused for this turn: the lookup failed.", {
          threadId,
          defect,
        }).pipe(Effect.andThen(reuseLast(threadId))),
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
