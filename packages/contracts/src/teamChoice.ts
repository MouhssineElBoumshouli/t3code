/**
 * The warning card (fork-only, see team/PREVENTION_PLAN.md, slice 3a). When
 * `team_plan` finds a planned file held by someone else, the server appends
 * one thread activity of kind {@link TEAM_CHOICE_ACTIVITY_KIND} and holds the
 * tool call until the user picks a choice on the card. The click appends a
 * {@link TEAM_CHOICE_MADE_ACTIVITY_KIND} activity, so the choice stays in the
 * thread; clients fold it into the card.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { type TeamClaim, teamPathsOverlap } from "./team.ts";
import { TeamPlanFile } from "./teamPlan.ts";

export const TEAM_CHOICE_ACTIVITY_KIND = "team.choice";
export const TEAM_CHOICE_MADE_ACTIVITY_KIND = "team.choice.made";

/** "ask" and "buildOnTop" are team only (slice 3d). */
export const TeamChoice = Schema.Literals(["anotherWay", "goAnyway", "wait", "ask", "buildOnTop"]);
export type TeamChoice = typeof TeamChoice.Type;

/**
 * Where a "Wait" stands (PREVENTION_PLAN.md section 2, slice 3c): waiting for
 * the holder; cancelled by the user (the card is open again); done (the
 * holder let go, and a turn continued the task); conflict (the holder let go,
 * but this chat's copy could not be updated on top of their work).
 */
export const TeamWaitStatus = Schema.Literals(["waiting", "cancelled", "done", "conflict"]);
export type TeamWaitStatus = typeof TeamWaitStatus.Type;

export const TeamChoiceActivityPayload = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  /** The thread the card is on; the click must name the same one. */
  threadId: ThreadId,
  solo: Schema.Boolean,
  /** Only the planned files someone else holds, each with its holders. */
  files: Schema.Array(TeamPlanFile),
  /**
   * The turn already changed these files without planning them (found in its
   * diff, PREVENTION_PLAN.md section 3). No call is held; the click starts a turn.
   */
  edited: Schema.optionalKey(Schema.Boolean),
});
export type TeamChoiceActivityPayload = typeof TeamChoiceActivityPayload.Type;

/**
 * How the choice reached the agent: the held `team_plan` call, or a new turn.
 * "none": "Go anyway" on a change already made, with nothing to tell the agent.
 */
export const TeamChoiceDelivery = Schema.Literals(["held", "turn", "none"]);
export type TeamChoiceDelivery = typeof TeamChoiceDelivery.Type;

/**
 * Where an "Ask" stands (slice 3d): asked and not answered yet (the other
 * choices stay open), or answered no (the card is open again, without Ask).
 * A yes is recorded as "goAnyway" with its `answer`.
 */
export const TeamAskStatus = Schema.Literals(["asked", "declined"]);
export type TeamAskStatus = typeof TeamAskStatus.Type;

/** The holders' answer: by their names ("Sara", "Sara and Omar"), and their lines. */
export const TeamChoiceAnswer = Schema.Struct({
  yes: Schema.Boolean,
  by: Schema.String,
  text: Schema.NullOr(TrimmedNonEmptyString),
});
export type TeamChoiceAnswer = typeof TeamChoiceAnswer.Type;

/**
 * A card can get several of these: "Wait", then its end or a cancel, then
 * (after a cancel) another choice; "Ask", then its answer. The newest one is
 * the card's state.
 */
export const TeamChoiceMadePayload = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  choice: TeamChoice,
  delivery: TeamChoiceDelivery,
  /** Only for "wait". */
  wait: Schema.optionalKey(TeamWaitStatus),
  /** Only for "ask". */
  ask: Schema.optionalKey(TeamAskStatus),
  /** The question in the team state, for "ask". */
  questionId: Schema.optionalKey(TrimmedNonEmptyString),
  askedAt: Schema.optionalKey(IsoDateTime),
  /** For a "no" ("ask", declined), or a "yes" ("goAnyway"). */
  answer: Schema.optionalKey(TeamChoiceAnswer),
  /** For "buildOnTop": whose branch this chat's copy moved onto. */
  onTopOf: Schema.optionalKey(
    Schema.Struct({ name: Schema.String, branch: TrimmedNonEmptyString }),
  ),
});
export type TeamChoiceMadePayload = typeof TeamChoiceMadePayload.Type;

/**
 * A message T3 sent on the user's behalf to carry a card's outcome (a choice,
 * the end of a wait, a teammate's answer): its id starts with the card's id.
 * Clients draw it as coming from the app, not as typed by the user.
 */
export const isTeamAppMessageId = (messageId: string) => messageId.startsWith("team-choice:");

/** "1 planned file is held: your choice"; "1 changed file is held: …" for an edited card. */
export const teamChoiceSummary = (fileCount: number, edited = false) =>
  `${fileCount} ${edited ? "changed" : "planned"} ${fileCount === 1 ? "file is" : "files are"} held: your choice`;

export const teamChoiceMadeSummary = (
  made: Pick<TeamChoiceMadePayload, "choice" | "wait" | "ask" | "answer">,
) => {
  switch (made.choice) {
    case "anotherWay":
      return "Chose: find another way";
    case "goAnyway":
      return made.answer?.yes === true ? "Go ahead, agreed" : "Chose: go anyway";
    case "buildOnTop":
      return "Chose: build on top of their work";
    case "ask":
      return made.ask === "declined" ? "Answered no" : "Chose: ask";
    case "wait":
      switch (made.wait) {
        case "cancelled":
          return "Stopped waiting";
        case "done":
          return "Done waiting";
        case "conflict":
          return "Done waiting: the copy could not be updated";
        default:
          return "Chose: wait";
      }
  }
};

/**
 * No choice yet, a cancelled wait, a question not answered yet, or a "no":
 * the card takes a click.
 */
export const teamChoiceIsOpen = (made: TeamChoiceMadePayload | null | undefined) =>
  made === null ||
  made === undefined ||
  made.wait === "cancelled" ||
  made.ask === "asked" ||
  made.ask === "declined";

export const teamChoiceIsWaiting = (made: TeamChoiceMadePayload | null | undefined) =>
  made?.wait === "waiting";

/** Asked a teammate, no answer yet. */
export const teamChoiceIsAsking = (made: TeamChoiceMadePayload | null | undefined) =>
  made?.ask === "asked";

/** Open and not waiting on a teammate's answer: the user is the one to act ("Awaiting Input"). */
export const teamChoiceAwaitsUser = (made: TeamChoiceMadePayload | null | undefined) =>
  teamChoiceIsOpen(made) && !teamChoiceIsAsking(made);

/**
 * The pushed branch "Build on top" moves onto: the newest active claim, by a
 * teammate the card names, on one of its files, whose branch is pushed.
 */
export const buildOnTopClaim = (
  claims: ReadonlyArray<TeamClaim>,
  files: ReadonlyArray<TeamPlanFile>,
): (TeamClaim & { readonly branch: string; readonly pushedCommit: string }) | undefined => {
  const members = new Set(
    files.flatMap((file) =>
      file.holders.flatMap((holder) => (holder.kind === "member" ? [holder.memberId] : [])),
    ),
  );
  return claims.findLast(
    (claim): claim is TeamClaim & { readonly branch: string; readonly pushedCommit: string } =>
      members.has(claim.memberId) &&
      claim.branch !== undefined &&
      claim.pushedCommit !== undefined &&
      claim.paths.some((held) => files.some((file) => teamPathsOverlap(held, file.path))),
  );
};

/** A choice, or "cancelWait" to stop waiting (the card is open again). */
export const TeamChooseAction = Schema.Literals([
  "anotherWay",
  "goAnyway",
  "wait",
  "ask",
  "buildOnTop",
  "cancelWait",
]);
export type TeamChooseAction = typeof TeamChooseAction.Type;

export const TeamChooseInput = Schema.Struct({
  threadId: ThreadId,
  choiceId: TrimmedNonEmptyString,
  choice: TeamChooseAction,
  /** For "ask": an optional line for the holders. */
  text: Schema.optionalKey(Schema.String),
});
export type TeamChooseInput = typeof TeamChooseInput.Type;

export const TeamChooseResult = Schema.Struct({ delivery: TeamChoiceDelivery });
export type TeamChooseResult = typeof TeamChooseResult.Type;

/** The card is gone, already answered, or its side effect failed; shown to the user as is. */
export class TeamChoiceError extends Schema.TaggedError<TeamChoiceError>()("TeamChoiceError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
