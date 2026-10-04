import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Invites made with `t3 team invite` on the host (team/DESIGN.md 7.1 M2.3).
 * The invite's credential is never stored here: only the id of the pairing
 * link that carries it. `/join` fills `used_*` and `member_id`, and the
 * invite row is what binds that session to its member.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_invites (
      invite_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      created_by_member_id TEXT NOT NULL,
      pairing_link_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by_session_id TEXT,
      member_id TEXT,
      revoked_at TEXT
    )
  `;
  // One session binds to at most one invite, so a session names one member.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_session
    ON team_invites (used_by_session_id)
    WHERE used_by_session_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_invites_team
    ON team_invites (team_id, created_at)
  `;
});
