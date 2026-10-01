/**
 * `team_memory_search` (team/DESIGN.md D5, D7): keyword search over handoff
 * notes and `.team/decisions/*.md`, with a freshness mark per result that is
 * checked in the caller's own checkout. Every check that fails says
 * "unknown"; nothing here fails the search.
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

import type * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

export const TEAM_MEMORY_LIMITS = {
  results: 5,
  /** Newest handoffs searched; older ones are not looked at. */
  handoffs: 200,
  decisions: 200,
  decisionBytes: 32_000,
  saysWords: 40,
  filesInMark: 3,
  gitTimeoutMs: 5_000,
};

export const FRESHNESS = {
  fresh: "fresh",
  notMerged: "not merged yet",
  unknown: "unknown",
  maybeOutdated: (files: ReadonlyArray<string>) =>
    `maybe outdated: ${listCapped(files, TEAM_MEMORY_LIMITS.filesInMark)} changed since`,
} as const;

/** One handoff note or decision file, ready to match and check. */
export interface MemoryEntry {
  readonly kind: "handoff" | "decision";
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

const listCapped = (items: ReadonlyArray<string>, max: number) =>
  items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} +${items.length - max} more`;

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

/**
 * Entries that match at least one term: most distinct terms matched first,
 * then newest first (undated decisions last). Simple substring matching; a
 * smarter search can replace this later (DESIGN.md D5).
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
        right.score - left.score || (right.entry.when ?? "").localeCompare(left.entry.when ?? ""),
    );
  return {
    top: scored.slice(0, TEAM_MEMORY_LIMITS.results).map(({ entry }) => entry),
    matched: scored.length,
  };
};

const timeLabel = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export const handoffEntry = (handoff: TeamHandoff, who: string): MemoryEntry => {
  const text = [
    handoff.changed,
    handoff.left === null ? "" : `Left: ${handoff.left}`,
    handoff.risks === null ? "" : `Risks: ${handoff.risks}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    kind: "handoff",
    says: firstWords(text, TEAM_MEMORY_LIMITS.saysWords),
    who,
    when: handoff.createdAt,
    whenLabel: timeLabel(handoff.createdAt),
    files: handoff.files,
    commit: handoff.commit,
    fileHashes: handoff.fileHashes,
    searchText: [text, who, ...handoff.files].join("\n"),
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

/**
 * Git blob hash of each file under `root`: null for a missing file. Folders,
 * and files Git could not hash, are left out.
 */
export const hashFiles = (git: Git, root: string, files: ReadonlyArray<string>) =>
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
        ["hash-object", "--stdin-paths"],
        `${existing.join("\n")}\n`,
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
const inHistory = (git: Git, root: string, file: string, content: string) =>
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

/** Commit-only check (decisions, and notes from before file hashes): D7 as first written. */
const sinceCommit = (git: Git, root: string, commit: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ancestor = yield* runGit(git, root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    if (ancestor.exitCode === 1) return FRESHNESS.notMerged;
    if (ancestor.exitCode !== 0) {
      // A commit this repo has never seen is not merged here; anything else is unknown.
      const head = yield* runGit(git, root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      const known = yield* runGit(git, root, ["cat-file", "-e", `${commit}^{commit}`]);
      return head.exitCode === 0 && known.exitCode !== 0 ? FRESHNESS.notMerged : FRESHNESS.unknown;
    }
    const diff = yield* runGit(git, root, [
      "diff",
      "--name-only",
      "--relative",
      commit,
      "--",
      ...files.map(literal),
    ]);
    if (diff.exitCode !== 0) return FRESHNESS.unknown;
    const changed = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return changed.length === 0 ? FRESHNESS.fresh : FRESHNESS.maybeOutdated(changed);
  });

/**
 * The freshness mark for one entry, checked in `root` (the caller's folder
 * holding `.team/`). With file hashes: same content → fresh; changed, and the
 * note's content is in this copy (same checkout, or in its history) → maybe
 * outdated; changed, and it never reached this copy → not merged yet.
 * `sameCheckout` says the note was written in the caller's own checkout.
 */
export const checkFreshness = (
  git: Git,
  root: string,
  entry: Pick<MemoryEntry, "files" | "commit" | "fileHashes">,
  sameCheckout: boolean,
) =>
  Effect.gen(function* () {
    if (entry.files.length === 0) return FRESHNESS.unknown;
    const inside = yield* runGit(git, root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return FRESHNESS.unknown;
    const noted = entry.fileHashes ?? {};
    const hashed = entry.files.filter((file) => Object.hasOwn(noted, file));
    const current = hashed.length === 0 ? new Map() : yield* hashFiles(git, root, hashed);
    const compared = hashed.filter((file) => current.has(file));
    if (compared.length === 0) {
      return entry.commit === null
        ? FRESHNESS.unknown
        : yield* sinceCommit(git, root, entry.commit, entry.files);
    }
    const changed = compared.filter((file) => current.get(file) !== noted[file]);
    if (changed.length === 0) return FRESHNESS.fresh;
    if (sameCheckout) return FRESHNESS.maybeOutdated(changed);
    for (const file of changed) {
      const content = noted[file];
      // A file missing when the note was written: Git cannot say whether that reached this copy.
      if (content === null || content === undefined) continue;
      if ((yield* inHistory(git, root, file, content)) === false) return FRESHNESS.notMerged;
    }
    return FRESHNESS.maybeOutdated(changed);
  }).pipe(Effect.catchCause(() => Effect.succeed(FRESHNESS.unknown)));
