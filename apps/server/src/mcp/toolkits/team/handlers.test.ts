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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { TEAM_RULEBOOK_TEMPLATE } from "../../../team/TeamProjectFiles.ts";
import * as TeamService from "../../../team/TeamService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { commitAll, git, initRepo, writeFile } from "../../../team/testing/gitRepo.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  CLAIM_WHERE,
  HANDOFF_NOTHING_CHANGED_MESSAGE,
  TEAM_STATUS_LIMITS,
  TeamToolkitHandlersLive,
} from "./handlers.ts";
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
  /** Run real Git instead of the mock (`gitCalls` stays empty). */
  readonly realGit?: boolean;
  /** Register the team with this server as owner, as `t3 team init` does. Default true. */
  readonly hostsTeam?: boolean;
}

const RealGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-memory-git-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

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
    options.realGit === true
      ? RealGitLayer
      : Layer.mock(GitVcsDriver.GitVcsDriver)({
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
  if (options.hostsTeam !== false) {
    yield* teams.ensureTeam({
      teamFile: TeamFile.make({ teamId: TEAM_ID, name: "Core" }),
      canonicalKey: null,
      owner: { environmentId: ENVIRONMENT_ID, displayName: "Mouhssine's laptop" },
    });
  }
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
  return { call, teams, gitCalls, sql };
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
      const { call, teams } = yield* makeHarness({ workspaceRoot: root, hostsTeam: false });
      const results = [
        yield* call("team_status", {}),
        yield* call("team_claim", { paths: ["src/a.ts"] }),
        yield* call("team_task", { title: "Anything" }),
        yield* call("team_handoff", { changed: "Something." }),
        yield* call("team_memory_search", { query: "login" }),
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

  // Security (team/DESIGN.md 7.2 S7, M2.1): a member's server must never make
  // itself owner of a team it only found in a cloned repo.
  it.effect(
    "never registers a team from a cloned repo: every tool says it is hosted elsewhere",
    () =>
      Effect.gen(function* () {
        const root = yield* makeProjectFolder(true);
        const { call, sql } = yield* makeHarness({ workspaceRoot: root, hostsTeam: false });
        const results = [
          yield* call("team_status", {}),
          yield* call("team_claim", { paths: ["src/a.ts"] }),
          yield* call("team_task", { title: "Anything", status: "in_progress" }),
          yield* call("team_handoff", { changed: "Something.", files: ["src/a.ts"] }),
          yield* call("team_memory_search", { query: "login" }),
          yield* call("team_status", {}, THREAD_B),
        ];
        for (const result of results) {
          assert.deepEqual(result, {
            inTeam: false,
            message:
              "This project is in team Core, which is hosted on another T3 server. This server has not joined it, so team tools do nothing here. Joining from another server is not supported yet.",
          });
        }
        const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND substr(name, 1, 5) = 'team_' AND name != 'team_sql_migrations'
      `;
        assert.includeMembers(
          tables.map((table) => table.name),
          [
            "team_teams",
            "team_members",
            "team_claims",
            "team_tasks",
            "team_handoffs",
            "team_activity",
          ],
        );
        for (const { name } of tables) {
          const rows = yield* sql.unsafe<{ readonly count: number }>(
            `SELECT COUNT(*) AS count FROM ${name}`,
          );
          assert.equal(rows[0]?.count, 0, name);
        }
      }),
  );

  it.effect("says so when this server is not a member of a team it already knows", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root, hostsTeam: false });
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

  it.effect("saves a handoff from a chat that changed nothing, but says it was not needed", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call, teams } = yield* makeHarness({ workspaceRoot: root });
      const thread = (threadId: ThreadId) => ({ environmentId: ENVIRONMENT_ID, threadId });

      // The cold start test's Codex note: no files, no claims, no edits in the chat.
      const quiet = inTeam(
        yield* call("team_handoff", {
          changed: "No code changes; reviewed the live team status for a progress update.",
        }),
      );
      assert.equal(quiet.message, HANDOFF_NOTHING_CHANGED_MESSAGE);
      assert.isTrue(quiet.saved);

      // Each sign of real work keeps the message away.
      const namesFiles = inTeam(
        yield* call("team_handoff", { changed: "Looked into it.", files: ["src/a.ts"] }, THREAD_B),
      );
      assert.notProperty(namesFiles, "message");
      yield* call("team_claim", { paths: ["src/b.ts"] }, THREAD_C);
      const holdsClaims = inTeam(yield* call("team_handoff", { changed: "Halfway." }, THREAD_C));
      assert.notProperty(holdsClaims, "message");
      const [owner] = yield* teams.listMembers(TEAM_ID);
      yield* teams.saveAutomaticNote({
        teamId: TEAM_ID,
        memberId: owner!.memberId,
        thread: thread(THREAD_A),
        files: ["src/c.ts"],
        fileHashes: {},
      });
      const editedEarlier = inTeam(yield* call("team_handoff", { changed: "Done with c." }));
      assert.notProperty(editedEarlier, "message");

      const saved = yield* teams.listHandoffs(TEAM_ID);
      assert.lengthOf(
        saved.filter((note) => !note.automatic),
        4,
      );
    }),
  );

  it("asks for handoffs only after edits or stopped work", () => {
    const handoff = TeamToolkit.tools.team_handoff.description ?? "";
    assert.include(handoff, "after editing files, or when the user stops work partway");
    assert.include(handoff, "Not after only answering questions.");
  });

  it.effect(
    "lists the rulebook's do-not-touch items in team_status, only when there are some",
    () =>
      Effect.gen(function* () {
        const root = yield* makeProjectFolder(true);
        const { call } = yield* makeHarness({ workspaceRoot: root });
        const statusOf = () => call("team_status", {}).pipe(Effect.map(inTeam));

        assert.notProperty(yield* statusOf(), "doNotTouch");
        writeFile(root, ".team/rulebook.md", TEAM_RULEBOOK_TEMPLATE);
        assert.notProperty(yield* statusOf(), "doNotTouch");
        writeFile(
          root,
          ".team/rulebook.md",
          "# Rules\n\n## Do not touch\n\n- `data/`: the sample data. A human updates it.\n\n## Decisions\n\n- x\n",
        );
        const status = yield* statusOf();
        assert.deepEqual(status.doNotTouch, ["`data/`: the sample data. A human updates it."]);
        assert.deepEqual(Object.keys(status).slice(0, 3), ["team", "you", "doNotTouch"]);
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
  it.effect("searches handoffs and decisions, best match first, with freshness per copy", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const base = initRepo(root, { "src/login.ts": "v1\n", "src/session.ts": "s1\n" });
      writeFile(
        root,
        ".team/decisions/0001-session-cookie.md",
        `---\ntitle: One session cookie\nauthor: Ana\ndate: 2026-09-20\nfiles: [src/session.ts]\ncommit: ${base}\n---\nThe login and the API share one session cookie.\n`,
      );
      commitAll(root, "decision");
      // Chat B works in its own worktree, made before chat A's work.
      const worktree = path.join(yield* fs.makeTempDirectoryScoped(), "chat-b");
      git(root, "worktree", "add", "--quiet", "-b", "chat-b", worktree);
      const { call } = yield* makeHarness({
        workspaceRoot: root,
        worktrees: { [THREAD_B]: worktree },
        realGit: true,
      });

      // Chat A edits login.ts in the main checkout and leaves it uncommitted.
      writeFile(root, "src/login.ts", "v2\n");
      yield* call("team_handoff", {
        changed: "Login form posts to /api/login.",
        left: "Error states.",
        files: ["src/login.ts"],
      });

      const fromA = inTeam(yield* call("team_memory_search", { query: "login session cookie" }));
      assert.deepEqual(
        fromA.results.map((result) => [result.kind, result.freshness]),
        [
          ["decision", "fresh"],
          ["handoff", "fresh"],
        ],
      );
      const [decision, handoff] = fromA.results;
      assert.deepInclude(decision, {
        says: "One session cookie: The login and the API share one session cookie.",
        who: "Ana",
        when: "2026-09-20",
        files: ["src/session.ts"],
        source: ".team/decisions/0001-session-cookie.md",
      });
      assert.deepInclude(handoff, {
        says: "Login form posts to /api/login. Left: Error states.",
        who: "Mouhssine's laptop",
        files: ["src/login.ts"],
      });
      assert.match(handoff!.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u);
      assert.equal(
        fromA.message,
        "Each mark compares the note with the files in your copy now. Code wins over notes.",
      );

      // Someone changes the file after the handoff.
      writeFile(root, "src/login.ts", "v3\n");
      const afterEdit = inTeam(yield* call("team_memory_search", { query: "src/login.ts" }));
      assert.deepEqual(
        afterEdit.results.map((result) => result.freshness),
        [
          "maybe outdated: content of src/login.ts changed since this note was written (+1 -1 lines)",
        ],
      );

      // Chat B's copy never got chat A's work.
      const fromB = inTeam(yield* call("team_memory_search", { query: "login form" }, THREAD_B));
      assert.deepEqual(
        fromB.results.map((result) => [result.kind, result.freshness]),
        [
          [
            "handoff",
            "not merged yet: this note's version of src/login.ts is not in your copy's history (another chat's uncommitted or unmerged work)",
          ],
          ["decision", "fresh"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps results at 5, works without a decisions folder, and needs keywords", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      const { call } = yield* makeHarness({ workspaceRoot: root });
      for (let index = 1; index <= 7; index++) {
        yield* call("team_handoff", { changed: `Cache step ${index}.` });
        yield* TestClock.adjust("1 second");
      }
      yield* call("team_handoff", { changed: "Payments page." });

      const search = inTeam(yield* call("team_memory_search", { query: "cache" }));
      assert.deepEqual(
        search.results.map((result) => [result.says, result.freshness]),
        [7, 6, 5, 4, 3].map((index) => [
          `Cache step ${index}.`,
          "unknown: the note names no files to check",
        ]),
      );
      assert.equal(
        search.message,
        "2 more matches left out. Each mark compares the note with the files in your copy now. Code wins over notes.",
      );

      const none = inTeam(yield* call("team_memory_search", { query: "billing" }));
      assert.deepEqual(none, {
        results: [],
        message: "No handoff notes or decisions match. Read the code.",
      });
      const empty = yield* call("team_memory_search", { query: "why is the" }).pipe(Effect.flip);
      assert.equal(empty.message, "Pass a few keywords or file paths.");
    }),
  );

  it.effect("shows automatic notes below real handoffs, marked as automatic", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      initRepo(root, { "src/login.ts": "v1\n" });
      const { call, teams } = yield* makeHarness({ workspaceRoot: root, realGit: true });
      yield* call("team_handoff", { changed: "Login form.", files: ["src/login.ts"] }, THREAD_B);
      yield* TestClock.adjust("1 minute");
      const [owner] = yield* teams.listMembers(TEAM_ID);
      // Newer, and matches more of the query, but was not written by an agent.
      yield* teams.saveAutomaticNote({
        teamId: TEAM_ID,
        memberId: owner!.memberId,
        thread: { environmentId: ENVIRONMENT_ID, threadId: THREAD_C },
        files: ["src/login.ts", "src/form.ts"],
        fileHashes: { "src/login.ts": git(root, "hash-object", "src/login.ts") },
      });

      const search = inTeam(yield* call("team_memory_search", { query: "login form src/form.ts" }));
      assert.deepEqual(
        search.results.map(({ kind, says, freshness }) => ({ kind, says, freshness })),
        [
          { kind: "handoff", says: "Login form.", freshness: "fresh" },
          {
            kind: "automatic note",
            says: "Automatic note, not written by the agent: this chat changed 2 files.",
            freshness: "fresh",
          },
        ],
      );
    }),
  );

  it.effect("stores each handoff file's content hash, null for a missing file", () =>
    Effect.gen(function* () {
      const root = yield* makeProjectFolder(true);
      initRepo(root, { "src/a.ts": "a\n" });
      const { call, teams } = yield* makeHarness({ workspaceRoot: root, realGit: true });
      yield* call("team_handoff", {
        changed: "Work.",
        files: ["src/a.ts", "src/gone.ts", "src"],
      });
      const [handoff] = yield* teams.listHandoffs(TEAM_ID);
      assert.deepEqual(handoff?.fileHashes, {
        "src/a.ts": git(root, "hash-object", "src/a.ts"),
        "src/gone.ts": null,
      });
    }),
  );
});
