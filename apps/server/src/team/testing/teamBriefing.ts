import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { installTeamBriefingResolver, renderTeamBriefing } from "../TeamBriefing.ts";

export const TEST_TEAM_BRIEFING = renderTeamBriefing({
  teamName: "Core",
  memberName: "Mouhssine's laptop",
  rulebookPath: ".team/rulebook.md",
});

/**
 * Runs `effect` with a team briefing resolver installed. `briefingFor` is read
 * on every lookup, so a test can move a thread into a team between turns.
 */
export const withTeamBriefing = <A, E, R>(
  briefingFor: (threadId: ThreadId) => string | undefined,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      installTeamBriefingResolver((threadId) => Effect.sync(() => briefingFor(threadId))),
    ),
    () => effect,
    (uninstall) => Effect.sync(uninstall),
  );
