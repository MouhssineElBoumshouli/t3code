import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Content hashes of a handoff's files, for freshness checks on uncommitted work (D7). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE team_handoffs ADD COLUMN file_hashes_json TEXT`;
});
