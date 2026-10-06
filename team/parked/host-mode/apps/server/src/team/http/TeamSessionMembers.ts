/**
 * TeamSessionMembers - which team member a host session belongs to.
 *
 * `/join` (M2.3) binds the session made from a team invite to a member row,
 * through the invite (`TeamInvites`). Any other session, the host owner's
 * own included, has no member, so every team endpoint but `/join` answers it
 * 403 "not_a_member" (team/DESIGN.md 7.1).
 *
 * @module TeamSessionMembers
 */
import type { AuthSessionId, Team, TeamMember } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { TeamServiceError } from "../TeamErrors.ts";
import { TeamInvites } from "../TeamInvites.ts";

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

export const layer = Layer.effect(
  TeamSessionMembers,
  Effect.gen(function* () {
    const invites = yield* TeamInvites;
    return { findBySession: invites.findBySession };
  }),
);
