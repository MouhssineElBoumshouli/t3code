/**
 * The edit check adapters call before an agent's file write lands (fork-only,
 * team/PREVENTION_PLAN.md section 3): Claude's PreToolUse hook and
 * Antigravity's client writes. `TeamGuard` installs it, the way the briefing
 * resolver is installed, so adapters need no team layer.
 *
 * @module teamEditCheck
 */
import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Why the write must wait (told to the agent), or `undefined` to let it through. Never fails. */
export type TeamEditCheck = (
  threadId: ThreadId,
  paths: ReadonlyArray<string>,
) => Effect.Effect<string | undefined>;

let installedCheck: TeamEditCheck | undefined;

/** Installs the check and returns a function that removes it again. */
export function installTeamEditCheck(check: TeamEditCheck): () => void {
  installedCheck = check;
  return () => {
    if (installedCheck === check) installedCheck = undefined;
  };
}

/** Full or working-folder-relative paths; outside a team, or with no check installed, every write passes. */
export function checkTeamEdit(
  threadId: ThreadId,
  paths: ReadonlyArray<string>,
): Effect.Effect<string | undefined> {
  return Effect.suspend(() => installedCheck?.(threadId, paths) ?? Effect.succeed(undefined));
}

/** The file a Claude edit tool writes, from its input. */
export function claudeEditToolPath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const input = toolInput as { readonly file_path?: unknown; readonly notebook_path?: unknown };
  const path = input.file_path ?? input.notebook_path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** The Claude tools that write files. Bash is not one: the after-the-turn check sees its edits. */
export const CLAUDE_EDIT_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/**
 * Claude's PreToolUse hook on its edit tools: a held file is refused with the
 * reason, which Claude reads as the tool's error. Hooks run in every
 * permission mode, `bypassPermissions` included. Allowed writes return no
 * decision, so the usual permission flow still applies.
 */
export const claudeTeamEditHooks = (
  threadId: ThreadId,
  run: <A>(effect: Effect.Effect<A>) => Promise<A>,
): NonNullable<ClaudeQueryOptions["hooks"]> => ({
  PreToolUse: [
    {
      matcher: CLAUDE_EDIT_TOOLS_MATCHER,
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const file = claudeEditToolPath(input.tool_input);
          if (file === undefined) return {};
          const reason = await run(checkTeamEdit(threadId, [file]));
          return reason === undefined
            ? {}
            : {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: reason,
                },
              };
        },
      ],
    },
  ],
});
