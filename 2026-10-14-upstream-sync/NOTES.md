# 2026-10-14 upstream sync smoke

Weekly upstream sync: 242 upstream commits (ed0f7b908 to 7ac952c630), merged into `main` at e407bfd267.
Fresh seeded `~/code/team-demo18`, one dev server (`--home-dir ~/.t3-dev`).

Codex hit the account's usage limit on its first turn ("try again at 8:23 PM"), so the cards were run with
Claude Sonnet 5.5 (approved for this round). The Codex turn still showed the team briefing
(`t3_code_team`, "Demo team 18") in its session log.

- `01-team-home.png`: Team home after the sync: members, claims, handoffs, the Merging section (nothing to report yet) and the Notes form.
- `02-plan-and-warning-cards.png`: a Claude chat asked to change `src/pins/search.ts`: plan card (1 file, held by Sara) and the warning card (Find another way, Go anyway, Wait for Sara, Ask Sara). Find another way was then sent to the agent; it planned `src/pins/urlSearch.ts` + `src/api/routes.ts` (a second card, Sara holds routes.ts); Go anyway finished the turn (+11).
- `03-notes.png`: a note written from Team home, shown under "From you"; it reached the remote's team state (writer file).
