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
  /** The claiming thread's task title, or "no task". */
  task: Schema.String,
  /** Where the claimed work is, so the agent knows why it cannot see it. */
  where: Schema.String,
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
  /** The rulebook's "Do not touch" list, capped; absent when it has none. */
  doNotTouch: Schema.optionalKey(Schema.Array(Schema.String)),
  yourTask: Schema.NullOr(TaskSummary),
  /** Newest first, capped. */
  tasks: Schema.Array(TaskSummary),
  /** Other threads' claims, newest first, capped. */
  claims: Schema.Array(ClaimSummary),
  yourClaims: Schema.Array(Schema.String),
  /** Teammates' claims that overlap yours, found since you claimed; each told once. */
  lateOverlaps: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Other chats' newest written handoff notes, "who, when: first line", capped; absent when none. */
  handoffs: Schema.optionalKey(Schema.Array(Schema.String)),
  recent: Schema.Array(Schema.String),
  /** How many older items were left out, when any were. */
  omitted: Schema.optionalKey(Schema.String),
});
export type TeamStatusResult = typeof TeamStatusResult.Type;

export const TeamClaimResult = Schema.Struct({
  claimed: Schema.Array(Schema.String),
  released: Schema.Array(Schema.String),
  overlaps: Schema.Array(ClaimSummary),
  /** Teammates' claims that overlap this thread's earlier claims, found since; each told once. */
  lateOverlaps: Schema.optionalKey(Schema.Array(Schema.String)),
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
  /** Set when the note looks unneeded: this thread changed no files and holds no claims. */
  message: Schema.optionalKey(Schema.String),
});
export type TeamHandoffResult = typeof TeamHandoffResult.Type;

const MemoryResult = Schema.Struct({
  /** "automatic note": saved after a turn, not written by the agent; ranked below the rest. */
  kind: Schema.Literals(["handoff", "automatic note", "decision"]),
  says: Schema.String,
  who: Schema.String,
  when: Schema.String,
  files: Schema.Array(Schema.String),
  /** "fresh", or "maybe outdated: …", "not merged yet: …" or "unknown: …" with why (D7). */
  freshness: Schema.String,
  /** Decisions: the file it came from. */
  source: Schema.optionalKey(Schema.String),
});

export const TeamMemorySearchResult = Schema.Struct({
  /** Best matches first, then newest, capped. */
  results: Schema.Array(MemoryResult),
  message: Schema.optionalKey(Schema.String),
});
export type TeamMemorySearchResult = typeof TeamMemorySearchResult.Type;

const PathList = Schema.Array(Schema.String).annotate({
  description: "Project-relative or full paths inside the project.",
});

const TeamStatusTool = Tool.make("team_status", {
  description:
    "See your team: open tasks, who claimed which paths, the newest handoff notes, what the rulebook says not to touch, and recent activity. Call before starting work.",
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
    "Claim files or folders before editing them; returns overlaps with others' claims. Claims last until your work merges or this thread is archived: don't release when done. release: true only if the user drops the work.",
  parameters: Schema.Struct({
    paths: Schema.optional(PathList),
    note: Schema.optional(Schema.String.annotate({ description: "Why, in a few words." })),
    release: Schema.optional(
      Schema.Boolean.annotate({
        description: "Releases the paths, or all your claims without paths.",
      }),
    ),
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
    "Save a handoff note after editing files, or when the user stops work partway: what changed, what is left, risks. Not after only answering questions. Max 150 words. The current commit is added for you.",
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

const TeamMemorySearchTool = Tool.make("team_memory_search", {
  description:
    "Search the team's handoff notes, automatic notes and decisions by keywords or file paths. Returns up to 5 short matches, each marked fresh, maybe outdated, not merged yet, or unknown for your copy, with why.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: "A few keywords or file paths." }),
  }),
  success: Schema.Union([NotInTeamResult, TeamMemorySearchResult]),
  failure: TeamToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Search team memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TeamToolkit = Toolkit.make(
  TeamStatusTool,
  TeamClaimTool,
  TeamTaskTool,
  TeamHandoffTool,
  TeamMemorySearchTool,
);
