/**
 * The plan card (fork-only, see team/UI_PLAN.md slice 2). When an agent calls
 * `team_plan` before editing, the server appends one thread activity of this
 * kind: the files it expects to change and, for each, who else held it when
 * the plan was checked. Clients draw it as a card in the agent's message.
 */
import * as Schema from "effect/Schema";

import { TeamMemberId, TeamPath, TeamThreadRef } from "./team.ts";

export const TEAM_PLAN_ACTIVITY_KIND = "team.plan";

/** A teammate, or another chat of the same person (always a chat when solo). */
export const TeamPlanHolder = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("member"),
    memberId: TeamMemberId,
    name: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("chat"),
    thread: TeamThreadRef,
  }),
]);
export type TeamPlanHolder = typeof TeamPlanHolder.Type;

export const TeamPlanFile = Schema.Struct({
  /** As the team's claims name it: relative to the repo root. */
  path: TeamPath,
  holders: Schema.Array(TeamPlanHolder),
});
export type TeamPlanFile = typeof TeamPlanFile.Type;

export const TeamPlanActivityPayload = Schema.Struct({
  solo: Schema.Boolean,
  files: Schema.Array(TeamPlanFile),
  /** False when the claims could not be shared yet: teammates' newest claims may be missing. */
  shared: Schema.Boolean,
});
export type TeamPlanActivityPayload = typeof TeamPlanActivityPayload.Type;

/** "3 files planned, checked against claims". */
export const teamPlanSummary = (fileCount: number) =>
  `${fileCount} ${fileCount === 1 ? "file" : "files"} planned, checked against claims`;
