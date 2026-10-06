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
