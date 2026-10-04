/**
 * The team layer's own migrator.
 *
 * Upstream's migrator skips every migration whose id is at or below the
 * highest id it has recorded, so team migrations must never join upstream's
 * `migrationEntries` list: any id we picked would clash with upstream's next
 * migration or block all of upstream's later ones. These run through the same
 * `Migrator`, but record into their own `team_sql_migrations` table, so the
 * two id sequences never see each other.
 *
 * `TeamService` runs this when it is built. It asks for the `SqlClient` from
 * the SQLite persistence layer, which finishes upstream's migrations before
 * it hands the client out, so team migrations always run after upstream's.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/001_TeamCore.ts";
import Migration0002 from "./Migrations/002_TeamHandoffFileHashes.ts";
import Migration0003 from "./Migrations/003_TeamAutomaticNotes.ts";
import Migration0004 from "./Migrations/004_TeamInvites.ts";

export const TEAM_MIGRATIONS_TABLE = "team_sql_migrations";

const teamMigrationEntries = [
  [1, "TeamCore", Migration0001],
  [2, "TeamHandoffFileHashes", Migration0002],
  [3, "TeamAutomaticNotes", Migration0003],
  [4, "TeamInvites", Migration0004],
] as const;

export const teamMigrationManifest = teamMigrationEntries.map(([id, name]) => [id, name] as const);

const run = Migrator.make({});

/** Runs pending team migrations and returns the `[id, name]` pairs it ran. */
export const runTeamMigrations = Effect.fn("runTeamMigrations")(function* () {
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        teamMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: TEAM_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Team migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
