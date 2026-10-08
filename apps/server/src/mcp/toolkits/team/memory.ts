/**
 * `team_memory_search` (team/DESIGN.md D5, D7): keyword search over handoff
 * notes (written and automatic) and `.team/decisions/*.md`, with a freshness
 * mark and its reason per result, checked in the caller's own checkout.
 * Every check that fails says "unknown"; nothing here fails the search.
 */
import {
  TEAM_DECISIONS_DIRECTORY_NAME,
  TEAM_DIRECTORY_NAME,
  type TeamHandoff,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { diffLines } from "diff";

import type * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

export const TEAM_MEMORY_LIMITS = {
  results: 5,
  /** Newest handoffs searched; older ones are not looked at. */
  handoffs: 200,
  decisions: 200,
  decisionBytes: 32_000,
  saysWords: 40,
  filesInMark: 3,
  /** Larger files get no line counts in a freshness reason. */
  lineCountBytes: 256_000,
  gitTimeoutMs: 5_000,
};

/**
 * Freshness marks (D7). Every mark but "fresh" says why in plain words, so
 * an agent does not have to guess what changed.
 */
export const FRESHNESS = {
  fresh: "fresh",
  maybeOutdated: (why: string) => `maybe outdated: ${why}`,
  notMerged: (why: string) => `not merged yet: ${why}`,
  unknown: (why: string) => `unknown: ${why}`,
} as const;

export const UNKNOWN_WHY = {
  noFiles: "the note names no files to check",
  notGit: "your folder is not a Git checkout",
  nothingStored: "no commit or file contents were stored to compare with",
  checkFailed: "the Git check failed or took too long",
} as const;

/** How one file differs from what a note saw: line counts when Git still has the old content. */
export type FileChange =
  | { readonly file: string; readonly change: "edited"; readonly lines: LineCounts | null }
  | { readonly file: string; readonly change: "deleted" | "created" };

interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

const linesLabel = (lines: LineCounts) => `+${lines.added} -${lines.removed} lines`;

/** "content of src/a.ts changed since this note was written (+1 -0 lines)", and the like. */
export const describeChanges = (changes: ReadonlyArray<FileChange>, since: string) => {
  const [only] = changes;
  if (changes.length === 1 && only !== undefined) {
    if (only.change !== "edited") {
      return `${only.file} ${only.change === "deleted" ? "was deleted" : "is new"} ${since}`;
    }
    const counts = only.lines === null ? "" : ` (${linesLabel(only.lines)})`;
    return `content of ${only.file} changed ${since}${counts}`;
  }
  const shown = changes.slice(0, TEAM_MEMORY_LIMITS.filesInMark).map((item) => {
    if (item.change !== "edited") {
      return `${item.file} (${item.change === "deleted" ? "deleted" : "new"})`;
    }
    return item.lines === null ? item.file : `${item.file} (${linesLabel(item.lines)})`;
  });
  const more = changes.length - shown.length;
  return `content of ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""} changed ${since}`;
};

const NOTE_SINCE = "since this note was written";
const shortCommit = (commit: string) => commit.slice(0, 7);

/** One handoff note or decision file, ready to match and check. */
export interface MemoryEntry {
  /** Automatic notes are saved after each turn; they rank below handoffs and decisions. */
  readonly kind: "handoff" | "automatic note" | "decision";
  readonly says: string;
  readonly who: string;
  /** ISO time used for "newest first"; null when a decision has no date. */
  readonly when: string | null;
  readonly whenLabel: string;
  readonly files: ReadonlyArray<string>;
  readonly commit: string | null;
  readonly fileHashes: Readonly<Record<string, string | null>> | null;
  /** All text the keywords are matched against. */
  readonly searchText: string;
  /** Decisions: the file, relative to the folder holding `.team/`. */
  readonly source?: string;
  readonly handoff?: TeamHandoff;
}

const firstWords = (text: string, max: number) => {
  const words = text.trim().split(/\s+/u);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
};

const STOP_WORDS = new Set(
  "a an and are as at be by did do does for from how i in is it its me my of on or our so the this that to was we were what when where which who why with you".split(
    " ",
  ),
);

/** Lowercase keywords from a query: words and paths, without stop words. */
export const queryTerms = (query: string): ReadonlyArray<string> => [
  ...new Set(
    query
      .toLowerCase()
      .split(/[\s,;"'`()[\]{}<>]+/u)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((word) => word.length >= 2 && !STOP_WORDS.has(word)),
  ),
];

const automaticLast = (entry: MemoryEntry) => (entry.kind === "automatic note" ? 1 : 0);

/**
 * Entries that match at least one term. Handoffs and decisions come before
 * automatic notes; then most distinct terms matched first, then newest first
 * (undated decisions last). Simple substring matching; a smarter search can
 * replace this later (DESIGN.md D5).
 */
export const rankMemory = (
  entries: ReadonlyArray<MemoryEntry>,
  terms: ReadonlyArray<string>,
): { readonly top: ReadonlyArray<MemoryEntry>; readonly matched: number } => {
  const scored = entries
    .map((entry) => {
      const text = entry.searchText.toLowerCase();
      return { entry, score: terms.filter((term) => text.includes(term)).length };
    })
    .filter(({ score }) => score > 0)
    .toSorted(
      (left, right) =>
        automaticLast(left.entry) - automaticLast(right.entry) ||
        right.score - left.score ||
        (right.entry.when ?? "").localeCompare(left.entry.when ?? ""),
    );
  return {
    top: scored.slice(0, TEAM_MEMORY_LIMITS.results).map(({ entry }) => entry),
    matched: scored.length,
  };
};

const timeLabel = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** "Sara, 2026-10-07 14:03 UTC: first line of what changed", for `team_status`. */
export const handoffHeadline = (handoff: TeamHandoff, who: string, maxWords: number) =>
  `${who}, ${timeLabel(handoff.createdAt)}: ${firstWords(handoff.changed.split(/\r?\n/u)[0]!, maxWords)}`;

/** Agents look for notes by their name first, so a written note also matches these words. */
const HANDOFF_WORDS = "handoff handoffs";

export const handoffEntry = (handoff: TeamHandoff, who: string): MemoryEntry => {
  const text = [
    handoff.changed,
    handoff.left === null ? "" : `Left: ${handoff.left}`,
    handoff.risks === null ? "" : `Risks: ${handoff.risks}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    kind: handoff.automatic ? "automatic note" : "handoff",
    says: firstWords(text, TEAM_MEMORY_LIMITS.saysWords),
    who,
    when: handoff.createdAt,
    whenLabel: timeLabel(handoff.createdAt),
    files: handoff.files,
    commit: handoff.commit,
    fileHashes: handoff.fileHashes,
    searchText: [text, who, ...handoff.files, ...(handoff.automatic ? [] : [HANDOFF_WORDS])].join(
      "\n",
    ),
    handoff,
  };
};

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/u, "$2");

/** Project-relative `/` paths; anything that climbs out is dropped. */
const decisionPaths = (values: ReadonlyArray<string>) => [
  ...new Set(
    values
      .map((value) =>
        unquote(value)
          .replaceAll("\\", "/")
          .replace(/^(\.\/|\/)+/u, ""),
      )
      .filter((value) => value.length > 0 && !value.split("/").includes("..")),
  ),
];

/**
 * Reads a decision file. Front matter is optional; the rulebook template
 * asks for `title`, `author`, `date`, `files` (`[a, b]` or a `- ` list) and
 * `commit`.
 */
export const parseDecision = (source: string, raw: string): MemoryEntry => {
  const fields = new Map<string, string>();
  const lists = new Map<string, Array<string>>();
  let body = raw.replace(/^﻿/u, "");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(body);
  if (frontMatter !== null) {
    body = body.slice(frontMatter[0].length);
    let listKey: string | null = null;
    for (const line of frontMatter[1]!.split(/\r?\n/u)) {
      const item = /^\s*-\s+(.*)$/u.exec(line);
      if (item !== null && listKey !== null) {
        lists.get(listKey)!.push(item[1]!);
        continue;
      }
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
      if (pair === null) continue;
      const key = pair[1]!.toLowerCase();
      const value = pair[2]!.trim();
      listKey = value.length === 0 ? key : null;
      if (value.length === 0) lists.set(key, []);
      else if (value.startsWith("[") && value.endsWith("]")) {
        lists.set(key, value.slice(1, -1).split(","));
      } else fields.set(key, unquote(value));
    }
  }
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
  const fileTitle = (source.split("/").at(-1) ?? source)
    .replace(/\.md$/iu, "")
    .replace(/^\d+[-_ ]*/u, "")
    .replaceAll(/[-_]+/gu, " ");
  const title = fields.get("title") ?? heading ?? fileTitle;
  const firstParagraph =
    body
      .split(/\r?\n\s*\r?\n/u)
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !part.startsWith("#")) ?? "";
  const date = fields.get("date");
  const parsed = date === undefined ? Option.none() : DateTime.make(date);
  const files = decisionPaths(
    lists.get("files") ?? (fields.has("files") ? [fields.get("files")!] : []),
  );
  const who = fields.get("author") ?? "unknown";
  return {
    kind: "decision",
    says: firstWords(
      firstParagraph.length > 0 ? `${title}: ${firstParagraph}` : title,
      TEAM_MEMORY_LIMITS.saysWords,
    ),
    who,
    when: Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null,
    whenLabel: Option.isSome(parsed) ? date! : "unknown",
    files,
    commit: fields.get("commit") || null,
    fileHashes: null,
    searchText: [title, body, who, ...files].join("\n"),
    source,
  };
};

/** `.team/decisions/*.md` under `teamRoot`, by file name. A missing folder or an unreadable file is skipped. */
export const readDecisions = (teamRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(teamRoot, TEAM_DIRECTORY_NAME, TEAM_DECISIONS_DIRECTORY_NAME);
    const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    const files = names
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .toSorted()
      .slice(0, TEAM_MEMORY_LIMITS.decisions);
    const read = yield* Effect.forEach(files, (name) =>
      Effect.gen(function* () {
        const filePath = path.join(folder, name);
        const info = yield* fs.stat(filePath);
        if (info.type !== "File" || Number(info.size) > TEAM_MEMORY_LIMITS.decisionBytes) {
          return null;
        }
        const raw = yield* fs.readFileString(filePath);
        return parseDecision(
          `${TEAM_DIRECTORY_NAME}/${TEAM_DECISIONS_DIRECTORY_NAME}/${name}`,
          raw,
        );
      }).pipe(Effect.orElseSucceed(() => null)),
    );
    return read.filter((entry) => entry !== null);
  });

type Git = GitVcsDriver.GitVcsDriver["Service"];

const runGit = (git: Git, cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
  git.execute({
    operation: "TeamMemory.freshness",
    cwd,
    args,
    ...(stdin === undefined ? {} : { stdin }),
    allowNonZeroExit: true,
    timeoutMs: TEAM_MEMORY_LIMITS.gitTimeoutMs,
  });

const literal = (file: string) => `:(literal)${file}`;

/** `HEAD` of the working folder, or null outside Git or before the first commit. */
export const currentCommit = (git: Git, cwd: string) =>
  git
    .execute({
      operation: "TeamToolkit.currentCommit",
      cwd,
      args: ["rev-parse", "HEAD"],
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.map((result) => {
        const sha = result.stdout.trim();
        return result.exitCode === 0 && sha.length > 0 ? sha : null;
      }),
      // No Git, or no commit yet: the note is still worth saving.
      Effect.orElseSucceed(() => null),
    );

/**
 * Git blob hash of each file under `root`: null for a missing file. Folders,
 * and files Git could not hash, are left out. With `store`, Git also keeps
 * the content (an unreferenced object, pruned by `git gc` after a while), so
 * a later freshness check can count the lines that changed since.
 */
export const hashFiles = (
  git: Git,
  root: string,
  files: ReadonlyArray<string>,
  options?: { readonly store?: boolean },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hashes = new Map<string, string | null>();
    const existing: Array<string> = [];
    for (const file of files) {
      const info = yield* fs.stat(path.join(root, file)).pipe(Effect.option);
      if (info._tag === "None") hashes.set(file, null);
      else if (info.value.type === "File") existing.push(file);
    }
    if (existing.length > 0) {
      const result = yield* runGit(
        git,
        root,
        ["hash-object", ...(options?.store === true ? ["-w"] : []), "--stdin-paths"],
        // Full paths: Git reads stdin paths from the repo root, not from `root`.
        `${existing.map((file) => path.join(root, file)).join("\n")}\n`,
      ).pipe(Effect.option);
      const lines =
        result._tag === "Some" && result.value.exitCode === 0
          ? result.value.stdout.trim().split("\n")
          : [];
      if (lines.length === existing.length) {
        existing.forEach((file, index) => hashes.set(file, lines[index]!.trim()));
      }
    }
    return hashes;
  });

/** Whether `content` was ever at `file` in this copy's history: true, false, or null if Git cannot tell. */
export const inHistory = (git: Git, root: string, file: string, content: string) =>
  runGit(git, root, [
    "log",
    "-1",
    "--format=%H",
    `--find-object=${content}`,
    "HEAD",
    "--",
    literal(file),
  ]).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim().length > 0 : null)),
    Effect.orElseSucceed(() => null),
  );

const countLines = (before: string, after: string): LineCounts => {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
  }
  return { added, removed };
};

/**
 * Lines added and removed in `file` since the note saw `noted`, or null when
 * Git no longer has that content, or either side is large or binary.
 */
const linesSince = (git: Git, root: string, file: string, noted: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tooBig = (bytes: number) => bytes > TEAM_MEMORY_LIMITS.lineCountBytes;
    const size = yield* runGit(git, root, ["cat-file", "-s", noted]);
    if (size.exitCode !== 0 || tooBig(Number(size.stdout.trim()))) return null;
    const filePath = path.join(root, file);
    if (tooBig(Number((yield* fs.stat(filePath)).size))) return null;
    const before = yield* runGit(git, root, ["cat-file", "blob", noted]);
    if (before.exitCode !== 0) return null;
    const after = yield* fs.readFileString(filePath);
    if (before.stdout.includes("\0") || after.includes("\0")) return null;
    return countLines(before.stdout, after);
  }).pipe(Effect.orElseSucceed(() => null));

/** Commit-only check (decisions, and notes from before file hashes): D7 as first written. */
const sinceCommit = (git: Git, root: string, commit: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ancestor = yield* runGit(git, root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    if (ancestor.exitCode === 1) {
      return FRESHNESS.notMerged(
        `commit ${shortCommit(commit)}, which this was written at, is not in your copy's history`,
      );
    }
    if (ancestor.exitCode !== 0) {
      // A commit this repo has never seen is not merged here; anything else is unknown.
      const head = yield* runGit(git, root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      const known = yield* runGit(git, root, ["cat-file", "-e", `${commit}^{commit}`]);
      return head.exitCode === 0 && known.exitCode !== 0
        ? FRESHNESS.notMerged(
            `this repo does not have commit ${shortCommit(commit)}, which this was written at`,
          )
        : FRESHNESS.unknown(UNKNOWN_WHY.checkFailed);
    }
    const diff = yield* runGit(git, root, [
      "diff",
      "--numstat",
      "--no-renames",
      "--relative",
      commit,
      "--",
      ...files.map(literal),
    ]);
    if (diff.exitCode !== 0) return FRESHNESS.unknown(UNKNOWN_WHY.checkFailed);
    const changes = diff.stdout
      .split("\n")
      .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map(([, added, removed, file]): FileChange => ({
        file: file!,
        change: "edited",
        lines:
          added === "-" || removed === "-"
            ? null
            : { added: Number(added), removed: Number(removed) },
      }));
    return changes.length === 0
      ? FRESHNESS.fresh
      : FRESHNESS.maybeOutdated(
          describeChanges(changes, `since commit ${shortCommit(commit)}, when this was written`),
        );
  });

/**
 * The freshness mark for one entry, with why, checked in `root` (the
 * caller's folder holding `.team/`). With file hashes: same content → fresh;
 * changed, and the note's content is in this copy (same checkout, or in its
 * history) → maybe outdated; changed, and it never reached this copy → not
 * merged yet. `sameCheckout` says the note was written in the caller's own
 * checkout.
 */
export const checkFreshness = (
  git: Git,
  root: string,
  entry: Pick<MemoryEntry, "files" | "commit" | "fileHashes">,
  sameCheckout: boolean,
) =>
  Effect.gen(function* () {
    if (entry.files.length === 0) return FRESHNESS.unknown(UNKNOWN_WHY.noFiles);
    const inside = yield* runGit(git, root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return FRESHNESS.unknown(UNKNOWN_WHY.notGit);
    }
    const noted = entry.fileHashes ?? {};
    const hashed = entry.files.filter((file) => Object.hasOwn(noted, file));
    const current = hashed.length === 0 ? new Map() : yield* hashFiles(git, root, hashed);
    const compared = hashed.filter((file) => current.has(file));
    if (compared.length === 0) {
      return entry.commit === null
        ? FRESHNESS.unknown(UNKNOWN_WHY.nothingStored)
        : yield* sinceCommit(git, root, entry.commit, entry.files);
    }
    const changed = compared.filter((file) => current.get(file) !== noted[file]);
    if (changed.length === 0) return FRESHNESS.fresh;
    if (!sameCheckout) {
      for (const file of changed) {
        const content = noted[file];
        // A file missing when the note was written: Git cannot say whether that reached this copy.
        if (content === null || content === undefined) continue;
        if ((yield* inHistory(git, root, file, content)) === false) {
          return FRESHNESS.notMerged(
            `this note's version of ${file} is not in your copy's history (another chat's uncommitted or unmerged work)`,
          );
        }
      }
    }
    const changes = yield* Effect.forEach(
      changed,
      (file, index): Effect.Effect<FileChange, never, FileSystem.FileSystem | Path.Path> => {
        const before = noted[file] ?? null;
        if (before === null) return Effect.succeed({ file, change: "created" });
        if (current.get(file) === null) return Effect.succeed({ file, change: "deleted" });
        // Only the files the reason names get line counts.
        if (index >= TEAM_MEMORY_LIMITS.filesInMark) {
          return Effect.succeed({ file, change: "edited", lines: null });
        }
        return linesSince(git, root, file, before).pipe(
          Effect.map((lines) => ({ file, change: "edited", lines })),
        );
      },
    );
    return FRESHNESS.maybeOutdated(describeChanges(changes, NOTE_SINCE));
  }).pipe(Effect.catchCause(() => Effect.succeed(FRESHNESS.unknown(UNKNOWN_WHY.checkFailed))));
