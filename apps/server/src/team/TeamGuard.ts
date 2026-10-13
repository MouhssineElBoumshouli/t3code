/**
 * The guard (fork-only, team/PREVENTION_PLAN.md section 3, slice 3b): the
 * pause in the middle, when an agent goes to change a file someone else holds
 * that its chat did not plan or claim.
 *
 * - Before the write, where a provider lets T3 see it: Claude's PreToolUse
 *   hook and Antigravity's client writes call {@link checkTeamEdit}. The write
 *   is refused with a reason that sends the agent to `team_plan`, which shows
 *   the warning card.
 * - After the turn, for every provider: edits made through a shell (`sed`, a
 *   script) or by a provider T3 cannot stop show up in the run's checkpoint
 *   (`checkpoint.captured`). The same card then shows, marked as already changed.
 *
 * In a checkout shared with the holder's chat (solo chats by default), a
 * turn's diff also holds the holder's own edits. A file is left out when that
 * chat ran a turn at the same time: the change cannot be told apart, and a
 * false alarm is worse than none (VISION.md section 3, "No false alarms").
 * For the same reason, while a merge is in progress in the chat's folder (a
 * "Fix it" turn, `TeamMergeFix`), a file exactly as the merged-in side has it
 * came with the merge and is left out.
 *
 * @module TeamGuard
 */
import type {
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
  RunId,
  TeamPath,
  TeamPlanFile,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTeamResolver, type TeamContext } from "../mcp/toolkits/team/resolve.ts";
import { isSharedPath, readSharedFiles } from "../mcp/toolkits/team/rulebook.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { heldElsewhere } from "./heldElsewhere.ts";
import { diffToTeamPaths } from "./TeamAutoNotes.ts";
import * as TeamChoices from "./TeamChoices.ts";
import { installTeamEditCheck, type TeamEditCheck } from "./teamEditCheck.ts";
import { findRepoRoot } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

/** A check that cannot finish in time lets the write through: the guard never blocks work. */
const EDIT_CHECK_TIMEOUT = "5 seconds";

const quoted = (paths: ReadonlyArray<string>) => paths.map((path) => `\`${path}\``).join(", ");

/** The reason a refused write gives the agent. */
export const heldEditReason = (files: ReadonlyArray<TeamPlanFile>) => {
  const one = files.length === 1;
  return `${quoted(files.map((file) => file.path))} ${one ? "is" : "are"} held by ${TeamChoices.holderWords(files)}. Call team_plan with ${one ? "this file" : "these files"} before editing; it may wait for the user's choice.`;
};

export const openCardEditReason = (paths: ReadonlyArray<string>) =>
  `The user has not chosen yet on the card for ${quoted(paths)}. Do not edit ${paths.length === 1 ? "it" : "them"}. Tell the user to pick a choice on the card, and end your turn.`;

export const waitingEditReason = (paths: ReadonlyArray<string>) =>
  `The user chose to wait until the holder of ${quoted(paths)} lets go of ${paths.length === 1 ? "it" : "them"}. Do not edit ${paths.length === 1 ? "it" : "them"}; end your turn. T3 starts your next turn then.`;

interface Interval {
  readonly start: number;
  readonly end: number;
}

const overlaps = (a: Interval, b: Interval) => a.start <= b.end && b.start <= a.end;

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const choices = yield* TeamChoices.TeamChoices;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  /**
   * The repo paths that differ from the commit being merged in; all of them
   * when no merge is in progress in `folder`.
   */
  const notFromMerge = (folder: string, repoPaths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const run = (args: ReadonlyArray<string>) =>
        git.execute({ operation: "TeamGuard.merge", cwd: folder, args, allowNonZeroExit: true });
      if (repoPaths.length === 0) return repoPaths;
      if ((yield* run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode !== 0) {
        return repoPaths;
      }
      const differ = yield* run([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "MERGE_HEAD",
        "--",
        ...repoPaths.map((file) => `:(top,literal)${file}`),
      ]);
      if (differ.exitCode !== 0) return repoPaths;
      const changed = new Set(differ.stdout.split("\0"));
      return repoPaths.filter((file) => changed.has(file));
    }).pipe(Effect.orElseSucceed(() => repoPaths));

  // From the sequence read now, so no checkpoint before activation is missed.
  const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
  const events = eventSink.stream({
    afterSequence: fromSequence,
    eventType: "checkpoint.captured",
  });

  const contextOf = (threadId: ThreadId) =>
    resolve({ environmentId, threadId }).pipe(
      Effect.map((resolved) => (resolved._tag === "InTeam" ? resolved.context : undefined)),
    );

  /**
   * The paths `runId` may change back: it is the run an "Undo it, find
   * another way" click started (its message is the click's). Later runs get no pass.
   */
  const undoPathsOf = (threadId: ThreadId, runId: RunId | null) =>
    Effect.gen(function* () {
      if (runId === null) return [];
      const requests = yield* choices.undoRequests(threadId);
      if (requests.length === 0) return [];
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.id === runId);
      return requests.flatMap((request) =>
        request.messageId === run?.userMessageId ? request.paths : [],
      );
    });

  /** The paths in `paths` someone else holds and this thread did not plan, claim, go ahead on or undo. */
  const heldFor = (context: TeamContext, paths: ReadonlyArray<TeamPath>, runId: RunId | null) =>
    Effect.gen(function* () {
      // The rulebook's shared files never stop anyone (VISION.md 3.6).
      const shared = yield* readSharedFiles(context).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const checked = paths.filter((file) => !isSharedPath(file, shared));
      if (checked.length === 0) return [];
      const teamId = context.teamFile.teamId;
      const [claims, members, wentAhead, undo] = yield* Effect.all([
        teams.listActiveClaims(teamId),
        teams.listMembers(teamId),
        choices.wentAhead(context.thread.threadId),
        undoPathsOf(context.thread.threadId, runId),
      ]);
      return heldElsewhere({
        paths: checked,
        claims,
        viewer: { thread: context.thread, memberId: context.member.memberId, solo: context.solo },
        names: new Map(members.map((member) => [member.memberId, member.displayName])),
        wentAhead: new Set([...wentAhead, ...undo]),
      });
    });

  /** Paths the agent wrote, as team paths; paths outside the team's folder are not the team's. */
  const toTeamPaths = (context: TeamContext, raws: ReadonlyArray<string>) =>
    raws.flatMap((raw): Array<TeamPath> => {
      const absolute = path.isAbsolute(raw) ? raw : path.resolve(context.workingFolder, raw);
      const relative = path.relative(context.teamRoot, absolute);
      if (relative.length === 0 || relative === ".." || /^\.\.[\\/]/u.test(relative)) return [];
      if (path.isAbsolute(relative)) return [];
      return [relative.replaceAll("\\", "/") as TeamPath];
    });

  const checkEdit: TeamEditCheck = (threadId, raws) =>
    Effect.gen(function* () {
      const context = yield* contextOf(threadId);
      if (context === undefined) return undefined;
      const paths = toTeamPaths(context, raws);
      if (paths.length === 0) return undefined;
      const open = yield* choices.openPaths(threadId);
      const unanswered = paths.filter((file) => open.has(file));
      if (unanswered.length > 0) return openCardEditReason(unanswered);
      const waitedOn = yield* choices.waitingPaths(threadId);
      const waiting = paths.filter((file) => waitedOn.has(file));
      if (waiting.length > 0) return waitingEditReason(waiting);
      const shell = yield* orchestrator.getThreadShell(threadId);
      const held = yield* heldFor(context, paths, shell?.activeRunId ?? null);
      return held.length === 0 ? undefined : heldEditReason(held);
    }).pipe(
      Effect.timeoutOption(EDIT_CHECK_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.tap((reason) =>
        reason === undefined
          ? Effect.void
          : Effect.logInfo("Team guard refused an edit.", { threadId, reason }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Team guard skipped an edit check.", { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /** When the chat's latest run went; still going, it has no end yet. */
  const latestRunInterval = (shell: OrchestrationV2ThreadShell): Interval | undefined => {
    const started = shell.latestRunStartedAt ?? shell.latestRunRequestedAt;
    if (shell.latestRunId === null || started == null) return undefined;
    const start = DateTime.toEpochMillis(started);
    const end =
      shell.latestRunCompletedAt != null
        ? DateTime.toEpochMillis(shell.latestRunCompletedAt)
        : shell.activeRunId !== null
          ? Number.POSITIVE_INFINITY
          : start;
    return { start, end };
  };

  /** A chat of this server in the same checkout that ran a turn during `turn`: its edits are in the diff too. */
  const editedAlongside = (context: TeamContext, file: TeamPlanFile, turn: Interval) =>
    Effect.gen(function* () {
      const here = path.resolve(context.workingFolder);
      for (const holder of file.holders) {
        if (holder.kind !== "chat" || holder.thread.environmentId !== environmentId) continue;
        const shell = yield* orchestrator.getThreadShell(holder.thread.threadId);
        if (shell === null) continue;
        const folder =
          shell.worktreePath ??
          Option.getOrUndefined(yield* projects.getById(shell.projectId))?.workspaceRoot;
        if (folder === undefined || path.resolve(folder) !== here) continue;
        const theirs = latestRunInterval(shell);
        if (theirs !== undefined && overlaps(theirs, turn)) return true;
      }
      return false;
    });

  const afterTurn = (payload: {
    readonly threadId: ThreadId;
    readonly runId: TeamChoices.ShowEditedInput["runId"];
    readonly files: ReadonlyArray<{ readonly path: string }>;
    readonly completedAt: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const context = yield* contextOf(payload.threadId);
      if (context === undefined) return;
      const repoRoot = Option.getOrElse(
        yield* findRepoRoot(context.workingFolder).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
        () => context.workingFolder,
      );
      const changed = diffToTeamPaths(
        path,
        yield* notFromMerge(
          context.workingFolder,
          payload.files.map((file) => file.path),
        ),
        repoRoot,
        context.teamRoot,
      ) as ReadonlyArray<TeamPath>;
      // A file already on an unanswered or waiting card of this chat waits on that card.
      const open = yield* choices.openPaths(payload.threadId);
      const waitedOn = yield* choices.waitingPaths(payload.threadId);
      const held = yield* heldFor(
        context,
        changed.filter((file) => !open.has(file) && !waitedOn.has(file)),
        payload.runId,
      );
      if (held.length === 0) return;
      const shell = yield* orchestrator.getThreadShell(payload.threadId);
      const end = DateTime.toEpochMillis(payload.completedAt);
      const turn = (shell !== null && shell.latestRunId === payload.runId
        ? latestRunInterval(shell)
        : undefined) ?? { start: end, end };
      const files = yield* Effect.filter(held, (file) =>
        editedAlongside(context, file, { start: turn.start, end }).pipe(
          Effect.map((ambiguous) => !ambiguous),
        ),
      );
      if (files.length === 0) return;
      yield* choices.showEdited({ context, files, runId: payload.runId });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team guard skipped a run's checkpoint.", {
          threadId: payload.threadId,
          cause,
        }),
      ),
    );

  const onEvent = ({ event }: OrchestrationV2StoredEvent) =>
    event.type === "checkpoint.captured" &&
    event.payload.runId !== null &&
    event.payload.status === "ready" &&
    event.payload.files.length > 0
      ? afterTurn({
          threadId: event.threadId,
          runId: event.payload.runId,
          files: event.payload.files,
          completedAt: event.payload.capturedAt,
        })
      : Effect.void;

  const uninstall = installTeamEditCheck(checkEdit);
  yield* Effect.addFinalizer(() => Effect.sync(uninstall));
  yield* forkParked(Stream.runForEach(events, onEvent));

  return { checkEdit, afterTurn };
});

export const TeamGuardLive = Layer.effectDiscard(make);
