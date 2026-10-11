/**
 * A real v2 orchestrator for the team layer's tests (fork-only): in-memory
 * SQLite, a temp T3 home, and a Codex instance whose sessions are never
 * opened. Built like upstream's `orchestration-v2/DelegatedCompletionDelivery.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-" });

const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
);

const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("team tests open no provider session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:team-test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const noEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: false,
};

/** The orchestrator, the project service, the event sink, MCP sessions, the provider registry, the server config and Node's platform. */
export const layer = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () => Effect.succeed(noEnrichment),
      request: () => Effect.void,
      getAvailable: () => Effect.succeed(noEnrichment),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provideMerge(layerProviderInstanceRegistry),
  Layer.provideMerge(layerPlatform),
);

/** Creates a project and a chat in it, with no run. */
export const seedThread = (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const existing = yield* projects.getById(input.projectId);
    if (existing._tag === "None") {
      yield* projects.create({
        commandId: CommandId.make(`command:team-project:${input.projectId}`),
        projectId: input.projectId,
        title: "Team project",
        workspaceRoot: input.workspaceRoot,
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:team-thread:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Team chat",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
    });
  });

/** The chat's provider thread, which a run needs before it can be projected. */
const providerThreadIdOf = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${threadId}`);

/**
 * Puts a run of `threadId` in `status`, the way the run executor records it:
 * "running" makes it the chat's `activeRunId`, "completed" ends it.
 */
export const setRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: "running" | "completed";
  /** ISO times; now when left out. */
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** The message the run started with. */
  readonly userMessageId?: MessageId;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const startedAt = input.startedAt === undefined ? now : DateTime.makeUnsafe(input.startedAt);
    const completedAt =
      input.completedAt === undefined ? now : DateTime.makeUnsafe(input.completedAt);
    const providerThreadId = providerThreadIdOf(input.threadId);
    const rootNodeId = NodeId.make(`node:${input.runId}`);
    const commandId = CommandId.make(`command:team-run:${input.runId}:${input.status}`);
    yield* eventSink.write({
      commandId,
      events: [
        {
          id: EventId.make(`event:team-provider-thread:${input.runId}:${input.status}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:team-run:${input.runId}:${input.status}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
            rootNodeId,
            activeAttemptId: null,
            status: input.status,
            requestedAt: startedAt,
            startedAt,
            completedAt: input.status === "completed" ? completedAt : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

/**
 * `ThreadManagementService` that only records what it is asked to dispatch:
 * the team layer's turns stop at the dispatch, since tests open no provider.
 */
export const layerRecordingDispatch = (
  dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>,
) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) =>
      Ref.update(dispatched, (commands) => [...commands, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] }),
      ),
  });
