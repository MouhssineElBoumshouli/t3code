/**
 * The one guard every team API handler starts with (team/DESIGN.md 7.1 M2.2):
 * the scope, then the member bound to this session (not removed), then, when
 * the path names a team, that it is the member's team. The security tests call
 * every team endpoint with a team-scoped session that has no member, so a
 * handler that skips this guard fails them.
 */
import {
  type AuthTeamReadScope,
  type AuthTeamWriteScope,
  type TeamId,
  TeamHttpInternalError,
  TeamMembershipRequiredError,
  type TeamMembershipRequiredReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { requireEnvironmentScope } from "../../auth/http.ts";
import type { TeamSessionMembers } from "./TeamSessionMembers.ts";

export type TeamHttpScope = typeof AuthTeamReadScope | typeof AuthTeamWriteScope;

const refuse = (reason: TeamMembershipRequiredReason) =>
  Effect.fail(new TeamMembershipRequiredError({ code: "team_membership_required", reason }));

/** `members` is taken once when the API is built, so handlers need no service per request. */
export const requireTeamMember = Effect.fn("team.http.requireMember")(function* (
  members: TeamSessionMembers["Service"],
  scope: TeamHttpScope,
  pathTeamId?: TeamId,
) {
  const session = yield* requireEnvironmentScope(scope);
  const found = yield* members.findBySession(session.sessionId).pipe(
    Effect.catch((cause) =>
      Effect.logError("team api member lookup failed", { cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new TeamHttpInternalError({
              code: "internal_error",
              reason: "team_member_lookup_failed",
            }),
          ),
        ),
      ),
    ),
  );
  if (Option.isNone(found)) {
    return yield* refuse("not_a_member");
  }
  if (found.value.removed) {
    return yield* refuse("member_removed");
  }
  if (pathTeamId !== undefined && pathTeamId !== found.value.team.teamId) {
    return yield* refuse("other_team");
  }
  return found.value;
});
