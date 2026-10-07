# 2026-10-07 design round (VISION.md step 3)

Main commit: 1a206119c (mockups in `team/mockups/`, proposal in `team/DESIGN_DIRECTION.md`).

Static HTML mockups, not the app. Headless Chromium through the Playwright MCP, 1440×900, pages served from `team/mockups/` by a local `python3 -m http.server` (stopped after). `shot=1` hides the mockup switcher. No console errors.

Names: `<option>-<theme>-<mode>[-card|-popover|-home].png`

- `a-*`: Option A, Team tab in the right panel (solo: Memory). Card above the composer.
- `b-*`: Option B, presence bar in the tab bar. `-popover`: the details popover open. `-card`: the warning card as a sheet over the chat.
- `c-*`: Option C, chat view with the sidebar who-is-around block. `-card`: the warning card inside the agent's message. `-home`: the Team home page (team) or Today (solo).
- `index-light.png`, `index-dark.png`: the index page with live previews.

Each option: light and dark, team and solo, with and without the card (24 pictures), plus B popover ×4, C home ×4, index ×2. 34 in all. Every picture was looked at; none can show a link, token or secret.

Seen while checking B (fixed before these pictures were taken): the solo chat chips had no color (a `.chat` class clash), and the popover was open by default over the plan card.

The repo's commit hook ran the formatter on the HTML/CSS after these pictures were taken (whitespace only).
