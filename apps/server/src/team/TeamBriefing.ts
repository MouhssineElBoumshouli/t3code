/**
 * The team briefing (fork-only, see team/DESIGN.md D4): a short block added to
 * an agent's runtime instructions when its project is in a team.
 *
 * Cursor, Grok and Antigravity add runtime instructions to every user message,
 * so the briefing holds only things that rarely change: the team, the member,
 * how to use the team tools, and where the rules are. Live state (claims,
 * tasks, handoffs) comes only from the team tools.
 *
 * Adapters read it with {@link readTeamBriefing}. The team layer installs the
 * resolver at startup; without one, or outside a team, there is no briefing.
 *
 * @module TeamBriefing
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** The briefing must stay within this many tokens, whatever the names are. */
export const TEAM_BRIEFING_TOKEN_BUDGET = 150;

/** Longest team or member name shown; longer names are cut. */
export const TEAM_BRIEFING_MAX_NAME_LENGTH = 60;

export interface TeamBriefingInput {
  readonly teamName: string;
  readonly memberName: string;
  /** The rulebook, relative to the agent's working folder. */
  readonly rulebookPath: string;
}

/** One line, no tag or quote characters, cut to a fixed length. */
function toBriefingName(value: string): string {
  const clean = value
    .replaceAll(/[<>"`]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return clean.length <= TEAM_BRIEFING_MAX_NAME_LENGTH
    ? clean
    : `${clean.slice(0, TEAM_BRIEFING_MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

export function renderTeamBriefing(input: TeamBriefingInput): string {
  return [
    "<team_context>",
    `This project is in team "${toBriefingName(input.teamName)}". You are "${toBriefingName(input.memberName)}".`,
    "Before editing files, call team_status, then team_claim the paths you will touch.",
    "If team_claim reports overlaps, tell the user before editing those files.",
    "When you finish or stop, write a team_handoff.",
    `Project rules are in ${input.rulebookPath}; read it before your first change.`,
    "Code is the truth; team notes can be out of date.",
    "</team_context>",
  ].join("\n");
}

/** Resolves a thread's briefing. Never fails; `undefined` means no briefing. */
export type TeamBriefingResolver = (threadId: ThreadId) => Effect.Effect<string | undefined>;

let installedResolver: TeamBriefingResolver | undefined;

/** Installs the resolver and returns a function that removes it again. */
export function installTeamBriefingResolver(resolver: TeamBriefingResolver): () => void {
  installedResolver = resolver;
  return () => {
    if (installedResolver === resolver) installedResolver = undefined;
  };
}

/** The briefing for this thread, or `undefined` when its project is not in a team. */
export function readTeamBriefing(threadId: ThreadId): Effect.Effect<string | undefined> {
  return Effect.suspend(() => installedResolver?.(threadId) ?? Effect.succeed(undefined));
}
