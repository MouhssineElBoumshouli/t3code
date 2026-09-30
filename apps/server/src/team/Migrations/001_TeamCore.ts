import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_teams (
      team_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      canonical_key TEXT,
      created_at TEXT NOT NULL
    )
  `;

  // One row per person per team. A member is named by their own T3 server.
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_members (
      member_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      UNIQUE (team_id, environment_id)
    )
  `;

  // Released claims keep their row (released_at set) so the activity feed can
  // still name them; `paths_json` holds a JSON array of repo-relative paths.
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_claims (
      claim_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      note TEXT,
      claimed_at TEXT NOT NULL,
      released_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_claims_active
    ON team_claims(team_id, released_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      paths_json TEXT NOT NULL,
      owner_member_id TEXT,
      environment_id TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_tasks_team
    ON team_tasks(team_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_handoffs (
      handoff_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT,
      changed TEXT NOT NULL,
      left_text TEXT,
      risks TEXT,
      files_json TEXT NOT NULL,
      commit_sha TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_handoffs_team
    ON team_handoffs(team_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_activity (
      activity_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      member_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      environment_id TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_activity_team
    ON team_activity(team_id, created_at)
  `;
});
