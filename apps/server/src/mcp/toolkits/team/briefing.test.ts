import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TeamFile,
  TeamId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { readTeamBriefing, renderTeamBriefing } from "../../../team/TeamBriefing.ts";
import * as TeamService from "../../../team/TeamService.ts";
import * as McpProviderSession from "../../McpProviderSession.ts";
import { TeamBriefingLive, makeTeamBriefingResolver } from "./briefing.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-a");
const TEAM_ID = TeamId.make("team-1");

function makeProject(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function makeThread(worktreePath: string | null): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
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
}

/** Pretends the provider session for THREAD_ID has the `t3-code` MCP server. */
const attachMcp = () =>
  McpProviderSession.setMcpProviderSession({
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claude"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer test",
    capabilities: new Set(),
  });

const makeFolder = (options: { readonly team: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-briefing-" });
    if (options.team) {
      yield* fs.makeDirectory(path.join(root, ".team"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".team", "team.json"),
        `{ "teamId": "${TEAM_ID}", "name": "Core" }`,
      );
    }
    return root;
  });

const makeDependencies = (workspaceRoot: string, worktreePath: string | null = null) =>
  Layer.mergeAll(
    TeamService.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          threadId === THREAD_ID ? Option.some(makeThread(worktreePath)) : Option.none(),
        ),
      getProjectShellById: () => Effect.succeed(Option.some(makeProject(workspaceRoot))),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: Effect.succeed({
        environmentId: ENVIRONMENT_ID,
        label: "Mouhssine's laptop",
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const briefingIn = (workspaceRoot: string, worktreePath: string | null = null) =>
  Effect.gen(function* () {
    const resolver = yield* makeTeamBriefingResolver;
    return yield* resolver(THREAD_ID);
  }).pipe(Effect.provide(makeDependencies(workspaceRoot, worktreePath)));

const EXPECTED = renderTeamBriefing({
  teamName: "Core",
  memberName: "Mouhssine's laptop",
  rulebookPath: ".team/rulebook.md",
});

describe("team briefing resolver", () => {
  afterEach(() => McpProviderSession.clearAllMcpProviderSessions());

  it.effect("gives no briefing when the project is not in a team", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: false });
      assert.isUndefined(yield* briefingIn(root));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("briefs a thread in a team, registering the team on first use", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      const briefing = yield* Effect.gen(function* () {
        const resolver = yield* makeTeamBriefingResolver;
        const first = yield* resolver(THREAD_ID);
        const members = yield* TeamService.TeamService.pipe(
          Effect.flatMap((teams) => teams.listMembers(TEAM_ID)),
        );
        assert.lengthOf(members, 1);
        return first;
      }).pipe(Effect.provide(makeDependencies(root)));
      assert.strictEqual(briefing, EXPECTED);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("points to the rulebook at the repo root from a project subfolder", () =>
    Effect.gen(function* () {
      attachMcp();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeFolder({ team: true });
      yield* fs.makeDirectory(path.join(repo, ".git"));
      const project = path.join(repo, "packages", "web");
      yield* fs.makeDirectory(project, { recursive: true });
      const briefing = yield* briefingIn(project);
      assert.include(briefing, "Project rules are in ../../.team/rulebook.md;");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the team from the thread's worktree, not the project root", () =>
    Effect.gen(function* () {
      attachMcp();
      const project = yield* makeFolder({ team: false });
      const worktree = yield* makeFolder({ team: true });
      assert.strictEqual(yield* briefingIn(project, worktree), EXPECTED);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives no briefing when the session has no t3-code MCP server", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder({ team: true });
      assert.isUndefined(yield* briefingIn(root));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives no briefing when this server is not a member of the team", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      const briefing = yield* Effect.gen(function* () {
        const teams = yield* TeamService.TeamService;
        yield* teams.ensureTeam({
          teamFile: TeamFile.make({ teamId: TEAM_ID, name: "Core" }),
          canonicalKey: null,
          owner: { environmentId: EnvironmentId.make("someone-else"), displayName: "Host" },
        });
        const resolver = yield* makeTeamBriefingResolver;
        return yield* resolver(THREAD_ID);
      }).pipe(Effect.provide(makeDependencies(root)));
      assert.isUndefined(briefing);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives no briefing, instead of failing, when the team file is broken", () =>
    Effect.gen(function* () {
      attachMcp();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder({ team: false });
      yield* fs.makeDirectory(path.join(root, ".team"));
      yield* fs.writeFileString(path.join(root, ".team", "team.json"), "{ not json");
      assert.isUndefined(yield* briefingIn(root));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serves adapters through readTeamBriefing while the layer is up", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      const inside = yield* readTeamBriefing(THREAD_ID).pipe(
        Effect.provide(TeamBriefingLive.pipe(Layer.provide(makeDependencies(root)))),
      );
      assert.strictEqual(inside, EXPECTED);
      assert.isUndefined(yield* readTeamBriefing(THREAD_ID));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
