# Slice 3a live self-test: the warning card (2026-10-08)

Dev server `vp run dev --home-dir ~/.t3-dev`, headless Chromium (Playwright MCP), 1440x900.
Code under test: `main` at a2304b940 (3a), then f2f79ce68 (the fix below) and c750efa2e (briefing) for pictures 10 to 13.
Projects: `~/code/team-demo8` (team "Demo team 5", `file://` origin; Omar holds `src/auth/session.ts`, Sara holds `src/pins/search.ts` and `src/api/routes.ts`) and `~/code/solo-demo3` (fresh, solo, current checkout).
Models: Codex GPT-6-Astra (medium), Claude Sonnet 5.5 (high), both full access.
No prompt named team_plan or claims.

| Picture | What it shows |
| --- | --- |
| 01-codex-team-card-held-light | Codex, team, "Add a GET /pins/count route": team_status, then team_plan before any edit; the plan card and the warning card "Sara holds a file in this plan". |
| 02-codex-team-card-held-dark | Same, dark, 2 min into the hold: past Codex's old 60 s tool timeout. Codex wrote "the team file-claim call is still pending; I'll apply the edit once it returns". |
| 03-codex-team-find-another-way-dark | After "Find another way": "You chose: Find another way · sent to the agent", a new plan with `src/server.ts` (nobody holds it); routes.ts untouched. |
| 04-claude-team-card-held-light | Claude, team, "Sessions should last 1 day instead of 7": card "Omar holds a file in this plan". |
| 05-claude-team-card-held-dark | Same, dark. |
| 06-claude-team-go-anyway-dark | After "Go anyway": session.ts edited; team activity got "mouhssine went ahead on src/auth/session.ts, held by Omar." |
| 07-codex-solo-card-held-dark | Codex, solo: "Another chat holds a file in this plan", holder chip 'held by your chat "Show Note Dates in List Output"', only "Wait for that chat" under Coming soon. |
| 08-codex-solo-stopped-card-open-dark | The user pressed Stop while held: turn interrupted, card still open. |
| 09-bug-codex-solo-click-after-stop-lost-dark | **Bug (before the fix):** the click after Stop said "sent to the agent" but went to the dead held call; no turn started. Fixed in f2f79ce68. |
| 10-claude-solo-card-held-light | Claude, solo, after the briefing change: team_status, team_plan, held; two holder chats. |
| 11-claude-solo-find-another-way-light | After "Find another way": new plan `src/cli.ts`, edited only that. |
| 12-codex-solo-fixed-stop-then-click-new-turn-dark | **After the fix:** Stop, then "Find another way": "sent as a new message", the choice arrives as the next user message, Codex re-plans (`src/cli.ts`, held by another chat: a second card). |
| 13-codex-solo-click-after-turn-ended-go-anyway-dark | Codex ended that turn itself while the call was open; the click on the second card started a new turn ("sent as a new message"); Codex edited cli.ts and wrote a handoff. |

Not shown: Claude solo in dark mode; Codex "Go anyway" while the call is held (seen with Claude).
