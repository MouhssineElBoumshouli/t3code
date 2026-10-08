/**
 * The team feed (fork-only, see team/UI_PLAN.md slice 0): what each team or
 * solo project on this server holds, for the UI's markers and presence chip.
 *
 * A subscriber gets every team that has a project on this server, then one
 * team's view each time it changes (`TeamService.subscribeChanges`). A view
 * equal to the last one sent is not sent again, so a write that saves and
 * then reloads pushes once, and nothing is pushed while nothing changes.
 *
 * Which team a project is in is worked out per change, the way the team
 * tools do it: `.team/team.json` in the project or its repo, else the
 * project's solo team.
 *
 * @module TeamFeed
 */
import {
  type OrchestrationProjectShell,
  TEAM_FEED_LIMITS,
  type TeamFeedEvent,
  type TeamFeedProject,
  TeamFeedTeam,
  type TeamId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { soloTeamIdOf } from "./state/SoloTeam.ts";
import { findTeamFile } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

export class TeamFeed extends Context.Service<
  TeamFeed,
  { readonly subscribe: Stream.Stream<TeamFeedEvent> }
>()("t3/team/TeamFeed") {}

/** A view as text, to tell whether it changed since it was last sent. */
const encodeView = Schema.encodeSync(Schema.fromJsonString(TeamFeedTeam));

/** The first line of a note, cut to a list item. */
export const handoffHeadline = (changed: string) => {
  const line = changed.split("\n", 1)[0]!.trim();
  return line.length <= TEAM_FEED_LIMITS.headline
    ? line
    : `${line.slice(0, TEAM_FEED_LIMITS.headline - 1).trimEnd()}…`;
};

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const path = yield* Path.Path;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  /** The team a project is in, and the project folder relative to the team's root. */
  const teamOfProject = (project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      const found = yield* findTeamFile(project.workspaceRoot);
      if (Option.isSome(found)) {
        const prefix = path
          .relative(found.value.teamRoot, project.workspaceRoot)
          .replaceAll("\\", "/");
        return { teamId: found.value.teamFile.teamId, projectId: project.id, pathPrefix: prefix };
      }
      return {
        teamId: yield* soloTeamIdOf(project.workspaceRoot),
        projectId: project.id,
        pathPrefix: "",
      };
    }).pipe(Effect.provide(fileContext), Effect.option);

  /** Every team with a project on this server, with those projects. */
  const projectsByTeam = snapshots.getProjectShells().pipe(
    Effect.flatMap((projects) => Effect.forEach(projects, teamOfProject)),
    Effect.map((found) => {
      const byTeam = new Map<TeamId, Array<TeamFeedProject>>();
      for (const item of found) {
        if (Option.isNone(item)) continue;
        const { teamId, ...project } = item.value;
        byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), project]);
      }
      return byTeam;
    }),
    Effect.orElseSucceed(() => new Map<TeamId, Array<TeamFeedProject>>()),
  );

  /** One team's view; none when this server has not opened it. */
  const viewOf = (teamId: TeamId, projects: ReadonlyArray<TeamFeedProject>) =>
    Effect.gen(function* () {
      const team = yield* teams.getTeam(teamId);
      if (Option.isNone(team)) return Option.none<TeamFeedTeam>();
      const members = yield* teams.listMembers(teamId);
      const claims = yield* teams.listActiveClaims(teamId);
      const tasks = yield* teams.listTasks(teamId);
      const notes = yield* teams.listHandoffs(teamId);
      const me = yield* teams.currentMember(teamId);
      const solo = yield* teams.isSolo(teamId);
      // Questions to this person they have not answered yet ("Ask", slice 3d).
      const questions =
        solo || Option.isNone(me)
          ? []
          : yield* Effect.gen(function* () {
              const answers = yield* teams.listAnswers(teamId);
              return (yield* teams.listQuestions(teamId)).filter(
                (question) =>
                  question.to.includes(me.value.memberId) &&
                  !answers.some(
                    (answer) =>
                      answer.questionId === question.questionId && answer.by === me.value.memberId,
                  ),
              );
            });
      return Option.some<TeamFeedTeam>({
        teamId,
        name: team.value.name,
        solo,
        projects,
        me: Option.match(me, { onNone: () => null, onSome: (member) => member.memberId }),
        members,
        claims,
        tasks: tasks.filter((task) => task.status !== "done").slice(-TEAM_FEED_LIMITS.tasks),
        handoffs: notes
          .filter((note) => !note.automatic)
          .slice(0, TEAM_FEED_LIMITS.handoffs)
          .map((note) => ({
            handoffId: note.handoffId,
            memberId: note.memberId,
            thread: note.thread,
            headline: handoffHeadline(note.changed),
            files: note.files.slice(0, TEAM_FEED_LIMITS.handoffFiles),
            createdAt: note.createdAt,
          })),
        ...(questions.length === 0 ? {} : { questions }),
        sync: yield* teams.syncState(teamId),
      });
    }).pipe(Effect.orElseSucceed(() => Option.none<TeamFeedTeam>()));

  const subscribe: Stream.Stream<TeamFeedEvent> = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the snapshot is read, so no change is missed.
      const changes = yield* teams.subscribeChanges;
      const sent = new Map<TeamId, string>();

      const byTeam = yield* projectsByTeam;
      const first: Array<TeamFeedTeam> = [];
      for (const [teamId, projects] of byTeam) {
        const view = yield* viewOf(teamId, projects);
        if (Option.isNone(view)) continue;
        first.push(view.value);
        sent.set(teamId, encodeView(view.value));
      }
      const snapshot: TeamFeedEvent = {
        _tag: "snapshot",
        teams: first.toSorted((a, b) => a.name.localeCompare(b.name)),
      };

      const onChange = (teamId: TeamId) =>
        Effect.gen(function* (): Effect.fn.Return<ReadonlyArray<TeamFeedEvent>> {
          const projects = (yield* projectsByTeam).get(teamId);
          const view =
            projects === undefined ? Option.none<TeamFeedTeam>() : yield* viewOf(teamId, projects);
          if (Option.isNone(view)) {
            if (!sent.delete(teamId)) return [];
            return [{ _tag: "removed", teamId } satisfies TeamFeedEvent];
          }
          const encoded = encodeView(view.value);
          if (sent.get(teamId) === encoded) return [];
          sent.set(teamId, encoded);
          return [{ _tag: "team", team: view.value } satisfies TeamFeedEvent];
        });

      return Stream.concat(
        Stream.make(snapshot),
        Stream.fromSubscription(changes).pipe(
          Stream.mapEffect(onChange),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        ),
      );
    }),
  );

  return TeamFeed.of({ subscribe });
});

export const layer = Layer.effect(TeamFeed, make);
