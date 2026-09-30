import * as Schema from "effect/Schema";

export class TeamStorageError extends Schema.TaggedError<TeamStorageError>()("TeamStorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Team storage failed in ${this.operation}.`;
  }
}

export class TeamNotFoundError extends Schema.TaggedError<TeamNotFoundError>()(
  "TeamNotFoundError",
  { teamId: Schema.String },
) {
  override get message(): string {
    return `No team ${this.teamId} on this server.`;
  }
}

export class TeamMemberNotFoundError extends Schema.TaggedError<TeamMemberNotFoundError>()(
  "TeamMemberNotFoundError",
  { teamId: Schema.String, memberId: Schema.String },
) {
  override get message(): string {
    return `Member ${this.memberId} is not in team ${this.teamId}.`;
  }
}

export class TeamTaskNotFoundError extends Schema.TaggedError<TeamTaskNotFoundError>()(
  "TeamTaskNotFoundError",
  { teamId: Schema.String, taskId: Schema.String },
) {
  override get message(): string {
    return `Task ${this.taskId} is not in team ${this.teamId}.`;
  }
}

export class TeamClaimPathsInvalidError extends Schema.TaggedError<TeamClaimPathsInvalidError>()(
  "TeamClaimPathsInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TeamHandoffTooLongError extends Schema.TaggedError<TeamHandoffTooLongError>()(
  "TeamHandoffTooLongError",
  { words: Schema.Number, maxWords: Schema.Number },
) {
  override get message(): string {
    return `Handoff note has ${this.words} words; the limit is ${this.maxWords}.`;
  }
}

export type TeamServiceError =
  | TeamStorageError
  | TeamNotFoundError
  | TeamMemberNotFoundError
  | TeamTaskNotFoundError
  | TeamClaimPathsInvalidError
  | TeamHandoffTooLongError;
