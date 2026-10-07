// @effect-diagnostics nodeBuiltinImport:off - a temp origin and checkout per test, made synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TeamFile,
  TeamId,
  type TeamLogin,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { makeTeamBriefingResolver } from "../mcp/toolkits/team/briefing.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamHost from "./state/TeamHost.ts";
import { renderTeamBriefing } from "./TeamBriefing.ts";
import * as TeamService from "./TeamService.ts";
import { makeTeamOrigin, testTeamServiceLayer, useTeamOrigin } from "./testing/teamState.ts";
import * as TeamWarmup from "./TeamWarmup.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-a");
const TEAM_FILE = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
const LOGIN = "Mouhssine";

let root = "";
let checkout = "";
let stateDirectory = "";
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-warmup-"));
  checkout = NodePath.join(root, "project");
  stateDirectory = NodePath.join(root, "state");
  NodeFS.mkdirSync(NodePath.join(checkout, ".team"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(checkout, ".team", "team.json"),
    JSON.stringify({ teamId: TEAM_FILE.teamId, name: TEAM_FILE.name }),
  );
  useTeamOrigin(checkout, makeTeamOrigin(root));
});
afterEach(() => {
  McpProviderSession.clearAllMcpProviderSessions();
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const projectCreated = (workspaceRoot: string) =>
  ({
    sequence: 1,
    eventId: EventId.make("event-1"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: "2026-09-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: { ...project, workspaceRoot, projectId: PROJECT_ID },
  }) as unknown as OrchestrationEvent;

/**
 * This server after a restart: it joined the team before (its state repo is
 * on disk) and must open it again. gh answers while `ghIsSlow` is false; after
 * that every gh call hangs, like a gh slower than the briefing's 2 seconds.
 */
const restartedServer = Effect.fn("restartedServer")(function* (options: {
  readonly projectsAtStart: ReadonlyArray<OrchestrationProjectShell>;
}) {
  // The earlier run: the team was started from this server.
  yield* TeamService.TeamService.pipe(
    Effect.flatMap((teams) => teams.ensureTeam({ teamFile: TEAM_FILE, checkout })),
    Effect.provide(testTeamServiceLayer({ environmentId: ENVIRONMENT_ID, stateDirectory })),
  );

  const ghIsSlow = yield* Ref.make(false);
  const ghCalls = yield* Queue.unbounded<string>();
  const host = TeamHost.TeamHost.of({
    login: () =>
      Queue.offer(ghCalls, "login").pipe(
        Effect.andThen(Ref.get(ghIsSlow)),
        Effect.flatMap((slow) =>
          slow
            ? Effect.never
            : Effect.succeed({
                status: "signedIn",
                login: LOGIN as TeamLogin,
                override: false,
              } as const),
        ),
      ),
    repoAccess: () => Effect.succeed({ status: "found", canPush: true, isPublic: false }),
    refChanged: () => Effect.succeed({ status: "unchanged" }),
  });
  const events = yield* PubSub.unbounded<OrchestrationEvent>();

  const dependencies = Layer.mergeAll(
    testTeamServiceLayer({ environmentId: ENVIRONMENT_ID, stateDirectory, host }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShells: () => Effect.succeed(options.projectsAtStart),
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
      getProjectShellById: () =>
        Effect.succeed(Option.some({ ...project, workspaceRoot: checkout })),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const context = yield* Layer.build(TeamWarmup.layer.pipe(Layer.provideMerge(dependencies)));

  /** A new turn: its briefing, with the real 2 second limit. */
  const firstTurnBriefing = Effect.gen(function* () {
    McpProviderSession.setMcpProviderSession({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("claude"),
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer test",
      capabilities: new Set(),
    });
    yield* Ref.set(ghIsSlow, true);
    const resolver = yield* makeTeamBriefingResolver.pipe(Effect.provide(context));
    return yield* resolver(THREAD_ID);
  });

  return {
    drain: TeamWarmup.TeamWarmup.pipe(
      Effect.flatMap((warmup) => warmup.drain),
      Effect.provide(context),
    ),
    ghCalls,
    publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
    firstTurnBriefing,
  };
});

const EXPECTED = renderTeamBriefing({
  teamName: TEAM_FILE.name,
  memberName: LOGIN,
  rulebookPath: ".team/rulebook.md",
});

describe("TeamWarmup", () => {
  // Real clock: without the warm-up, the turn would wait on gh and its
  // briefing would hit the real 2 second limit.
  it.live("opens each project's team at start, so the first turn gets its briefing", () =>
    Effect.gen(function* () {
      const server = yield* restartedServer({
        projectsAtStart: [{ ...project, workspaceRoot: checkout }],
      });
      yield* server.drain;

      assert.strictEqual(yield* server.firstTurnBriefing, EXPECTED);
      // The warm-up asked gh once; the turn did not ask again.
      assert.equal(yield* Queue.size(server.ghCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.live("opens the team of a project added while the server runs", () =>
    Effect.gen(function* () {
      const server = yield* restartedServer({ projectsAtStart: [] });
      yield* server.drain;
      assert.equal(yield* Queue.size(server.ghCalls), 0);

      yield* server.publish(projectCreated(checkout));
      // gh was asked: the project is being opened. Wait until it is.
      yield* Queue.take(server.ghCalls);
      yield* server.drain;

      assert.strictEqual(yield* server.firstTurnBriefing, EXPECTED);
      assert.equal(yield* Queue.size(server.ghCalls), 0, "the turn did not ask gh again");
    }).pipe(Effect.scoped),
  );
});
