/**
 * Lists read from the rulebook.
 *
 * - "Do not touch", shown in `team_status` (team/DESIGN.md D5). In the cold
 *   start test neither agent read `.team/rulebook.md` to answer a question, so
 *   both missed a folder the rulebook keeps for humans. The list comes with the
 *   board, short and capped; the rest of the rulebook stays in the file.
 * - "Shared files" (team/VISION.md 3.6): files everyone adds to, such as a
 *   routes list or global styles. Someone else holding one never raises the
 *   warning card or the guard; the claim is still recorded, so the markers
 *   still show who is in there.
 *
 * No section, or an empty one, means no list.
 */
import {
  normalizeTeamPath,
  TEAM_DIRECTORY_NAME,
  TEAM_RULEBOOK_FILE_NAME,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  TEAM_RULEBOOK_DO_NOT_TOUCH_EXAMPLE,
  TEAM_RULEBOOK_SHARED_FILES_EXAMPLE,
} from "../../../team/TeamProjectFiles.ts";

export const TEAM_DO_NOT_TOUCH_LIMITS = {
  items: 5,
  itemCharacters: 120,
  /** A larger rulebook is not read; it is far over its word cap anyway. */
  rulebookBytes: 64_000,
};

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u;
const DO_NOT_TOUCH_TITLE = /^(?:do not|don't|don’t) touch\b/iu;
const SHARED_FILES_TITLE = /^shared files\b/iu;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u;
const FENCE = /^\s*(?:```|~~~)/u;

const cut = (text: string) =>
  text.length <= TEAM_DO_NOT_TOUCH_LIMITS.itemCharacters
    ? text
    : `${text.slice(0, TEAM_DO_NOT_TOUCH_LIMITS.itemCharacters - 1).trimEnd()}…`;

/**
 * The items of the first section whose title matches, one per list item or
 * paragraph, until the next heading of the same or a higher level. Wrapped
 * lines join their item.
 */
function readSectionItems(markdown: string, title: RegExp): Array<string> {
  const items: Array<string> = [];
  let sectionLevel = 0;
  let inFence = false;
  let previousBlank = true;
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (sectionLevel > 0 && level <= sectionLevel) break;
      if (sectionLevel === 0 && title.test(heading[2]!)) sectionLevel = level;
      previousBlank = true;
      continue;
    }
    if (sectionLevel === 0) continue;
    if (line.trim().length === 0) {
      previousBlank = true;
      continue;
    }
    const listItem = LIST_ITEM.exec(line);
    const text = (listItem?.[1] ?? line).trim().replaceAll(/\s+/gu, " ");
    if (listItem === null && !previousBlank && items.length > 0) {
      items[items.length - 1] = `${items.at(-1)} ${text}`;
    } else {
      items.push(text);
    }
    previousBlank = false;
  }
  return items;
}

/**
 * The "Do not touch" items. The template's example line is left out. Past the
 * cap, the last item says how many more are in `rulebookPath`.
 */
export function readDoNotTouchSection(
  markdown: string,
  rulebookPath: string,
): ReadonlyArray<string> {
  const shown = readSectionItems(markdown, DO_NOT_TOUCH_TITLE).filter(
    (item) => item.length > 0 && item !== TEAM_RULEBOOK_DO_NOT_TOUCH_EXAMPLE,
  );
  if (shown.length <= TEAM_DO_NOT_TOUCH_LIMITS.items) return shown.map(cut);
  const kept = TEAM_DO_NOT_TOUCH_LIMITS.items - 1;
  return [...shown.slice(0, kept).map(cut), `+${shown.length - kept} more in ${rulebookPath}`];
}

/**
 * The paths of the "Shared files" section: the first `code span` of each item,
 * else its first word ("`src/api/routes.ts`: everyone adds routes"). A folder
 * covers what is inside it. The template's example line is left out.
 */
export function readSharedFilesSection(markdown: string): ReadonlyArray<string> {
  return readSectionItems(markdown, SHARED_FILES_TITLE).flatMap((item) => {
    if (item === TEAM_RULEBOOK_SHARED_FILES_EXAMPLE) return [];
    const raw = /`([^`]+)`/u.exec(item)?.[1] ?? item.split(" ")[0]!.replace(/[:,;]+$/u, "");
    const path = normalizeTeamPath(raw);
    return path.length === 0 ? [] : [path];
  });
}

/** Whether `path` is a shared file, or inside a shared folder. */
export const isSharedPath = (path: string, shared: ReadonlyArray<string>) => {
  const file = normalizeTeamPath(path).toLowerCase();
  return shared.some((entry) => {
    const listed = normalizeTeamPath(entry).toLowerCase();
    return file === listed || file.startsWith(`${listed}/`);
  });
};

const readRulebook = <A>(
  input: { readonly teamRoot: string; readonly workingFolder: string },
  read: (markdown: string, rulebookPath: string) => ReadonlyArray<A>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rulebook = path.join(input.teamRoot, TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME);
    const info = yield* fs.stat(rulebook);
    if (info.type !== "File" || Number(info.size) > TEAM_DO_NOT_TOUCH_LIMITS.rulebookBytes) {
      return [];
    }
    const markdown = yield* fs.readFileString(rulebook);
    return read(markdown, path.relative(input.workingFolder, rulebook));
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<A> => []));

/** The caller's rulebook's list; empty when the file or the section is missing or unreadable. */
export const readDoNotTouch = (input: {
  readonly teamRoot: string;
  readonly workingFolder: string;
}) => readRulebook(input, readDoNotTouchSection);

/** The caller's rulebook's shared files; empty when the file or the section is missing or unreadable. */
export const readSharedFiles = (input: {
  readonly teamRoot: string;
  readonly workingFolder: string;
}) => readRulebook(input, (markdown) => readSharedFilesSection(markdown));
