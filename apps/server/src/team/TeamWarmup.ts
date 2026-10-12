/**
 * Team warm-up (fork-only, see team/STORAGE_PLAN.md 3.4): opens the team of
 * every project when the server starts, and of each project added while it
 * runs (looked for every 15 s), so the first turn finds its team already open.
 *
 * Why: a turn's briefing gets 2 seconds (`mcp/toolkits/team/briefing.ts`),
 * and the first open of a team on GitHub asks gh who is signed in and whether
 * they can push, then fetches the team state: together about as long. Opened
 * here, a turn's open is a lookup in memory. A turn that comes while the
 * warm-up still runs waits for it instead of asking gh again (the per-team
 * open lock in `GitTeamService`).
 *
 * Opening never starts the team state (only `t3 team init` does). A failure is
 * logged and changes nothing: the turn opens the team itself, as before.
 *
 * @module TeamWarmup
 */
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { findTeamFile } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

/** How often new projects are looked for: upstream has no project event to follow. */
const NEW_PROJECT_CHECK_INTERVAL = Duration.seconds(15);

export class TeamWarmup extends Context.Service<
  TeamWarmup,
  {
    /** Resolves once the team of every project this server has now is opened. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/team/TeamWarmup") {}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const projects = yield* ProjectService.ProjectService;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const warm = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const found = yield* findTeamFile(workspaceRoot);
      if (Option.isNone(found)) return;
      const { teamFile, teamRoot } = found.value;
      const membership = yield* teams.openTeam({ teamFile, checkout: teamRoot });
      yield* Effect.logDebug("Team opened at warm-up.", {
        teamId: teamFile.teamId,
        status: membership.status,
      });
    }).pipe(
      Effect.provide(fileContext),
      Effect.catchCause((cause) =>
        Effect.logWarning("Team warm-up failed; a turn opens the team itself.", {
          workspaceRoot,
          cause,
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(warm);
  const startupQueued = yield* Deferred.make<void>();

  // Each project folder once; the first pass is the startup pass.
  const seen = new Set<string>();
  const queueNewProjects = projects.snapshot.pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        snapshot.projects.filter(
          (project) => project.deletedAt === null && !seen.has(project.workspaceRoot),
        ),
        (project) => {
          seen.add(project.workspaceRoot);
          return worker.enqueue(project.workspaceRoot);
        },
        { discard: true },
      ),
    ),
    Effect.catch((cause) => Effect.logWarning("Team warm-up could not list projects.", { cause })),
  );

  yield* forkParked(
    queueNewProjects.pipe(
      Effect.ensuring(Deferred.succeed(startupQueued, undefined)),
      Effect.andThen(
        queueNewProjects.pipe(Effect.repeat(Schedule.spaced(NEW_PROJECT_CHECK_INTERVAL))),
      ),
    ),
  );

  return TeamWarmup.of({
    // Looks for new projects first, so it covers every project known now.
    drain: Deferred.await(startupQueued).pipe(
      Effect.andThen(queueNewProjects),
      Effect.andThen(worker.drain),
    ),
  });
});

export const layer = Layer.effect(TeamWarmup, make);
