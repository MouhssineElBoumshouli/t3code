/**
 * Notes (fork-only, team/UI_PLAN.md slice 4): what a client does with them
 * (`team.note` in `ws.ts`), and which notes an agent is told.
 *
 * A note marked "Agents should know this" sits on a file or folder. An agent
 * is told it only when it plans files there (`team_plan`'s answer) or works on
 * files there (the turn note, from the files its chat touched or holds), and
 * each note once per chat: never on every message, and never in the cached
 * part of the prompt. Done notes, and notes for another teammate, are not told.
 *
 * @module TeamNotes
 */
import {
  type TeamMemberId,
  type TeamNote,
  TeamNoteError,
  type TeamNoteInput,
  type TeamNoteResult,
  TEAM_NOTE_LIMITS,
  teamPathsOverlap,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { TeamContext } from "../mcp/toolkits/team/resolve.ts";
import * as TeamService from "./TeamService.ts";

/**
 * The notes an agent should be told now: marked for agents, open, for
 * everyone or for this person, on a path that overlaps one it works on, and
 * not told to this chat yet. Newest first, capped.
 */
export const notesForAgent = (input: {
  readonly notes: ReadonlyArray<TeamNote>;
  readonly memberId: TeamMemberId;
  readonly paths: ReadonlyArray<string>;
  readonly told: ReadonlySet<string>;
}): ReadonlyArray<TeamNote> =>
  input.notes
    .filter(
      (note) =>
        note.forAgents &&
        note.path !== null &&
        note.doneAt === null &&
        (note.to === null || note.to === input.memberId) &&
        !input.told.has(note.noteId) &&
        input.paths.some((path) => teamPathsOverlap(note.path!, path)),
    )
    .slice(0, TEAM_NOTE_LIMITS.agentNotes);

const cut = (text: string) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= TEAM_NOTE_LIMITS.agentNoteText
    ? line
    : `${line.slice(0, TEAM_NOTE_LIMITS.agentNoteText - 1)}…`;
};

/** One sentence per note: who left it (not when solo), where, and its text. */
export const agentNoteLines = (
  notes: ReadonlyArray<TeamNote>,
  nameOf: (memberId: TeamMemberId) => string | null,
) =>
  notes.map((note) => {
    const name = nameOf(note.from);
    return `${name === null ? "" : `${name} on `}\`${note.path}\`: "${cut(note.text)}"`;
  });

/** The turn note's part, or undefined when there is nothing to tell. */
export const renderAgentNotes = (lines: ReadonlyArray<string>, solo: boolean) =>
  lines.length === 0
    ? undefined
    : `<team_notes>${solo ? "Notes the user left for agents" : "Notes the team left for agents"} on files you work on: ${lines.join("; ")}. Follow them, and tell the user if one conflicts with the task.</team_notes>`;

export class TeamNotes extends Context.Service<
  TeamNotes,
  {
    /** One client action on notes, as this server's person. */
    readonly act: (input: TeamNoteInput) => Effect.Effect<TeamNoteResult, TeamNoteError>;
    /**
     * Notes for the agent of a chat working on `paths`, as sentences; each
     * returned once per chat. Never fails: no notes on a problem.
     */
    readonly takeForAgent: (
      context: TeamContext,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/team/TeamNotes") {}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  /** Note ids told to each chat on this server. */
  const told = new Map<ThreadId, Set<string>>();

  const act = (input: TeamNoteInput) =>
    Effect.gen(function* () {
      const me = yield* teams.currentMember(input.teamId);
      if (Option.isNone(me)) {
        return yield* new TeamNoteError({ detail: "This team is not open here." });
      }
      const memberId = me.value.memberId;
      const teamId = input.teamId;
      switch (input._tag) {
        case "write":
          yield* teams.writeNote({
            teamId,
            memberId,
            to: input.to,
            text: input.text,
            path: input.path,
            forAgents: input.forAgents,
          });
          break;
        case "reply":
          yield* teams.replyToNote({ teamId, memberId, noteId: input.noteId, text: input.text });
          break;
        case "done":
          yield* teams.markNote({ teamId, memberId, noteIds: [input.noteId], done: input.done });
          break;
        case "seen":
          yield* teams.markNote({ teamId, memberId, noteIds: input.noteIds, seen: true });
          break;
        case "remove":
          yield* teams.removeNote({ teamId, memberId, noteId: input.noteId });
          break;
      }
      return {};
    }).pipe(
      Effect.catch((error) => {
        switch (error._tag) {
          case "TeamNoteError":
            return Effect.fail(error);
          case "TeamNoteRefusedError":
          case "TeamClaimPathsInvalidError":
            return Effect.fail(new TeamNoteError({ detail: error.message }));
          case "TeamMemberNotFoundError":
            return Effect.fail(new TeamNoteError({ detail: "That teammate is not in this team." }));
          default:
            return Effect.logWarning("A team note could not be saved.", { error }).pipe(
              Effect.andThen(
                Effect.fail(
                  new TeamNoteError({ detail: "The note could not be saved. Try again." }),
                ),
              ),
            );
        }
      }),
    );

  const takeForAgent = (context: TeamContext, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (paths.length === 0) return [];
      const teamId = context.teamFile.teamId;
      const threadId = context.thread.threadId;
      const notes = yield* teams.listNotes(teamId);
      const toldHere = told.get(threadId) ?? new Set<string>();
      const shown = notesForAgent({
        notes,
        memberId: context.member.memberId,
        paths,
        told: toldHere,
      });
      if (shown.length === 0) return [];
      for (const note of shown) toldHere.add(note.noteId);
      told.set(threadId, toldHere);
      const members = context.solo ? [] : yield* teams.listMembers(teamId);
      return agentNoteLines(shown, (memberId) =>
        context.solo
          ? null
          : (members.find((member) => member.memberId === memberId)?.displayName ?? memberId),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team notes for an agent skipped.", { cause }).pipe(Effect.as([])),
      ),
    );

  return TeamNotes.of({ act, takeForAgent });
});

export const layer = Layer.effect(TeamNotes, make);
