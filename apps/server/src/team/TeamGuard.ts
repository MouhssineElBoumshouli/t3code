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
 *   script) or by a provider T3 cannot stop show up in the turn's diff. The
 *   same card then shows, marked as already changed.
 *
 * In a checkout shared with the holder's chat (solo chats by default), a
 * turn's diff also holds the holder's own edits. A file is left out when that
 * chat ran a turn at the same time: the change cannot be told apart, and a
 * false alarm is worse than none (VISION.md section 3, "No false alarms").
 *
 * @module TeamGuard
 */
import type {
  OrchestrationEvent,
  TeamPath,
  TeamPlanFile,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTeamResolver, type TeamContext } from "../mcp/toolkits/team/resolve.ts";
import { isSharedPath, readSharedFiles } from "../mcp/toolkits/team/rulebook.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { forkParked } from "../serverActivation.ts";
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

interface Interval {
  readonly start: number;
  readonly end: number;
}

const overlaps = (a: Interval, b: Interval) => a.start <= b.end && b.start <= a.end;

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const choices = yield* TeamChoices.TeamChoices;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const turnRows = yield* ProjectionTurnRepository;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  // Subscribe now, so no event published before activation is missed.
  const events = yield* engine.subscribeDomainEvents;

  const contextOf = (threadId: ThreadId) =>
    resolve({ environmentId, threadId }).pipe(
      Effect.map((resolved) => (resolved._tag === "InTeam" ? resolved.context : undefined)),
    );

  /**
   * The paths `turnId` may change back: it is the turn an "Undo it, find
   * another way" click started. Later turns get no pass.
   */
  const undoPathsOf = (threadId: ThreadId, turnId: TurnId | null) =>
    Effect.gen(function* () {
      if (turnId === null) return [];
      const requests = yield* choices.undoRequests(threadId);
      if (requests.length === 0) return [];
      const row = Option.getOrUndefined(yield* turnRows.getByTurnId({ threadId, turnId }));
      return requests.flatMap((request) =>
        request.messageId === row?.pendingMessageId ? request.paths : [],
      );
    });

  /** The paths in `paths` someone else holds and this thread did not plan, claim, go ahead on or undo. */
  const heldFor = (context: TeamContext, paths: ReadonlyArray<TeamPath>, turnId: TurnId | null) =>
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
        undoPathsOf(context.thread.threadId, turnId),
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
      const waiting = paths.filter((file) => open.has(file));
      if (waiting.length > 0) return openCardEditReason(waiting);
      const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
      const running = shell?.latestTurn?.state === "running" ? shell.latestTurn.turnId : null;
      const held = yield* heldFor(context, paths, running);
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

  const turnInterval = (
    turn:
      | {
          readonly requestedAt: string;
          readonly startedAt: string | null;
          readonly completedAt: string | null;
          readonly state: string;
        }
      | null
      | undefined,
  ): Interval | undefined => {
    if (turn === null || turn === undefined) return undefined;
    const start = Date.parse(turn.startedAt ?? turn.requestedAt);
    const end =
      turn.completedAt !== null
        ? Date.parse(turn.completedAt)
        : turn.state === "running"
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
        const shell = Option.getOrUndefined(
          yield* snapshots.getThreadShellById(holder.thread.threadId),
        );
        if (shell === undefined) continue;
        const folder =
          shell.worktreePath ??
          Option.getOrUndefined(yield* snapshots.getProjectShellById(shell.projectId))
            ?.workspaceRoot;
        if (folder === undefined || path.resolve(folder) !== here) continue;
        const theirs = turnInterval(shell.latestTurn);
        if (theirs !== undefined && overlaps(theirs, turn)) return true;
      }
      return false;
    });

  const afterTurn = (payload: {
    readonly threadId: ThreadId;
    readonly turnId: TeamChoices.ShowEditedInput["turnId"];
    readonly files: ReadonlyArray<{ readonly path: string }>;
    readonly completedAt: string;
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
        payload.files.map((file) => file.path),
        repoRoot,
        context.teamRoot,
      ) as ReadonlyArray<TeamPath>;
      // A file already on an unanswered card of this chat waits on that card.
      const open = yield* choices.openPaths(payload.threadId);
      const held = yield* heldFor(
        context,
        changed.filter((file) => !open.has(file)),
        payload.turnId,
      );
      if (held.length === 0) return;
      const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(payload.threadId));
      const end = Date.parse(payload.completedAt);
      const turn = (shell?.latestTurn?.turnId === payload.turnId
        ? turnInterval(shell.latestTurn)
        : undefined) ?? { start: end, end };
      const files = yield* Effect.filter(held, (file) =>
        editedAlongside(context, file, { start: turn.start, end }).pipe(
          Effect.map((ambiguous) => !ambiguous),
        ),
      );
      if (files.length === 0) return;
      yield* choices.showEdited({ context, files, turnId: payload.turnId });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team guard skipped a turn's diff.", {
          threadId: payload.threadId,
          cause,
        }),
      ),
    );

  const onEvent = (event: OrchestrationEvent) =>
    event.type === "thread.turn-diff-completed" &&
    event.payload.status === "ready" &&
    event.payload.files.length > 0
      ? afterTurn(event.payload)
      : Effect.void;

  const uninstall = installTeamEditCheck(checkEdit);
  yield* Effect.addFinalizer(() => Effect.sync(uninstall));
  yield* forkParked(Stream.runForEach(events, onEvent));

  return { checkEdit, afterTurn };
});

export const TeamGuardLive = Layer.effectDiscard(make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
