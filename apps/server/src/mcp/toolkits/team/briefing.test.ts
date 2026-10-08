// @effect-diagnostics nodeBuiltinImport:off - a temp origin per test, made and removed synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as TeamHost from "../../../team/state/TeamHost.ts";
import {
  readTeamBriefing,
  renderSoloBriefing,
  renderTeamBriefing,
} from "../../../team/TeamBriefing.ts";
import * as TeamService from "../../../team/TeamService.ts";
import { git } from "../../../team/testing/gitRepo.ts";
import {
  fakeTeamHost,
  makeTeamOrigin,
  TEST_TEAM_LOGIN,
  testTeamServiceLayer,
  useTeamOrigin,
} from "../../../team/testing/teamState.ts";
import * as McpProviderSession from "../../McpProviderSession.ts";
import { TeamBriefingLive, makeTeamBriefingResolver } from "./briefing.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-a");
const TEAM_ID = TeamId.make("team-1");
const TEAM_FILE = TeamFile.make({ teamId: TEAM_ID, name: "Core" });

/** Per test: the team's `origin` and this server's state folder. */
let testRoot = "";
let originUrl = "";
beforeEach(() => {
  testRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-briefing-origin-"));
  originUrl = makeTeamOrigin(testRoot);
});
afterEach(() => NodeFS.rmSync(testRoot, { recursive: true, force: true }));

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
      useTeamOrigin(root, originUrl);
    }
    return root;
  });

interface DependencyOptions {
  /** Start the team state on `origin` with this server as owner. Default true. */
  readonly startsTeam?: boolean;
  readonly host?: TeamHost.TeamHost["Service"];
}

const makeDependencies = (
  workspaceRoot: string,
  worktreePath: string | null = null,
  options: DependencyOptions = {},
) =>
  Layer.mergeAll(
    testTeamServiceLayer({
      environmentId: ENVIRONMENT_ID,
      stateDirectory: NodePath.join(testRoot, "state"),
      host: options.host,
    }),
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
        label: TEST_TEAM_LOGIN,
        platform: { os: "linux" as const, arch: "x64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    }),
  ).pipe(
    (dependencies) =>
      options.startsTeam === false
        ? dependencies
        : Layer.effectDiscard(
            TeamService.TeamService.pipe(
              Effect.flatMap((teams) =>
                teams.ensureTeam({ teamFile: TEAM_FILE, checkout: worktreePath ?? workspaceRoot }),
              ),
              Effect.orDie,
            ),
          ).pipe(Layer.provideMerge(dependencies)),
    Layer.provideMerge(NodeServices.layer),
  );

const briefingIn = (
  workspaceRoot: string,
  worktreePath: string | null = null,
  options: DependencyOptions = {},
) =>
  Effect.gen(function* () {
    const resolver = yield* makeTeamBriefingResolver;
    return yield* resolver(THREAD_ID);
  }).pipe(Effect.provide(makeDependencies(workspaceRoot, worktreePath, options)));

const EXPECTED = renderTeamBriefing({
  teamName: "Core",
  memberName: TEST_TEAM_LOGIN,
  rulebookPath: ".team/rulebook.md",
});

describe("team briefing resolver", () => {
  afterEach(() => McpProviderSession.clearAllMcpProviderSessions());

  it.effect("gives the solo briefing when the project is not in a team", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: false });
      const briefing = yield* briefingIn(root, null, { startsTeam: false });
      assert.equal(briefing, renderSoloBriefing());
      assert.notInclude(briefing ?? "", "rulebook");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("briefs a thread in a team this server is a member of", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      assert.strictEqual(yield* briefingIn(root), EXPECTED);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Only `t3 team init` starts the team state; a briefing lookup never does.
  it.effect("gives no briefing, and starts nothing, when the remote has no team state", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      const { briefing, team } = yield* Effect.gen(function* () {
        const resolver = yield* makeTeamBriefingResolver;
        const briefing = yield* resolver(THREAD_ID);
        const team = yield* TeamService.TeamService.pipe(
          Effect.flatMap((teams) => teams.getTeam(TEAM_ID)),
        );
        return { briefing, team };
      }).pipe(Effect.provide(makeDependencies(root, null, { startsTeam: false })));
      assert.isUndefined(briefing);
      assert.isTrue(Option.isNone(team));
      assert.equal(git(NodePath.join(testRoot, "origin.git"), "for-each-ref"), "");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("points to the rulebook at the repo root from a project subfolder", () =>
    Effect.gen(function* () {
      attachMcp();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeFolder({ team: true });
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

  it.effect("gives no briefing when this server cannot use the team", () =>
    Effect.gen(function* () {
      attachMcp();
      const root = yield* makeFolder({ team: true });
      // Sara started the team from her server; this one is signed out of GitHub.
      yield* TeamService.TeamService.pipe(
        Effect.flatMap((teams) => teams.ensureTeam({ teamFile: TEAM_FILE, checkout: root })),
        Effect.provide(
          testTeamServiceLayer({
            environmentId: EnvironmentId.make("sara-server"),
            stateDirectory: NodePath.join(testRoot, "sara-state"),
            host: fakeTeamHost("Sara"),
          }),
        ),
      );
      const briefing = yield* briefingIn(root, null, {
        startsTeam: false,
        host: fakeTeamHost(null),
      });
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

  // A turn without it would change the cached prompt prefix (team/VISION.md 6.5).
  it.effect("reuses the thread's last briefing when a lookup fails; not in a team drops it", () =>
    Effect.gen(function* () {
      attachMcp();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder({ team: true });
      const teamJson = path.join(root, ".team", "team.json");
      const [first, broken, notInTeam, brokenAfter] = yield* Effect.gen(function* () {
        const resolver = yield* makeTeamBriefingResolver;
        const first = yield* resolver(THREAD_ID);
        yield* fs.writeFileString(teamJson, "{ not json");
        const broken = yield* resolver(THREAD_ID);
        // A team this server cannot use: the team's id is not on the remote.
        yield* fs.writeFileString(teamJson, `{ "teamId": "team-elsewhere", "name": "Other" }`);
        const notInTeam = yield* resolver(THREAD_ID);
        yield* fs.writeFileString(teamJson, "{ not json");
        const brokenAfter = yield* resolver(THREAD_ID);
        return [first, broken, notInTeam, brokenAfter] as const;
      }).pipe(Effect.provide(makeDependencies(root)));
      assert.strictEqual(first, EXPECTED);
      assert.strictEqual(broken, EXPECTED);
      assert.isUndefined(notInTeam);
      assert.isUndefined(brokenAfter);
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
