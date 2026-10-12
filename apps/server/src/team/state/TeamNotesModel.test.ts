import {
  EnvironmentId,
  type TeamLogin,
  TeamMemberId,
  teamNoteConcerns,
  type TeamWriterFile,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  addNoteReply,
  addTeamNote,
  buildTeamNotes,
  capTeamNotes,
  markTeamNote,
  pruneTeamNotes,
} from "./TeamNotesModel.ts";
import { emptyWriterFile } from "./TeamStateModel.ts";

/** Noon on that day of October 2026, or the given minute after midnight on the 1st. */
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const minute = (index: number) =>
  `2026-10-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;

const writer = (login: string): TeamWriterFile =>
  emptyWriterFile({
    login: login as TeamLogin,
    displayName: login,
    environmentId: EnvironmentId.make(`env-${login}`),
    now: at(1),
  });

const note = (noteId: string, to: string | null, createdAt = at(1)) => ({
  noteId,
  to,
  text: `Note ${noteId}`,
  path: null,
  forAgents: false,
  createdAt,
});

const view = (...files: ReadonlyArray<TeamWriterFile>) =>
  buildTeamNotes(files.map((file) => ({ key: `${file.login}/${file.environmentId}`, file })));

describe("team notes in the state", () => {
  it("shows each person the notes for everyone, for them and from them", () => {
    const yassine = addTeamNote(
      addTeamNote(addTeamNote(writer("yassine"), note("all", null)), note("to-sara", "sara")),
      note("to-omar", "omar"),
    );
    const notes = view(yassine, writer("sara"), writer("omar"));
    const listFor = (login: string) =>
      notes
        .filter((found) => teamNoteConcerns(found, TeamMemberId.make(login)))
        .map((found) => found.noteId)
        .toSorted();
    assert.deepEqual(listFor("sara"), ["all", "to-sara"]);
    assert.deepEqual(listFor("omar"), ["all", "to-omar"]);
    assert.deepEqual(listFor("yassine"), ["all", "to-omar", "to-sara"]);
  });

  it("is done by the newest done or open-again mark; seeing a note never reopens it", () => {
    const author = addTeamNote(writer("yassine"), note("n1", null));
    let sara = markTeamNote(writer("sara"), { noteId: "n1", done: true }, at(2));
    let omar = markTeamNote(writer("omar"), { noteId: "n1", seen: true }, at(3));
    let [merged] = view(author, sara, omar);
    assert.strictEqual(merged?.doneAt, at(2));
    assert.strictEqual(String(merged?.doneBy), "sara");
    assert.deepEqual(merged?.seenBy.map(String).toSorted(), ["omar", "sara"]);

    omar = markTeamNote(omar, { noteId: "n1", done: false }, at(4));
    [merged] = view(author, sara, omar);
    assert.isNull(merged?.doneAt);
    sara = markTeamNote(sara, { noteId: "n1", done: true }, at(5));
    [merged] = view(author, sara, omar);
    assert.strictEqual(merged?.doneAt, at(5));
    // Seeing it again changes nothing in the file.
    assert.strictEqual(markTeamNote(omar, { noteId: "n1", seen: true }, at(6)), omar);
  });

  it("shows replies oldest first under their note", () => {
    const author = addTeamNote(writer("yassine"), note("n1", "sara"));
    const sara = addNoteReply(
      addNoteReply(writer("sara"), {
        noteId: "n1",
        replyId: "r2",
        text: "Second",
        createdAt: at(3),
      }),
      { noteId: "n1", replyId: "r1", text: "First", createdAt: at(2) },
    );
    assert.deepEqual(
      view(author, sara)[0]?.replies.map((reply) => reply.text),
      ["First", "Second"],
    );
  });

  it("drops a done note a week after it was done, and old marks and replies on gone notes", () => {
    const author = addTeamNote(
      addTeamNote(writer("yassine"), note("old-done", "sara")),
      note("recent-done", "sara"),
    );
    const sara = addNoteReply(
      markTeamNote(
        markTeamNote(writer("sara"), { noteId: "old-done", done: true }, at(2)),
        { noteId: "recent-done", done: true },
        at(9),
      ),
      { noteId: "gone-long-ago", replyId: "r1", text: "Hm", createdAt: at(1) },
    );
    const notes = view(author, sara);
    const now = at(10);
    const prunedAuthor = pruneTeamNotes(author, notes, now);
    assert.deepEqual(
      prunedAuthor.teamNotes?.map((kept) => kept.noteId),
      ["recent-done"],
    );
    const prunedSara = pruneTeamNotes(sara, notes, now);
    assert.deepEqual(
      prunedSara.noteMarks?.map((mark) => mark.noteId),
      ["recent-done"],
    );
    assert.deepEqual(prunedSara.noteReplies, []);
    // Nothing old: the same file comes back.
    assert.strictEqual(pruneTeamNotes(author, notes, at(3)), author);
  });

  it("keeps marks on a note that only looks gone, until they are old", () => {
    // The author's file could not be read: the note is missing from the view.
    const sara = markTeamNote(writer("sara"), { noteId: "n1", seen: true }, at(9));
    assert.strictEqual(pruneTeamNotes(sara, [], at(10)), sara);
    assert.deepEqual(pruneTeamNotes(sara, [], at(20)).noteMarks, []);
  });

  it("keeps the newest notes when a writer has too many", () => {
    let file = writer("yassine");
    for (let index = 0; index < 105; index++) {
      file = addTeamNote(file, note(`n${index}`, null, minute(index)));
    }
    const kept = capTeamNotes(file).teamNotes ?? [];
    assert.lengthOf(kept, 100);
    assert.strictEqual(kept[0]?.noteId, "n5");
  });
});
