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
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as TeamService from "../../../team/TeamService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CLAIM_WHERE, TEAM_STATUS_LIMITS, TeamToolkitHandlersLive } from "./handlers.ts";
import { type NotInTeamResult, TeamToolkit } from "./tools.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const THREAD_C = ThreadId.make("thread-c");
const TEAM_ID = TeamId.make("team-1");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

type ToolName = keyof typeof TeamToolkit.tools;
type ToolResult<Name extends ToolName> = Tool.Success<(typeof TeamToolkit.tools)[Name]>;

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

function makeThread(id: ThreadId, worktreePath: string | null): OrchestrationThreadShell {
  return {
    id,
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

const writeTeamFile = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(root, ".team"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, ".team", "team.json"),
      `{ "teamId": "${TEAM_ID}", "name": "Core" }`,
    );
  });

interface HarnessOptions {
  readonly workspaceRoot: string;
  /** Worktree for every thread; null uses the project root. */
  readonly worktreePath?: string | null;
  /** Worktrees for single threads, over `worktreePath`. */
  readonly worktrees?: Partial<Record<ThreadId, string | null>>;
}

const makeHarness = Effect.fn("makeTeamToolkitHarness")(function* (options: HarnessOptions) {
  const gitCalls = yield* Ref.make<ReadonlyArray<GitVcsDriver.ExecuteGitInput>>([]);
  const teamLayer = TeamService.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const dependencies = Layer.mergeAll(
    teamLayer,
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          threadId === THREAD_A || threadId === THREAD_B || threadId === THREAD_C
            ? Option.some(
                makeThread(threadId, options.worktrees?.[threadId] ?? options.worktreePath ?? null),
              )
            : Option.none(),
        ),
      getProjectShellById: () => Effect.succeed(Option.some(makeProject(options.workspaceRoot))),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: (input) =>
        Ref.update(gitCalls, (calls) => [...calls, input]).pipe(
          Effect.as({
            exitCode: 0 as never,
            stdout: `${COMMIT}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
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
  const context = yield* Layer.build(dependencies);
  const toolkit = yield* TeamToolkit.pipe(
    Effect.provide(TeamToolkitHandlersLive),
    Effect.provide(context),
  );
  const call = <Name extends ToolName>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    threadId: ThreadId = THREAD_A,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map((chunk) => chunk.at(-1)!.result as ToolResult<Name>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: ENVIRONMENT_ID,
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claude"),
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      }),
      Effect.provide(context),
    );
  const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
  return { call, teams, gitCalls };
});

/** A temp project folder; with `team: true` it holds `.team/team.json`. */
const makeProjectFolder = (team: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-tools-" });
    if (team) yield* writeTeamFile(root);
    return root;
  }).pipe(Effect.provide(NodeServices.layer));

const inTeam = <R>(result: R) => {
  assert.isFalse(
    typeof result === "object" && result !== null && "inTeam" in result,
    "expected a team result",
  );
  return result as Exclude<R, NotInTeamResult>;
};

describe("team toolkit", () => {
  it("keeps every tool description under 40 words", () => {
    for (const tool of Object.values(TeamToolkit.tools)) {
      const words = (tool.description ?? "").trim().split(/\s+/u).length;
      assert.isBelow(words, 40, tool.name);
    }
  });

  it.effect("answers every tool with a plain result in a project that is not in a team", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(false);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      const results = [
        yield* call("team_status", {}),
        yield* call("team_claim", { paths: ["src/a.ts"] }),
        yield* call("team_task", { title: "Anything" }),
        yield* call("team_handoff", { changed: "Something." }),
      ];
      for (const result of results) {
        assert.deepEqual(result, {
          inTeam: false,
          message:
            "This project is not in a team, so team tools do nothing here. Carry on without them.",
        });
      }
      assert.isTrue(Option.isNone(yield* teams.getTeam(TEAM_ID)));
    }),
  );

  it.effect("registers the team with this server as owner on first use", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      const status = inTeam(yield* call("team_status", {}));
      assert.equal(status.team, "Core");
      assert.equal(status.you, "Mouhssine's laptop");
      assert.isNull(status.yourTask);
      const members = yield* teams.listMembers(TEAM_ID);
      assert.lengthOf(members, 1);
      assert.equal(members[0]?.role, "owner");
      assert.equal(members[0]?.environmentId, ENVIRONMENT_ID);

      yield* call("team_status", {});
      assert.lengthOf(yield* teams.listMembers(TEAM_ID), 1);
    }),
  );

  it.effect("says so when this server is not a member of a team it already knows", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      yield* teams.ensureTeam({
        teamFile: TeamFile.make({ teamId: TEAM_ID, name: "Core" }),
        canonicalKey: null,
        owner: { environmentId: EnvironmentId.make("someone-else"), displayName: "Host" },
      });
      const result = yield* call("team_status", {});
      assert.deepInclude(result, { inTeam: false });
      assert.include((result as { message: string }).message, "not a member");
    }),
  );

  it.effect("finds the team file at the repo root when the project is a subfolder", () =>
    Effect.gen(function* () {
      const repo = yield* makeProjectFolder(true);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(repo, ".git"));
      const workspaceRoot = path.join(repo, "packages", "web");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const { call } = yield* makeHarness({ workspaceRoot });
      const claim = inTeam(yield* call("team_claim", { paths: ["src/a.ts"] }));
      assert.deepEqual(claim.claimed, ["packages/web/src/a.ts"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("claims full and relative paths, reports overlaps, and releases", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call } = yield* makeHarness({ workspaceRoot: root });
      const other = inTeam(
        yield* call("team_claim", { paths: ["src/auth/"], note: "login work" }, THREAD_B),
      );
      assert.deepEqual(other.overlaps, []);
      assert.equal(other.message, "Claimed. No overlaps.");

      const mine = inTeam(
        yield* call("team_claim", { paths: [`${root}/src/auth/login.ts`, "docs/auth.md"] }),
      );
      assert.deepEqual(mine.claimed, ["src/auth/login.ts", "docs/auth.md"]);
      assert.deepEqual(mine.overlaps, [
        {
          who: "Mouhssine's laptop",
          task: "no task",
          where: CLAIM_WHERE.sameCheckout,
          paths: ["src/auth"],
          note: "login work",
        },
      ]);
      assert.include(mine.message, "Tell the user");

      const outside = yield* call("team_claim", { paths: ["/etc/passwd"] }).pipe(Effect.flip);
      assert.equal(outside._tag, "TeamToolError");
      assert.include(outside.message, `is outside this project (${root})`);
      const none = yield* call("team_claim", {}).pipe(Effect.flip);
      assert.equal(none.message, "Pass paths to claim.");

      const some = inTeam(
        yield* call("team_claim", { paths: [`${root}/docs/auth.md`], release: true }),
      );
      assert.deepEqual(some.released, ["docs/auth.md"]);
      const rest = inTeam(yield* call("team_claim", { release: true }));
      assert.deepEqual(rest.released, ["src/auth/login.ts"]);
      const nothing = inTeam(yield* call("team_claim", { release: true }));
      assert.deepEqual(nothing, {
        claimed: [],
        released: [],
        overlaps: [],
        message: "Nothing to release.",
      });
    }),
  );

  it.effect("reads, creates and updates this thread's task", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call } = yield* makeHarness({ workspaceRoot: root });
      const empty = inTeam(yield* call("team_task", {}));
      assert.deepEqual(empty, {
        task: null,
        message: "This thread has no task yet. Pass title to create one.",
      });
      const statusOnly = inTeam(yield* call("team_task", { status: "done" }));
      assert.isNull(statusOnly.task);

      const created = inTeam(yield* call("team_task", { title: "Add login", note: "Use OAuth." }));
      assert.deepEqual(created, {
        task: {
          title: "Add login",
          status: "in_progress",
          owner: "Mouhssine's laptop",
          note: "Use OAuth.",
        },
        message: "Created this thread's task.",
      });

      const read = inTeam(yield* call("team_task", {}));
      assert.deepEqual(read.task, created.task);

      const moved = inTeam(
        yield* call("team_task", { status: "in_review", note: "", title: "Other" }),
      );
      assert.deepEqual(moved, {
        task: { title: "Add login", status: "in_review", owner: "Mouhssine's laptop" },
        message: "This thread already has a task; the title was not changed.",
      });

      // Another thread has its own task.
      const otherThread = inTeam(yield* call("team_task", {}, THREAD_B));
      assert.isNull(otherThread.task);
    }),
  );

  it.effect("saves a handoff with the working folder's commit, and caps its length", () =>
    Effect.gen(function* () {
      const project = yield* makeProjectFolder(false);
      const worktree = yield* makeProjectFolder(true);
      const { call, teams, gitCalls } = yield* makeHarness({
        workspaceRoot: project,
        worktreePath: worktree,
      });
      yield* call("team_task", { title: "Add login" });
      const saved = inTeam(
        yield* call("team_handoff", {
          changed: "Added the login form.",
          left: "Error states.",
          risks: "Session cookie name may clash.",
          files: [`${worktree}/src/login.tsx`, "src/session.ts"],
        }),
      );
      assert.deepEqual(saved, {
        saved: true,
        words: 11,
        files: ["src/login.tsx", "src/session.ts"],
        commit: COMMIT,
      });
      const calls = yield* Ref.get(gitCalls);
      assert.deepEqual(
        calls.map((input) => [input.cwd, input.args]),
        [[worktree, ["rev-parse", "HEAD"]]],
      );
      const [handoff] = yield* teams.listHandoffs(TEAM_ID);
      const task = yield* teams.findTaskForThread(TEAM_ID, {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_A,
      });
      assert.equal(handoff?.taskId, Option.getOrThrow(task).taskId);

      const tooLong = yield* call("team_handoff", {
        changed: Array.from({ length: 151 }, () => "word").join(" "),
      }).pipe(Effect.flip);
      assert.equal(tooLong._tag, "TeamToolError");
      assert.equal(tooLong.message, "Handoff note has 151 words; the limit is 150.");
      const outside = yield* call("team_handoff", {
        changed: "x",
        files: [`${project}/src/a.ts`],
      }).pipe(Effect.flip);
      assert.include(outside.message, "is outside this project");
    }),
  );

  it.effect("keeps team_status short, dropping the oldest tasks and claims first", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      const status = inTeam(yield* call("team_status", {}));
      const [owner] = yield* teams.listMembers(TEAM_ID);
      const memberId = owner!.memberId;
      const otherThread = { environmentId: ENVIRONMENT_ID, threadId: THREAD_B };
      const extraTasks = 3;
      const extraClaims = 2;
      for (let index = 0; index < TEAM_STATUS_LIMITS.tasks + extraTasks; index++) {
        yield* TestClock.adjust("1 second");
        yield* teams.createTask({
          teamId: TEAM_ID,
          actorMemberId: memberId,
          title: `Task ${index}`,
        });
      }
      yield* teams.createTask({
        teamId: TEAM_ID,
        actorMemberId: memberId,
        title: "Finished",
        status: "done",
      });
      for (let index = 0; index < TEAM_STATUS_LIMITS.claims + extraClaims; index++) {
        yield* TestClock.adjust("1 second");
        yield* teams.claimPaths({
          teamId: TEAM_ID,
          memberId,
          thread: otherThread,
          paths: index === 0 ? ["a", "b", "c", "d", "e", "f", "g"] : [`file-${index}.ts`],
        });
      }
      yield* call("team_claim", { paths: ["mine.ts"] });
      yield* call("team_task", { title: "My task" });

      const full = inTeam(yield* call("team_status", {}));
      assert.equal(status.team, "Core");
      assert.deepEqual(full.yourTask, {
        title: "My task",
        status: "in_progress",
        owner: "Mouhssine's laptop",
      });
      assert.lengthOf(full.tasks, TEAM_STATUS_LIMITS.tasks);
      assert.equal(full.tasks[0]?.title, `Task ${TEAM_STATUS_LIMITS.tasks + extraTasks - 1}`);
      assert.notInclude(
        full.tasks.map((task) => task.title),
        "Task 0",
      );
      assert.notInclude(
        full.tasks.map((task) => task.title),
        "Finished",
      );
      assert.lengthOf(full.claims, TEAM_STATUS_LIMITS.claims);
      assert.deepEqual(full.claims[0]?.paths, [
        `file-${TEAM_STATUS_LIMITS.claims + extraClaims - 1}.ts`,
      ]);
      assert.notDeepInclude(full.claims, {
        who: "Mouhssine's laptop",
        task: "no task",
        where: CLAIM_WHERE.sameCheckout,
        paths: ["file-1.ts"],
      });
      assert.deepEqual(full.yourClaims, ["mine.ts"]);
      assert.lengthOf(full.recent, TEAM_STATUS_LIMITS.activity);
      assert.equal(full.omitted, `${extraTasks} older tasks, ${extraClaims} older claims`);
    }),
  );

  it.effect("caps the paths shown for one claim", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      yield* call("team_status", {});
      const [owner] = yield* teams.listMembers(TEAM_ID);
      yield* teams.claimPaths({
        teamId: TEAM_ID,
        memberId: owner!.memberId,
        thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_B },
        paths: ["a", "b", "c", "d", "e", "f", "g"],
      });
      const status = inTeam(yield* call("team_status", {}));
      assert.deepEqual(status.claims[0]?.paths, ["a", "b", "c", "d", "e", "+2 more"]);
      assert.isUndefined(status.omitted);
    }),
  );

  it.effect("shows each claim's task, so one person's threads can be told apart", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call } = yield* makeHarness({ workspaceRoot: root });
      yield* call("team_task", { title: "Login page" }, THREAD_B);
      yield* call("team_claim", { paths: ["src/login.ts"] }, THREAD_B);
      yield* call("team_claim", { paths: ["src/login.ts"] }, THREAD_C);

      const mine = inTeam(yield* call("team_claim", { paths: ["src/login.ts"] }));
      assert.sameDeepMembers(
        mine.overlaps.map(({ who, task }) => ({ who, task })),
        [
          { who: "Mouhssine's laptop", task: "Login page" },
          { who: "Mouhssine's laptop", task: "no task" },
        ],
      );
      const status = inTeam(yield* call("team_status", {}));
      assert.sameMembers(
        status.claims.map((claim) => claim.task),
        ["Login page", "no task"],
      );
    }),
  );
  it.effect("says another thread's claimed work is in its own copy and not merged yet", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      // Chat A works in its own worktree; chats B and C share the project root.
      const worktree = yield* makeProjectFolder(true);
      const { call } = yield* makeHarness({
        workspaceRoot: root,
        worktrees: { [THREAD_A]: worktree },
      });
      yield* call("team_claim", { paths: ["src/login.ts"] }, THREAD_A);

      const fromB = inTeam(yield* call("team_claim", { paths: ["src/login.ts"] }, THREAD_B));
      assert.deepEqual(
        fromB.overlaps.map(({ where, paths }) => ({ where, paths })),
        [{ where: "their own copy; not merged into yours yet", paths: ["src/login.ts"] }],
      );
      assert.include(fromB.message, "in their own copy and not merged yet");
      assert.include(fromB.message, "Tell the user before editing those.");

      const statusB = inTeam(yield* call("team_status", {}, THREAD_B));
      assert.deepEqual(
        statusB.claims.map(({ where }) => where),
        [CLAIM_WHERE.ownCopy],
      );

      // Chat C shares chat B's checkout, so B's edits are visible to it.
      const fromC = inTeam(yield* call("team_claim", { paths: ["src/login.ts"] }, THREAD_C));
      assert.sameDeepMembers(
        fromC.overlaps.map(({ where }) => where),
        [CLAIM_WHERE.ownCopy, CLAIM_WHERE.sameCheckout],
      );
      const onlyB = inTeam(yield* call("team_claim", { paths: ["docs/b.md"] }, THREAD_B));
      assert.deepEqual(onlyB.overlaps, []);
      const sameCheckout = inTeam(yield* call("team_claim", { paths: ["docs/b.md"] }, THREAD_C));
      assert.deepEqual(
        sameCheckout.overlaps.map(({ where }) => where),
        [CLAIM_WHERE.sameCheckout],
      );
      assert.equal(
        sameCheckout.message,
        "Claimed, but teammates hold overlapping paths. Tell the user before editing those.",
      );
    }),
  );

  it("tells agents to keep claims when done and release only dropped work", () => {
    const claim = TeamToolkit.tools.team_claim.description ?? "";
    assert.include(claim, "Claims last until your work merges or this thread is archived");
    assert.include(claim, "don't release when done");
    assert.include(claim, "release: true only if the user drops the work");
  });
});
