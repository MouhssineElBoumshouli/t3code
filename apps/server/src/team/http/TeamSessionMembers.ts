/**
 * TeamSessionMembers - which team member a host session belongs to.
 *
 * `/join` (M2.3) binds the session made from a team invite to a member row.
 * Until then no session is bound to a member, so the live lookup finds none
 * and every team endpoint answers 403 "not_a_member" (team/DESIGN.md 7.1).
 *
 * @module TeamSessionMembers
 */
import type { AuthSessionId, Team, TeamMember } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { TeamServiceError } from "../TeamErrors.ts";

export interface TeamSessionMember {
  readonly team: Team;
  readonly member: TeamMember;
  /** Removed members keep their row (and their handoffs) but lose access (M2.9). */
  readonly removed: boolean;
}

export class TeamSessionMembers extends Context.Service<
  TeamSessionMembers,
  {
    readonly findBySession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamSessionMember>, TeamServiceError>;
  }
>()("t3/team/http/TeamSessionMembers") {}

/** No session is bound to a member before `/join` exists (M2.3). */
export const layer = Layer.succeed(TeamSessionMembers, {
  findBySession: () => Effect.succeedNone,
});
