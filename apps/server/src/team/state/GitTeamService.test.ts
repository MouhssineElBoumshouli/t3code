// @effect-diagnostics nodeBuiltinImport:off - synchronous renames to take origin offline.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  TEAM_AUTOMATIC_NOTE_MAX_FILES,
  TEAM_STATE_REF,
  TeamFile,
  TeamId,
  type TeamLogin,
  TeamMemberId,
  type TeamThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { git } from "../testing/gitRepo.ts";
import type { TeamMembership } from "../TeamService.ts";
import * as GitTeamService from "./GitTeamService.ts";
import * as TeamHost from "./TeamHost.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-team-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const teamFile = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
const ownerEnvironment = EnvironmentId.make("env-owner");
const friendEnvironment = EnvironmentId.make("env-friend");
const threadA = { environmentId: ownerEnvironment, threadId: ThreadId.make("thread-a") };
const threadB = { environmentId: ownerEnvironment, threadId: ThreadId.make("thread-b") };
const friendThread = { environmentId: friendEnvironment, threadId: ThreadId.make("thread-f") };

const signedIn = (login: string): TeamHost.TeamHostLogin => ({
  status: "signedIn",
  login: login as TeamLogin,
  override: false,
});

/** A host that answers from fixed values; the state itself goes over `file://`. */
const fakeHost = (
  login: TeamHost.TeamHostLogin,
  access: TeamHost.TeamHostRepoAccess = { status: "found", canPush: true, isPublic: false },
) =>
  TeamHost.TeamHost.of({
    login: () => Effect.succeed(login),
    repoAccess: () => Effect.succeed(access),
    refChanged: () => Effect.die("not used here"),
  });

/**
 * A local bare `origin` over `file://` (real Git, no network), a checkout
 * whose `origin` it is, and T3 servers that each have their own home.
 */
const bench = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-team-" });
  const origin = path.join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", origin);
  const checkout = path.join(root, "project");
  git(root, "init", "--quiet", checkout);
  git(checkout, "remote", "add", "origin", `file://${origin}`);

  /** Pushes to origin's state ref, as seen by a wrapped Git driver. */
  const pushes: Array<string> = [];
  let pushLanded: Deferred.Deferred<void> | null = null;

  /** Network Git commands of the state repos, as `<server>:<command>`. */
  const networkCalls: Array<string> = [];
  const countCalls = (call: string) => networkCalls.filter((made) => made === call).length;

  const server = (input: {
    readonly name: string;
    readonly environmentId: EnvironmentId;
    readonly host: TeamHost.TeamHost["Service"];
    readonly locate?: GitTeamService.GitTeamServiceOptions["locate"];
    readonly onPoll?: GitTeamService.GitTeamServiceOptions["onPoll"];
  }) =>
    Effect.gen(function* () {
      const real = yield* GitVcsDriver.GitVcsDriver;
      const recording: GitVcsDriver.GitVcsDriver["Service"] = {
        ...real,
        execute: (execute) => {
          const command = execute.args[0] ?? "";
          if (["fetch", "ls-remote", "push"].includes(command)) {
            networkCalls.push(`${input.name}:${command}`);
          }
          return command !== "push"
            ? real.execute(execute)
            : real.execute(execute).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    pushes.push(input.name);
                    if (pushLanded !== null) yield* Deferred.succeed(pushLanded, undefined);
                  }),
                ),
              );
        },
      };
      return yield* GitTeamService.make({
        environmentId: input.environmentId,
        stateDirectory: path.join(root, input.name, "team"),
        locate: input.locate,
        onPoll: input.onPoll,
      }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, recording),
        Effect.provideService(TeamHost.TeamHost, input.host),
      );
    });

  const ownerServer = () =>
    server({
      name: "owner",
      environmentId: ownerEnvironment,
      host: fakeHost(signedIn("Mouhssine")),
    });
  const friendServer = () =>
    server({
      name: "friend",
      environmentId: friendEnvironment,
      host: fakeHost(signedIn("Friend")),
    });

  /** Commits on origin's state ref, newest first. */
  const originLog = () =>
    git(origin, "rev-list", TEAM_STATE_REF)
      .split("\n")
      .filter((line) => line.length > 0);
  const originFile = (file: string) => git(origin, "show", `${TEAM_STATE_REF}:${file}`);
  /** The state ref's commit on origin; null when it has none. */
  const originTip = () =>
    git(origin, "for-each-ref", "--format=%(objectname)", TEAM_STATE_REF) || null;
  const takeOffline = () => NodeFS.renameSync(origin, `${origin}.offline`);
  const bringOnline = () => NodeFS.renameSync(`${origin}.offline`, origin);
  /** Resolves when the next push lands. */
  const nextPush = Effect.gen(function* () {
    const landed = yield* Deferred.make<void>();
    pushLanded = landed;
    return landed;
  });

  return {
    root,
    checkout,
    server,
    ownerServer,
    friendServer,
    originLog,
    originFile,
    takeOffline,
    bringOnline,
    nextPush,
    pushes,
    originTip,
    countCalls,
  };
});

const memberOf = (membership: TeamMembership) => {
  if (membership.status !== "member") {
    return assert.fail(`expected a member, got ${JSON.stringify(membership)}`);
  }
  return membership.member;
};

/** The owner's server with the team started on origin. */
const setUpTeam = Effect.gen(function* () {
  const b = yield* bench;
  const teams = yield* b.ownerServer();
  const started = yield* teams.ensureTeam({ teamFile, checkout: b.checkout });
  return { ...b, teams, owner: memberOf(started.membership) };
});

/** The owner's and a friend's servers in one team. */
const setUpTwo = Effect.gen(function* () {
  const set = yield* setUpTeam;
  const friendTeams = yield* set.friendServer();
  const friend = memberOf(yield* friendTeams.openTeam({ teamFile, checkout: set.checkout }));
  yield* friendTeams.sync(teamFile.teamId);
  yield* set.teams.sync(teamFile.teamId);
  return { ...set, friendTeams, friend };
});

describe("GitTeamService (the TeamService behaviour, on Git)", () => {
  it.effect("creates a team once, with its creator as owner, and returns it unchanged after", () =>
    Effect.gen(function* () {
      const b = yield* bench;
      const teams = yield* b.ownerServer();
      const first = yield* teams.ensureTeam({ teamFile, checkout: b.checkout });
      assert.isTrue(first.created);
      const owner = memberOf(first.membership);
      assert.equal(owner.memberId, "Mouhssine");
      assert.equal(owner.role, "owner");
      const team = Option.getOrThrow(yield* teams.getTeam(teamFile.teamId));
      assert.equal(team.name, "Core");
      // Started on origin at once, with team.json and the creator's writer file.
      assert.lengthOf(b.originLog(), 1);
      assert.include(b.originFile("team.json"), '"createdBy": "Mouhssine"');

      const second = yield* teams.ensureTeam({
        teamFile: TeamFile.make({ teamId: teamFile.teamId, name: "Renamed" }),
        checkout: b.checkout,
      });
      assert.isFalse(second.created);
      assert.deepEqual(Option.getOrThrow(yield* teams.getTeam(teamFile.teamId)), team);
      assert.deepEqual(memberOf(second.membership), owner);
      assert.lengthOf(yield* teams.listMembers(teamFile.teamId), 1);
      assert.lengthOf(b.originLog(), 1, "nothing new to push");

      // Another person's server joins as a plain member, by opening the team.
      const friendTeams = yield* b.friendServer();
      const friend = memberOf(yield* friendTeams.openTeam({ teamFile, checkout: b.checkout }));
      assert.equal(friend.role, "member");
      yield* friendTeams.sync(teamFile.teamId);
      yield* teams.sync(teamFile.teamId);
      assert.deepEqual(
        (yield* teams.listMembers(teamFile.teamId)).map((member) => [member.memberId, member.role]),
        [
          ["Friend", "member"],
          ["Mouhssine", "owner"],
        ],
      );
      assert.sameMembers(
        (yield* teams.listActivity(teamFile.teamId)).map((item) => item.summary),
        ["Mouhssine created team Core.", "Friend joined the team."],
      );
      assert.isTrue(Option.isNone(yield* teams.getTeam(TeamId.make("missing"))));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("claims paths and reports overlaps with other threads only", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const first = yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["./src/auth/", "src\\auth\\login.ts", "docs/readme.md"],
        note: "  login flow  ",
      });
      assert.deepEqual(first.claim.paths, ["src/auth", "src/auth/login.ts", "docs/readme.md"]);
      assert.equal(first.claim.note, "login flow");
      assert.deepEqual(first.overlaps, []);
      assert.isTrue(first.confirmed);

      // Same thread claiming more is not an overlap with itself.
      const again = yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/auth/session.ts"],
      });
      assert.deepEqual(again.overlaps, []);

      // Another thread: a file inside a claimed folder overlaps; a sibling folder does not.
      const other = yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadB,
        paths: ["src/auth/login.ts", "src/authz/rules.ts"],
      });
      assert.deepEqual(
        other.overlaps.map((overlap) => [overlap.claim.claimId, overlap.paths]),
        [[first.claim.claimId, ["src/auth", "src/auth/login.ts"]]],
      );
      assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("releases some paths, then all of a thread's claims", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/a.ts", "src/lib/b.ts", "test/c.ts"],
      });
      yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadB,
        paths: ["src/a.ts"],
      });

      // Releasing a folder releases the paths claimed inside it.
      const partial = yield* teams.releasePaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/lib"],
      });
      assert.lengthOf(partial, 1);
      assert.deepEqual(partial[0]!.paths, ["src/a.ts", "test/c.ts"]);
      assert.isNull(partial[0]!.releasedAt);

      const all = yield* teams.releasePaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
      });
      assert.lengthOf(all, 1);
      assert.isNotNull(all[0]!.releasedAt);

      assert.deepEqual(
        (yield* teams.listActiveClaims(teamFile.teamId)).map((claim) => claim.thread.threadId),
        [threadB.threadId],
      );
      // Nothing left to release is not an error.
      assert.deepEqual(
        yield* teams.releasePaths({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
        }),
        [],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects claims that name the whole repo, leave it, or come from someone else", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const claim = (paths: ReadonlyArray<string>, memberId = owner.memberId) =>
        teams
          .claimPaths({ teamId: teamFile.teamId, memberId, thread: threadA, paths })
          .pipe(Effect.flip);

      assert.equal((yield* claim(["."]))._tag, "TeamClaimPathsInvalidError");
      assert.equal((yield* claim(["/"]))._tag, "TeamClaimPathsInvalidError");
      assert.equal((yield* claim(["src/../../etc"]))._tag, "TeamClaimPathsInvalidError");
      assert.equal((yield* claim([]))._tag, "TeamClaimPathsInvalidError");
      // A server writes only as the login it opened the team as.
      assert.equal(
        (yield* claim(["src/a.ts"], TeamMemberId.make("stranger")))._tag,
        "TeamMemberNotFoundError",
      );
      assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates a task, links it to a thread and moves it", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const task = yield* teams.createTask({
        teamId: teamFile.teamId,
        actorMemberId: owner.memberId,
        title: "  Add login  ",
        paths: ["src/auth/"],
        note: "Use the new session API.",
      });
      assert.equal(task.title, "Add login");
      assert.equal(task.status, "todo");
      assert.deepEqual(task.paths, ["src/auth"]);
      assert.isNull(task.thread);

      yield* TestClock.adjust("1 second");
      const started = yield* teams.updateTask({
        teamId: teamFile.teamId,
        taskId: task.taskId,
        actorMemberId: owner.memberId,
        status: "in_progress",
        thread: threadA,
        ownerMemberId: owner.memberId,
      });
      assert.equal(started.status, "in_progress");
      assert.deepEqual(started.thread, threadA);
      assert.equal(started.ownerMemberId, owner.memberId);
      assert.equal(started.note, "Use the new session API.");
      assert.notEqual(started.updatedAt, task.updatedAt);

      const cleared = yield* teams.updateTask({
        teamId: teamFile.teamId,
        taskId: task.taskId,
        actorMemberId: owner.memberId,
        note: null,
      });
      assert.isNull(cleared.note);
      assert.equal(cleared.status, "in_progress");

      const forThread = yield* teams.findTaskForThread(teamFile.teamId, threadA);
      assert.equal(Option.getOrThrow(forThread).taskId, task.taskId);
      assert.isTrue(Option.isNone(yield* teams.findTaskForThread(teamFile.teamId, threadB)));
      assert.lengthOf(yield* teams.listTasks(teamFile.teamId), 1);

      const missing = yield* teams
        .updateTask({
          teamId: teamFile.teamId,
          taskId: task.taskId.replace("-", "x") as typeof task.taskId,
          actorMemberId: owner.memberId,
          status: "done",
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "TeamTaskNotFoundError");
      const strangerOwner = yield* teams
        .updateTask({
          teamId: teamFile.teamId,
          taskId: task.taskId,
          actorMemberId: owner.memberId,
          ownerMemberId: TeamMemberId.make("stranger"),
        })
        .pipe(Effect.flip);
      assert.equal(strangerOwner._tag, "TeamMemberNotFoundError");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates a task already started on a thread", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const task = yield* teams.createTask({
        teamId: teamFile.teamId,
        actorMemberId: owner.memberId,
        title: "Fix search",
        ownerMemberId: owner.memberId,
        status: "in_progress",
        thread: threadA,
      });
      assert.equal(task.status, "in_progress");
      assert.deepEqual(task.thread, threadA);
      const forThread = yield* teams.findTaskForThread(teamFile.teamId, threadA);
      assert.equal(Option.getOrThrow(forThread).taskId, task.taskId);
      const [created] = yield* teams.listActivity(teamFile.teamId, { limit: 1 });
      assert.deepEqual(created?.thread, threadA);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("writes handoff notes with files and commit, and caps them at 150 words", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const handoff = yield* teams.writeHandoff({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        changed: "Login form posts to the new endpoint.",
        left: "Error states.",
        risks: "",
        files: ["./src/auth/login.ts"],
        commit: "abc1234",
        // Keys are normalized like files; hashes of files not in the note are dropped.
        fileHashes: { "./src/auth/login.ts": "f00d", "src/other.ts": "beef" },
      });
      assert.equal(handoff.changed, "Login form posts to the new endpoint.");
      assert.equal(handoff.left, "Error states.");
      assert.isNull(handoff.risks);
      assert.deepEqual(handoff.files, ["src/auth/login.ts"]);
      assert.equal(handoff.commit, "abc1234");
      assert.deepEqual(handoff.fileHashes, { "src/auth/login.ts": "f00d" });

      yield* TestClock.adjust("1 second");
      yield* teams.writeHandoff({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadB,
        changed: "Other thread.",
        files: [],
      });
      assert.isNull((yield* teams.listHandoffs(teamFile.teamId, { limit: 1 }))[0]?.fileHashes);

      const forThreadA = yield* teams.listHandoffs(teamFile.teamId, { thread: threadA });
      assert.deepEqual(
        forThreadA.map((item) => item.handoffId),
        [handoff.handoffId],
      );
      assert.deepEqual(
        (yield* teams.listHandoffs(teamFile.teamId)).map((item) => item.changed),
        ["Other thread.", "Login form posts to the new endpoint."],
      );

      const tooLong = yield* teams
        .writeHandoff({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          changed: Array.from({ length: 151 }, () => "word").join(" "),
          files: [],
        })
        .pipe(Effect.flip);
      assert.equal(tooLong._tag, "TeamHandoffTooLongError");
      assert.lengthOf(yield* teams.listHandoffs(teamFile.teamId), 2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps one automatic note per thread, updated in place, newest turn's files first",
    () =>
      Effect.gen(function* () {
        const { teams, owner } = yield* setUpTeam;
        const task = yield* teams.createTask({
          teamId: teamFile.teamId,
          actorMemberId: owner.memberId,
          title: "Login page",
          thread: threadA,
        });
        const activityBefore = (yield* teams.listActivity(teamFile.teamId)).length;
        const first = yield* teams.saveAutomaticNote({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          taskId: task.taskId,
          files: ["./src/login.ts", "src/form.ts"],
          commit: "abc1234",
          fileHashes: { "src/login.ts": "aaa1", "src/form.ts": "bbb1" },
        });
        assert.isTrue(first.automatic);
        assert.equal(
          first.changed,
          'Automatic note, not written by the agent: this chat changed 2 files for task "Login page".',
        );

        yield* TestClock.adjust("1 minute");
        const second = yield* teams.saveAutomaticNote({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          taskId: task.taskId,
          files: ["src/api.ts", "src/login.ts"],
          commit: "def5678",
          fileHashes: { "src/login.ts": "aaa2" },
        });
        assert.equal(second.handoffId, first.handoffId);
        assert.deepEqual(second.files, ["src/api.ts", "src/login.ts", "src/form.ts"]);
        assert.deepEqual(second.fileHashes, { "src/login.ts": "aaa2", "src/form.ts": "bbb1" });
        assert.equal(second.commit, "def5678");
        assert.isAbove(Date.parse(second.createdAt), Date.parse(first.createdAt));

        // Another thread gets its own note; a real handoff stays separate and untouched.
        yield* teams.saveAutomaticNote({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadB,
          files: ["docs/a.md"],
        });
        const handoff = yield* teams.writeHandoff({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          changed: "Login form done.",
          files: ["src/login.ts"],
        });
        yield* teams.saveAutomaticNote({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          files: ["src/login.ts"],
        });
        const forThreadA = yield* teams.listHandoffs(teamFile.teamId, { thread: threadA });
        assert.sameDeepMembers(
          forThreadA.map(({ handoffId, automatic, changed }) => ({
            handoffId,
            automatic,
            changed,
          })),
          [
            { handoffId: handoff.handoffId, automatic: false, changed: "Login form done." },
            {
              handoffId: first.handoffId,
              automatic: true,
              changed: "Automatic note, not written by the agent: this chat changed 3 files.",
            },
          ],
        );
        assert.lengthOf(yield* teams.listHandoffs(teamFile.teamId), 3);
        // Automatic notes never write activity lines; the handoff wrote one.
        assert.lengthOf(yield* teams.listActivity(teamFile.teamId), activityBefore + 1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("caps an automatic note's files, and never counts them against the handoff cap", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      const many = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`);
      const note = yield* teams.saveAutomaticNote({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        files: many,
      });
      assert.lengthOf(note.files, TEAM_AUTOMATIC_NOTE_MAX_FILES);
      assert.deepEqual(note.files.slice(0, 2), ["src/file-0.ts", "src/file-1.ts"]);
      const handoff = yield* teams.writeHandoff({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        changed: Array.from({ length: 150 }, () => "word").join(" "),
        files: many,
      });
      assert.isFalse(handoff.automatic);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records each write in the activity feed, newest first", () =>
    Effect.gen(function* () {
      const { teams, owner } = yield* setUpTeam;
      yield* TestClock.adjust("1 second");
      yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/a.ts"],
      });
      yield* TestClock.adjust("1 second");
      const task = yield* teams.createTask({
        teamId: teamFile.teamId,
        actorMemberId: owner.memberId,
        title: "Task",
      });
      yield* TestClock.adjust("1 second");
      yield* teams.updateTask({
        teamId: teamFile.teamId,
        taskId: task.taskId,
        actorMemberId: owner.memberId,
        status: "done",
      });
      yield* TestClock.adjust("1 second");
      yield* teams.writeHandoff({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        changed: "Done.",
        files: [],
      });
      yield* TestClock.adjust("1 second");
      yield* teams.releasePaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
      });

      const activity = yield* teams.listActivity(teamFile.teamId);
      assert.deepEqual(
        activity.map((item) => item.kind),
        [
          "claim.released",
          "handoff.written",
          "task.updated",
          "task.created",
          "claim.added",
          "team.created",
        ],
      );
      assert.equal(activity[2]!.summary, 'Mouhssine moved task "Task" to done.');
      assert.lengthOf(yield* teams.listActivity(teamFile.teamId, { limit: 2 }), 2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("releases a thread's claims when its work ends, only claims made before, once", () =>
    Effect.gen(function* () {
      const { teams, owner, friendTeams, friend } = yield* setUpTwo;
      const claim = (thread: TeamThreadRef, paths: Array<string>) =>
        teams.claimPaths({ teamId: teamFile.teamId, memberId: owner.memberId, thread, paths });
      yield* claim(threadA, ["src/a.ts"]);
      yield* claim(threadA, ["src/b.ts"]);
      yield* claim(threadB, ["src/a.ts"]);
      // Same thread id on another server is another thread.
      yield* friendTeams.claimPaths({
        teamId: teamFile.teamId,
        memberId: friend.memberId,
        thread: { ...threadA, environmentId: friendEnvironment },
        paths: ["x.ts"],
      });
      yield* teams.sync(teamFile.teamId);
      assert.deepEqual(yield* teams.listClaimedThreads(ownerEnvironment), [
        threadA.threadId,
        threadB.threadId,
      ]);

      // Merged at 30s; thread A claims more at 60s, after the merge.
      yield* TestClock.adjust("60 seconds");
      yield* claim(threadA, ["src/c.ts"]);
      const merged = yield* teams.releaseThreadClaims({
        thread: threadA,
        reason: "its pull request merged",
        claimedBefore: "1970-01-01T00:00:30.000Z",
      });
      assert.sameMembers(
        merged.flatMap((released) => released.paths),
        ["src/a.ts", "src/b.ts"],
      );
      assert.isTrue(merged.every((released) => released.releasedAt !== null));
      const [latest] = yield* teams.listActivity(teamFile.teamId, { limit: 1 });
      assert.equal(latest?.kind, "claim.released");
      assert.equal(
        latest?.summary,
        "Released Mouhssine's claims on src/a.ts, src/b.ts: its pull request merged.",
      );

      const archived = yield* teams.releaseThreadClaims({
        thread: threadA,
        reason: "its thread was archived",
      });
      assert.deepEqual(
        archived.flatMap((released) => released.paths),
        ["src/c.ts"],
      );
      const activityCount = (yield* teams.listActivity(teamFile.teamId)).length;
      assert.deepEqual(
        yield* teams.releaseThreadClaims({ thread: threadA, reason: "its thread was deleted" }),
        [],
      );
      assert.lengthOf(yield* teams.listActivity(teamFile.teamId), activityCount);

      assert.sameDeepMembers(
        (yield* teams.listActiveClaims(teamFile.teamId)).map((held) => [
          held.thread.environmentId,
          held.thread.threadId,
        ]),
        [
          [ownerEnvironment, threadB.threadId],
          [friendEnvironment, threadA.threadId],
        ],
      );
      assert.deepEqual(yield* teams.listClaimedThreads(ownerEnvironment), [threadB.threadId]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("GitTeamService (new on Git)", () => {
  it.effect("fetches before a claim, so overlaps include a teammate's claim not seen yet", () =>
    Effect.gen(function* () {
      const { teams, owner, friendTeams, friend } = yield* setUpTwo;
      const theirs = yield* friendTeams.claimPaths({
        teamId: teamFile.teamId,
        memberId: friend.memberId,
        thread: friendThread,
        paths: ["src/auth/login.ts"],
      });
      assert.isTrue(theirs.confirmed);
      // The owner has not synced since; before the claim, it does not know.
      assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 0);

      const mine = yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/auth"],
      });
      assert.isTrue(mine.confirmed);
      assert.deepEqual(
        mine.overlaps.map((overlap) => [String(overlap.claim.memberId), overlap.paths]),
        [["Friend", ["src/auth/login.ts"]]],
      );
      // Reported by the claim itself, so never again as a late overlap on this side.
      yield* teams.sync(teamFile.teamId);
      assert.deepEqual(yield* teams.takeLateOverlaps(teamFile.teamId, threadA), []);
      // The friend claimed first and heard nothing then: they hear of it once now.
      yield* friendTeams.sync(teamFile.teamId);
      const late = yield* friendTeams.takeLateOverlaps(teamFile.teamId, friendThread);
      assert.deepEqual(
        late.map((overlap) => [String(overlap.theirs.memberId), overlap.paths]),
        [["Mouhssine", ["src/auth"]]],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps a claim made offline as not shared yet, then tells both sides of the overlap once",
    () =>
      Effect.gen(function* () {
        const { teams, owner, friendTeams, friend, takeOffline, bringOnline } = yield* setUpTwo;
        takeOffline();
        const mine = yield* teams.claimPaths({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          paths: ["src/a.ts"],
        });
        const theirs = yield* friendTeams.claimPaths({
          teamId: teamFile.teamId,
          memberId: friend.memberId,
          thread: friendThread,
          paths: ["src/a.ts"],
        });
        // Claimed on this computer, not shared yet; overlaps unknown.
        assert.deepEqual([mine.confirmed, mine.overlaps], [false, []]);
        assert.deepEqual([theirs.confirmed, theirs.overlaps], [false, []]);
        assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 1, "kept locally");

        bringOnline();
        assert.isTrue((yield* teams.sync(teamFile.teamId)).confirmed);
        assert.isTrue((yield* friendTeams.sync(teamFile.teamId)).confirmed);
        yield* teams.sync(teamFile.teamId);

        const ownerHears = yield* teams.takeLateOverlaps(teamFile.teamId, threadA);
        const friendHears = yield* friendTeams.takeLateOverlaps(teamFile.teamId, friendThread);
        assert.deepEqual(
          ownerHears.map((overlap) => [overlap.mine.claimId, overlap.theirs.claimId]),
          [[mine.claim.claimId, theirs.claim.claimId]],
        );
        assert.deepEqual(
          friendHears.map((overlap) => [overlap.mine.claimId, overlap.theirs.claimId]),
          [[theirs.claim.claimId, mine.claim.claimId]],
        );
        assert.equal(ownerHears[0]!.key, friendHears[0]!.key);
        // Once: not on the next take, nor after another sync.
        yield* teams.sync(teamFile.teamId);
        assert.deepEqual(yield* teams.takeLateOverlaps(teamFile.teamId, threadA), []);
        assert.deepEqual(yield* friendTeams.takeLateOverlaps(teamFile.teamId, friendThread), []);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pushes writes made close together as one commit, about 2 seconds later", () =>
    Effect.gen(function* () {
      const { teams, owner, originLog, originFile, nextPush } = yield* setUpTeam;
      const before = originLog().length;
      const landed = yield* nextPush;
      const task = yield* teams.createTask({
        teamId: teamFile.teamId,
        actorMemberId: owner.memberId,
        title: "Search page",
      });
      yield* teams.writeHandoff({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        changed: "Started the search page.",
        files: [],
      });
      assert.equal(originLog().length, before, "nothing pushed yet");

      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(landed);
      assert.equal(originLog().length, before + 1, "both writes in one commit");
      const shared = originFile(`writers/Mouhssine/${ownerEnvironment}.json`);
      assert.include(shared, task.taskId);
      assert.include(shared, "Started the search page.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves a teammate's edit of a task the same way on both servers", () =>
    Effect.gen(function* () {
      const { teams, owner, friendTeams, friend } = yield* setUpTwo;
      const task = yield* teams.createTask({
        teamId: teamFile.teamId,
        actorMemberId: owner.memberId,
        title: "Docs",
      });
      yield* teams.sync(teamFile.teamId);
      yield* friendTeams.sync(teamFile.teamId);
      // Same clock on both: the edit is still newer than the version it edits.
      const taken = yield* friendTeams.updateTask({
        teamId: teamFile.teamId,
        taskId: task.taskId,
        actorMemberId: friend.memberId,
        status: "in_progress",
        ownerMemberId: friend.memberId,
      });
      assert.isAbove(Date.parse(taken.updatedAt), Date.parse(task.updatedAt));
      yield* friendTeams.sync(teamFile.teamId);
      yield* teams.sync(teamFile.teamId);
      for (const service of [teams, friendTeams]) {
        const seen = Option.getOrThrow(yield* service.getTask(teamFile.teamId, task.taskId));
        assert.deepEqual([seen.status, seen.ownerMemberId], ["in_progress", "Friend"]);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds its teams and claims again after a restart, without the network", () =>
    Effect.gen(function* () {
      const { teams, owner, takeOffline, ...b } = yield* setUpTeam;
      yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/a.ts"],
      });
      takeOffline();
      const restarted = yield* b.ownerServer();
      assert.deepEqual(yield* restarted.listClaimedThreads(ownerEnvironment), [threadA.threadId]);
      assert.equal(Option.getOrThrow(yield* restarted.getTeam(teamFile.teamId)).name, "Core");
      const released = yield* restarted.releaseThreadClaims({
        thread: threadA,
        reason: "its thread was archived",
      });
      assert.deepEqual(
        released.map((claim) => claim.paths),
        [["src/a.ts"]],
      );
      assert.deepEqual(yield* restarted.listClaimedThreads(ownerEnvironment), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("says why a server is not in the team", () =>
    Effect.gen(function* () {
      const b = yield* bench;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let probes = 0;
      /** Each probe is a fresh server, so no membership is cached. */
      const open = (host: TeamHost.TeamHost["Service"], checkout: string, file = teamFile) =>
        b
          .server({ name: `probe-${(probes += 1)}`, environmentId: ownerEnvironment, host })
          .pipe(Effect.flatMap((teams) => teams.openTeam({ teamFile: file, checkout })));

      // No team state on origin yet.
      assert.deepEqual(yield* open(fakeHost(signedIn("Mouhssine")), b.checkout), {
        status: "noTeamState",
      });
      // No origin remote.
      const bare = path.join(b.root, "no-remote");
      yield* fs.makeDirectory(bare);
      git(bare, "init", "--quiet");
      assert.deepEqual(yield* open(fakeHost(signedIn("Mouhssine")), bare), { status: "noRemote" });
      // Signed out.
      const signedOut = yield* open(
        fakeHost({ status: "signedOut", detail: "Not signed in to github.com in gh." }),
        b.checkout,
      );
      assert.equal(signedOut.status, "signedOut");

      // On a host: no access, or read-only access, is decided before any Git call.
      const hosted = path.join(b.root, "hosted");
      yield* fs.makeDirectory(hosted);
      git(hosted, "init", "--quiet");
      git(hosted, "remote", "add", "origin", "https://github.com/acme/app.git");
      assert.deepEqual(
        yield* open(fakeHost(signedIn("Mouhssine"), { status: "notFound" }), hosted),
        { status: "noAccess" },
      );
      assert.deepEqual(
        yield* open(
          fakeHost(signedIn("Mouhssine"), { status: "found", canPush: false, isPublic: true }),
          hosted,
        ),
        { status: "noPushAccess" },
      );

      // The remote's state belongs to another team.
      const owner = yield* b.ownerServer();
      memberOf((yield* owner.ensureTeam({ teamFile, checkout: b.checkout })).membership);
      const other = TeamFile.make({ teamId: TeamId.make("team-2"), name: "Other" });
      assert.deepEqual(yield* open(fakeHost(signedIn("Friend")), b.checkout, other), {
        status: "otherTeam",
        teamId: teamFile.teamId,
      });
      // A team id that cannot be a folder name is refused.
      const unsafe = TeamFile.make({ teamId: TeamId.make("../escape"), name: "Bad" });
      const error = yield* open(fakeHost(signedIn("Friend")), b.checkout, unsafe).pipe(Effect.flip);
      assert.equal(error._tag, "TeamStorageError");
    }).pipe(Effect.provide(TestLayer)),
  );
});

/** Where the poller tests say the repo lives, so it is checked with ETags as on GitHub. */
const onGitHub = () => ({ host: "github.com", owner: "acme", name: "app" });

type Bench = Effect.Success<typeof bench>;

/**
 * A host that answers ETag checks like GitHub: the ETag is the ref's commit
 * on origin, so it answers "unchanged" until the ref moves. `mode` makes it
 * fail, or say gh cannot check.
 */
const gitHubLikeHost = (b: Bench, login: string) => {
  const state = {
    mode: "ok" as "ok" | "failing" | "noApi",
    /** The commit GitHub reports, when set; else origin's. */
    pinnedSha: null as string | null,
    /** The ETag sent with each check. */
    checks: [] as Array<string | null>,
  };
  const host = TeamHost.TeamHost.of({
    login: () => Effect.succeed(signedIn(login)),
    repoAccess: () => Effect.succeed({ status: "found", canPush: true, isPublic: false }),
    refChanged: (_repo, etag) =>
      Effect.sync((): TeamHost.TeamHostRefCheck => {
        state.checks.push(etag);
        if (state.mode === "failing") return { status: "unavailable", detail: "offline" };
        if (state.mode === "noApi") return { status: "noApi", detail: "gh is not installed." };
        const sha = state.pinnedSha ?? b.originTip();
        if (sha === null) return { status: "missing" };
        return etag === `"${sha}"`
          ? { status: "unchanged" }
          : { status: "current", sha, etag: `"${sha}"` };
      }),
  });
  return { host, state };
};

/** The owner's server, watched by the poller, with the team started on origin. */
const setUpPolledOwner = Effect.gen(function* () {
  const b = yield* bench;
  const owner = gitHubLikeHost(b, "Mouhssine");
  const polls = yield* Queue.unbounded<GitTeamService.TeamPollOutcome>();
  const teams = yield* b.server({
    name: "owner",
    environmentId: ownerEnvironment,
    host: owner.host,
    locate: onGitHub,
    onPoll: (_teamId, outcome) => Queue.offer(polls, outcome).pipe(Effect.asVoid),
  });
  memberOf((yield* teams.ensureTeam({ teamFile, checkout: b.checkout })).membership);
  /** Moves the clock and waits for the owner's next check. */
  const nextCheck = (after: Duration.Input) =>
    TestClock.adjust(after).pipe(Effect.andThen(Queue.take(polls)));
  return { ...b, teams, owner, polls, nextCheck };
});

describe("GitTeamService poller", () => {
  it("waits 15 s, or 60 s with ls-remote, and backs off from 30 s to at most 15 minutes", () => {
    const delay = (mode: GitTeamService.TeamPollMode, failures: number) =>
      Duration.toSeconds(GitTeamService.nextPollDelay({ mode, failures }));
    assert.deepEqual(
      [0, 1, 2, 3, 6, 20].map((failures) => delay("etag", failures)),
      [15, 30, 60, 120, 900, 900],
    );
    assert.equal(delay("lsRemote", 0), 60);
    assert.equal(delay("lsRemote", 1), 30);
  });

  it.effect("checks every 15 seconds and fetches nothing while the ref stays put (304)", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      const fetches = set.countCalls("owner:fetch");

      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      // The first check had no ETag; later ones send the one GitHub gave.
      const etag = `"${set.originTip()}"`;
      assert.deepEqual(set.owner.state.checks, [null, etag, etag]);
      assert.equal(set.countCalls("owner:fetch"), fetches);
      assert.equal(set.countCalls("owner:ls-remote"), 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fetches once when a teammate pushes, and finds their claim and the late overlap", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      const friendTeams = yield* set.friendServer();
      const friend = memberOf(yield* friendTeams.openTeam({ teamFile, checkout: set.checkout }));
      yield* friendTeams.sync(teamFile.teamId);
      // The owner's own claim is pushed with the friend's file already fetched.
      yield* set.teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: TeamMemberId.make("Mouhssine"),
        thread: threadA,
        paths: ["src/auth"],
      });
      // The friend claims the same folder after the owner's last fetch.
      yield* friendTeams.claimPaths({
        teamId: teamFile.teamId,
        memberId: friend.memberId,
        thread: friendThread,
        paths: ["src/auth/login.ts"],
      });
      const fetches = set.countCalls("owner:fetch");
      assert.isFalse(
        (yield* set.teams.listActiveClaims(teamFile.teamId)).some(
          (claim) => claim.memberId === friend.memberId,
        ),
      );

      assert.equal(yield* set.nextCheck("15 seconds"), "fetched");
      assert.equal(set.countCalls("owner:fetch"), fetches + 1);
      const claims = yield* set.teams.listActiveClaims(teamFile.teamId);
      assert.deepEqual(
        claims.filter((claim) => claim.memberId === friend.memberId).map((claim) => claim.paths),
        [["src/auth/login.ts"]],
      );
      const late = yield* set.teams.takeLateOverlaps(teamFile.teamId, threadA);
      assert.lengthOf(late, 1);
      assert.equal(late[0]!.theirs.paths[0], "src/auth/login.ts");

      // One fetch per change: the next checks see the same tip.
      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      assert.equal(set.countCalls("owner:fetch"), fetches + 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fetches again after a fetch failed, even though GitHub then answers 304", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      const friendTeams = yield* set.friendServer();
      memberOf(yield* friendTeams.openTeam({ teamFile, checkout: set.checkout }));
      yield* friendTeams.sync(teamFile.teamId);

      // GitHub says the ref moved, but the fetch cannot reach origin.
      set.owner.state.pinnedSha = set.originTip();
      set.takeOffline();
      assert.equal(yield* set.nextCheck("15 seconds"), "failed");
      set.bringOnline();
      set.owner.state.pinnedSha = null;

      assert.equal(yield* set.nextCheck("30 seconds"), "fetched");
      assert.deepEqual(
        (yield* set.teams.listMembers(teamFile.teamId)).map((member) => member.memberId),
        ["Friend", "Mouhssine"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pushes a claim made offline at its next check once origin is back", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      set.takeOffline();
      const mine = yield* set.teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: TeamMemberId.make("Mouhssine"),
        thread: threadA,
        paths: ["src/offline.ts"],
      });
      assert.isFalse(mine.confirmed);
      const pushes = set.pushes.length;

      // Still offline: the retry fails and backs off like a failed check.
      assert.equal(yield* set.nextCheck("15 seconds"), "failed");
      set.bringOnline();
      assert.equal(yield* set.nextCheck("30 seconds"), "pushed");
      assert.include(
        set.originFile(`writers/Mouhssine/${ownerEnvironment}.json`),
        "src/offline.ts",
      );
      // Retries sync with Git; gh was not asked while the claim waited.
      assert.lengthOf(set.owner.state.checks, 0);

      // Shared: back to ETag checks, nothing more to push.
      assert.equal(yield* set.nextCheck("15 seconds"), "unchanged");
      assert.equal(set.pushes.length, pushes + 1);
      assert.lengthOf(set.owner.state.checks, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pushes a claim a previous run could not, once the team is opened again", () =>
    Effect.gen(function* () {
      const b = yield* bench;
      const firstRun = yield* Scope.make();
      const before = yield* b.ownerServer().pipe(Effect.provideService(Scope.Scope, firstRun));
      const owner = memberOf(
        (yield* before.ensureTeam({ teamFile, checkout: b.checkout })).membership,
      );
      b.takeOffline();
      yield* before.claimPaths({
        teamId: teamFile.teamId,
        memberId: owner.memberId,
        thread: threadA,
        paths: ["src/offline.ts"],
      });
      yield* Scope.close(firstRun, Exit.void);
      b.bringOnline();

      const polls = yield* Queue.unbounded<GitTeamService.TeamPollOutcome>();
      const restarted = yield* b.server({
        name: "owner",
        environmentId: ownerEnvironment,
        host: gitHubLikeHost(b, "Mouhssine").host,
        locate: onGitHub,
        onPoll: (_teamId, outcome) => Queue.offer(polls, outcome).pipe(Effect.asVoid),
      });
      memberOf(yield* restarted.openTeam({ teamFile, checkout: b.checkout }));
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* Queue.take(polls), "pushed");
      assert.include(b.originFile(`writers/Mouhssine/${ownerEnvironment}.json`), "src/offline.ts");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("backs off after failed checks and goes back to 15 seconds after one works", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      set.owner.state.mode = "failing";
      assert.equal(yield* set.nextCheck("15 seconds"), "failed");

      // 30 seconds after the first failure, not 15.
      yield* TestClock.adjust("29 seconds");
      assert.equal(yield* Queue.size(set.polls), 0);
      assert.equal(yield* set.nextCheck("1 second"), "failed");

      // Then 60 seconds.
      yield* TestClock.adjust("59 seconds");
      assert.equal(yield* Queue.size(set.polls), 0);
      set.owner.state.mode = "ok";
      assert.equal(yield* set.nextCheck("1 second"), "unchanged");

      // Back to every 15 seconds.
      yield* TestClock.adjust("14 seconds");
      assert.equal(yield* Queue.size(set.polls), 0);
      assert.equal(yield* set.nextCheck("1 second"), "unchanged");
      assert.lengthOf(set.owner.state.checks, 4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("checks with git ls-remote every 60 seconds when gh cannot check", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      set.owner.state.mode = "noApi";
      assert.equal(yield* set.nextCheck("15 seconds"), "fallback");

      // A teammate joins: the ref moves.
      const friendTeams = yield* set.friendServer();
      memberOf(yield* friendTeams.openTeam({ teamFile, checkout: set.checkout }));
      yield* friendTeams.sync(teamFile.teamId);
      const fetches = set.countCalls("owner:fetch");

      yield* TestClock.adjust("59 seconds");
      assert.equal(yield* Queue.size(set.polls), 0);
      assert.equal(yield* set.nextCheck("1 second"), "fetched");
      assert.equal(set.countCalls("owner:ls-remote"), 1);
      assert.equal(set.countCalls("owner:fetch"), fetches + 1);
      assert.deepEqual(
        (yield* set.teams.listMembers(teamFile.teamId)).map((member) => member.memberId),
        ["Friend", "Mouhssine"],
      );

      assert.equal(yield* set.nextCheck("60 seconds"), "unchanged");
      assert.equal(set.countCalls("owner:ls-remote"), 2);
      // gh was asked once, then never again.
      assert.lengthOf(set.owner.state.checks, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops when the server stops", () =>
    Effect.gen(function* () {
      const b = yield* bench;
      const owner = gitHubLikeHost(b, "Mouhssine");
      const polls = yield* Queue.unbounded<GitTeamService.TeamPollOutcome>();
      const serverScope = yield* Scope.make();
      const teams = yield* b
        .server({
          name: "owner",
          environmentId: ownerEnvironment,
          host: owner.host,
          locate: onGitHub,
          onPoll: (_teamId, outcome) => Queue.offer(polls, outcome).pipe(Effect.asVoid),
        })
        .pipe(Effect.provideService(Scope.Scope, serverScope));
      memberOf((yield* teams.ensureTeam({ teamFile, checkout: b.checkout })).membership);
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* Queue.take(polls), "unchanged");

      yield* Scope.close(serverScope, Exit.void);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(polls), 0);
      assert.lengthOf(owner.state.checks, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not watch a team this server has not opened in this run", () =>
    Effect.gen(function* () {
      const set = yield* setUpPolledOwner;
      // A restart: the team is on disk, not opened yet.
      const restartedPolls = yield* Queue.unbounded<GitTeamService.TeamPollOutcome>();
      const restartedHost = gitHubLikeHost(set, "Mouhssine");
      yield* set.server({
        name: "owner",
        environmentId: ownerEnvironment,
        host: restartedHost.host,
        locate: onGitHub,
        onPoll: (_teamId, outcome) => Queue.offer(restartedPolls, outcome).pipe(Effect.asVoid),
      });
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* Queue.take(restartedPolls), "idle");
      assert.lengthOf(restartedHost.state.checks, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
