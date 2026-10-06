/**
 * Invites and `/join` on the host (team/DESIGN.md 7.1 M2.3, security S5, S6,
 * S7, S8, S12), with the real `EnvironmentAuth` on an in-memory database and a
 * test clock, so expiry is checked without waiting. The same paths against a
 * running server are in `http/security.test.ts`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthSessionId,
  EnvironmentId,
  TeamFile,
  TeamId,
  type TeamJoinRefusedReason,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamInvites from "./TeamInvites.ts";
import * as TeamService from "./TeamService.ts";

const TestLayer = Layer.mergeAll(
  TeamInvites.layer.pipe(Layer.provideMerge(TeamService.layer)),
  EnvironmentAuth.layer,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-invites-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | TeamInvites.TeamInvites
    | TeamService.TeamService
    | EnvironmentAuth.EnvironmentAuth
    | SqlClient.SqlClient
    | NodeServices.NodeServices
  >,
) => effect.pipe(Effect.provide(TestLayer));

const hostEnvironment = EnvironmentId.make("env-host");
const saraEnvironment = EnvironmentId.make("env-sara");
const omarEnvironment = EnvironmentId.make("env-omar");
const teamA = TeamFile.make({ teamId: TeamId.make("team-a"), name: "Core" });
const teamB = TeamFile.make({ teamId: TeamId.make("team-b"), name: "Other" });

const requestMetadata = { deviceType: "bot" as const, os: "Linux" };

const setUp = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  for (const teamFile of [teamA, teamB]) {
    yield* teams.ensureTeam({
      teamFile,
      canonicalKey: null,
      owner: { environmentId: hostEnvironment, displayName: "Mouhssine" },
    });
  }
  return {
    teams,
    invites: yield* TeamInvites.TeamInvites,
    auth: yield* EnvironmentAuth.EnvironmentAuth,
  };
});

const invite = (memberName: string, options?: { teamId?: TeamId; ttl?: Duration.Duration }) =>
  TeamInvites.issueTeamInvite({
    teamId: options?.teamId ?? teamA.teamId,
    memberName,
    ttl: options?.ttl,
    hostEnvironmentId: hostEnvironment,
  });

/** What the member's server does with the URL: exchange it, asking for no scopes (M2.4). */
const exchange = (credential: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      credential,
      undefined,
      requestMetadata,
    );
    const session = yield* auth.authenticateHttpRequest({
      cookies: {},
      headers: { authorization: `Bearer ${token.access_token}` },
    } as unknown as Parameters<
      EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
    >[0]);
    return session;
  });

/** `/join`, as the handler calls it: the invite id comes from the session's subject. */
const join = (
  session: { readonly sessionId: AuthSessionId; readonly subject: string },
  environmentId: EnvironmentId,
) =>
  Effect.gen(function* () {
    const invites = yield* TeamInvites.TeamInvites;
    const inviteId = TeamInvites.inviteIdFromSubject(session.subject);
    if (Option.isNone(inviteId))
      return yield* new TeamInvites.TeamJoinRefused({ reason: "not_an_invite" });
    return yield* invites.join({
      inviteId: inviteId.value,
      sessionId: session.sessionId,
      environmentId,
    });
  });

const isJoinRefused = Schema.is(TeamInvites.TeamJoinRefused);
const isInviteRefused = Schema.is(TeamInvites.TeamInviteRefusedError);

const refusedReason = <A, E>(exit: Exit.Exit<A, E>): TeamJoinRefusedReason | string => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const error = Exit.findErrorOption(exit);
  if (Option.isNone(error)) return "died";
  return isJoinRefused(error.value) ? error.value.reason : "other error";
};

const refusedDetail = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
  return Option.isSome(error) && isInviteRefused(error.value) ? error.value.detail : "not refused";
};

describe("t3 team invite", () => {
  it.effect(
    "an invite is a one-time pairing link with exactly the team scopes, and no credential is stored",
    () =>
      run(
        Effect.gen(function* () {
          const { auth } = yield* setUp;
          const issued = yield* invite("Sara");

          assert.equal(issued.invite.status, "pending");
          assert.equal(issued.invite.memberName, "Sara");
          assert.equal(issued.team.name, "Core");
          const links = yield* auth.listPairingLinks();
          const link = links.find((candidate) => candidate.id === issued.invite.pairingLinkId);
          assert.isDefined(link);
          // S5: exactly the two team scopes, never more.
          assert.deepStrictEqual([...link!.scopes].toSorted(), ["team:read", "team:write"]);
          assert.equal(link!.subject, `team-invite:${issued.invite.inviteId}`);
          assert.equal(link!.label, "Team Core: Sara");
          // Decision 2: 30 minutes by default.
          assert.equal(
            link!.expiresAt.epochMilliseconds - link!.createdAt.epochMilliseconds,
            30 * 60 * 1000,
          );

          // Decision 9 / S12: the team layer keeps the link's id, not its credential.
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<Record<string, unknown>>`SELECT * FROM team_invites`;
          assert.lengthOf(rows, 1);
          for (const value of Object.values(rows[0]!)) {
            assert.notInclude(String(value), issued.credential);
          }
        }),
      ),
  );

  it.effect("checks the name, the lifetime, the team and the owner before making anything", () =>
    run(
      Effect.gen(function* () {
        const { auth, invites } = yield* setUp;
        const refused = [
          yield* Effect.exit(invite("")),
          yield* Effect.exit(invite("x".repeat(61))),
          yield* Effect.exit(invite("<b>Sara</b>")),
          yield* Effect.exit(invite("Sara\nOwner")),
          // The owner's name, any case.
          yield* Effect.exit(invite("mouhssine")),
          yield* Effect.exit(invite("Sara", { ttl: Duration.hours(25) })),
          yield* Effect.exit(invite("Sara", { ttl: Duration.zero })),
          yield* Effect.exit(invite("Sara", { teamId: TeamId.make("team-unknown") })),
          yield* Effect.exit(
            TeamInvites.issueTeamInvite({
              teamId: teamA.teamId,
              memberName: "Sara",
              hostEnvironmentId: EnvironmentId.make("env-not-owner"),
            }),
          ),
        ];
        const details = refused.map(refusedDetail);
        assert.include(details[0], "1 to 60 characters");
        assert.include(details[1], "1 to 60 characters");
        assert.include(details[2], "1 to 60 characters");
        assert.include(details[3], "1 to 60 characters");
        assert.include(details[4], "already has a member named Mouhssine");
        assert.include(details[5], "at most 24 hours");
        assert.include(details[6], "at most 24 hours");
        assert.include(details[7], "does not host team team-unknown");
        assert.include(details[8], "not the owner");
        assert.lengthOf(yield* invites.list(), 0);
        assert.lengthOf(yield* auth.listPairingLinks(), 0);

        // Spaces are tidied, and 60 characters is fine.
        const tidy = yield* invite("  Sara   El  ");
        assert.equal(tidy.invite.memberName, "Sara El");
        yield* invite("y".repeat(60));
      }),
    ),
  );

  it.effect("one pending invite per name, until it expires or is revoked", () =>
    run(
      Effect.gen(function* () {
        yield* setUp;
        const first = yield* invite("Sara", { ttl: Duration.minutes(2) });
        const again = yield* Effect.exit(invite("SARA"));
        assert.include(refusedDetail(again), "already a pending invite for Sara");
        assert.include(refusedDetail(again), first.invite.inviteId);
        // Another team may use the same name.
        yield* invite("Sara", { teamId: teamB.teamId });

        yield* TestClock.adjust("3 minutes");
        const second = yield* invite("Sara");
        yield* TeamInvites.revokeTeamInvite(second.invite.inviteId);
        yield* invite("Sara");
      }),
    ),
  );
});

describe("/join", () => {
  it.effect("binds the session to a new member named by the invite, once", () =>
    run(
      Effect.gen(function* () {
        const { teams, invites } = yield* setUp;
        const issued = yield* invite("Sara");
        const session = yield* exchange(issued.credential);
        assert.equal(session.subject, `team-invite:${issued.invite.inviteId}`);

        const joined = yield* join(session, saraEnvironment);
        assert.equal(joined.team.teamId, teamA.teamId);
        assert.equal(joined.member.displayName, "Sara");
        assert.equal(joined.member.role, "member");
        assert.equal(joined.member.environmentId, saraEnvironment);

        const used = yield* invites.get(issued.invite.inviteId);
        assert.equal(Option.getOrThrow(used).status, "used");
        assert.equal(Option.getOrThrow(used).memberId, joined.member.memberId);

        const bound = yield* invites.findBySession(session.sessionId);
        assert.equal(Option.getOrThrow(bound).member.memberId, joined.member.memberId);
        assert.isFalse(Option.getOrThrow(bound).removed);

        // The same session again: the same member, no second row.
        const again = yield* join(session, saraEnvironment);
        assert.equal(again.member.memberId, joined.member.memberId);
        const members = yield* teams.listMembers(teamA.teamId);
        // Sorted: under the test clock both joined at the same instant.
        assert.deepStrictEqual(
          members.map((member) => `${member.displayName}:${member.role}`).toSorted(),
          ["Mouhssine:owner", "Sara:member"],
        );
        const activity = yield* teams.listActivity(teamA.teamId);
        assert.equal(activity[0]?.kind, "member.joined");
        assert.equal(activity[0]?.summary, "Sara joined team Core.");
      }),
    ),
  );

  it.effect(
    "S6: a used link cannot be exchanged again, and a second session for the invite is refused",
    () =>
      run(
        Effect.gen(function* () {
          const { teams, auth } = yield* setUp;
          const issued = yield* invite("Sara");
          const session = yield* exchange(issued.credential);
          yield* join(session, saraEnvironment);

          const reused = yield* Effect.exit(exchange(issued.credential));
          assert.isTrue(Exit.isFailure(reused));

          // A session that names the same invite some other way (it cannot come
          // from the link, which is gone) still cannot join a second time.
          const forged = yield* auth.issueSession({
            subject: `team-invite:${issued.invite.inviteId}`,
            scopes: TeamInvites.TEAM_INVITE_SCOPES,
          });
          const second = yield* Effect.exit(join(forged, omarEnvironment));
          assert.equal(refusedReason(second), "invite_used");
          assert.lengthOf(yield* teams.listMembers(teamA.teamId), 2);
        }),
      ),
  );

  it.effect("S6: an expired invite can be neither exchanged nor joined", () =>
    run(
      Effect.gen(function* () {
        const { teams, invites } = yield* setUp;
        const late = yield* invite("Sara", { ttl: Duration.minutes(2) });
        // Exchanged in time, but joined after the invite expired.
        const exchangedInTime = yield* invite("Omar", { ttl: Duration.minutes(2) });
        const session = yield* exchange(exchangedInTime.credential);

        yield* TestClock.adjust("3 minutes");
        assert.equal(Option.getOrThrow(yield* invites.get(late.invite.inviteId)).status, "expired");
        const exchanged = yield* Effect.exit(exchange(late.credential));
        assert.isTrue(Exit.isFailure(exchanged));

        const joined = yield* Effect.exit(join(session, omarEnvironment));
        assert.equal(refusedReason(joined), "invite_expired");
        assert.lengthOf(yield* teams.listMembers(teamA.teamId), 1);
      }),
    ),
  );

  it.effect("S6: a revoked invite can be neither exchanged nor joined", () =>
    run(
      Effect.gen(function* () {
        const { teams, invites, auth } = yield* setUp;
        const before = yield* invite("Sara");
        const revoked = yield* TeamInvites.revokeTeamInvite(before.invite.inviteId);
        assert.isFalse(revoked.alreadyRevoked);
        assert.equal(revoked.invite.status, "revoked");
        const links = yield* auth.listPairingLinks();
        assert.isFalse(links.some((link) => link.id === before.invite.pairingLinkId));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(exchange(before.credential))));

        // Exchanged first, then revoked before joining.
        const after = yield* invite("Omar");
        const session = yield* exchange(after.credential);
        yield* TeamInvites.revokeTeamInvite(after.invite.inviteId);
        assert.equal(
          refusedReason(yield* Effect.exit(join(session, omarEnvironment))),
          "invite_revoked",
        );
        assert.lengthOf(yield* teams.listMembers(teamA.teamId), 1);

        // Revoking twice says so; a used invite or an unknown id is refused.
        const twice = yield* TeamInvites.revokeTeamInvite(after.invite.inviteId);
        assert.isTrue(twice.alreadyRevoked);
        const used = yield* invite("Lina");
        yield* join(yield* exchange(used.credential), EnvironmentId.make("env-lina"));
        assert.include(
          refusedDetail(yield* Effect.exit(TeamInvites.revokeTeamInvite(used.invite.inviteId))),
          "already used",
        );
        assert.include(
          refusedDetail(yield* Effect.exit(TeamInvites.revokeTeamInvite("no-such-invite"))),
          "No invite no-such-invite",
        );
        assert.equal(Option.getOrThrow(yield* invites.get(used.invite.inviteId)).status, "used");
      }),
    ),
  );

  it.effect(
    "the joining server cannot take the owner's environment id, and the body names nothing else (S7, S8)",
    () =>
      run(
        Effect.gen(function* () {
          const { teams, invites } = yield* setUp;
          const issued = yield* invite("Sara");
          const session = yield* exchange(issued.credential);
          assert.equal(
            refusedReason(yield* Effect.exit(join(session, hostEnvironment))),
            "already_member",
          );
          assert.lengthOf(yield* teams.listMembers(teamA.teamId), 1);
          assert.equal(
            Option.getOrThrow(yield* invites.get(issued.invite.inviteId)).status,
            "pending",
          );
          // Still usable with the server's own id.
          const joined = yield* join(session, saraEnvironment);
          assert.equal(joined.member.role, "member");
        }),
      ),
  );

  it.effect(
    "wrong team: a member is bound to its invite's team only; a deleted team refuses the join",
    () =>
      run(
        Effect.gen(function* () {
          const { invites } = yield* setUp;
          const toA = yield* invite("Sara");
          const sessionA = yield* exchange(toA.credential);
          yield* join(sessionA, saraEnvironment);
          assert.equal(
            Option.getOrThrow(yield* invites.findBySession(sessionA.sessionId)).team.teamId,
            teamA.teamId,
          );

          const toB = yield* invite("Omar", { teamId: teamB.teamId });
          const sessionB = yield* exchange(toB.credential);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM team_teams WHERE team_id = ${teamB.teamId}`;
          assert.equal(
            refusedReason(yield* Effect.exit(join(sessionB, omarEnvironment))),
            "team_not_found",
          );
          assert.isTrue(Option.isNone(yield* invites.findBySession(sessionB.sessionId)));
        }),
      ),
  );

  it.effect("sessions that did not come from an invite have no member and cannot join", () =>
    run(
      Effect.gen(function* () {
        const { invites, auth } = yield* setUp;
        const admin = yield* auth.issueSession({ subject: "cli-issued-session" });
        assert.equal(
          refusedReason(yield* Effect.exit(join(admin, saraEnvironment))),
          "not_an_invite",
        );
        assert.isTrue(Option.isNone(yield* invites.findBySession(admin.sessionId)));
        const unknown = yield* auth.issueSession({
          subject: "team-invite:no-such-invite",
          scopes: TeamInvites.TEAM_INVITE_SCOPES,
        });
        assert.equal(
          refusedReason(yield* Effect.exit(join(unknown, saraEnvironment))),
          "invite_not_found",
        );
      }),
    ),
  );

  it("reads the invite id from a session subject", () => {
    assert.deepStrictEqual(TeamInvites.inviteIdFromSubject("team-invite:abc"), Option.some("abc"));
    assert.isTrue(Option.isNone(TeamInvites.inviteIdFromSubject("team-invite:")));
    assert.isTrue(Option.isNone(TeamInvites.inviteIdFromSubject("one-time-token")));
    assert.isTrue(Option.isNone(TeamInvites.inviteIdFromSubject("x-team-invite:abc")));
  });
});
