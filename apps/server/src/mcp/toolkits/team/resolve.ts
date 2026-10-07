/**
 * thread -> project -> working folder -> `.team/team.json` -> team and this
 * server's member (team/DESIGN.md D5). Shared by the team tools, the team
 * briefing and automatic notes, so all agree on which threads are in a team.
 *
 * The team state lives on the project's remote (team/STORAGE_PLAN.md), so
 * opening the team asks the Git host whether this person may use it. It never
 * starts the team state: only `t3 team init` does.
 */
import type {
  EnvironmentId,
  TeamFile,
  TeamMember,
  TeamThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TeamServiceError } from "../../../team/TeamErrors.ts";
import { findRepoRoot, readTeamFile } from "../../../team/TeamProjectFiles.ts";
import * as TeamService from "../../../team/TeamService.ts";
import { type NotInTeamResult, TeamToolError, TeamToolFailedError } from "./tools.ts";

const NOT_IN_TEAM: NotInTeamResult = {
  inTeam: false,
  message: "This project is not in a team, so team tools do nothing here. Carry on without them.",
};

/** Why this server cannot use the team a project names, in words the agent can pass on. */
export const notInTeamReason = (
  teamFile: TeamFile,
  membership: Exclude<TeamService.TeamMembership, { readonly status: "member" }>,
): NotInTeamResult => {
  const why = (() => {
    switch (membership.status) {
      case "noRemote":
        return "its Git repo has no origin remote, where the team's shared state lives";
      case "signedOut":
        return "this computer is not signed in to GitHub (run gh auth login)";
      case "noAccess":
        return "the GitHub account signed in here cannot see the project's repo";
      case "noPushAccess":
        return "the GitHub account signed in here cannot push to the project's repo";
      case "noTeamState":
        return "the project's remote has no team state yet (t3 team init starts it)";
      case "otherTeam":
        return `the project's remote holds the state of another team (${membership.teamId})`;
      case "unavailable":
        return `the team state could not be read right now: ${membership.detail}`;
    }
  })();
  return {
    inTeam: false,
    message: `This project is in team ${teamFile.name}, but ${why}. Team tools do nothing here.`,
  };
};

export interface TeamContext {
  readonly teamFile: TeamFile;
  readonly member: TeamMember;
  readonly thread: TeamThreadRef;
  readonly teamRoot: string;
  readonly workingFolder: string;
}

export type Resolved =
  | { readonly _tag: "NotInTeam"; readonly result: NotInTeamResult }
  | { readonly _tag: "InTeam"; readonly context: TeamContext };

const notInTeam = (result: NotInTeamResult): Resolved => ({ _tag: "NotInTeam", result });
const inTeamWith = (context: TeamContext): Resolved => ({ _tag: "InTeam", context });

export const fromService = (operation: string) => (error: TeamServiceError) =>
  error._tag === "TeamStorageError"
    ? new TeamToolFailedError({ operation, cause: error })
    : new TeamToolError({ detail: error.message });

export const makeTeamResolver = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
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

  const resolve = (scope: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
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

      const membership = yield* teams
        .openTeam({ teamFile, checkout: teamRoot })
        .pipe(Effect.mapError(fromService("lookup")));
      if (membership.status !== "member") return notInTeam(notInTeamReason(teamFile, membership));
      return inTeamWith({
        teamFile,
        member: membership.member,
        thread: { environmentId: scope.environmentId, threadId: scope.threadId },
        teamRoot,
        workingFolder,
      });
    });

  return { resolve };
});
