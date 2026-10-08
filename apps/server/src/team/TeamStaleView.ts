/**
 * The stale-view line (fork-only, team/VISION.md 3.6 point 3): at the start of
 * each turn, the agent is told which files it touched or planned changed
 * since its last turn, by whom, and whether that change is in its copy, so it
 * re-reads them instead of editing from memory.
 *
 * - Its view is the files' state at the end of its last turn: that turn's
 *   checkpoint ref (a commit of the whole working tree).
 * - A file whose content here differs from that is named, with who changed
 *   it: the other thread whose note (automatic or handoff) holds exactly this
 *   content, else whoever else holds the file, else "outside this chat".
 * - A file unchanged here that a teammate's note, written since that turn,
 *   holds in another version not in this copy's history is named as "not
 *   merged into your copy".
 *
 * Each change is told once: the next turn's view includes it. Solo and team
 * alike: solo chats share the checkout by default, so another chat's edit
 * lands under this one. The line goes with the turn's message (teamTurnNote),
 * only when something changed.
 *
 * @module TeamStaleView
 */
import { type TeamHandoff, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { hashFiles, inHistory } from "../mcp/toolkits/team/memory.ts";
import { makeTeamResolver, type TeamContext } from "../mcp/toolkits/team/resolve.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { holdersOf, sameThread } from "./heldElsewhere.ts";
import { diffToTeamPaths } from "./TeamAutoNotes.ts";
import { findRepoRoot } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";
import { installTeamTurnNote } from "./teamTurnNote.ts";

/** A slow lookup leaves the line out for this turn; it is not in the cached prefix. */
const STALE_VIEW_TIMEOUT = "2 seconds";
/** Files named in the line; the rest are counted. */
export const STALE_VIEW_MAX_FILES = 5;
/** Files compared per turn, so a long thread stays cheap. */
const STALE_VIEW_MAX_CHECKED = 200;

export interface StaleFile {
  readonly path: string;
  /** Who changed it: teammates' names or "another chat"; empty when nobody is known. */
  readonly by: ReadonlyArray<string>;
  /** The change is in this thread's copy, or only in someone else's. */
  readonly inCopy: boolean;
}

const names = (by: ReadonlyArray<string>) =>
  by.length <= 1 ? (by[0] ?? "") : `${by.slice(0, -1).join(", ")} and ${by.at(-1)}`;

/** The line, or `undefined` when nothing changed. */
export const renderStaleView = (files: ReadonlyArray<StaleFile>) => {
  if (files.length === 0) return undefined;
  const shown = files.slice(0, STALE_VIEW_MAX_FILES).map((file) => {
    const who = file.by.length === 0 ? "outside this chat" : `by ${names(file.by)}`;
    return `\`${file.path}\` (${who}, ${file.inCopy ? "in your copy" : "not merged into your copy"})`;
  });
  const more =
    files.length > STALE_VIEW_MAX_FILES ? ` and ${files.length - STALE_VIEW_MAX_FILES} more` : "";
  const after = [
    files.some((file) => file.inCopy) ? "Re-read them before editing them." : undefined,
    files.some((file) => !file.inCopy) ? "Unmerged changes may conflict with yours." : undefined,
  ].filter((sentence) => sentence !== undefined);
  return `<team_changes>Changed since your last turn: ${shown.join("; ")}${more}. ${after.join(" ")}</team_changes>`;
};

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  /** Blob hash of each repo path in the commit `ref`; a path missing there is absent. */
  const hashesAt = (repoRoot: string, ref: string, repoPaths: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "TeamStaleView.lastTurn",
        cwd: repoRoot,
        args: [
          "ls-tree",
          "--full-tree",
          "-z",
          ref,
          "--",
          ...repoPaths.map((file) => `:(literal)${file}`),
        ],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => {
          const hashes = new Map<string, string>();
          if (result.exitCode !== 0) return undefined;
          for (const entry of result.stdout.split("\0")) {
            const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/u.exec(entry);
            if (match !== null) hashes.set(match[2]!, match[1]!);
          }
          return hashes;
        }),
      );

  const staleFiles = (context: TeamContext) =>
    Effect.gen(function* () {
      const threadId = context.thread.threadId;
      const checkpoints = Option.getOrUndefined(
        yield* snapshots.getThreadCheckpointContext(threadId),
      );
      // Its last turn's checkpoint: the newest ready one.
      const last = checkpoints?.checkpoints
        .filter((checkpoint) => checkpoint.status === "ready")
        .toSorted((a, b) => b.checkpointTurnCount - a.checkpointTurnCount)[0];
      // The first turn has no earlier view.
      if (checkpoints === undefined || last === undefined) return [];
      const cwd = checkpoints.worktreePath ?? checkpoints.workspaceRoot;
      const repoRoot = Option.getOrElse(yield* withFiles(findRepoRoot(cwd)), () => cwd);
      const teamId = context.teamFile.teamId;
      const [claims, members, notes] = yield* Effect.all([
        teams.listActiveClaims(teamId),
        teams.listMembers(teamId),
        teams.listHandoffs(teamId),
      ]);
      const touched = diffToTeamPaths(
        path,
        checkpoints.checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
        repoRoot,
        context.teamRoot,
      );
      const planned = claims
        .filter((claim) => sameThread(claim.thread, context.thread))
        .flatMap((claim) => claim.paths.filter((held) => !held.endsWith("/")));
      const files = [...new Set([...touched, ...planned])].slice(0, STALE_VIEW_MAX_CHECKED);
      if (files.length === 0) return [];

      const toRepo = (file: string) =>
        path.relative(repoRoot, path.join(context.teamRoot, file)).replaceAll("\\", "/");
      const before = yield* hashesAt(repoRoot, last.checkpointRef, files.map(toRepo));
      if (before === undefined) return [];
      const now = yield* withFiles(hashFiles(git, context.teamRoot, files));

      const viewer = { memberId: context.member.memberId, solo: context.solo };
      const memberNames = new Map(members.map((member) => [member.memberId, member.displayName]));
      const who = (note: Pick<TeamHandoff, "memberId">) =>
        !context.solo && note.memberId !== context.member.memberId
          ? (memberNames.get(note.memberId) ?? note.memberId)
          : "another chat";
      const others = notes.filter((note) => !sameThread(note.thread, context.thread));
      const otherClaims = claims.filter((claim) => !sameThread(claim.thread, context.thread));
      const since = Date.parse(last.completedAt);

      const stale: Array<StaleFile> = [];
      for (const file of files) {
        const then = before.get(toRepo(file)) ?? null;
        const current = now.get(file) ?? null;
        const noted = others.filter((note) => note.fileHashes?.[file] !== undefined);
        if (then !== current) {
          const authors = noted.filter((note) => note.fileHashes?.[file] === current).map(who);
          const by =
            authors.length > 0
              ? authors
              : holdersOf(file, otherClaims, viewer, memberNames).map((holder) =>
                  holder.kind === "member" ? holder.name : "another chat",
                );
          stale.push({ path: file, by: [...new Set(by)], inCopy: true });
          continue;
        }
        const newer = noted.filter((note) => {
          const theirs = note.fileHashes?.[file];
          return (
            Date.parse(note.createdAt) > since && typeof theirs === "string" && theirs !== current
          );
        });
        const unmerged: Array<string> = [];
        for (const note of newer) {
          const merged = yield* inHistory(git, context.teamRoot, file, note.fileHashes![file]!);
          if (merged === false) unmerged.push(who(note));
        }
        if (unmerged.length > 0)
          stale.push({ path: file, by: [...new Set(unmerged)], inCopy: false });
      }
      return stale;
    });

  const read = (threadId: ThreadId): Effect.Effect<string | undefined> =>
    resolve({ environmentId, threadId }).pipe(
      Effect.flatMap((resolved) =>
        resolved._tag === "InTeam" ? staleFiles(resolved.context) : Effect.succeed([]),
      ),
      Effect.map(renderStaleView),
      Effect.timeoutOption(STALE_VIEW_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.tap((line) =>
        line === undefined
          ? Effect.void
          : Effect.logInfo("Team stale-view line added.", { threadId, line }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Team stale-view line skipped.", { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  return { read };
});

export const TeamStaleViewLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { read } = yield* make;
    const uninstall = installTeamTurnNote(read);
    yield* Effect.addFinalizer(() => Effect.sync(uninstall));
  }),
);
