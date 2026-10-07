import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import {
  runTeamMigrations,
  TEAM_MIGRATIONS_TABLE,
  teamMigrationManifest,
} from "./TeamMigrations.ts";
import * as TeamService from "./TeamService.ts";

const latestUpstreamId = migrationManifest.at(-1)![0];
const teamIds = teamMigrationManifest.map(([id]) => id);

const recordedIds = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: number }>`
      SELECT migration_id AS "id" FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => row.id);
  });

const teamTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'team_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("team migrations", () => {
  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("on a fresh database", (it) => {
    it.effect("creates the team tables and records only team ids in their own table", () =>
      Effect.gen(function* () {
        const ran = yield* runTeamMigrations();
        assert.deepEqual(ran, teamMigrationManifest);
        assert.deepEqual(yield* teamTables, [
          "team_activity",
          "team_claims",
          "team_handoffs",
          "team_invites",
          "team_members",
          "team_sql_migrations",
          "team_tasks",
          "team_teams",
        ]);
        assert.deepEqual(yield* recordedIds(TEAM_MIGRATIONS_TABLE), teamIds);

        // Running again is a no-op.
        assert.deepEqual(yield* runTeamMigrations(), []);
        assert.deepEqual(yield* recordedIds(TEAM_MIGRATIONS_TABLE), teamIds);
      }),
    );
  });

  // The failure this guards against: team ids in upstream's table would make
  // upstream's migrator skip every later upstream migration at or below them.
  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
    "next to upstream's migrations",
    (it) => {
      it.effect("does not stop upstream migrations added later from running", () =>
        Effect.gen(function* () {
          const olderUpstream = latestUpstreamId - 4;
          yield* runMigrations({ toMigrationInclusive: olderUpstream });
          yield* runTeamMigrations();

          // Upstream ships new migrations; the next start runs them.
          const ran = yield* runMigrations();
          assert.deepEqual(
            ran.map(([id]) => id),
            range(olderUpstream + 1, latestUpstreamId),
          );
          assert.deepEqual(yield* recordedIds("effect_sql_migrations"), range(1, latestUpstreamId));
          assert.deepEqual(yield* recordedIds(TEAM_MIGRATIONS_TABLE), teamIds);
        }),
      );
    },
  );

  it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("run before upstream's", (it) => {
    it.effect("leaves every upstream migration to run", () =>
      Effect.gen(function* () {
        yield* runTeamMigrations();
        const ran = yield* runMigrations();
        assert.deepEqual(
          ran.map(([id]) => id),
          range(1, latestUpstreamId),
        );
        assert.deepEqual(yield* recordedIds(TEAM_MIGRATIONS_TABLE), teamIds);
      }),
    );
  });

  it.effect("runs when the team service is built on the server's SQLite layer", () =>
    Effect.gen(function* () {
      yield* TeamService.TeamService;
      assert.deepEqual(yield* recordedIds("effect_sql_migrations"), range(1, latestUpstreamId));
      assert.deepEqual(yield* recordedIds(TEAM_MIGRATIONS_TABLE), teamIds);
      assert.include(yield* teamTables, "team_teams");
    }).pipe(
      Effect.provide(
        TeamService.layer.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
