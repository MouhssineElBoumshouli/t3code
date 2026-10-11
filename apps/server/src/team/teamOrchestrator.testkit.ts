/**
 * A real v2 orchestrator for the team layer's tests (fork-only): in-memory
 * SQLite, a temp T3 home, and a Codex instance whose sessions are never
 * opened. Built like upstream's `orchestration-v2/DelegatedCompletionDelivery.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
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

/** The orchestrator, the project service, the event sink, the server config and Node's platform. */
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
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerProviderInstanceRegistry),
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
