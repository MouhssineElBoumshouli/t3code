import {
  CommandId,
  countTeamWords,
  EventId,
  TEAM_PLAN_ACTIVITY_KIND,
  type TeamClaim,
  type TeamClaimOverlap,
  type TeamPlanActivityPayload,
  type TeamPlanHolder,
  teamPathsOverlap,
  teamPlanSummary,
  type TeamTask,
  type TeamThreadRef,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { folderKey, realFolder } from "../../../team/folders.ts";
import * as TeamService from "../../../team/TeamService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  checkFreshness,
  currentCommit,
  handoffEntry,
  handoffHeadline,
  hashFiles,
  type MemoryEntry,
  queryTerms,
  rankMemory,
  readDecisions,
  TEAM_MEMORY_LIMITS,
} from "./memory.ts";
import { toProjectPaths } from "./paths.ts";
import { readDoNotTouch } from "./rulebook.ts";
import { fromService, makeTeamResolver, type TeamContext } from "./resolve.ts";
import {
  type NotInTeamResult,
  TeamToolError,
  TeamToolkit,
  type TeamMemorySearchResult,
  type TeamPlanResult,
  type TeamStatusResult,
} from "./tools.ts";

/**
 * Told to an agent that hands off from a thread that changed no files and holds
 * no claims, in a note naming no files: in the cold start test Codex read "when
 * you finish or stop" as every turn end and handed off after a question. The
 * note is still saved, since "looked into X, nothing to change" can be worth
 * keeping; the server cannot tell that from a note about nothing.
 */
export const HANDOFF_NOTHING_CHANGED_MESSAGE =
  "Saved, but this chat changed no files and holds no claims. Write a handoff only after editing files or when the user stops work partway, not after answering a question.";

/** A claim whose push did not land: kept on this server, unknown to teammates for now. */
export const CLAIM_NOT_SHARED_MESSAGE =
  "Claimed on this computer, not shared yet: the team's remote could not be reached. Overlaps with teammates' newest claims are unknown. It is shared on the next successful sync.";

/** `team_status` when the team state could not be read just now and the last one read is shown. */
export const notFreshMessage = (readAt: string | null) =>
  `Not fresh: the team state could not be read just now, so this is the last state read${readAt === null ? "" : ` (${readAt})`}. Teammates' newer claims may be missing; call team_status again before editing shared files.`;

/** Caps on `team_status`, which every team agent may call often. Oldest items go first. */
export const TEAM_STATUS_LIMITS = {
  tasks: 8,
  claims: 10,
  pathsPerClaim: 5,
  activity: 5,
  handoffs: 3,
  handoffWords: 20,
};

/**
 * Where another thread's claimed work is. In worktree mode it is in that
 * thread's own copy until it merges, so this agent cannot see those edits.
 */
export const CLAIM_WHERE = {
  ownCopy: "their own copy; not merged into yours yet",
  sameCheckout: "same checkout as you",
} as const;

const sameThread = (left: TeamThreadRef | null, right: TeamThreadRef) =>
  left !== null && left.environmentId === right.environmentId && left.threadId === right.threadId;

const byNewest =
  <A>(dateOf: (item: A) => string) =>
  (left: A, right: A) =>
    dateOf(right).localeCompare(dateOf(left));

const capPaths = (paths: ReadonlyArray<string>) =>
  paths.length <= TEAM_STATUS_LIMITS.pathsPerClaim
    ? paths
    : [
        ...paths.slice(0, TEAM_STATUS_LIMITS.pathsPerClaim),
        `+${paths.length - TEAM_STATUS_LIMITS.pathsPerClaim} more`,
      ];

const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const { resolve } = yield* makeTeamResolver;
  const platform = yield* HostProcessPlatform;

  /** A folder as the OS compares it: links resolved, and on Windows case and slashes ignored (W8). */
  const folderKeyOf = (folder: string) =>
    realFolder(folder).pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map((real) => folderKey(real, platform)),
    );

  /** Runs `run` for a team project, and answers with the not-in-team result otherwise. */
  const inTeam = <A, E, R>(run: (context: TeamContext) => Effect.Effect<A, E, R>) =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap(resolve),
      Effect.flatMap((resolved): Effect.Effect<A | NotInTeamResult, E, R> =>
        resolved._tag === "NotInTeam" ? Effect.succeed(resolved.result) : run(resolved.context),
      ),
    );

  const projectPaths = (raws: ReadonlyArray<string>, context: TeamContext) =>
    toProjectPaths(
      raws,
      { teamRoot: context.teamRoot, workingFolder: context.workingFolder },
      path,
    );

  const namesOf = (context: TeamContext) =>
    teams.listMembers(context.teamFile.teamId).pipe(
      Effect.mapError(fromService("lookup")),
      Effect.map(
        (members) => new Map(members.map((member) => [member.memberId, member.displayName])),
      ),
    );

  const summarizeTask = (task: TeamTask, names: ReadonlyMap<string, string>) => {
    const owner = task.ownerMemberId === null ? undefined : names.get(task.ownerMemberId);
    return {
      title: task.title,
      status: task.status,
      ...(owner === undefined ? {} : { owner }),
      ...(task.note === null ? {} : { note: task.note }),
    };
  };

  /** A thread's working folder on this server: its worktree, else its project root. */
  const workingFolderOf = (thread: TeamThreadRef) =>
    snapshots.getThreadShellById(thread.threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (shell) =>
            shell.worktreePath !== null
              ? Effect.succeed(shell.worktreePath)
              : snapshots
                  .getProjectShellById(shell.projectId)
                  .pipe(
                    Effect.map(
                      Option.match({ onNone: () => null, onSome: (p) => p.workspaceRoot }),
                    ),
                  ),
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Where each claiming thread's work is, looked up once per thread. */
  const makeWhereOf = (context: TeamContext) => {
    const known = new Map<string, string>();
    let here: string | undefined;
    return (thread: TeamThreadRef) =>
      Effect.gen(function* () {
        const key = `${thread.environmentId}/${thread.threadId}`;
        const cached = known.get(key);
        if (cached !== undefined) return cached;
        // Another server's thread is always in another copy.
        const folder =
          thread.environmentId === context.thread.environmentId
            ? yield* workingFolderOf(thread)
            : null;
        here ??= yield* folderKeyOf(context.workingFolder);
        const where =
          folder !== null && (yield* folderKeyOf(folder)) === here
            ? CLAIM_WHERE.sameCheckout
            : CLAIM_WHERE.ownCopy;
        known.set(key, where);
        return where;
      });
  };

  /** `tasks` tells one person's threads apart: each claim shows its thread's task. */
  const summarizeClaim = (
    claim: Pick<TeamClaim, "memberId" | "thread" | "note">,
    paths: ReadonlyArray<string>,
    names: ReadonlyMap<string, string>,
    tasks: ReadonlyArray<TeamTask>,
    where: string,
  ) => ({
    who: names.get(claim.memberId) ?? "Unknown member",
    task: tasks.findLast((task) => sameThread(task.thread, claim.thread))?.title ?? "no task",
    where,
    paths: capPaths(paths),
    ...(claim.note === null ? {} : { note: claim.note }),
  });

  /**
   * Teammates' claims found to overlap this thread's after both were made
   * (team/STORAGE_PLAN.md Q4), as sentences; each overlap is told only once.
   */
  const lateOverlapsOf = (context: TeamContext) =>
    Effect.gen(function* () {
      const late = yield* teams.takeLateOverlaps(context.teamFile.teamId, context.thread);
      if (late.length === 0) return {};
      const names = yield* namesOf(context);
      return {
        lateOverlaps: late.map(
          (overlap) =>
            `Since you claimed, ${names.get(overlap.theirs.memberId) ?? "a teammate"} also claimed ${capPaths(overlap.paths).join(", ")}. Tell the user before editing those.`,
        ),
      };
    });

  const heldPaths = (context: TeamContext) =>
    teams.listActiveClaims(context.teamFile.teamId).pipe(
      Effect.mapError(fromService("lookup")),
      Effect.map((claims) => [
        ...new Set(
          claims
            .filter((claim) => sameThread(claim.thread, context.thread))
            .flatMap((claim) => claim.paths),
        ),
      ]),
    );

  /**
   * Claims paths for this thread and words the overlaps for the agent; shared
   * by `team_claim` and `team_plan`.
   */
  const claimAndSummarize = (
    context: TeamContext,
    paths: ReadonlyArray<string>,
    note: string | undefined,
  ) =>
    Effect.gen(function* () {
      const { claim, overlaps, confirmed } = yield* teams
        .claimPaths({
          teamId: context.teamFile.teamId,
          memberId: context.member.memberId,
          thread: context.thread,
          paths,
          note,
        })
        .pipe(Effect.mapError(fromService("claim")));
      const names = overlaps.length === 0 ? new Map<string, string>() : yield* namesOf(context);
      const tasks =
        overlaps.length === 0
          ? []
          : yield* teams
              .listTasks(context.teamFile.teamId)
              .pipe(Effect.mapError(fromService("claim")));
      const whereOf = makeWhereOf(context);
      const shown = yield* Effect.forEach(overlaps, (overlap) =>
        whereOf(overlap.claim.thread).pipe(
          Effect.map((where) => summarizeClaim(overlap.claim, overlap.paths, names, tasks, where)),
        ),
      );
      const holders = context.solo ? "other chats of the user" : "teammates";
      const overlapText =
        shown.length === 0
          ? null
          : shown.some((overlap) => overlap.where === CLAIM_WHERE.ownCopy)
            ? `${holders} hold overlapping paths. Their changes are in their own copy and not merged yet, so you may not see them. Tell the user before editing those.`
            : `${holders} hold overlapping paths. Tell the user before editing those.`;
      return { claim, overlaps, names, shown, confirmed, overlapText };
    });

  /** Who else held each planned path: a teammate, or another chat of the same person. */
  const planFiles = (
    context: TeamContext,
    paths: ReadonlyArray<string>,
    overlaps: ReadonlyArray<TeamClaimOverlap>,
    names: ReadonlyMap<string, string>,
  ): TeamPlanActivityPayload["files"] =>
    paths.map((path) => {
      const seen = new Set<string>();
      const holders: Array<TeamPlanHolder> = [];
      for (const { claim } of overlaps) {
        if (!claim.paths.some((held) => teamPathsOverlap(path, held))) continue;
        const mine = context.solo || claim.memberId === context.member.memberId;
        const key = mine
          ? `chat:${claim.thread.environmentId}/${claim.thread.threadId}`
          : `member:${claim.memberId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        holders.push(
          mine
            ? { kind: "chat", thread: claim.thread }
            : {
                kind: "member",
                memberId: claim.memberId,
                name: names.get(claim.memberId) ?? claim.memberId,
              },
        );
      }
      // Teammates first, as the markers order them.
      holders.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "member" ? -1 : 1));
      return { path, holders };
    });

  /**
   * The plan card: one activity on the thread, in the running turn. Best
   * effort: the claim stands and the agent is answered even if it fails.
   */
  const appendPlanActivity = (context: TeamContext, payload: TeamPlanActivityPayload) =>
    Effect.gen(function* () {
      const threadId = context.thread.threadId;
      const thread = yield* snapshots.getThreadShellById(threadId);
      const latestTurn = Option.getOrUndefined(thread)?.latestTurn ?? null;
      const uuid = yield* crypto.randomUUIDv4;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:team-plan:${threadId}:${uuid}`),
        threadId,
        activity: {
          id: EventId.make(`team-plan:${uuid}`),
          tone: "info",
          kind: TEAM_PLAN_ACTIVITY_KIND,
          summary: teamPlanSummary(payload.files.length),
          payload,
          turnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not add the plan card to the thread.", { cause }),
      ),
    );

  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  /** Whether a handoff was written in the caller's own checkout (its thread works there). */
  const writtenHere = (entry: MemoryEntry, context: TeamContext) => {
    const thread = entry.handoff?.thread;
    if (thread === undefined) return Effect.succeed(false);
    if (sameThread(context.thread, thread)) return Effect.succeed(true);
    if (thread.environmentId !== context.thread.environmentId) return Effect.succeed(false);
    return workingFolderOf(thread).pipe(
      Effect.flatMap((folder) =>
        folder === null
          ? Effect.succeed(false)
          : Effect.all([folderKeyOf(folder), folderKeyOf(context.workingFolder)]).pipe(
              Effect.map(([theirs, mine]) => theirs === mine),
            ),
      ),
    );
  };

  return TeamToolkit.of({
    team_status: () =>
      inTeam((context) =>
        Effect.gen(function* () {
          const teamId = context.teamFile.teamId;
          const names = yield* namesOf(context);
          const tasks = yield* teams.listTasks(teamId).pipe(Effect.mapError(fromService("status")));
          const claims = yield* teams
            .listActiveClaims(teamId)
            .pipe(Effect.mapError(fromService("status")));
          const activity = yield* teams
            .listActivity(teamId, { limit: TEAM_STATUS_LIMITS.activity })
            .pipe(Effect.mapError(fromService("status")));
          const notes = yield* teams
            .listHandoffs(teamId, { limit: TEAM_MEMORY_LIMITS.handoffs })
            .pipe(Effect.mapError(fromService("status")));
          const doNotTouch = yield* readDoNotTouch(context).pipe(withFiles);
          const late = yield* lateOverlapsOf(context);
          const freshness = yield* teams.freshness(teamId);

          // Written notes from other chats; this chat knows its own.
          const handoffs = notes
            .filter((note) => !note.automatic && !sameThread(note.thread, context.thread))
            .slice(0, TEAM_STATUS_LIMITS.handoffs)
            .map((note) =>
              handoffHeadline(
                note,
                names.get(note.memberId) ?? "Unknown member",
                TEAM_STATUS_LIMITS.handoffWords,
              ),
            );

          const yourTask = tasks.findLast((task) => sameThread(task.thread, context.thread));
          const openTasks = tasks
            .filter((task) => task !== yourTask && task.status !== "done")
            .toSorted(byNewest((task) => task.updatedAt));
          const otherClaims = claims
            .filter((claim) => !sameThread(claim.thread, context.thread))
            .toSorted(byNewest((claim) => claim.claimedAt));
          const whereOf = makeWhereOf(context);
          const shownClaims = yield* Effect.forEach(
            otherClaims.slice(0, TEAM_STATUS_LIMITS.claims),
            (claim) =>
              whereOf(claim.thread).pipe(
                Effect.map((where) => summarizeClaim(claim, claim.paths, names, tasks, where)),
              ),
          );
          const droppedTasks = Math.max(0, openTasks.length - TEAM_STATUS_LIMITS.tasks);
          const droppedClaims = Math.max(0, otherClaims.length - TEAM_STATUS_LIMITS.claims);
          const omitted = [
            droppedTasks > 0 ? `${droppedTasks} older tasks` : null,
            droppedClaims > 0 ? `${droppedClaims} older claims` : null,
          ].filter((part) => part !== null);

          return {
            team: context.solo
              ? `${context.teamFile.name} (solo: kept on this computer)`
              : context.teamFile.name,
            you: context.member.displayName,
            ...(freshness.fresh ? {} : { notFresh: notFreshMessage(freshness.readAt) }),
            ...(doNotTouch.length === 0 ? {} : { doNotTouch }),
            yourTask: yourTask === undefined ? null : summarizeTask(yourTask, names),
            tasks: openTasks
              .slice(0, TEAM_STATUS_LIMITS.tasks)
              .map((task) => summarizeTask(task, names)),
            claims: shownClaims,
            yourClaims: capPaths([
              ...new Set(
                claims
                  .filter((claim) => sameThread(claim.thread, context.thread))
                  .flatMap((claim) => claim.paths),
              ),
            ]),
            ...late,
            ...(handoffs.length === 0 ? {} : { handoffs }),
            recent: activity.map((item) => item.summary),
            ...(omitted.length === 0 ? {} : { omitted: omitted.join(", ") }),
          } satisfies TeamStatusResult;
        }),
      ),

    team_plan: (input) =>
      inTeam((context) =>
        Effect.gen(function* () {
          const paths = yield* projectPaths(input.files, context);
          if (paths.length === 0) {
            return yield* new TeamToolError({ detail: "Pass the files you expect to change." });
          }
          const { claim, overlaps, names, shown, confirmed, overlapText } =
            yield* claimAndSummarize(context, paths, input.note);
          yield* appendPlanActivity(context, {
            solo: context.solo,
            files: planFiles(context, claim.paths, overlaps, names),
            shared: confirmed,
          });
          const planned = `Planned and claimed ${claim.paths.length} ${claim.paths.length === 1 ? "file" : "files"}; the user sees the plan.`;
          return {
            planned: claim.paths,
            overlaps: shown,
            ...(yield* lateOverlapsOf(context)),
            message: !confirmed
              ? `${CLAIM_NOT_SHARED_MESSAGE}${overlapText === null ? "" : ` Already known: ${overlapText}`}`
              : overlapText === null
                ? `${planned} No overlaps.`
                : `${planned} But ${overlapText}`,
          } satisfies TeamPlanResult;
        }),
      ),

    team_claim: (input) =>
      inTeam((context) =>
        Effect.gen(function* () {
          const teamId = context.teamFile.teamId;
          const paths =
            input.paths === undefined ? undefined : yield* projectPaths(input.paths, context);
          if (input.release === true) {
            const before = yield* heldPaths(context);
            yield* teams
              .releasePaths({
                teamId,
                memberId: context.member.memberId,
                thread: context.thread,
                paths: paths === undefined || paths.length === 0 ? undefined : paths,
              })
              .pipe(Effect.mapError(fromService("release")));
            const after = new Set(yield* heldPaths(context));
            const released = before.filter((held) => !after.has(held));
            return {
              claimed: [],
              released,
              overlaps: [],
              message: released.length > 0 ? "Released." : "Nothing to release.",
            };
          }
          if (paths === undefined || paths.length === 0) {
            return yield* new TeamToolError({ detail: "Pass paths to claim." });
          }
          const { claim, shown, confirmed, overlapText } = yield* claimAndSummarize(
            context,
            paths,
            input.note,
          );
          return {
            claimed: claim.paths,
            released: [],
            overlaps: shown,
            ...(yield* lateOverlapsOf(context)),
            message: !confirmed
              ? `${CLAIM_NOT_SHARED_MESSAGE}${overlapText === null ? "" : ` Already known: ${overlapText}`}`
              : overlapText === null
                ? "Claimed. No overlaps."
                : `Claimed, but ${overlapText}`,
          };
        }),
      ),

    team_task: (input) =>
      inTeam((context) =>
        Effect.gen(function* () {
          const teamId = context.teamFile.teamId;
          const names = yield* namesOf(context);
          const current = yield* teams
            .findTaskForThread(teamId, context.thread)
            .pipe(Effect.mapError(fromService("task")));
          const title = input.title?.trim() ?? "";

          if (Option.isNone(current)) {
            if (title.length === 0) {
              return {
                task: null,
                message: "This thread has no task yet. Pass title to create one.",
              };
            }
            const created = yield* teams
              .createTask({
                teamId,
                actorMemberId: context.member.memberId,
                title,
                note: input.note,
                status: input.status ?? "in_progress",
                ownerMemberId: context.member.memberId,
                thread: context.thread,
              })
              .pipe(Effect.mapError(fromService("task")));
            return { task: summarizeTask(created, names), message: "Created this thread's task." };
          }

          const titleIgnored =
            title.length > 0 && title !== current.value.title
              ? { message: "This thread already has a task; the title was not changed." }
              : {};
          if (input.status === undefined && input.note === undefined) {
            return { task: summarizeTask(current.value, names), ...titleIgnored };
          }
          const updated = yield* teams
            .updateTask({
              teamId,
              taskId: current.value.taskId,
              actorMemberId: context.member.memberId,
              status: input.status,
              note: input.note,
            })
            .pipe(Effect.mapError(fromService("task")));
          return { task: summarizeTask(updated, names), ...titleIgnored };
        }),
      ),

    team_handoff: (input) =>
      inTeam((context) =>
        Effect.gen(function* () {
          const teamId = context.teamFile.teamId;
          const files = yield* projectPaths(input.files ?? [], context);
          if (input.changed.trim().length === 0) {
            return yield* new TeamToolError({ detail: "Say what changed." });
          }
          const task = yield* teams
            .findTaskForThread(teamId, context.thread)
            .pipe(Effect.mapError(fromService("handoff")));
          // Earlier turns' edits left an automatic note (D7). This turn's have none
          // yet, but the briefing asks for claims before editing.
          const nothingChanged =
            files.length === 0 &&
            (yield* heldPaths(context)).length === 0 &&
            !(yield* teams.listHandoffs(teamId, { thread: context.thread }).pipe(
              Effect.mapError(fromService("handoff")),
              Effect.map((notes) => notes.some((note) => note.automatic)),
            ));
          const commit = yield* currentCommit(git, context.workingFolder);
          // Freshness compares these later, since the work is often not committed yet (D7).
          const fileHashes = Object.fromEntries(
            yield* hashFiles(git, context.teamRoot, files, { store: true }).pipe(withFiles),
          );
          const handoff = yield* teams
            .writeHandoff({
              teamId,
              memberId: context.member.memberId,
              thread: context.thread,
              taskId: Option.getOrUndefined(Option.map(task, (value) => value.taskId)),
              changed: input.changed,
              left: input.left,
              risks: input.risks,
              files,
              commit: commit ?? undefined,
              fileHashes,
            })
            .pipe(Effect.mapError(fromService("handoff")));
          return {
            saved: true as const,
            words: countTeamWords(
              [handoff.changed, handoff.left ?? "", handoff.risks ?? ""].join(" "),
            ),
            files: handoff.files,
            commit: handoff.commit,
            ...(nothingChanged ? { message: HANDOFF_NOTHING_CHANGED_MESSAGE } : {}),
          };
        }),
      ),

    team_memory_search: (input) =>
      inTeam((context) =>
        Effect.gen(function* () {
          const terms = queryTerms(input.query);
          if (terms.length === 0) {
            return yield* new TeamToolError({ detail: "Pass a few keywords or file paths." });
          }
          const names = yield* namesOf(context);
          const handoffs = yield* teams
            .listHandoffs(context.teamFile.teamId, { limit: TEAM_MEMORY_LIMITS.handoffs })
            .pipe(Effect.mapError(fromService("search")));
          const decisions = yield* readDecisions(context.teamRoot).pipe(withFiles);
          const { top, matched } = rankMemory(
            [
              ...handoffs.map((handoff) =>
                handoffEntry(handoff, names.get(handoff.memberId) ?? "Unknown member"),
              ),
              ...decisions,
            ],
            terms,
          );
          const results = yield* Effect.forEach(
            top,
            (entry) =>
              writtenHere(entry, context).pipe(
                Effect.flatMap((sameCheckout) =>
                  checkFreshness(git, context.teamRoot, entry, sameCheckout).pipe(withFiles),
                ),
                Effect.map((freshness) => ({
                  kind: entry.kind,
                  says: entry.says,
                  who: entry.who,
                  when: entry.whenLabel,
                  files: capPaths(entry.files),
                  freshness,
                  ...(entry.source === undefined ? {} : { source: entry.source }),
                })),
              ),
            { concurrency: TEAM_MEMORY_LIMITS.results },
          );
          const message =
            results.length === 0
              ? "No handoff notes or decisions match. Read the code."
              : [
                  matched > results.length
                    ? `${matched - results.length} more matches left out.`
                    : null,
                  "Each mark compares the note with the files in your copy now. Code wins over notes.",
                ]
                  .filter((part) => part !== null)
                  .join(" ");
          return { results, message } satisfies TeamMemorySearchResult;
        }),
      ),
  });
});

export const TeamToolkitHandlersLive = TeamToolkit.toLayer(make);
