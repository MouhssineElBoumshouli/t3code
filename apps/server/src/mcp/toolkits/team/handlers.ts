import {
  countTeamWords,
  type TeamClaim,
  type TeamFile,
  type TeamMember,
  type TeamTask,
  type TeamThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TeamServiceError } from "../../../team/TeamErrors.ts";
import { findRepoRoot, readTeamFile } from "../../../team/TeamProjectFiles.ts";
import * as TeamService from "../../../team/TeamService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { toProjectPaths } from "./paths.ts";
import {
  type NotInTeamResult,
  TeamToolError,
  TeamToolFailedError,
  TeamToolkit,
  type TeamStatusResult,
} from "./tools.ts";

/** Caps on `team_status`, which every team agent may call often. Oldest items go first. */
export const TEAM_STATUS_LIMITS = { tasks: 8, claims: 10, pathsPerClaim: 5, activity: 5 };

const NOT_IN_TEAM: NotInTeamResult = {
  inTeam: false,
  message: "This project is not in a team, so team tools do nothing here. Carry on without them.",
};

interface TeamContext {
  readonly teamFile: TeamFile;
  readonly member: TeamMember;
  readonly thread: TeamThreadRef;
  readonly teamRoot: string;
  readonly workingFolder: string;
}

type Resolved =
  | { readonly _tag: "NotInTeam"; readonly result: NotInTeamResult }
  | { readonly _tag: "InTeam"; readonly context: TeamContext };

const notInTeam = (result: NotInTeamResult): Resolved => ({ _tag: "NotInTeam", result });
const inTeamWith = (context: TeamContext): Resolved => ({ _tag: "InTeam", context });

const fromService = (operation: string) => (error: TeamServiceError) =>
  error._tag === "TeamStorageError"
    ? new TeamToolFailedError({ operation, cause: error })
    : new TeamToolError({ detail: error.message });

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
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const path = yield* Path.Path;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const lookupFailed = (operation: string) => (cause: unknown) =>
    new TeamToolFailedError({ operation, cause });

  /** Finds `.team/team.json` in the working folder, else at the root of its Git repo. */
  const findTeamFile = (workingFolder: string) =>
    Effect.gen(function* () {
      const here = yield* readTeamFile(workingFolder);
      if (Option.isSome(here))
        return Option.some({ teamFile: here.value, teamRoot: workingFolder });
      const repoRoot = yield* findRepoRoot(workingFolder);
      if (Option.isNone(repoRoot) || repoRoot.value === workingFolder) return Option.none();
      const atRoot = yield* readTeamFile(repoRoot.value);
      return Option.map(atRoot, (teamFile) => ({ teamFile, teamRoot: repoRoot.value }));
    }).pipe(
      Effect.mapError(
        (error) => new TeamToolError({ detail: `${error.filePath}: ${error.detail}` }),
      ),
      Effect.provide(fileContext),
    );

  /** thread -> project -> working folder -> `.team/team.json` -> team and this server's member. */
  const resolve = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError(lookupFailed("lookup")));
    if (Option.isNone(thread)) {
      return yield* new TeamToolError({ detail: `Thread ${scope.threadId} was not found.` });
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.mapError(lookupFailed("lookup")));
    if (Option.isNone(project)) {
      return yield* new TeamToolError({ detail: "This thread's project was not found." });
    }
    const workingFolder = thread.value.worktreePath ?? project.value.workspaceRoot;
    const found = yield* findTeamFile(workingFolder);
    if (Option.isNone(found)) return notInTeam(NOT_IN_TEAM);
    const { teamFile, teamRoot } = found.value;

    const existing = yield* teams
      .getTeam(teamFile.teamId)
      .pipe(Effect.mapError(fromService("lookup")));
    let member: TeamMember;
    if (Option.isNone(existing)) {
      // The file is checked in but this server has not seen the team yet (M1: solo host).
      const descriptor = yield* environment.getDescriptor;
      const ensured = yield* teams
        .ensureTeam({
          teamFile,
          canonicalKey: project.value.repositoryIdentity?.canonicalKey ?? null,
          owner: { environmentId: scope.environmentId, displayName: descriptor.label },
        })
        .pipe(Effect.mapError(fromService("registration")));
      member = ensured.owner;
    } else {
      const found = yield* teams
        .findMemberByEnvironment(teamFile.teamId, scope.environmentId)
        .pipe(Effect.mapError(fromService("lookup")));
      if (Option.isNone(found)) {
        return notInTeam({
          inTeam: false,
          message: `This project is in team ${teamFile.name}, but this T3 server is not a member. Team tools do nothing here.`,
        });
      }
      member = found.value;
    }
    return inTeamWith({
      teamFile,
      member,
      thread: { environmentId: scope.environmentId, threadId: scope.threadId },
      teamRoot,
      workingFolder,
    });
  });

  /** Runs `run` for a team project, and answers with the not-in-team result otherwise. */
  const inTeam = <A, E, R>(run: (context: TeamContext) => Effect.Effect<A, E, R>) =>
    resolve.pipe(
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

  const summarizeClaim = (
    claim: Pick<TeamClaim, "memberId" | "note">,
    paths: ReadonlyArray<string>,
    names: ReadonlyMap<string, string>,
  ) => ({
    who: names.get(claim.memberId) ?? "Unknown member",
    paths: capPaths(paths),
    ...(claim.note === null ? {} : { note: claim.note }),
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

  const currentCommit = (workingFolder: string) =>
    git
      .execute({
        operation: "TeamToolkit.currentCommit",
        cwd: workingFolder,
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

          const yourTask = tasks.findLast((task) => sameThread(task.thread, context.thread));
          const openTasks = tasks
            .filter((task) => task !== yourTask && task.status !== "done")
            .toSorted(byNewest((task) => task.updatedAt));
          const otherClaims = claims
            .filter((claim) => !sameThread(claim.thread, context.thread))
            .toSorted(byNewest((claim) => claim.claimedAt));
          const droppedTasks = Math.max(0, openTasks.length - TEAM_STATUS_LIMITS.tasks);
          const droppedClaims = Math.max(0, otherClaims.length - TEAM_STATUS_LIMITS.claims);
          const omitted = [
            droppedTasks > 0 ? `${droppedTasks} older tasks` : null,
            droppedClaims > 0 ? `${droppedClaims} older claims` : null,
          ].filter((part) => part !== null);

          return {
            team: context.teamFile.name,
            you: context.member.displayName,
            yourTask: yourTask === undefined ? null : summarizeTask(yourTask, names),
            tasks: openTasks
              .slice(0, TEAM_STATUS_LIMITS.tasks)
              .map((task) => summarizeTask(task, names)),
            claims: otherClaims
              .slice(0, TEAM_STATUS_LIMITS.claims)
              .map((claim) => summarizeClaim(claim, claim.paths, names)),
            yourClaims: capPaths([
              ...new Set(
                claims
                  .filter((claim) => sameThread(claim.thread, context.thread))
                  .flatMap((claim) => claim.paths),
              ),
            ]),
            recent: activity.map((item) => item.summary),
            ...(omitted.length === 0 ? {} : { omitted: omitted.join(", ") }),
          } satisfies TeamStatusResult;
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
          const { claim, overlaps } = yield* teams
            .claimPaths({
              teamId,
              memberId: context.member.memberId,
              thread: context.thread,
              paths,
              note: input.note,
            })
            .pipe(Effect.mapError(fromService("claim")));
          const names = overlaps.length === 0 ? new Map() : yield* namesOf(context);
          return {
            claimed: claim.paths,
            released: [],
            overlaps: overlaps.map((overlap) =>
              summarizeClaim(overlap.claim, overlap.paths, names),
            ),
            message:
              overlaps.length === 0
                ? "Claimed. No overlaps."
                : "Claimed, but teammates hold overlapping paths. Coordinate with them before editing those.",
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
          const commit = yield* currentCommit(context.workingFolder);
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
            })
            .pipe(Effect.mapError(fromService("handoff")));
          return {
            saved: true as const,
            words: countTeamWords(
              [handoff.changed, handoff.left ?? "", handoff.risks ?? ""].join(" "),
            ),
            files: handoff.files,
            commit: handoff.commit,
          };
        }),
      ),
  });
});

export const TeamToolkitHandlersLive = TeamToolkit.toLayer(make);
