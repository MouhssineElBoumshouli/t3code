/**
 * TeamInvites - invites to teams this server hosts, and the sessions they
 * bound to members (team/DESIGN.md 7.1 M2.3).
 *
 * `t3 team invite` makes a one-time pairing link with exactly `team:read` and
 * `team:write` and subject `team-invite:<invite id>`, and a `team_invites` row
 * that holds the link's id, never its credential. The member's server
 * exchanges the link for a session, then calls `/join`: the host reads the
 * invite id from the session's subject, adds a `member` named by the invite
 * (decision 3), and records the session on the invite. From then on the
 * invite row is what tells the team API which member a session is.
 *
 * @module TeamInvites
 */
import {
  type AuthSessionId,
  AuthTeamReadScope,
  AuthTeamWriteScope,
  EnvironmentId,
  type Team,
  TeamId,
  TeamJoinRefusedReason,
  type TeamMember,
  TeamMemberId,
  TeamMemberRole,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { type TeamServiceError, TeamStorageError } from "./TeamErrors.ts";
import { TeamService } from "./TeamService.ts";
import type { TeamSessionMember } from "./http/TeamSessionMembers.ts";

/** Subject of every invite's pairing link, and so of the session made from it. */
export const TEAM_INVITE_SUBJECT_PREFIX = "team-invite:";
/** Exactly what an invite hands out, never more (S5). */
export const TEAM_INVITE_SCOPES = [AuthTeamReadScope, AuthTeamWriteScope] as const;
/** Decision 2: 30 minutes by default, at most 24 hours. */
export const TEAM_INVITE_DEFAULT_TTL = Duration.minutes(30);
export const TEAM_INVITE_MAX_TTL = Duration.hours(24);
/** The briefing cuts names at 60 characters (D4), so the host never gives a longer one. */
export const TEAM_MEMBER_NAME_MAX_LENGTH = 60;

export type TeamInviteStatus = "pending" | "used" | "expired" | "revoked";

export interface TeamInvite {
  readonly inviteId: string;
  readonly teamId: TeamId;
  readonly memberName: string;
  readonly createdByMemberId: TeamMemberId;
  readonly pairingLinkId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly usedBySessionId: string | null;
  readonly memberId: TeamMemberId | null;
  readonly revokedAt: string | null;
  /** As of when the invite was read. */
  readonly status: TeamInviteStatus;
}

/** A refused invite command, with a message for the person at the terminal. */
export class TeamInviteRefusedError extends Schema.TaggedError<TeamInviteRefusedError>()(
  "TeamInviteRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** `/join` refused; the reason goes back to the member's server as is. */
export class TeamJoinRefused extends Schema.TaggedError<TeamJoinRefused>()("TeamJoinRefused", {
  reason: TeamJoinRefusedReason,
}) {
  override get message(): string {
    return `Join refused: ${this.reason}.`;
  }
}

const refuseJoin = (reason: TeamJoinRefusedReason) => Effect.fail(new TeamJoinRefused({ reason }));

/** The invite id in a session subject, or none when the session did not come from an invite. */
export const inviteIdFromSubject = (subject: string): Option.Option<string> => {
  if (!subject.startsWith(TEAM_INVITE_SUBJECT_PREFIX)) return Option.none();
  const id = subject.slice(TEAM_INVITE_SUBJECT_PREFIX.length).trim();
  return id.length > 0 ? Option.some(id) : Option.none();
};

// Control characters, and the characters the briefing strips from names (D4).
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}<>"`]/u;

/** The host names the member (decision 3): one line, 1 to 60 characters. */
export const validateMemberName = (raw: string) => {
  const name = raw.trim().replace(/ +/g, " ");
  if (
    name.length === 0 ||
    name.length > TEAM_MEMBER_NAME_MAX_LENGTH ||
    FORBIDDEN_NAME_CHARACTERS.test(name)
  ) {
    return Effect.fail(
      new TeamInviteRefusedError({
        detail: `A member name is 1 to ${TEAM_MEMBER_NAME_MAX_LENGTH} characters on one line, without < > " or \`. Got: ${JSON.stringify(raw)}.`,
      }),
    );
  }
  return Effect.succeed(name);
};

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const InviteRow = Schema.Struct({
  inviteId: TrimmedNonEmptyString,
  teamId: TeamId,
  memberName: TrimmedNonEmptyString,
  createdByMemberId: TeamMemberId,
  pairingLinkId: TrimmedNonEmptyString,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  usedAt: Schema.NullOr(Schema.String),
  usedBySessionId: Schema.NullOr(Schema.String),
  memberId: Schema.NullOr(TeamMemberId),
  revokedAt: Schema.NullOr(Schema.String),
});
const decodeInviteRows = Schema.decodeUnknownEffect(Schema.Array(InviteRow));

const BoundRow = Schema.Struct({
  teamId: TeamId,
  teamName: TrimmedNonEmptyString,
  canonicalKey: Schema.NullOr(TrimmedNonEmptyString),
  teamCreatedAt: Schema.String,
  memberId: TeamMemberId,
  displayName: TrimmedNonEmptyString,
  role: TeamMemberRole,
  environmentId: EnvironmentId,
  joinedAt: Schema.String,
});
const decodeBoundRows = Schema.decodeUnknownEffect(Schema.Array(BoundRow));

const statusAt = (row: typeof InviteRow.Type, now: DateTime.Utc): TeamInviteStatus => {
  if (row.revokedAt !== null) return "revoked";
  if (row.usedAt !== null) return "used";
  const expiresAt = DateTime.make(row.expiresAt);
  return Option.isSome(expiresAt) && DateTime.isGreaterThanOrEqualTo(now, expiresAt.value)
    ? "expired"
    : "pending";
};

export class TeamInvites extends Context.Service<
  TeamInvites,
  {
    /** Stores an invite whose pairing link exists already. */
    readonly create: (input: {
      readonly inviteId: string;
      readonly teamId: TeamId;
      readonly memberName: string;
      readonly createdByMemberId: TeamMemberId;
      readonly pairingLinkId: string;
      readonly createdAt: DateTime.Utc;
      readonly expiresAt: DateTime.Utc;
    }) => Effect.Effect<TeamInvite, TeamStorageError>;
    readonly get: (inviteId: string) => Effect.Effect<Option.Option<TeamInvite>, TeamStorageError>;
    /** Newest first; every hosted team when `teamId` is left out. */
    readonly list: (teamId?: TeamId) => Effect.Effect<ReadonlyArray<TeamInvite>, TeamStorageError>;
    /** Marks an unused invite revoked. A used one is refused: removing a member is M2.9. */
    readonly markRevoked: (
      inviteId: string,
    ) => Effect.Effect<
      { readonly invite: TeamInvite; readonly alreadyRevoked: boolean },
      TeamInviteRefusedError | TeamStorageError
    >;
    /**
     * `/join`: the session made from the invite becomes a `member` named by
     * the invite. Calling again with the same session returns the same member.
     */
    readonly join: (input: {
      readonly inviteId: string;
      readonly sessionId: AuthSessionId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      { readonly team: Team; readonly member: TeamMember },
      TeamJoinRefused | TeamServiceError
    >;
    /** The member a session joined as, through its invite. */
    readonly findBySession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamSessionMember>, TeamStorageError>;
  }
>()("t3/team/TeamInvites") {}

export const make = Effect.gen(function* () {
  // TeamService runs the team migrations when it is built, `team_invites` included.
  const teams = yield* TeamService;
  const sql = yield* SqlClient.SqlClient;

  const storage =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TeamStorageError({ operation, cause })));

  const selectInvites = (filter: { readonly inviteId?: string; readonly teamId?: TeamId }) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT invite_id AS "inviteId", team_id AS "teamId", member_name AS "memberName",
          created_by_member_id AS "createdByMemberId", pairing_link_id AS "pairingLinkId",
          created_at AS "createdAt", expires_at AS "expiresAt", used_at AS "usedAt",
          used_by_session_id AS "usedBySessionId", member_id AS "memberId",
          revoked_at AS "revokedAt"
        FROM team_invites
        WHERE 1 = 1
          ${filter.inviteId === undefined ? sql`` : sql`AND invite_id = ${filter.inviteId}`}
          ${filter.teamId === undefined ? sql`` : sql`AND team_id = ${filter.teamId}`}
        ORDER BY created_at DESC, rowid DESC
      `.pipe(storage("listInvites"), Effect.flatMap(decodeInviteRows), storage("listInvites"));
      const now = yield* DateTime.now;
      return rows.map((row): TeamInvite => ({ ...row, status: statusAt(row, now) }));
    });

  const get: TeamInvites["Service"]["get"] = (inviteId) =>
    selectInvites({ inviteId }).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const findBySession: TeamInvites["Service"]["findBySession"] = (sessionId) =>
    sql`
      SELECT t.team_id AS "teamId", t.name AS "teamName", t.canonical_key AS "canonicalKey",
        t.created_at AS "teamCreatedAt", m.member_id AS "memberId",
        m.display_name AS "displayName", m.role, m.environment_id AS "environmentId",
        m.joined_at AS "joinedAt"
      FROM team_invites i
      JOIN team_members m ON m.member_id = i.member_id AND m.team_id = i.team_id
      JOIN team_teams t ON t.team_id = i.team_id
      WHERE i.used_by_session_id = ${sessionId}
    `.pipe(
      storage("findBySession"),
      Effect.flatMap(decodeBoundRows),
      storage("findBySession"),
      Effect.map((rows) =>
        Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          team: {
            teamId: row.teamId,
            name: row.teamName,
            canonicalKey: row.canonicalKey,
            createdAt: row.teamCreatedAt,
          } satisfies Team,
          member: {
            memberId: row.memberId,
            teamId: row.teamId,
            displayName: row.displayName,
            role: row.role,
            environmentId: row.environmentId,
            joinedAt: row.joinedAt,
          } satisfies TeamMember,
          // Removing members arrives in M2.9.
          removed: false,
        })),
      ),
    );

  const create: TeamInvites["Service"]["create"] = Effect.fn("TeamInvites.create")(
    function* (input) {
      yield* sql`
        INSERT INTO team_invites (
          invite_id, team_id, member_name, created_by_member_id, pairing_link_id,
          created_at, expires_at
        ) VALUES (
          ${input.inviteId}, ${input.teamId}, ${input.memberName}, ${input.createdByMemberId},
          ${input.pairingLinkId}, ${DateTime.formatIso(input.createdAt)},
          ${DateTime.formatIso(input.expiresAt)}
        )
      `.pipe(storage("createInvite"));
      const created = yield* get(input.inviteId);
      if (Option.isNone(created)) {
        return yield* new TeamStorageError({
          operation: "createInvite",
          cause: new Error("The invite was not found after saving."),
        });
      }
      return created.value;
    },
  );

  const markRevoked: TeamInvites["Service"]["markRevoked"] = Effect.fn("TeamInvites.markRevoked")(
    function* (inviteId) {
      const found = yield* get(inviteId);
      if (Option.isNone(found)) {
        return yield* new TeamInviteRefusedError({
          detail: `No invite ${inviteId} in this T3 home. \`t3 team invites\` lists them.`,
        });
      }
      const invite = found.value;
      if (invite.status === "revoked") return { invite, alreadyRevoked: true };
      if (invite.status === "used") {
        return yield* new TeamInviteRefusedError({
          detail: `Invite ${inviteId} was already used: ${invite.memberName} joined with it. Revoking it would not remove them; removing a member comes with \`t3 team remove\` (not built yet).`,
        });
      }
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE team_invites SET revoked_at = ${revokedAt}
        WHERE invite_id = ${inviteId} AND revoked_at IS NULL AND used_at IS NULL
      `.pipe(storage("revokeInvite"));
      const updated = yield* get(inviteId);
      if (Option.isNone(updated) || updated.value.status !== "revoked") {
        return yield* new TeamInviteRefusedError({
          detail: `Invite ${inviteId} changed while it was being revoked (was it just used?). Run \`t3 team invites\` to see it.`,
        });
      }
      return { invite: updated.value, alreadyRevoked: false };
    },
  );

  const join: TeamInvites["Service"]["join"] = Effect.fn("TeamInvites.join")(function* (input) {
    return yield* Effect.gen(function* () {
      const found = yield* get(input.inviteId);
      if (Option.isNone(found)) return yield* refuseJoin("invite_not_found");
      const invite = found.value;

      if (invite.usedBySessionId === input.sessionId) {
        const bound = yield* findBySession(input.sessionId);
        if (Option.isSome(bound)) return { team: bound.value.team, member: bound.value.member };
        // The member or team row is gone; joining again would not bring it back.
        return yield* refuseJoin("team_not_found");
      }
      if (invite.usedBySessionId !== null) return yield* refuseJoin("invite_used");
      if (invite.status === "revoked") return yield* refuseJoin("invite_revoked");
      if (invite.status === "expired") return yield* refuseJoin("invite_expired");

      const team = yield* teams.getTeam(invite.teamId);
      if (Option.isNone(team)) return yield* refuseJoin("team_not_found");
      const existing = yield* teams.findMemberByEnvironment(invite.teamId, input.environmentId);
      if (Option.isSome(existing)) return yield* refuseJoin("already_member");

      const member = yield* teams.addMember({
        teamId: invite.teamId,
        displayName: invite.memberName,
        environmentId: input.environmentId,
      });
      const usedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE team_invites
        SET used_at = ${usedAt}, used_by_session_id = ${input.sessionId},
          member_id = ${member.memberId}
        WHERE invite_id = ${invite.inviteId} AND used_by_session_id IS NULL
      `.pipe(storage("joinInvite"));
      return { team: team.value, member };
    }).pipe(
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(new TeamStorageError({ operation: "joinInvite", cause })),
      ),
    );
  });

  return TeamInvites.of({
    create,
    get,
    list: (teamId) => selectInvites(teamId === undefined ? {} : { teamId }),
    markRevoked,
    join,
    findBySession,
  });
});

/** Needs `TeamService` (which runs the team migrations) and its `SqlClient`. */
export const layer = Layer.effect(TeamInvites, make);

export interface IssuedTeamInvite {
  readonly invite: TeamInvite;
  readonly team: Team;
  /** Shown once to the host, then only in the member's hands. Never stored by the team layer. */
  readonly credential: string;
}

/**
 * `t3 team invite`: checks the team, the name and the lifetime, makes the
 * pairing link (exactly the two team scopes), then the invite row. If the row
 * cannot be saved, the link is revoked again.
 */
export const issueTeamInvite = Effect.fn("TeamInvites.issue")(function* (input: {
  readonly teamId: TeamId;
  readonly memberName: string;
  readonly ttl?: Duration.Duration | undefined;
  /** This server's environment id; it must be the team's owner. */
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const teams = yield* TeamService;
  const invites = yield* TeamInvites;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const crypto = yield* Crypto.Crypto;

  const name = yield* validateMemberName(input.memberName);
  const ttl = input.ttl ?? TEAM_INVITE_DEFAULT_TTL;
  if (Duration.toMillis(ttl) <= 0 || Duration.isGreaterThan(ttl, TEAM_INVITE_MAX_TTL)) {
    return yield* new TeamInviteRefusedError({
      detail: `An invite lasts more than 0 and at most 24 hours (--ttl). Got ${Duration.format(ttl)}.`,
    });
  }

  const team = yield* teams.getTeam(input.teamId);
  if (Option.isNone(team)) {
    return yield* new TeamInviteRefusedError({
      detail: `This T3 home does not host team ${input.teamId}, so it cannot invite anyone to it. Run the invite on the team's host.`,
    });
  }
  const members = yield* teams.listMembers(input.teamId);
  const owner = members.find(
    (member) => member.environmentId === input.hostEnvironmentId && member.role === "owner",
  );
  if (owner === undefined) {
    return yield* new TeamInviteRefusedError({
      detail: `This server is not the owner of team "${team.value.name}", so it cannot invite.`,
    });
  }
  const taken = members.find((member) => sameName(member.displayName, name));
  if (taken !== undefined) {
    return yield* new TeamInviteRefusedError({
      detail: `Team "${team.value.name}" already has a member named ${taken.displayName}. Pick another name.`,
    });
  }
  const pending = (yield* invites.list(input.teamId)).find(
    (invite) => invite.status === "pending" && sameName(invite.memberName, name),
  );
  if (pending !== undefined) {
    return yield* new TeamInviteRefusedError({
      detail: `There is already a pending invite for ${pending.memberName} (${pending.inviteId}, expires ${pending.expiresAt}). Revoke it first with \`t3 team invites --revoke ${pending.inviteId}\`, or use that one.`,
    });
  }

  const inviteId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const link = yield* auth.createPairingLink({
    scopes: TEAM_INVITE_SCOPES,
    subject: `${TEAM_INVITE_SUBJECT_PREFIX}${inviteId}`,
    label: `Team ${team.value.name}: ${name}`,
    ttl,
  });
  const invite = yield* invites
    .create({
      inviteId,
      teamId: input.teamId,
      memberName: name,
      createdByMemberId: owner.memberId,
      pairingLinkId: link.id,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
    })
    .pipe(Effect.tapError(() => auth.revokePairingLink(link.id).pipe(Effect.ignore)));
  return { invite, team: team.value, credential: link.credential } satisfies IssuedTeamInvite;
});

/** `t3 team invites --revoke`: the invite row first (so `/join` refuses), then its pairing link. */
export const revokeTeamInvite = Effect.fn("TeamInvites.revoke")(function* (inviteId: string) {
  const invites = yield* TeamInvites;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* invites.markRevoked(inviteId);
  yield* auth.revokePairingLink(result.invite.pairingLinkId);
  return result;
});
