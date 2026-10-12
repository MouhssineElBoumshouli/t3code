/**
 * Notes in the team state (fork-only, team/UI_PLAN.md slice 4): pure
 * functions, like TeamStateModel. A note lives in its author's writer file;
 * each reader's "seen", "done" and replies live in the reader's own file
 * (contracts `teamNotes.ts`). Reading merges them into one {@link TeamNote}.
 *
 * Done notes fold away and are dropped {@link TEAM_NOTE_LIMITS.doneDays}
 * after they were marked done, by their author's server on its next write;
 * marks and replies on a note that is gone go the same way.
 *
 * @module TeamNotesModel
 */
import {
  type TeamLogin,
  TeamMemberId,
  type TeamNote,
  type TeamNoteReply,
  type TeamStateNoteMark,
  type TeamStateNoteReply,
  type TeamStateTeamNote,
  type TeamWriterFile,
  TEAM_NOTE_LIMITS,
} from "@t3tools/contracts";

/** The writer files a view is built from; the key breaks ties. */
interface NoteWriter {
  readonly key: string;
  readonly file: TeamWriterFile;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const timeOf = (iso: string | null) => {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

const memberIdOf = (login: TeamLogin | string) => TeamMemberId.make(login);

/**
 * Every note with everyone's marks and replies, newest first. `writers` must
 * be in a fixed order (by key), so readers given the same files agree.
 */
export const buildTeamNotes = (writers: ReadonlyArray<NoteWriter>): ReadonlyArray<TeamNote> => {
  const marks = new Map<string, Array<{ readonly by: string; readonly mark: TeamStateNoteMark }>>();
  const replies = new Map<string, Array<TeamNoteReply>>();
  for (const writer of writers) {
    for (const mark of writer.file.noteMarks ?? []) {
      const list = marks.get(mark.noteId) ?? [];
      list.push({ by: writer.file.login, mark });
      marks.set(mark.noteId, list);
    }
    for (const reply of writer.file.noteReplies ?? []) {
      const list = replies.get(reply.noteId) ?? [];
      list.push({
        replyId: reply.replyId,
        by: memberIdOf(writer.file.login),
        text: reply.text,
        createdAt: reply.createdAt,
      });
      replies.set(reply.noteId, list);
    }
  }

  const seen = new Set<string>();
  const notes: Array<TeamNote> = [];
  for (const writer of writers) {
    for (const note of writer.file.teamNotes ?? []) {
      // One person writing from two servers never shares an id; keep the first anyway.
      if (seen.has(note.noteId)) continue;
      seen.add(note.noteId);
      const from = writer.file.login;
      const noteMarks = marks.get(note.noteId) ?? [];
      // The newest "done" or "open again" decides; a later writer wins a tie.
      let decided: { readonly by: string; readonly mark: TeamStateNoteMark } | undefined;
      for (const entry of noteMarks) {
        if (entry.mark.doneChangedAt === null) continue;
        if (
          decided === undefined ||
          timeOf(entry.mark.doneChangedAt) >= timeOf(decided.mark.doneChangedAt)
        ) {
          decided = entry;
        }
      }
      const doneAt = decided?.mark.doneAt ?? null;
      notes.push({
        noteId: note.noteId,
        from: memberIdOf(from),
        to: note.to === null ? null : memberIdOf(note.to),
        text: note.text,
        path: note.path,
        forAgents: note.forAgents,
        createdAt: note.createdAt,
        seenBy: [
          ...new Set(
            noteMarks
              .filter((entry) => entry.mark.seenAt !== null && entry.by !== from)
              .map((entry) => entry.by),
          ),
        ].map(memberIdOf),
        doneAt,
        doneBy: doneAt === null || decided === undefined ? null : memberIdOf(decided.by),
        replies: (replies.get(note.noteId) ?? [])
          .toSorted((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
          .slice(-TEAM_NOTE_LIMITS.repliesPerNote),
      });
    }
  }
  return notes.toSorted(
    (a, b) =>
      timeOf(b.createdAt) - timeOf(a.createdAt) ||
      (a.noteId < b.noteId ? 1 : a.noteId > b.noteId ? -1 : 0),
  );
};

/** Whether a done note is past keeping: it folds away first, then goes. */
export const isNotePastKeeping = (note: Pick<TeamNote, "doneAt">, now: string) =>
  note.doneAt !== null && timeOf(note.doneAt) < timeOf(now) - TEAM_NOTE_LIMITS.doneDays * DAY_MS;

export const addTeamNote = (file: TeamWriterFile, note: TeamStateTeamNote): TeamWriterFile => ({
  ...file,
  teamNotes: [...(file.teamNotes ?? []), note],
});

/** Drops one of this writer's notes; the same file when it is not there. */
export const removeTeamNote = (file: TeamWriterFile, noteId: string): TeamWriterFile =>
  file.teamNotes?.some((note) => note.noteId === noteId) === true
    ? { ...file, teamNotes: file.teamNotes.filter((note) => note.noteId !== noteId) }
    : file;

/**
 * Records that this writer saw a note, or marked it done or open again. The
 * same file when nothing changes: a note already seen stays seen as it was.
 */
export const markTeamNote = (
  file: TeamWriterFile,
  input: { readonly noteId: string; readonly seen?: boolean; readonly done?: boolean },
  now: string,
): TeamWriterFile => {
  const current = file.noteMarks?.find((mark) => mark.noteId === input.noteId);
  const before: TeamStateNoteMark = current ?? {
    noteId: input.noteId,
    seenAt: null,
    doneAt: null,
    doneChangedAt: null,
  };
  let next = before;
  if (input.seen === true && next.seenAt === null) next = { ...next, seenAt: now };
  if (input.done !== undefined) {
    // Marking done also means it was seen.
    next = {
      ...next,
      seenAt: next.seenAt ?? now,
      doneAt: input.done ? now : null,
      doneChangedAt: now,
    };
  }
  if (next === before) return file;
  return {
    ...file,
    noteMarks: [...(file.noteMarks ?? []).filter((mark) => mark.noteId !== input.noteId), next],
  };
};

export const addNoteReply = (file: TeamWriterFile, reply: TeamStateNoteReply): TeamWriterFile => ({
  ...file,
  noteReplies: [...(file.noteReplies ?? []), reply],
});

/**
 * Drops what the team no longer needs, with the merged notes the server holds:
 * this writer's notes done more than {@link TEAM_NOTE_LIMITS.doneDays} ago, and
 * its marks and replies on notes that are gone, once they are that old too (a
 * note may only look gone while its author's file cannot be read). The same
 * file when nothing goes.
 */
export const pruneTeamNotes = (
  file: TeamWriterFile,
  notes: ReadonlyArray<TeamNote>,
  now: string,
): TeamWriterFile => {
  if (
    file.teamNotes === undefined &&
    file.noteMarks === undefined &&
    file.noteReplies === undefined
  )
    return file;
  const byId = new Map(notes.map((note) => [note.noteId, note]));
  const cutoff = timeOf(now) - TEAM_NOTE_LIMITS.doneDays * DAY_MS;
  const gone = (noteId: string, at: number) => {
    const note = byId.get(noteId);
    return note === undefined ? at < cutoff : isNotePastKeeping(note, now);
  };
  const teamNotes = file.teamNotes?.filter((note) => {
    const merged = byId.get(note.noteId);
    return merged === undefined || !isNotePastKeeping(merged, now);
  });
  const noteMarks = file.noteMarks?.filter(
    (mark) => !gone(mark.noteId, Math.max(timeOf(mark.seenAt), timeOf(mark.doneChangedAt))),
  );
  const noteReplies = file.noteReplies?.filter(
    (reply) => !gone(reply.noteId, timeOf(reply.createdAt)),
  );
  if (
    teamNotes?.length === file.teamNotes?.length &&
    noteMarks?.length === file.noteMarks?.length &&
    noteReplies?.length === file.noteReplies?.length
  ) {
    return file;
  }
  return {
    ...file,
    ...(teamNotes === undefined ? {} : { teamNotes }),
    ...(noteMarks === undefined ? {} : { noteMarks }),
    ...(noteReplies === undefined ? {} : { noteReplies }),
  };
};

/** Keeps the newest `limit` entries, in file order. */
const keepNewest = <A>(entries: ReadonlyArray<A>, limit: number, at: (entry: A) => number) => {
  if (entries.length <= limit) return entries;
  const kept = new Set(entries.toSorted((a, b) => at(b) - at(a)).slice(0, limit));
  return entries.filter((entry) => kept.has(entry));
};

/** The caps on a writer file's notes, marks and replies; part of `compactWriterFile`. */
export const capTeamNotes = (file: TeamWriterFile): Partial<TeamWriterFile> => ({
  ...(file.teamNotes === undefined
    ? {}
    : {
        teamNotes: keepNewest(file.teamNotes, TEAM_NOTE_LIMITS.notes, (note) =>
          timeOf(note.createdAt),
        ),
      }),
  ...(file.noteMarks === undefined
    ? {}
    : {
        noteMarks: keepNewest(file.noteMarks, TEAM_NOTE_LIMITS.marks, (mark) =>
          Math.max(timeOf(mark.seenAt), timeOf(mark.doneChangedAt)),
        ),
      }),
  ...(file.noteReplies === undefined
    ? {}
    : {
        noteReplies: keepNewest(file.noteReplies, TEAM_NOTE_LIMITS.replies, (reply) =>
          timeOf(reply.createdAt),
        ),
      }),
});
