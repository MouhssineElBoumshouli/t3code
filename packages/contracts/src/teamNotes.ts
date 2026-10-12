/**
 * Notes (fork-only, team/UI_PLAN.md slice 4, part 2): a short note to the
 * whole team or to one teammate, or, solo, to future you. It may sit on a file
 * or folder, and may be marked for agents: then an agent planning or editing
 * there is told it (`team_plan`'s answer or the turn note), once per chat.
 *
 * The note lives in its author's writer file; the reader's "seen", "done" and
 * replies live in the reader's own file, so each server still writes only its
 * own file. Anyone with access to the repo can read them: they are not private.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamId, TeamMemberId, TeamPath } from "./team.ts";

export const TEAM_NOTE_LIMITS = {
  /** Characters in a note or a reply. */
  text: 500,
  /** A done note folds away, and its author's server drops it this long after. */
  doneDays: 7,
  /** Per writer file, the newest kept: notes, marks, replies. */
  notes: 100,
  marks: 200,
  replies: 200,
  /** Replies shown under one note. */
  repliesPerNote: 10,
  /** Notes told to an agent at once, and the characters of each. */
  agentNotes: 3,
  agentNoteText: 200,
} as const;

/** A note in its author's writer file. `to` null means everyone (solo: future you). */
export const TeamStateTeamNote = Schema.Struct({
  noteId: TrimmedNonEmptyString,
  to: Schema.NullOr(TrimmedNonEmptyString),
  text: TrimmedNonEmptyString,
  /** A file or folder, relative to the team's root. */
  path: Schema.NullOr(TeamPath),
  /** "Agents should know this": told to an agent working on `path`. */
  forAgents: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type TeamStateTeamNote = typeof TeamStateTeamNote.Type;

/**
 * What this writer did with a note: when it was first seen, and whether it
 * marked it done. Across writers, the newest `doneChangedAt` says whether the
 * note is done, so seeing a note never opens it again.
 */
export const TeamStateNoteMark = Schema.Struct({
  noteId: TrimmedNonEmptyString,
  seenAt: Schema.NullOr(IsoDateTime),
  /** Null while this writer has it open. */
  doneAt: Schema.NullOr(IsoDateTime),
  /** When this writer last marked it done or open again; null if it never did. */
  doneChangedAt: Schema.NullOr(IsoDateTime),
});
export type TeamStateNoteMark = typeof TeamStateNoteMark.Type;

/** A reply under someone's note, in the replier's writer file. */
export const TeamStateNoteReply = Schema.Struct({
  noteId: TrimmedNonEmptyString,
  replyId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type TeamStateNoteReply = typeof TeamStateNoteReply.Type;

export const TeamNoteReply = Schema.Struct({
  replyId: TrimmedNonEmptyString,
  by: TeamMemberId,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type TeamNoteReply = typeof TeamNoteReply.Type;

/** A note as every reader sees it, with the marks and replies of all writers. */
export const TeamNote = Schema.Struct({
  noteId: TrimmedNonEmptyString,
  from: TeamMemberId,
  /** Null: everyone. */
  to: Schema.NullOr(TeamMemberId),
  text: TrimmedNonEmptyString,
  path: Schema.NullOr(TeamPath),
  forAgents: Schema.Boolean,
  createdAt: IsoDateTime,
  /** Who has seen it, other than its author. */
  seenBy: Schema.Array(TeamMemberId),
  doneAt: Schema.NullOr(IsoDateTime),
  doneBy: Schema.NullOr(TeamMemberId),
  /** Oldest first, capped. */
  replies: Schema.Array(TeamNoteReply),
});
export type TeamNote = typeof TeamNote.Type;

/** Whether a note is for this person, from them, or for everyone: what their lists show. */
export const teamNoteConcerns = (note: Pick<TeamNote, "from" | "to">, memberId: string) =>
  note.to === null || note.to === memberId || note.from === memberId;

/** Who may mark a note done: the person it is for; for everyone's notes, anyone. */
export const canMarkTeamNoteDone = (note: Pick<TeamNote, "from" | "to">, memberId: string) =>
  note.to === null || note.to === memberId;

const NoteText = TrimmedNonEmptyString.check(Schema.isMaxLength(TEAM_NOTE_LIMITS.text));

/** Everything a client does with notes, in one RPC. */
export const TeamNoteInput = Schema.Union([
  Schema.TaggedStruct("write", {
    teamId: TeamId,
    text: NoteText,
    /** Null: everyone. */
    to: Schema.NullOr(TeamMemberId),
    /** Relative to the team's root. */
    path: Schema.optionalKey(Schema.String),
    forAgents: Schema.Boolean,
  }),
  Schema.TaggedStruct("reply", { teamId: TeamId, noteId: TrimmedNonEmptyString, text: NoteText }),
  Schema.TaggedStruct("done", {
    teamId: TeamId,
    noteId: TrimmedNonEmptyString,
    /** False opens it again. */
    done: Schema.Boolean,
  }),
  Schema.TaggedStruct("seen", { teamId: TeamId, noteIds: Schema.Array(TrimmedNonEmptyString) }),
  /** Only the author's own note. */
  Schema.TaggedStruct("remove", { teamId: TeamId, noteId: TrimmedNonEmptyString }),
]);
export type TeamNoteInput = typeof TeamNoteInput.Type;

export const TeamNoteResult = Schema.Struct({});
export type TeamNoteResult = typeof TeamNoteResult.Type;

/** The note is gone, not this person's to change, or the team could not be written; shown as is. */
export class TeamNoteError extends Schema.TaggedError<TeamNoteError>()("TeamNoteError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
