# 2026-10-07 slice 0: host mode parked

- `main` commit: 55b070421 (feat(team): slice 0, park host mode)
- Dev server: `vp run dev --home-dir ~/.t3-dev`, web port 5733, server port 13773. The home was the one part 0 made earlier the same day.
- Browser: Playwright MCP, headless Chromium, fresh profile.

Checks, in order:

1. `curl` without a session: `GET /api/team/v1/me` → 404 on the server port (13773) and through the web proxy (5733).
2. A session from `t3 pair` (standard scopes), exchanged at `/oauth/token`: `/api/auth/session` says authenticated; `GET /api/team/v1/me`, `/join`, `/teams` and `POST /api/team/v1/join` → 404; control `GET /api/orchestration/snapshot` → 200.
3. `t3 team --help` (`t3-team-help.txt`): subcommands `init` and `status` only. `t3 team invite ...` prints the same help (no such command).
4. Opened the startup pairing URL in Playwright; the app loaded.
   - `01-welcome-after-pairing.png`: the "Set up T3 Code" dialog, this computer "Connected". From the page, `/api/team/v1/me` → 404.
5. **Found:** from the same page, `GET /api/auth/clients` → 500 `EnvironmentInternalError`. Cause: part 0's browser session (made before slice 0) stored `team:read` and `team:write`, which no longer decode. Fixed on this dev home by marking that session and its pairing link revoked (only rows with a `team:` scope), then restarting the server.
   - After the restart, from the page: `/api/auth/clients` → 200 (2 sessions), `/api/team/v1/me` → 404.
   - `02-app-after-dev-home-fix.png`: the app after the restart, same dialog, "Connected".

No pairing link or token is in any picture or file here.
