/**
 * The team's checked-in files in a project repo: `.team/team.json`,
 * `.team/rulebook.md`, and the `defaultThreadEnvMode` field of `t3.json`.
 *
 * `initTeamProject` creates what is missing and never overwrites what is
 * there, so running it again is safe and keeps the same team. It never
 * commits; the user reviews and commits the files. Its optional `register`
 * step (the host's database, team/DESIGN.md M2.1) runs after every check and
 * before any write, so a refused or failed registration writes nothing.
 *
 * @module TeamProjectFiles
 */
import {
  T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_SCHEMA_URL,
  TEAM_DIRECTORY_NAME,
  TEAM_FILE_NAME,
  TEAM_RULEBOOK_FILE_NAME,
  TEAM_RULEBOOK_MAX_WORDS,
  TeamFile,
  TeamId,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export class TeamProjectNotInRepoError extends Schema.TaggedError<TeamProjectNotInRepoError>()(
  "TeamProjectNotInRepoError",
  { startDirectory: Schema.String },
) {
  override get message(): string {
    return `${this.startDirectory} is not inside a Git repository. A team is one Git repo; run this inside one.`;
  }
}

export class TeamProjectFileInvalidError extends Schema.TaggedError<TeamProjectFileInvalidError>()(
  "TeamProjectFileInvalidError",
  { filePath: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.filePath}: ${this.detail} Nothing was written.`;
  }
}

/** `initTeamProject`'s `register` step refused or failed; nothing was written. */
export class TeamProjectRegisterError extends Schema.TaggedError<TeamProjectRegisterError>()(
  "TeamProjectRegisterError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TeamProjectFileWriteError extends Schema.TaggedError<TeamProjectFileWriteError>()(
  "TeamProjectFileWriteError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.filePath}.`;
  }
}

export type TeamProjectFileStatus = "created" | "updated" | "unchanged";

export interface TeamProjectFileResult {
  /** Path relative to the repo root, with `/` separators. */
  readonly path: string;
  readonly status: TeamProjectFileStatus;
  readonly detail: string;
}

export interface TeamProjectInitResult {
  readonly repoRoot: string;
  readonly teamFile: TeamFile;
  readonly files: ReadonlyArray<TeamProjectFileResult>;
}

const decodeTeamFileJson = Schema.decodeExit(fromLenientJson(TeamFile));
const encodeTeamFileJson = Schema.encodeSync(fromJsonStringPretty(TeamFile));
const decodeLenientJson = Schema.decodeExit(fromLenientJson(Schema.Unknown));
const encodePrettyJson = Schema.encodeSync(fromJsonStringPretty(Schema.Unknown));

const WORKTREE_KEY = "defaultThreadEnvMode";
const WORKTREE_VALUE = "worktree";

/** The template's "Do not touch" example line; `team_status` leaves it out. */
export const TEAM_RULEBOOK_DO_NOT_TOUCH_EXAMPLE = "Files or folders that need a human first.";

export const TEAM_RULEBOOK_TEMPLATE = `# Project rulebook

Keep this file under ${TEAM_RULEBOOK_MAX_WORDS.toLocaleString("en-US")} words. Every agent on the team reads all of it before its first change, so cut anything that is not a rule.

## What this project is

One or two sentences.

## How we work

- Branches, commits and pull requests.
- Who reviews what.

## Code rules

- The rules a new teammate would get wrong.

## Do not touch

- ${TEAM_RULEBOOK_DO_NOT_TOUCH_EXAMPLE}

## Decisions

Write one short file per decision in \`.team/decisions/NNNN-short-title.md\`, starting with:

\`\`\`
---
title: Short title
author: Your name
date: YYYY-MM-DD
files: [src/a.ts, src/b/]
commit: output of git rev-parse HEAD
---
\`\`\`

Then say what was decided and why, in a few lines. Code always wins over these notes.
`;

type JsonObject = { readonly [key: string]: unknown };

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEquals(item, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
    );
  }
  return false;
};

export type WorktreeDefaultEdit =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Edited"; readonly contents: string; readonly previous: unknown }
  | { readonly _tag: "Invalid"; readonly detail: string };

/**
 * Sets `"defaultThreadEnvMode": "worktree"` in raw `t3.json` text (or new
 * text when there is no file), editing only that field so comments,
 * formatting and every other key stay as they were. The edit is re-parsed
 * and compared before it is accepted.
 */
export function setWorktreeDefault(raw: string | null): WorktreeDefaultEdit {
  if (raw === null) {
    return {
      _tag: "Edited",
      contents: `${encodePrettyJson({ $schema: T3_PROJECT_FILE_SCHEMA_URL, [WORKTREE_KEY]: WORKTREE_VALUE })}\n`,
      previous: undefined,
    };
  }
  const parsed = decodeLenientJson(raw);
  if (Exit.isFailure(parsed) || !isJsonObject(parsed.value)) {
    return { _tag: "Invalid", detail: "is not a JSON object, so it was not edited." };
  }
  const current = parsed.value;
  if (current[WORKTREE_KEY] === WORKTREE_VALUE) return { _tag: "Unchanged" };

  let contents: string;
  if (Object.hasOwn(current, WORKTREE_KEY)) {
    contents = raw.replace(
      /("defaultThreadEnvMode"\s*:\s*)("(?:[^"\\]|\\.)*"|null|true|false|-?\d[\d.eE+-]*)/u,
      `$1"${WORKTREE_VALUE}"`,
    );
  } else {
    const brace = raw.indexOf("{");
    const indent = /\{[^\S\n]*\n([^\S\n]+)\S/u.exec(raw)?.[1] ?? "  ";
    const separator = Object.keys(current).length > 0 ? "," : "\n";
    contents = `${raw.slice(0, brace + 1)}\n${indent}"${WORKTREE_KEY}": "${WORKTREE_VALUE}"${separator}${raw.slice(brace + 1)}`;
  }

  const reparsed = decodeLenientJson(contents);
  const expected = { ...current, [WORKTREE_KEY]: WORKTREE_VALUE };
  if (Exit.isFailure(reparsed) || !jsonEquals(reparsed.value, expected)) {
    return {
      _tag: "Invalid",
      detail: `could not be edited safely. Add "${WORKTREE_KEY}": "${WORKTREE_VALUE}" to it by hand.`,
    };
  }
  return { _tag: "Edited", contents, previous: current[WORKTREE_KEY] };
}

/** The nearest folder at or above `startDirectory` that holds `.git` (a folder, or a file in a worktree). */
export const findRepoRoot = Effect.fn("TeamProjectFiles.findRepoRoot")(function* (
  startDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.resolve(startDirectory);
  while (true) {
    if (
      yield* fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false))
    ) {
      return Option.some(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return Option.none<string>();
    directory = parent;
  }
});

const readOptionalFile = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.map((contents): string | null => contents),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new TeamProjectFileInvalidError({ filePath, detail: "could not be read." }),
            ),
      ),
    );
  });

/** Reads `.team/team.json` at a repo root. None when there is no file. */
export const readTeamFile = Effect.fn("TeamProjectFiles.readTeamFile")(function* (
  repoRoot: string,
) {
  const path = yield* Path.Path;
  const filePath = path.join(repoRoot, TEAM_DIRECTORY_NAME, TEAM_FILE_NAME);
  const raw = yield* readOptionalFile(filePath);
  if (raw === null) return Option.none<TeamFile>();
  const decoded = decodeTeamFileJson(raw);
  if (Exit.isFailure(decoded)) {
    return yield* new TeamProjectFileInvalidError({
      filePath,
      detail: 'is not a valid team file. It needs a "teamId" and a "name".',
    });
  }
  return Option.some(decoded.value);
});

/**
 * The team a working folder belongs to: `.team/team.json` in the folder, else
 * at the root of its Git repo. `teamRoot` is the folder that holds it.
 */
export const findTeamFile = Effect.fn("TeamProjectFiles.findTeamFile")(function* (
  workingFolder: string,
) {
  const here = yield* readTeamFile(workingFolder);
  if (Option.isSome(here)) return Option.some({ teamFile: here.value, teamRoot: workingFolder });
  const repoRoot = yield* findRepoRoot(workingFolder);
  if (Option.isNone(repoRoot) || repoRoot.value === workingFolder) return Option.none();
  const atRoot = yield* readTeamFile(repoRoot.value);
  return Option.map(atRoot, (teamFile) => ({ teamFile, teamRoot: repoRoot.value }));
});

/**
 * Creates the team's checked-in files in the repo that holds
 * `startDirectory`. Reads and checks everything first, then writes, so a
 * broken existing file stops the run before anything changes.
 */
export const initTeamProject = Effect.fn("TeamProjectFiles.initTeamProject")(function* (input: {
  readonly startDirectory: string;
  /** Used only when the team is created. Default: the repo folder name. */
  readonly name?: string | undefined;
  /**
   * Runs after every check and before any write. `created` is true when this
   * run makes `.team/team.json`, false when the repo already had one.
   */
  readonly register?: (input: {
    readonly repoRoot: string;
    readonly teamFile: TeamFile;
    readonly created: boolean;
  }) => Effect.Effect<void, TeamProjectRegisterError>;
}) {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const repoRoot = yield* findRepoRoot(input.startDirectory).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new TeamProjectNotInRepoError({ startDirectory: input.startDirectory })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const teamFilePath = path.join(repoRoot, TEAM_DIRECTORY_NAME, TEAM_FILE_NAME);
  const rulebookPath = path.join(repoRoot, TEAM_DIRECTORY_NAME, TEAM_RULEBOOK_FILE_NAME);
  const projectFilePath = path.join(repoRoot, T3_PROJECT_FILE_NAME);

  const existingTeam = yield* readTeamFile(repoRoot);
  const existingRulebook = yield* readOptionalFile(rulebookPath);
  const projectFileRaw = yield* readOptionalFile(projectFilePath);
  const worktreeEdit = setWorktreeDefault(projectFileRaw);
  if (worktreeEdit._tag === "Invalid") {
    return yield* new TeamProjectFileInvalidError({
      filePath: projectFilePath,
      detail: worktreeEdit.detail,
    });
  }

  const requestedName = input.name?.trim();
  const teamFile = Option.isSome(existingTeam)
    ? existingTeam.value
    : TeamFile.make({
        teamId: TeamId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        name: requestedName && requestedName.length > 0 ? requestedName : path.basename(repoRoot),
      });

  if (input.register) {
    yield* input.register({ repoRoot, teamFile, created: Option.isNone(existingTeam) });
  }

  const write = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.mapError((cause) => new TeamProjectFileWriteError({ filePath, cause })),
    );
  const files: Array<TeamProjectFileResult> = [];
  const teamRelative = `${TEAM_DIRECTORY_NAME}/${TEAM_FILE_NAME}`;
  const rulebookRelative = `${TEAM_DIRECTORY_NAME}/${TEAM_RULEBOOK_FILE_NAME}`;

  if (Option.isSome(existingTeam)) {
    const nameNote =
      requestedName && requestedName !== teamFile.name
        ? ` Kept the existing name "${teamFile.name}"; edit the file to rename.`
        : "";
    files.push({
      path: teamRelative,
      status: "unchanged",
      detail: `Team "${teamFile.name}" already exists (teamId ${teamFile.teamId}).${nameNote}`,
    });
  } else {
    yield* write(teamFilePath, `${encodeTeamFileJson(teamFile)}\n`);
    files.push({
      path: teamRelative,
      status: "created",
      detail: `New team "${teamFile.name}" (teamId ${teamFile.teamId}).`,
    });
  }

  if (existingRulebook === null) {
    yield* write(rulebookPath, TEAM_RULEBOOK_TEMPLATE);
    files.push({
      path: rulebookRelative,
      status: "created",
      detail: `Template with section headings. Keep it under ${TEAM_RULEBOOK_MAX_WORDS.toLocaleString("en-US")} words.`,
    });
  } else {
    files.push({ path: rulebookRelative, status: "unchanged", detail: "Already exists." });
  }

  if (worktreeEdit._tag === "Unchanged") {
    files.push({
      path: T3_PROJECT_FILE_NAME,
      status: "unchanged",
      detail: `Already sets "${WORKTREE_KEY}": "${WORKTREE_VALUE}".`,
    });
  } else {
    yield* write(projectFilePath, worktreeEdit.contents);
    files.push({
      path: T3_PROJECT_FILE_NAME,
      status: projectFileRaw === null ? "created" : "updated",
      detail:
        worktreeEdit.previous === undefined
          ? `Set "${WORKTREE_KEY}": "${WORKTREE_VALUE}" so each thread gets its own worktree.`
          : `Changed "${WORKTREE_KEY}" from ${encodePrettyJson(worktreeEdit.previous)} to "${WORKTREE_VALUE}".`,
    });
  }

  return { repoRoot, teamFile, files } satisfies TeamProjectInitResult;
});
