import {
  EnvironmentId,
  TEAM_STATE_LIMITS,
  TeamActivityId,
  TeamClaimId,
  TeamHandoffId,
  TeamId,
  type TeamLogin,
  type TeamStateTask,
  type TeamStateTeamFile,
  TeamTaskId,
  type TeamThreadRef,
  type TeamWriterFile,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  addClaim,
  addHandoff,
  addActivity,
  buildTeamView,
  compactWriterFile,
  emptyWriterFile,
  encodeTeamStateTeamFile,
  encodeWriterFile,
  findLateOverlaps,
  overlapKey,
  parseTeamState,
  releasePaths,
  saveAutomaticNote,
  saveTask,
  writerFilePath,
} from "./TeamStateModel.ts";

const team: TeamStateTeamFile = {
  format: 1,
  teamId: TeamId.make("team-1"),
  name: "Demo",
  createdBy: "sara" as TeamLogin,
  createdAt: "2026-10-07T09:00:00.000Z",
};

const start = DateTime.makeUnsafe("2026-10-07T10:00:00.000Z");
const at = (minute: number, seconds = 0) =>
  DateTime.formatIso(DateTime.add(start, { minutes: minute, seconds }));
const daysAfter = (iso: string, days: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { days }));

const writer = (login: string, environmentId: string, displayName = login) =>
  emptyWriterFile({
    login: login as TeamLogin,
    displayName,
    environmentId: EnvironmentId.make(environmentId),
    now: at(0),
  });

const thread = (environmentId: string, threadId: string): TeamThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

let nextId = 0;
const id = (prefix: string) => `${prefix}-${++nextId}`;

const claim = (
  file: TeamWriterFile,
  threadId: string,
  paths: ReadonlyArray<string>,
  minute: number,
) =>
  addClaim(file, {
    claimId: TeamClaimId.make(id("claim")),
    activityId: TeamActivityId.make(id("activity")),
    thread: thread(file.environmentId, threadId),
    paths,
    note: null,
    now: at(minute),
  });

/** The state tree as Git would hand it over: path → contents. */
const tree = (...files: ReadonlyArray<TeamWriterFile>) =>
  new Map<string, string>([
    ["team.json", encodeTeamStateTeamFile(team)],
    ...files.map(
      (file) => [writerFilePath(file.login, file.environmentId), encodeWriterFile(file)] as const,
    ),
  ]);

const viewOf = (files: ReadonlyMap<string, string>) => {
  const parsed = parseTeamState(files);
  assert.isNotNull(parsed.team);
  return { ...buildTeamView(parsed.team!, parsed.writers), warnings: parsed.warnings };
};

const task = (
  overrides: Partial<TeamStateTask> & Pick<TeamStateTask, "updatedAt">,
): TeamStateTask => ({
  taskId: TeamTaskId.make("task-1"),
  title: "Login page",
  status: "todo",
  note: null,
  paths: [],
  owner: null,
  thread: null,
  createdAt: at(0),
  ...overrides,
});

describe("TeamStateModel", () => {
  it("merges two writers' files into one view", () => {
    let sara = claim(writer("sara", "env-sara"), "t1", ["src/auth"], 1).file;
    sara = saveTask(sara, {
      task: task({ updatedAt: at(2) }),
      previous: null,
      activityId: TeamActivityId.make(id("activity")),
    });
    let yassine = claim(writer("yassine", "env-yassine"), "t9", ["src/ui/button.tsx"], 3).file;
    yassine = addHandoff(yassine, {
      note: {
        handoffId: TeamHandoffId.make("note-1"),
        thread: thread("env-yassine", "t9"),
        taskId: null,
        changed: "Made the button.",
        left: null,
        risks: null,
        files: ["src/ui/button.tsx"],
        commit: null,
        fileHashes: null,
        automatic: false,
        createdAt: at(4),
      },
      activityId: TeamActivityId.make(id("activity")),
    });

    const view = viewOf(tree(sara, yassine));

    assert.deepEqual(view.warnings, []);
    assert.deepEqual(
      view.members.map((member) => [member.login, member.role]),
      [
        ["sara", "owner"],
        ["yassine", "member"],
      ],
    );
    assert.deepEqual(
      view.activeClaims.map((active) => [`${active.memberId}`, `${active.teamId}`, active.paths]),
      [
        ["sara", "team-1", ["src/auth"]],
        ["yassine", "team-1", ["src/ui/button.tsx"]],
      ],
    );
    assert.deepEqual(
      view.tasks.map((item) => item.title),
      ["Login page"],
    );
    assert.deepEqual(
      view.notes.map((note) => [`${note.memberId}`, note.changed]),
      [["yassine", "Made the button."]],
    );
    // Newest first, from both writers.
    assert.deepEqual(
      view.activity.map((line) => line.summary),
      [
        "yassine wrote a handoff note.",
        "yassine claimed src/ui/button.tsx.",
        'sara created task "Login page".',
        "sara claimed src/auth.",
      ],
    );
  });

  it("counts one person on two servers as one member with two writers", () => {
    const laptop = claim(writer("sara", "env-laptop", "Sara (old name)"), "t1", ["a.ts"], 1).file;
    const desktop = { ...writer("sara", "env-desktop", "Sara"), lastSyncAt: at(5) };

    const view = viewOf(tree(laptop, desktop));

    assert.equal(view.members.length, 1);
    const [sara] = view.members;
    assert.equal(sara?.login, "sara");
    assert.equal(sara?.displayName, "Sara", "the writer that synced last names the member");
    assert.deepEqual(sara?.environmentIds.map(String), ["env-desktop", "env-laptop"]);
    assert.equal(sara?.lastSyncAt, at(5));
  });

  it("resolves concurrent task edits the same way on every reader", () => {
    const created = task({ updatedAt: at(1) });
    const a = saveTask(writer("ana", "env-a"), {
      task: created,
      previous: null,
      activityId: TeamActivityId.make(id("activity")),
    });
    // Two people move the same card; the later edit wins.
    const b = saveTask(writer("bo", "env-b"), {
      task: { ...created, status: "in_progress", updatedAt: at(3) },
      previous: created,
      activityId: TeamActivityId.make(id("activity")),
    });
    const c = saveTask(writer("cy", "env-c"), {
      task: { ...created, status: "done", updatedAt: at(2) },
      previous: created,
      activityId: TeamActivityId.make(id("activity")),
    });
    // Same time as bo's edit: the larger writer key wins the tie.
    const d = saveTask(writer("bz", "env-d"), {
      task: { ...created, status: "in_review", updatedAt: at(3) },
      previous: created,
      activityId: TeamActivityId.make(id("activity")),
    });

    const orders = [
      [a, b, c, d],
      [d, c, b, a],
      [c, a, d, b],
    ];
    for (const files of orders) {
      const view = viewOf(tree(...files));
      assert.deepEqual(
        view.tasks.map((item) => [`${item.taskId}`, item.status]),
        [["task-1", "in_review"]],
      );
    }
    // Every reader also sees both moves in the activity feed.
    const activity = viewOf(tree(a, b, c, d)).activity.map((line) => line.summary);
    assert.include(activity, 'bo moved task "Login page" to in_progress.');
    assert.include(activity, 'bz moved task "Login page" to in_review.');
  });

  it("keeps a writer file within its caps", () => {
    let file = writer("sara", "env-sara");
    // More active claims than the cap: the newest 200 are kept.
    for (let index = 0; index < TEAM_STATE_LIMITS.claims + 5; index += 1) {
      file = claim(file, `t${index}`, [`f${index}.ts`], 0).file;
    }
    for (let index = 0; index < TEAM_STATE_LIMITS.notes + 5; index += 1) {
      file = addHandoff(file, {
        note: {
          handoffId: TeamHandoffId.make(`note-${index}`),
          thread: thread("env-sara", "t0"),
          taskId: null,
          changed: `Note ${index}.`,
          left: null,
          risks: null,
          files: [],
          commit: null,
          fileHashes: null,
          automatic: false,
          createdAt: at(0, index),
        },
        activityId: TeamActivityId.make(id("activity")),
      });
    }

    assert.equal(file.claims.length, TEAM_STATE_LIMITS.claims);
    assert.equal(file.notes.length, TEAM_STATE_LIMITS.notes);
    assert.equal(file.notes[0]?.changed, "Note 5.", "the oldest notes go first");
    assert.equal(file.notes.at(-1)?.changed, `Note ${TEAM_STATE_LIMITS.notes + 4}.`);
    assert.equal(file.activity.length, TEAM_STATE_LIMITS.activity);
    assert.equal(file.activity.at(-1)?.summary, "sara wrote a handoff note.");

    // Active claims come before released ones when the cap bites.
    let mixed = writer("ana", "env-a");
    mixed = claim(mixed, "old", ["old.ts"], 0).file;
    mixed = releasePaths(mixed, {
      activityId: TeamActivityId.make(id("activity")),
      thread: thread("env-a", "old"),
      now: at(1),
    }).file;
    for (let index = 0; index < TEAM_STATE_LIMITS.claims; index += 1) {
      mixed = claim(mixed, `t${index}`, [`f${index}.ts`], 2).file;
    }
    assert.equal(mixed.claims.length, TEAM_STATE_LIMITS.claims);
    assert.isTrue(mixed.claims.every((item) => item.releasedAt === null));
  });

  it("drops a released claim after 7 days, and keeps it until then", () => {
    let file = claim(writer("sara", "env-sara"), "t1", ["src/a.ts"], 0).file;
    file = claim(file, "t2", ["src/b.ts"], 0).file;
    file = releasePaths(file, {
      activityId: TeamActivityId.make(id("activity")),
      thread: thread("env-sara", "t1"),
      now: at(1),
    }).file;

    const sixDays = compactWriterFile(file, daysAfter(at(1), 6));
    assert.deepEqual(
      sixDays.claims.map((item) => [item.paths, item.releasedAt]),
      [
        [["src/a.ts"], at(1)],
        [["src/b.ts"], null],
      ],
    );
    const eightDays = compactWriterFile(file, daysAfter(at(1), 8));
    assert.deepEqual(
      eightDays.claims.map((item) => item.paths),
      [["src/b.ts"]],
      "the active claim stays however old it is",
    );
    // A write a week later drops it too.
    const later = addActivity(file, {
      activityId: TeamActivityId.make(id("activity")),
      kind: "member.joined",
      summary: "sara is back.",
      thread: null,
      createdAt: daysAfter(at(1), 8),
    });
    assert.equal(later.claims.length, 1);
  });

  it("skips a broken writer file and tolerates a newer one", () => {
    const sara = claim(writer("sara", "env-sara"), "t1", ["src/a.ts"], 1).file;
    const newer = JSON.parse(
      encodeWriterFile(claim(writer("yassine", "env-y"), "t2", ["src/b.ts"], 2).file),
    );
    newer.format = 2;
    newer.mood = "a field this app does not know";
    newer.claims[0].priority = "high";
    newer.tasks.push({ ...task({ updatedAt: at(2) }), status: "blocked" });

    const files = tree(sara);
    files.set("writers/yassine/env-y.json", JSON.stringify(newer));
    files.set("writers/omar/env-o.json", "{ not json");
    files.set("writers/lina/env-l.json", JSON.stringify({ format: 1, login: "lina" }));
    files.set("writers/eve/env-e.json", encodeWriterFile(writer("mallory", "env-e")));
    files.set("README.md", "not a writer file");

    const view = viewOf(files);

    assert.deepEqual(
      view.members.map((member) => member.login),
      ["sara", "yassine"],
    );
    assert.deepEqual(
      view.activeClaims.map((item) => item.paths),
      [["src/a.ts"], ["src/b.ts"]],
    );
    assert.deepEqual(view.tasks, [], "the task with an unknown status is skipped");
    assert.deepEqual(view.warnings, [
      "writers/eve/env-e.json names another writer inside (mallory/env-e); skipped.",
      "writers/lina/env-l.json does not match the writer file format; skipped.",
      "writers/omar/env-o.json is not valid JSON; skipped.",
      "writers/yassine/env-y.json: 1 entry not understood; skipped.",
    ]);

    const noTeam = parseTeamState(new Map([["team.json", "[]"]]));
    assert.isNull(noTeam.team);
    assert.deepEqual(noTeam.warnings, ["team.json does not match the team file format; skipped."]);
  });

  it("finds a late overlap once, from both sides", () => {
    // Both claimed login.ts before either saw the other's claim.
    const sara = claim(writer("sara", "env-sara"), "t1", ["src/auth/login.ts"], 1).file;
    const yassine = claim(writer("yassine", "env-y"), "t2", ["src/auth"], 1).file;
    const view = viewOf(tree(sara, yassine));

    const saraSide = findLateOverlaps(
      view,
      { login: sara.login, environmentId: sara.environmentId },
      new Set(),
    );
    const yassineSide = findLateOverlaps(
      view,
      { login: yassine.login, environmentId: yassine.environmentId },
      new Set(),
    );
    assert.deepEqual(
      saraSide.overlaps.map((overlap) => [
        `${overlap.mine.memberId}`,
        `${overlap.theirs.memberId}`,
        overlap.paths,
      ]),
      [["sara", "yassine", ["src/auth"]]],
    );
    assert.deepEqual(
      yassineSide.overlaps.map((overlap) => [
        `${overlap.mine.memberId}`,
        `${overlap.theirs.memberId}`,
        overlap.paths,
      ]),
      [["yassine", "sara", ["src/auth/login.ts"]]],
    );
    assert.equal(saraSide.overlaps[0]?.key, yassineSide.overlaps[0]?.key);

    // The next sync does not report it again.
    const again = findLateOverlaps(
      view,
      { login: sara.login, environmentId: sara.environmentId },
      saraSide.reported,
    );
    assert.deepEqual(again.overlaps, []);
    assert.deepEqual([...again.reported], [saraSide.overlaps[0]?.key]);

    // An overlap the claim already reported is not reported late.
    const [saraClaim, yassineClaim] = view.activeClaims;
    const known = new Set([overlapKey(saraClaim!.claimId, yassineClaim!.claimId)]);
    assert.deepEqual(
      findLateOverlaps(view, { login: sara.login, environmentId: sara.environmentId }, known)
        .overlaps,
      [],
    );

    // Once a side releases, the pair is forgotten.
    const released = releasePaths(yassine, {
      activityId: TeamActivityId.make(id("activity")),
      thread: thread("env-y", "t2"),
      now: at(2),
    }).file;
    const after = findLateOverlaps(
      viewOf(tree(sara, released)),
      { login: sara.login, environmentId: sara.environmentId },
      saraSide.reported,
    );
    assert.deepEqual(after.overlaps, []);
    assert.equal(after.reported.size, 0);
  });

  it("treats the same person's other server as someone else for late overlaps", () => {
    const laptop = claim(writer("sara", "env-laptop"), "t1", ["src/a.ts"], 1).file;
    const desktop = claim(writer("sara", "env-desktop"), "t2", ["src/a.ts"], 1).file;
    const result = findLateOverlaps(
      viewOf(tree(laptop, desktop)),
      { login: laptop.login, environmentId: laptop.environmentId },
      new Set(),
    );
    assert.deepEqual(
      result.overlaps.map((overlap) => `${overlap.theirs.thread.environmentId}`),
      ["env-desktop"],
    );
  });

  it("keeps one automatic note per thread, newest files first", () => {
    const first = saveAutomaticNote(writer("sara", "env-sara"), {
      handoffId: TeamHandoffId.make("auto-1"),
      thread: thread("env-sara", "t1"),
      task: null,
      files: ["a.ts", "b.ts"],
      fileHashes: { "a.ts": "h-a1", "b.ts": "h-b1" },
      commit: null,
      now: at(1),
    });
    const second = saveAutomaticNote(first.file, {
      handoffId: TeamHandoffId.make("auto-2"),
      thread: thread("env-sara", "t1"),
      task: { taskId: TeamTaskId.make("task-1"), title: "Login page" },
      files: ["b.ts", "c.ts"],
      fileHashes: { "b.ts": "h-b2" },
      commit: "abc",
      now: at(2),
    });

    assert.equal(second.file.notes.length, 1);
    assert.equal(second.note.handoffId, "auto-1");
    assert.deepEqual(second.note.files, ["b.ts", "c.ts", "a.ts"]);
    assert.deepEqual(second.note.fileHashes, { "b.ts": "h-b2", "a.ts": "h-a1" });
    assert.equal(
      second.note.changed,
      'Automatic note, not written by the agent: this chat changed 3 files for task "Login page".',
    );
    assert.equal(second.file.activity.length, 0, "automatic notes are never activity lines");
  });

  it("releases a folder with the paths claimed inside it", () => {
    const file = claim(
      writer("sara", "env-sara"),
      "t1",
      ["src/auth/login.ts", "src/auth/jwt.ts", "docs"],
      1,
    ).file;
    const result = releasePaths(file, {
      activityId: TeamActivityId.make(id("activity")),
      thread: thread("env-sara", "t1"),
      paths: ["src/auth"],
      now: at(2),
    });
    assert.deepEqual(
      result.changed.map((item) => [item.paths, item.releasedAt]),
      [[["docs"], null]],
    );
    assert.equal(
      result.file.activity.at(-1)?.summary,
      "sara released src/auth/login.ts, src/auth/jwt.ts.",
    );
    // Nothing held: nothing changes, and no activity line.
    const none = releasePaths(result.file, {
      activityId: TeamActivityId.make(id("activity")),
      thread: thread("env-sara", "t9"),
      now: at(3),
    });
    assert.equal(none.file, result.file);
  });
});
