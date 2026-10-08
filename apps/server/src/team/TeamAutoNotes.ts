/**
 * Automatic notes (fork-only, see team/DESIGN.md D7). Agents do not always
 * write a handoff, so after every turn whose diff is ready, the team layer
 * saves an automatic note for the thread: the files it changed and their
 * content hashes, so `team_memory_search` can still say who changed what and
 * whether that work reached the caller's copy.
 *
 * One note per thread, updated in place (`TeamService.saveAutomaticNote`).
 * It writes no activity line, and it is not the agent's handoff: no word cap,
 * and search ranks it below handoffs and decisions.
 *
 * Only `status: "ready"` diffs count: mid-turn placeholders have no files
 * (D6). In local mode a turn's diff also holds edits made by people or other
 * threads in the same checkout, so the note can name files this thread did
 * not write.
 *
 * @module TeamAutoNotes
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { currentCommit, hashFiles } from "../mcp/toolkits/team/memory.ts";
import { makeTeamResolver } from "../mcp/toolkits/team/resolve.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { findRepoRoot } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

/** Turn diff paths are relative to the Git repo root; team paths to the folder holding `.team/`. */
export const diffToTeamPaths = (
  path: Path.Path,
  files: ReadonlyArray<string>,
  repoRoot: string,
  teamRoot: string,
) =>
  files.flatMap((file) => {
    const relative = path.relative(teamRoot, path.join(repoRoot, file)).replaceAll("\\", "/");
    const outside =
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative);
    return outside ? [] : [relative];
  });

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  // Subscribe now, so no event published before activation is missed.
  const events = yield* engine.subscribeDomainEvents;

  const toTeamPaths = (files: ReadonlyArray<string>, repoRoot: string, teamRoot: string) =>
    diffToTeamPaths(path, files, repoRoot, teamRoot);

  const save = (threadId: ThreadId, turnFiles: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const resolved = yield* resolve({ environmentId, threadId });
      if (resolved._tag === "NotInTeam") return;
      const { teamFile, member, thread, teamRoot, workingFolder } = resolved.context;
      const repoRoot = Option.getOrElse(yield* findRepoRoot(workingFolder), () => workingFolder);
      const files = toTeamPaths(turnFiles, repoRoot, teamRoot);
      if (files.length === 0) return;
      // Stored, so a later freshness check can count the lines changed since.
      const hashes = yield* hashFiles(git, teamRoot, files, { store: true });
      const task = yield* teams.findTaskForThread(teamFile.teamId, thread);
      yield* teams.saveAutomaticNote({
        teamId: teamFile.teamId,
        memberId: member.memberId,
        thread,
        taskId: Option.getOrUndefined(Option.map(task, (value) => value.taskId)),
        files,
        commit: (yield* currentCommit(git, workingFolder)) ?? undefined,
        fileHashes: Object.fromEntries(hashes),
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Team automatic note skipped.", { threadId, cause }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("Team automatic note skipped.", { threadId, defect }),
      ),
    );

  const onEvent = (event: OrchestrationEvent) =>
    event.type === "thread.turn-diff-completed" &&
    event.payload.status === "ready" &&
    event.payload.files.length > 0
      ? save(
          event.payload.threadId,
          event.payload.files.map((file) => file.path),
        )
      : Effect.void;

  yield* forkParked(Stream.runForEach(events, onEvent));
});

export const TeamAutoNotesLive = Layer.effectDiscard(make);
