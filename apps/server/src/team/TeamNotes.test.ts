import { type TeamNote, TeamMemberId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { agentNoteLines, notesForAgent, renderAgentNotes } from "./TeamNotes.ts";

const SARA = TeamMemberId.make("sara");
const OMAR = TeamMemberId.make("omar");

const note = (noteId: string, fields: Partial<TeamNote> = {}): TeamNote => ({
  noteId,
  from: OMAR,
  to: null,
  text: `Note ${noteId}`,
  path: "src/db",
  forAgents: true,
  createdAt: "2026-10-12T10:00:00.000Z",
  seenBy: [],
  doneAt: null,
  doneBy: null,
  replies: [],
  ...fields,
});

const ids = (notes: ReadonlyArray<TeamNote>) => notes.map((found) => found.noteId);

describe("notes told to an agent", () => {
  it("tells a note marked for agents only when the agent works on or inside its path", () => {
    const notes = [note("db"), note("file", { path: "src/db/schema.ts" })];
    const at = (paths: ReadonlyArray<string>) =>
      ids(notesForAgent({ notes, memberId: SARA, paths, told: new Set() }));
    assert.deepEqual(at(["src/db/schema.ts"]), ["db", "file"]);
    assert.deepEqual(at(["src/db"]), ["db", "file"]);
    assert.deepEqual(at(["src/db/migrate.ts"]), ["db"]);
    assert.deepEqual(at(["src/api/users.ts"]), []);
    assert.deepEqual(at([]), []);
  });

  it("leaves out notes not for agents, done, for another teammate, or already told", () => {
    const notes = [
      note("plain", { forAgents: false }),
      note("done", { doneAt: "2026-10-12T11:00:00.000Z" }),
      note("for-omar", { to: OMAR }),
      note("for-sara", { to: SARA }),
      note("told"),
      note("no-path", { path: null }),
    ];
    assert.deepEqual(
      ids(notesForAgent({ notes, memberId: SARA, paths: ["src/db"], told: new Set(["told"]) })),
      ["for-sara"],
    );
  });

  it("tells at most three at once, with each text cut short", () => {
    const long = "x".repeat(400);
    const notes = ["a", "b", "c", "d"].map((id) => note(id, { text: long }));
    const shown = notesForAgent({ notes, memberId: SARA, paths: ["src/db"], told: new Set() });
    assert.deepEqual(ids(shown), ["a", "b", "c"]);
    const [line] = agentNoteLines(shown, () => "Omar");
    assert.isTrue(line!.startsWith('Omar on `src/db`: "xxx'));
    assert.isBelow(line!.length, 240);
  });

  it("adds nothing to the turn when there is nothing to tell, and names no one solo", () => {
    assert.isUndefined(renderAgentNotes([], false));
    const [line] = agentNoteLines([note("a")], () => null);
    assert.strictEqual(line, '`src/db`: "Note a"');
    assert.include(renderAgentNotes([line!], true), "Notes the user left for agents");
  });
});
