import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTeamReadScope,
  AuthTeamWriteScope,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  TeamId,
  TeamMemberId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { TeamStorageError } from "../TeamErrors.ts";
import { requireTeamMember } from "./guard.ts";
import type { TeamSessionMember } from "./TeamSessionMembers.ts";

const SESSION_ID = AuthSessionId.make("session-1");
const TEAM_ID = TeamId.make("team-1");

const sara = (removed = false): TeamSessionMember => ({
  team: {
    teamId: TEAM_ID,
    name: "Core",
    canonicalKey: null,
    createdAt: "2026-10-03T00:00:00.000Z",
  },
  member: {
    memberId: TeamMemberId.make("member-sara"),
    teamId: TEAM_ID,
    displayName: "Sara",
    role: "member",
    environmentId: EnvironmentId.make("env-sara"),
    joinedAt: "2026-10-03T00:00:00.000Z",
  },
  removed,
});

const runGuard = (input: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly lookup: Effect.Effect<Option.Option<TeamSessionMember>, TeamStorageError>;
  readonly scope?: typeof AuthTeamReadScope | typeof AuthTeamWriteScope;
  readonly pathTeamId?: TeamId;
}) =>
  requireTeamMember(
    {
      findBySession: (sessionId) => (sessionId === SESSION_ID ? input.lookup : Effect.succeedNone),
    },
    input.scope ?? AuthTeamReadScope,
    input.pathTeamId,
  ).pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: SESSION_ID,
      subject: "team-invite:1",
      method: "bearer-access-token",
      scopes: new Set(input.scopes),
    }),
    Effect.flip,
  );

const TEAM_SCOPES = [AuthTeamReadScope, AuthTeamWriteScope] as const;

describe("requireTeamMember", () => {
  it.effect("returns the member bound to the session", () =>
    requireTeamMember(
      { findBySession: () => Effect.succeedSome(sara()) },
      AuthTeamWriteScope,
      TEAM_ID,
    ).pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: SESSION_ID,
        subject: "team-invite:1",
        method: "bearer-access-token",
        scopes: new Set(TEAM_SCOPES),
      }),
      Effect.map((found) => assert.strictEqual(found.member.displayName, "Sara")),
    ),
  );

  it.effect("checks the scope before looking for a member", () =>
    Effect.gen(function* () {
      const error = yield* runGuard({
        scopes: [AuthOrchestrationReadScope, AuthTeamReadScope],
        scope: AuthTeamWriteScope,
        lookup: Effect.die("the member lookup must not run without the scope"),
      });
      assert.strictEqual(error._tag, "EnvironmentScopeRequiredError");
    }),
  );

  it.effect("team:write does not imply team:read", () =>
    Effect.gen(function* () {
      const error = yield* runGuard({
        scopes: [AuthTeamWriteScope],
        lookup: Effect.succeedSome(sara()),
      });
      assert.strictEqual(error._tag, "EnvironmentScopeRequiredError");
    }),
  );

  it.effect("refuses a session with no member, a removed member, and another team", () =>
    Effect.gen(function* () {
      const reasons = [];
      for (const [lookup, pathTeamId] of [
        [Effect.succeedNone, undefined],
        [Effect.succeedSome(sara(true)), undefined],
        [Effect.succeedSome(sara()), TeamId.make("team-other")],
      ] as const) {
        const error = yield* runGuard({
          scopes: TEAM_SCOPES,
          lookup,
          ...(pathTeamId ? { pathTeamId } : {}),
        });
        reasons.push(error._tag === "TeamMembershipRequiredError" ? error.reason : error._tag);
      }
      assert.deepStrictEqual(reasons, ["not_a_member", "member_removed", "other_team"]);
    }),
  );

  it.effect("a failed lookup is an internal error, not access", () =>
    Effect.gen(function* () {
      const error = yield* runGuard({
        scopes: TEAM_SCOPES,
        lookup: Effect.fail(new TeamStorageError({ operation: "read", cause: new Error("disk") })),
      });
      assert.strictEqual(error._tag, "TeamHttpInternalError");
    }),
  );
});
