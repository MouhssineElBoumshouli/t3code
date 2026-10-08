// @effect-diagnostics nodeBuiltinImport:off - temp folders and a local origin, made synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  ProjectId,
  TeamFile,
  TeamId,
  type TeamFeedEvent,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamFeed from "./TeamFeed.ts";
import * as TeamService from "./TeamService.ts";
import { makeTeamOrigin, testTeamServiceLayer, useTeamOrigin } from "./testing/teamState.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_A = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-a") };

const project = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Notes app",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const tempFolder = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    (folder) => Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
  );

/** The team service on a temp home, one project, and the feed's events in a queue. */
const harness = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(
        testTeamServiceLayer({
          environmentId: ENVIRONMENT_ID,
          stateDirectory: yield* tempFolder("t3-team-feed-state-"),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShells: () => Effect.succeed([project(workspaceRoot)]),
        }),
        NodeServices.layer,
      ),
    );
    const teams = yield* TeamService.TeamService.pipe(Effect.provide(context));
    const feed = yield* TeamFeed.make.pipe(Effect.provide(context));
    const events = yield* Queue.unbounded<TeamFeedEvent>();
    const subscribe = Stream.runForEach(feed.subscribe, (event) => Queue.offer(events, event)).pipe(
      Effect.forkScoped,
    );
    return { teams, subscribe, next: Queue.take(events), pending: Queue.size(events) };
  });

const teamOf = (event: TeamFeedEvent) => {
  if (event._tag !== "team") return assert.fail(`expected a team event, got ${event._tag}`);
  return event.team;
};

describe("TeamFeed", () => {
  it.effect("sends a solo project's state, then one view per change", () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder("t3-team-feed-solo-");
      const { teams, subscribe, next } = yield* harness(folder);
      const opened = yield* teams.openSolo({ projectRoot: folder, name: "Notes app" });
      if (opened.status !== "member") return assert.fail("not a member");
      const teamId = opened.team.teamId;
      yield* subscribe;

      const snapshot = yield* next;
      assert.equal(snapshot._tag, "snapshot");
      const [solo] = snapshot._tag === "snapshot" ? snapshot.teams : [];
      assert.deepEqual(
        solo && {
          name: solo.name,
          solo: solo.solo,
          me: solo.me,
          projects: solo.projects,
          sync: solo.sync.status,
        },
        {
          name: "Notes app",
          solo: true,
          me: opened.member.memberId,
          projects: [{ projectId: PROJECT_ID, pathPrefix: "" }],
          sync: "solo",
        },
      );

      yield* teams.claimPaths({
        teamId,
        memberId: opened.member.memberId,
        thread: THREAD_A,
        paths: ["src/a.ts"],
      });
      const claimed = teamOf(yield* next);
      assert.deepEqual(
        claimed.claims.map((claim) => claim.paths),
        [["src/a.ts"]],
      );

      // The claim's save and reload pushed one view: the next event is the handoff's.
      yield* teams.writeHandoff({
        teamId,
        memberId: opened.member.memberId,
        thread: THREAD_A,
        changed: "Added the form.\nMore detail here.",
        files: ["src/a.ts"],
      });
      const handedOff = teamOf(yield* next);
      assert.deepEqual(
        handedOff.handoffs.map((note) => note.headline),
        ["Added the form."],
      );
      assert.lengthOf(handedOff.claims, 1);
    }),
  );

  it.effect("sends a team's members and sync state, with the project's path in the repo", () =>
    Effect.gen(function* () {
      const repo = yield* tempFolder("t3-team-feed-repo-");
      useTeamOrigin(repo, makeTeamOrigin(yield* tempFolder("t3-team-feed-origin-")));
      const teamFile = TeamFile.make({ teamId: TeamId.make("team-1"), name: "Core" });
      NodeFS.mkdirSync(NodePath.join(repo, ".team"));
      NodeFS.writeFileSync(
        NodePath.join(repo, ".team", "team.json"),
        `{ "teamId": "team-1", "name": "Core" }`,
      );
      const web = NodePath.join(repo, "packages", "web");
      NodeFS.mkdirSync(web, { recursive: true });
      const { teams, subscribe, next } = yield* harness(web);
      const started = yield* teams.ensureTeam({ teamFile, checkout: repo });
      assert.equal(started.membership.status, "member");
      yield* subscribe;

      const snapshot = yield* next;
      const [team] = snapshot._tag === "snapshot" ? snapshot.teams : [];
      assert.deepEqual(
        team && {
          solo: team.solo,
          projects: team.projects,
          members: team.members.map((member): string => member.memberId),
          sync: team.sync.status,
        },
        {
          solo: false,
          projects: [{ projectId: PROJECT_ID, pathPrefix: "packages/web" }],
          members: ["Mouhssine"],
          sync: "synced",
        },
      );
      assert.isTrue(Option.isSome(yield* teams.getTeam(teamFile.teamId)));

      // A claim in the team pushes the team's view.
      const member = Option.getOrThrow(yield* teams.currentMember(teamFile.teamId));
      yield* teams.claimPaths({
        teamId: teamFile.teamId,
        memberId: member.memberId,
        thread: THREAD_A,
        paths: ["packages/web/src/a.ts"],
      });
      assert.deepEqual(
        teamOf(yield* next).claims.map((claim) => claim.paths),
        [["packages/web/src/a.ts"]],
      );
    }),
  );
});
