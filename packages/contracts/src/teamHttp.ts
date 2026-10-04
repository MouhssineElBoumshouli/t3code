/**
 * The team HTTP API (fork-only, see team/DESIGN.md section 7). A member's
 * server calls its team's host here with a bearer session that holds only
 * `team:read` and `team:write`. It is a separate API from
 * `EnvironmentHttpApi`, mounted next to it with the same session middleware.
 *
 * Every handler starts with one guard: the scope, then "which member is this
 * session" (a member row bound to the session, not removed), then, when the
 * path names a team, that it is the member's team. The one exception is
 * `/join`, which is how a session made from a team invite gets its member.
 */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentAuthenticatedAuth, EnvironmentScopeRequiredError } from "./environmentHttp.ts";
import { Team, TeamId, TeamMember } from "./team.ts";

/** Every team path starts here; `v1` leaves room for a member and host on different versions. */
export const TEAM_HTTP_PATH_PREFIX = "/api/team/v1";

export const TeamMembershipRequiredReason = Schema.Literals([
  /** The session is valid and has the scope, but no member row is bound to it. */
  "not_a_member",
  /** The member was removed from the team. */
  "member_removed",
  /** The path names a team the session's member is not in. */
  "other_team",
]);
export type TeamMembershipRequiredReason = typeof TeamMembershipRequiredReason.Type;

export class TeamMembershipRequiredError extends Schema.TaggedError<TeamMembershipRequiredError>()(
  "TeamMembershipRequiredError",
  {
    code: Schema.Literal("team_membership_required"),
    reason: TeamMembershipRequiredReason,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamMembershipRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This session may not use the team API (${this.reason}).`;
  }
}

export class TeamHttpInternalError extends Schema.TaggedError<TeamHttpInternalError>()(
  "TeamHttpInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: Schema.Literals(["team_member_lookup_failed", "team_join_failed"]),
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamHttpInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The team host failed to answer (${this.reason}).`;
  }
}

export const TeamJoinRefusedReason = Schema.Literals([
  /** The session did not come from a team invite. */
  "not_an_invite",
  /** No invite with the session's invite id on this host. */
  "invite_not_found",
  /** Another session already joined with this invite. */
  "invite_used",
  /** The host revoked the invite. */
  "invite_revoked",
  /** The invite expired before this session joined. */
  "invite_expired",
  /** The invite's team is no longer on this host. */
  "team_not_found",
  /** The team already has a member for this environment id. */
  "already_member",
]);
export type TeamJoinRefusedReason = typeof TeamJoinRefusedReason.Type;

export class TeamJoinRefusedError extends Schema.TaggedError<TeamJoinRefusedError>()(
  "TeamJoinRefusedError",
  {
    code: Schema.Literal("team_join_refused"),
    reason: TeamJoinRefusedReason,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamJoinRefusedError)(this, { status: 403 });
  }

  override get message(): string {
    return `The team host refused to join (${this.reason}).`;
  }
}

const TeamBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});

const TeamHttpErrors = [
  EnvironmentScopeRequiredError,
  TeamMembershipRequiredError,
  TeamHttpInternalError,
] as const;

/** Your member row and its team, as the host sees them. */
export const TeamMeResult = Schema.Struct({
  team: Team,
  member: TeamMember,
});
export type TeamMeResult = typeof TeamMeResult.Type;

/** Placeholder until the board read lands (M2.5). */
export const TeamBoardPlaceholderResult = Schema.Struct({
  teamId: TeamId,
  placeholder: Schema.Literal(true),
  note: TrimmedNonEmptyString,
});
export type TeamBoardPlaceholderResult = typeof TeamBoardPlaceholderResult.Type;

/**
 * What the member's server says about itself when it joins. Nothing else: the
 * member's name and role come from the invite, never from the request (S7, S8).
 */
export const TeamJoinRequest = Schema.Struct({
  /** The joining server's own environment id; threads it reports later must carry it. */
  environmentId: EnvironmentId,
});
export type TeamJoinRequest = typeof TeamJoinRequest.Type;

const TeamPathParams = Schema.Struct({
  teamId: TeamId,
});

export class TeamHttpGroup extends HttpApiGroup.make("team")
  .add(
    HttpApiEndpoint.get("me", `${TEAM_HTTP_PATH_PREFIX}/me`, {
      headers: TeamBearerHeaders,
      success: TeamMeResult,
      error: TeamHttpErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("join", `${TEAM_HTTP_PATH_PREFIX}/join`, {
      headers: TeamBearerHeaders,
      payload: TeamJoinRequest,
      success: TeamMeResult,
      error: [EnvironmentScopeRequiredError, TeamJoinRefusedError, TeamHttpInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("board", `${TEAM_HTTP_PATH_PREFIX}/teams/:teamId/board`, {
      headers: TeamBearerHeaders,
      params: TeamPathParams,
      success: TeamBoardPlaceholderResult,
      error: TeamHttpErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class TeamHttpApi extends HttpApi.make("team").add(TeamHttpGroup) {}
