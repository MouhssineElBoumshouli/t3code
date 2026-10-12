import { TeamId, TeamMemberId, type TeamFeedTeam, type TeamNote } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileNotes, notePathInProject, projectPathToTeamPath, teamNoteLists } from "./teamNotes.ts";

const ME = TeamMemberId.make("me-login");
const SARA = TeamMemberId.make("sara");
const OMAR = TeamMemberId.make("omar");

const note = (noteId: string, fields: Partial<TeamNote> = {}): TeamNote => ({
  noteId,
  from: SARA,
  to: null,
  text: noteId,
  path: null,
  forAgents: false,
  createdAt: "2026-10-12T10:00:00.000Z",
  seenBy: [],
  doneAt: null,
  doneBy: null,
  replies: [],
  ...fields,
});

const team = (notes: ReadonlyArray<TeamNote>, solo = false): TeamFeedTeam => ({
  teamId: TeamId.make("team-1"),
  name: "Core",
  solo,
  projects: [],
  me: ME,
  members: [],
  claims: [],
  tasks: [],
  handoffs: [],
  notes,
  sync: { status: solo ? "solo" : "synced", unshared: false, readAt: null },
});

const ids = (notes: ReadonlyArray<TeamNote>) => notes.map((found) => found.noteId);

describe("team note lists", () => {
  it("puts each note in for everyone, for you or from you, and done ones apart", () => {
    const lists = teamNoteLists(
      team([
        note("all"),
        note("to-me", { to: ME, seenBy: [ME] }),
        note("mine-to-omar", { from: ME, to: OMAR, seenBy: [OMAR] }),
        note("mine-to-all", { from: ME }),
        note("done-old", { to: ME, doneAt: "2026-10-12T11:00:00.000Z" }),
        note("done-new", { doneAt: "2026-10-12T12:00:00.000Z" }),
      ]),
    );
    expect(ids(lists.forEveryone)).toEqual(["all"]);
    expect(ids(lists.forYou)).toEqual(["to-me"]);
    expect(ids(lists.fromYou)).toEqual(["mine-to-omar", "mine-to-all"]);
    expect(ids(lists.done)).toEqual(["done-new", "done-old"]);
    // Only notes for this person count as unseen; theirs never do.
    expect(ids(lists.unseen)).toEqual(["all"]);
  });

  it("solo: every open note is to future you, and nothing is unseen", () => {
    const lists = teamNoteLists(
      team(
        [note("a", { from: ME }), note("b", { from: ME, doneAt: "2026-10-12T11:00:00.000Z" })],
        true,
      ),
    );
    expect(ids(lists.forYou)).toEqual(["a"]);
    expect(ids(lists.done)).toEqual(["b"]);
    expect(lists.forEveryone).toEqual([]);
    expect(lists.fromYou).toEqual([]);
    expect(lists.unseen).toEqual([]);
  });
});

describe("note paths", () => {
  it("names a note's path as the project does, case kept, and back", () => {
    expect(notePathInProject(note("a", { path: "apps/web/src/DB" }), "apps/web")).toBe("src/DB");
    expect(notePathInProject(note("a", { path: "apps" }), "apps/web")).toBe("the whole project");
    expect(notePathInProject(note("a"), "")).toBeNull();
    expect(projectPathToTeamPath("./src/db/", "apps/web")).toBe("apps/web/src/db/");
    expect(projectPathToTeamPath(" src\\db ", "")).toBe("src/db");
  });

  it("marks only the file or folder a note sits on, open notes only", () => {
    const projectTeam = {
      team: team([
        note("db", { path: "apps/web/src/DB" }),
        note("done", { path: "apps/web/src/db", doneAt: "2026-10-12T11:00:00.000Z" }),
      ]),
      pathPrefix: "apps/web",
    };
    expect(ids(fileNotes(projectTeam, "src/db"))).toEqual(["db"]);
    expect(ids(fileNotes(projectTeam, "src/db/schema.ts"))).toEqual([]);
    expect(ids(fileNotes(projectTeam, "src"))).toEqual([]);
  });
});
