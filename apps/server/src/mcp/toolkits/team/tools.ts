/**
 * Team tools (fork-only, see team/DESIGN.md D5). Every agent sees them, so
 * descriptions stay under 40 words and results stay short. A project without
 * `.team/team.json` gets a plain {@link NotInTeamResult}, not an error.
 */
import { TeamTaskStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** A problem the agent can fix or report, shown to it as is. */
export class TeamToolError extends Schema.TaggedError<TeamToolError>()("TeamToolError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** A server-side failure; the cause stays out of the agent's view. */
export class TeamToolFailedError extends Schema.TaggedError<TeamToolFailedError>()(
  "TeamToolFailedError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Team ${this.operation} failed on the server.`;
  }
}

const TeamToolFailure = Schema.Union([TeamToolError, TeamToolFailedError]);

export const NotInTeamResult = Schema.Struct({
  inTeam: Schema.Literal(false),
  message: Schema.String,
});
export type NotInTeamResult = typeof NotInTeamResult.Type;

const ClaimSummary = Schema.Struct({
  who: Schema.String,
  paths: Schema.Array(Schema.String),
  note: Schema.optionalKey(Schema.String),
});

const TaskSummary = Schema.Struct({
  title: Schema.String,
  status: TeamTaskStatus,
  owner: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
});

export const TeamStatusResult = Schema.Struct({
  team: Schema.String,
  you: Schema.String,
  yourTask: Schema.NullOr(TaskSummary),
  /** Newest first, capped. */
  tasks: Schema.Array(TaskSummary),
  /** Other threads' claims, newest first, capped. */
  claims: Schema.Array(ClaimSummary),
  yourClaims: Schema.Array(Schema.String),
  recent: Schema.Array(Schema.String),
  /** How many older items were left out, when any were. */
  omitted: Schema.optionalKey(Schema.String),
});
export type TeamStatusResult = typeof TeamStatusResult.Type;

export const TeamClaimResult = Schema.Struct({
  claimed: Schema.Array(Schema.String),
  released: Schema.Array(Schema.String),
  overlaps: Schema.Array(ClaimSummary),
  message: Schema.String,
});
export type TeamClaimResult = typeof TeamClaimResult.Type;

export const TeamTaskResult = Schema.Struct({
  task: Schema.NullOr(TaskSummary),
  message: Schema.optionalKey(Schema.String),
});
export type TeamTaskResult = typeof TeamTaskResult.Type;

export const TeamHandoffResult = Schema.Struct({
  saved: Schema.Literal(true),
  words: Schema.Int,
  files: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
});
export type TeamHandoffResult = typeof TeamHandoffResult.Type;

const PathList = Schema.Array(Schema.String).annotate({
  description: "Project-relative or full paths inside the project.",
});

const TeamStatusTool = Tool.make("team_status", {
  description:
    "See your team: open tasks, who claimed which paths, and recent activity. Call before starting work.",
  success: Schema.Union([NotInTeamResult, TeamStatusResult]),
  failure: TeamToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Team status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TeamClaimTool = Tool.make("team_claim", {
  description:
    "Claim files or folders before editing ones you have not touched, so teammates know. Returns overlaps with others' claims; coordinate before editing those. release: true releases the paths, or all your claims without paths.",
  parameters: Schema.Struct({
    paths: Schema.optional(PathList),
    note: Schema.optional(Schema.String.annotate({ description: "Why, in a few words." })),
    release: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([NotInTeamResult, TeamClaimResult]),
  failure: TeamToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Claim or release team paths")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const TeamTaskTool = Tool.make("team_task", {
  description:
    "Read this thread's task. Pass status or note to update it. With no task yet, pass title to create one for this thread.",
  parameters: Schema.Struct({
    title: Schema.optional(Schema.String),
    status: Schema.optional(TeamTaskStatus),
    note: Schema.optional(Schema.String.annotate({ description: "Empty string clears it." })),
  }),
  success: Schema.Union([NotInTeamResult, TeamTaskResult]),
  failure: TeamToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Team task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const TeamHandoffTool = Tool.make("team_handoff", {
  description:
    "Save a handoff note for whoever continues this work: what changed, what is left, risks. Max 150 words in all. The current commit is added for you.",
  parameters: Schema.Struct({
    changed: Schema.String,
    left: Schema.optional(Schema.String),
    risks: Schema.optional(Schema.String),
    files: Schema.optional(PathList),
  }),
  success: Schema.Union([NotInTeamResult, TeamHandoffResult]),
  failure: TeamToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Team handoff note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TeamToolkit = Toolkit.make(
  TeamStatusTool,
  TeamClaimTool,
  TeamTaskTool,
  TeamHandoffTool,
);
