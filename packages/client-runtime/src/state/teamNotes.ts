/**
 * Notes on Team home / Today (fork-only, team/UI_PLAN.md slice 4), from the
 * team feed: which list each note goes in, and which notes sit on a file or
 * folder of the project, for the file tree's marker. Web and mobile share it.
 *
 * Note paths are relative to the team's root, like claims; a project may sit
 * in a folder of the repo (`pathPrefix`). Case is ignored, as the server does.
 */
import type { TeamFeedTeam, TeamNote } from "@t3tools/contracts";

import { claimPathInProject, type ProjectTeam } from "./teamMarkers.ts";

export interface TeamNoteLists {
  /** Open notes to everyone from teammates. Empty when solo. */
  readonly forEveryone: ReadonlyArray<TeamNote>;
  /** Open notes to this person; solo: every open note, to future you. */
  readonly forYou: ReadonlyArray<TeamNote>;
  /** Open notes this person wrote to others or everyone. Empty when solo. */
  readonly fromYou: ReadonlyArray<TeamNote>;
  /** Done notes not dropped yet, newest done first; folded on the page. */
  readonly done: ReadonlyArray<TeamNote>;
  /** Notes for this person they have not seen yet, to mark seen when shown. */
  readonly unseen: ReadonlyArray<TeamNote>;
}

/** Splits the feed's notes into the page's lists. The feed sends newest first. */
export function teamNoteLists(team: TeamFeedTeam): TeamNoteLists {
  const notes = team.notes ?? [];
  const open = notes.filter((note) => note.doneAt === null);
  const done = notes
    .filter((note) => note.doneAt !== null)
    .sort((a, b) => Date.parse(b.doneAt!) - Date.parse(a.doneAt!));
  if (team.solo || team.me === null) {
    return { forEveryone: [], forYou: open, fromYou: [], done, unseen: [] };
  }
  const me = team.me;
  const forEveryone = open.filter((note) => note.to === null && note.from !== me);
  const forYou = open.filter((note) => note.to === me);
  const fromYou = open.filter((note) => note.from === me);
  const unseen = [...forEveryone, ...forYou].filter((note) => !note.seenBy.includes(me));
  return { forEveryone, forYou, fromYou, done, unseen };
}

/** The note's file or folder as the project names it, case kept; null when it has none. */
export function notePathInProject(note: TeamNote, pathPrefix: string): string | null {
  if (note.path === null) return null;
  const inProject = claimPathInProject(note.path, pathPrefix);
  if (inProject === null) return note.path;
  if (inProject === "") return "the whole project";
  const trimmed = note.path.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.length - inProject.length);
}

/** A path typed on the page, relative to the project, as the team's root names it. */
export function projectPathToTeamPath(path: string, pathPrefix: string): string {
  const trimmed = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/^\/+/u, "");
  const prefix = pathPrefix.replace(/\/+$/u, "");
  return prefix === "" || trimmed === "" ? trimmed : `${prefix}/${trimmed}`;
}

/** Open notes that sit on exactly this file or folder of the project. */
export function fileNotes(projectTeam: ProjectTeam, path: string): ReadonlyArray<TeamNote> {
  const target = path.replace(/\/+$/u, "").toLowerCase();
  return (projectTeam.team.notes ?? []).filter(
    (note) =>
      note.doneAt === null &&
      note.path !== null &&
      claimPathInProject(note.path, projectTeam.pathPrefix) === target,
  );
}
