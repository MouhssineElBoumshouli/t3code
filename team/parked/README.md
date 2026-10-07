# Parked code

Code we stopped running but may want back. Nothing here is compiled or tested: `team/` is in no `tsconfig` `include` and no package's test run. The repo-wide lint and formatter still read these files.

## host-mode/

Team host mode, M2.2 and M2.3: one T3 server hosts the team, others join it with an invite. [VISION.md](../VISION.md) replaced it with team state on a Git ref in the project's repo ([STORAGE_PLAN.md](../STORAGE_PLAN.md) 3.6).

- **Runnable copy:** the tag `team-host-mode-m2.3` (commit fc0dc2691). Check it out to run host mode as it was.
- **Layout:** the same paths as in the app, under `host-mode/`. `git log --follow` works on the moved files.
- `apps/server/src/cli/team.ts` and `team.test.ts` are full copies of those files at the tag. In the app, only their `invite` and `invites` parts were removed; `init` and `status` stay there.
- The files here do not build against the current code: the team scopes (`team:read`, `team:write`), `TeamService.addMember` and the `teamHttp.ts` export were removed with them.

Kept in the app on purpose:

- The upstream fix in `apps/server/src/ws.ts` (three ChatGPT RPCs now check their scope). Its test is `apps/server/src/auth/ChatGptRpcScopes.test.ts`.
- Team migration 4 (`team_invites`): existing dev databases have the table, so the migration list does not change.

## sqlite-service/

The SQLite team service, M1 to M2.3: team state in the `team_*` tables of the T3 home's database. Slice 5 of [STORAGE_PLAN.md](../STORAGE_PLAN.md) replaced it with `GitTeamService` (`apps/server/src/team/state/`), which keeps the same reads and writes on the hidden ref `refs/t3-team/state` of the project's remote.

- **Runnable copy:** any commit before the switch, for example the tag `team-host-mode-m2.3` (with host mode) or bc1e8a6be (without).
- **What moved:** `TeamService.ts` (the SQLite body; `apps/server/src/team/TeamService.ts` is now the interface only), its test, the team migrator `TeamMigrations.ts` and its test, and `Migrations/001` to `004`. The migrator was only run by the SQLite service.
- Existing dev databases keep their `team_*` tables and `team_sql_migrations` rows. Nothing reads or drops them.
- These files do not build against the current code: `TeamService` is an interface with other methods now, and `TeamMember` has `lastSeenAt` instead of `environmentId` and `joinedAt`.
