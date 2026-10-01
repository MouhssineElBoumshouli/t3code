import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Automatic notes: one per thread, saved after each turn (D7). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE team_handoffs ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_handoffs_automatic_thread
    ON team_handoffs (team_id, environment_id, thread_id)
    WHERE automatic = 1
  `;
});
