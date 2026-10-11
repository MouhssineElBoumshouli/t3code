/**
 * What the team layer adds to a turn's text before the provider gets it
 * (fork-only, team/V2_PORT_PLAN.md D3). `RunExecutionService` calls
 * {@link withTeamTurnText} for every turn it starts.
 *
 * - The turn note (`teamTurnNote`), after the text, every turn.
 * - The team briefing, before the text, for providers whose system prompt the
 *   team layer does not reach: on the provider thread's first turn, and again
 *   only when the briefing changes. Claude gets it in its system prompt and
 *   Codex as its own context entry, so they get nothing here.
 *
 * Slash commands go as typed: text around one would change it. The thread's
 * stored message stays as the user wrote it.
 *
 * @module teamTurnText
 */
import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readTeamBriefing } from "./TeamBriefing.ts";
import { withTeamTurnNote } from "./teamTurnNote.ts";

/** Drivers whose adapter adds the briefing to its own instructions. */
const BRIEFED_BY_ADAPTER: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/** The briefing last put in front of each thread's text, on this server. */
const lastBriefing = new Map<ThreadId, string>();

export function withTeamTurnText(input: {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  /** 1 for the provider thread's first turn. */
  readonly providerTurnOrdinal: number;
  readonly text: string;
}): Effect.Effect<string> {
  if (input.text.trimStart().startsWith("/")) return Effect.succeed(input.text);
  return Effect.gen(function* () {
    const noted = yield* withTeamTurnNote(input.threadId, input.text);
    if (BRIEFED_BY_ADAPTER.has(input.driver)) return noted;
    const briefing = yield* readTeamBriefing(input.threadId);
    if (briefing === undefined) {
      lastBriefing.delete(input.threadId);
      return noted;
    }
    // A new server sends it once more: what the provider thread saw is not known here.
    if (input.providerTurnOrdinal > 1 && lastBriefing.get(input.threadId) === briefing) {
      return noted;
    }
    lastBriefing.set(input.threadId, briefing);
    return `${briefing}\n\n${noted}`;
  });
}
