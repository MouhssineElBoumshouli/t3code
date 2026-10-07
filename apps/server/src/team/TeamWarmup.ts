/**
 * Team warm-up (fork-only, see team/STORAGE_PLAN.md 3.4): opens the team of
 * every project when the server starts, and of each project added while it
 * runs, so the first turn finds its team already open.
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
import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { findTeamFile } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

export class TeamWarmup extends Context.Service<
  TeamWarmup,
  {
    /** Resolves once the startup pass and every project queued so far are opened. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/team/TeamWarmup") {}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
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

  // Subscribe now, so a project added during the startup pass is not missed.
  const events = yield* engine.subscribeDomainEvents;
  const onEvent = (event: OrchestrationEvent) =>
    event.type === "project.created" ? worker.enqueue(event.payload.workspaceRoot) : Effect.void;

  const startup = snapshots.getProjectShells().pipe(
    Effect.flatMap((projects) =>
      Effect.forEach(projects, (project) => worker.enqueue(project.workspaceRoot), {
        discard: true,
      }),
    ),
    Effect.catch((cause) => Effect.logWarning("Team warm-up could not list projects.", { cause })),
    Effect.ensuring(Deferred.succeed(startupQueued, undefined)),
  );

  yield* forkParked(startup.pipe(Effect.andThen(Stream.runForEach(events, onEvent))));

  return TeamWarmup.of({
    drain: Deferred.await(startupQueued).pipe(Effect.andThen(worker.drain)),
  });
});

export const layer = Layer.effect(TeamWarmup, make);
