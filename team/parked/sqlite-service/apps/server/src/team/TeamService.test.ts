import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  TEAM_AUTOMATIC_NOTE_MAX_FILES,
  TeamFile,
  TeamId,
  TeamMemberId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamService from "./TeamService.ts";

const TestLayer = TeamService.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const withTeamService = <A, E>(effect: Effect.Effect<A, E, TeamService.TeamService>) =>
  effect.pipe(Effect.provide(TestLayer));

const teamFile = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
const ownerEnvironment = EnvironmentId.make("env-owner");
const friendEnvironment = EnvironmentId.make("env-friend");
const threadA = { environmentId: ownerEnvironment, threadId: ThreadId.make("thread-a") };
const threadB = { environmentId: ownerEnvironment, threadId: ThreadId.make("thread-b") };

const setUpTeam = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const { owner } = yield* teams.ensureTeam({
    teamFile,
    canonicalKey: "github.com/acme/app",
    owner: { environmentId: ownerEnvironment, displayName: "Mouhssine" },
  });
  return { teams, owner };
});

describe("TeamService", () => {
  it.effect("creates a team once, with its owner, and returns it unchanged after", () =>
    withTeamService(
      Effect.gen(function* () {
        const teams = yield* TeamService.TeamService;
        const first = yield* teams.ensureTeam({
          teamFile,
          canonicalKey: "github.com/acme/app",
          owner: { environmentId: ownerEnvironment, displayName: "Mouhssine" },
        });
        assert.isTrue(first.created);
        assert.equal(first.team.name, "Core");
        assert.equal(first.team.canonicalKey, "github.com/acme/app");
        assert.equal(first.owner.role, "owner");

        const second = yield* teams.ensureTeam({
          teamFile: TeamFile.make({ teamId: teamFile.teamId, name: "Renamed" }),
          canonicalKey: null,
          owner: { environmentId: ownerEnvironment, displayName: "Someone else" },
        });
        assert.isFalse(second.created);
        assert.deepEqual(second.team, first.team);
        assert.deepEqual(second.owner, first.owner);
        assert.lengthOf(yield* teams.listMembers(teamFile.teamId), 1);

        // A second environment joins as a plain member.
        const friend = yield* teams.ensureTeam({
          teamFile,
          canonicalKey: null,
          owner: { environmentId: friendEnvironment, displayName: "Friend" },
        });
        assert.equal(friend.owner.role, "member");

        const activity = yield* teams.listActivity(teamFile.teamId);
        assert.deepEqual(
          activity.map((item) => item.kind),
          ["team.created"],
        );
        assert.isTrue(Option.isNone(yield* teams.getTeam(TeamId.make("missing"))));
      }),
    ),
  );

  it.effect("claims paths and reports overlaps with other threads only", () =>
    withTeamService(
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
        // `again` holds src/auth/session.ts, which touches neither new path.
        assert.deepEqual(
          other.overlaps.map((overlap) => [overlap.claim.claimId, overlap.paths]),
          [[first.claim.claimId, ["src/auth", "src/auth/login.ts"]]],
        );
        assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 3);
      }),
    ),
  );

  it.effect("releases some paths, then all of a thread's claims", () =>
    withTeamService(
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

        const active = yield* teams.listActiveClaims(teamFile.teamId);
        assert.deepEqual(
          active.map((claim) => claim.thread.threadId),
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
      }),
    ),
  );

  it.effect("rejects claims that name the whole repo, leave it, or come from a non-member", () =>
    withTeamService(
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
        assert.equal(
          (yield* claim(["src/a.ts"], TeamMemberId.make("stranger")))._tag,
          "TeamMemberNotFoundError",
        );
        assert.lengthOf(yield* teams.listActiveClaims(teamFile.teamId), 0);
      }),
    ),
  );

  it.effect("creates a task, links it to a thread and moves it", () =>
    withTeamService(
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
      }),
    ),
  );

  it.effect("creates a task already started on a thread", () =>
    withTeamService(
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
      }),
    ),
  );

  it.effect("writes handoff notes with files and commit, and caps them at 150 words", () =>
    withTeamService(
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

        // Notes without hashes (and every note from before they existed) read back as null.
        assert.isNull((yield* teams.listHandoffs(teamFile.teamId, { limit: 1 }))[0]?.fileHashes);

        const forThreadA = yield* teams.listHandoffs(teamFile.teamId, { thread: threadA });
        assert.deepEqual(
          forThreadA.map((item) => item.handoffId),
          [handoff.handoffId],
        );
        const newestFirst = yield* teams.listHandoffs(teamFile.teamId);
        assert.deepEqual(
          newestFirst.map((item) => item.changed),
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
      }),
    ),
  );

  it.effect(
    "keeps one automatic note per thread, updated in place, newest turn's files first",
    () =>
      withTeamService(
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
            // src/api.ts could not be hashed (a folder, say): no hash for it.
            fileHashes: { "src/login.ts": "aaa2" },
          });
          assert.equal(second.handoffId, first.handoffId);
          assert.deepEqual(second.files, ["src/api.ts", "src/login.ts", "src/form.ts"]);
          // This turn's hashes replace the old ones; earlier files keep theirs.
          assert.deepEqual(second.fileHashes, { "src/login.ts": "aaa2", "src/form.ts": "bbb1" });
          assert.equal(second.commit, "def5678");
          assert.isAbove(Date.parse(second.createdAt), Date.parse(first.createdAt));
          assert.equal(
            second.changed,
            'Automatic note, not written by the agent: this chat changed 3 files for task "Login page".',
          );

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
        }),
      ),
  );

  it.effect("caps an automatic note's files, and never counts them against the handoff cap", () =>
    withTeamService(
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

        // The thread can still write a full 150-word handoff, and only its own words count.
        const handoff = yield* teams.writeHandoff({
          teamId: teamFile.teamId,
          memberId: owner.memberId,
          thread: threadA,
          changed: Array.from({ length: 150 }, () => "word").join(" "),
          files: many,
        });
        assert.isFalse(handoff.automatic);
      }),
    ),
  );

  it.effect("records each write in the activity feed, newest first", () =>
    withTeamService(
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
      }),
    ),
  );
  it.effect("releases a thread's claims when its work ends, only claims made before, once", () =>
    withTeamService(
      Effect.gen(function* () {
        const { teams, owner } = yield* setUpTeam;
        const { owner: friend } = yield* teams.ensureTeam({
          teamFile,
          canonicalKey: null,
          owner: { environmentId: friendEnvironment, displayName: "Friend" },
        });
        const claim = (memberId: TeamMemberId, thread: typeof threadA, paths: Array<string>) =>
          teams.claimPaths({ teamId: teamFile.teamId, memberId, thread, paths });
        yield* claim(owner.memberId, threadA, ["src/a.ts"]);
        yield* claim(owner.memberId, threadA, ["src/b.ts"]);
        yield* claim(owner.memberId, threadB, ["src/a.ts"]);
        // Same thread id on another server is another thread.
        yield* claim(friend.memberId, { ...threadA, environmentId: friendEnvironment }, ["x.ts"]);
        assert.deepEqual(yield* teams.listClaimedThreads(ownerEnvironment), [
          threadA.threadId,
          threadB.threadId,
        ]);

        // Merged at 30s; thread A claims more at 60s, after the merge.
        yield* TestClock.adjust("60 seconds");
        yield* claim(owner.memberId, threadA, ["src/c.ts"]);
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

        const active = yield* teams.listActiveClaims(teamFile.teamId);
        assert.sameDeepMembers(
          active.map((held) => [held.thread.environmentId, held.thread.threadId]),
          [
            [ownerEnvironment, threadB.threadId],
            [friendEnvironment, threadA.threadId],
          ],
        );
        assert.deepEqual(yield* teams.listClaimedThreads(ownerEnvironment), [threadB.threadId]);
      }),
    ),
  );
});
