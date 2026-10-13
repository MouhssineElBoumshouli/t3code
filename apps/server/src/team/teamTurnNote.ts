/**
 * A short note added to the text of each turn sent to the agent (fork-only,
 * team/VISION.md 3.6 point 3): the files this thread works on that changed
 * since its last turn. It goes with the user's message, not the runtime
 * instructions, so the cached prompt prefix never changes (VISION.md 6.5);
 * the message stored in the thread stays as the user wrote it.
 *
 * `ProviderCommandReactor` adds it with {@link withTeamTurnNote}; the team
 * layer installs its readers at startup: the stale-view line and notes
 * (`TeamStaleView`), and the merge check's line (`TeamMergeCheck`). Their
 * parts are joined in the order they were installed.
 *
 * @module teamTurnNote
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** The thread's note for this turn, or `undefined` for none. Never fails. */
export type TeamTurnNoteReader = (threadId: ThreadId) => Effect.Effect<string | undefined>;

const installedReaders = new Set<TeamTurnNoteReader>();

/** Installs a reader and returns a function that removes it again. */
export function installTeamTurnNote(reader: TeamTurnNoteReader): () => void {
  installedReaders.add(reader);
  return () => {
    installedReaders.delete(reader);
  };
}

/**
 * The message text with the thread's note after it. Slash commands go as
 * typed: text after one would become its arguments.
 */
export function withTeamTurnNote(threadId: ThreadId, text: string): Effect.Effect<string> {
  if (text.trimStart().startsWith("/")) return Effect.succeed(text);
  return Effect.suspend(() =>
    Effect.forEach([...installedReaders], (reader) => reader(threadId)),
  ).pipe(
    Effect.map((parts) => {
      const notes = parts.filter((part) => part !== undefined);
      return notes.length === 0 ? text : `${text}\n\n${notes.join("\n\n")}`;
    }),
  );
}
