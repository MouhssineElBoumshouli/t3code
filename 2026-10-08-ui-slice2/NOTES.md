# UI slice 2: the plan card, and holder names in the row and tab tooltips (2026-10-08)

`main` commits: f1f6b70ea (tooltips, login override), 6d614b059 (plan card). Dev server on `~/.t3-dev`, headless Chromium 1440×900, Codex (GPT-6-Astra).
Projects: `~/code/team-demo7` (seeded: Sara holds `src/pins/search.ts`, `src/api/routes.ts`; Omar holds `src/auth/session.ts`) and `~/code/solo-demo2` (plain Git repo, no remote).

- `team-light.png`, `team-dark.png`: the chat was told to call `team_plan` with `src/auth/session.ts`, `src/pins/search.ts`, `src/auth/RememberMe.tsx` and not edit. The card under "Worked for 14s" (the turn is folded; the card stays): "3 files planned, checked against claims · 2 held by others"; OM "held by Omar", SA "held by Sara"; RememberMe.tsx free. Header chip "OM SA · synced". Dark has `session.ts` open in the right panel; the tree marks it OM.
- `team-light-row-tooltip.png`: hover on the chat's sidebar row: the details card ends with the chips and "Also held by Sara, Omar" (before this fix the names were only in the accessible label).
- `team-light-tab-tooltip.png`: hover on the `session.ts` tab: "session.ts / Also held by Omar".
- `solo-light.png`, `solo-dark.png`: second solo chat planned `src/notes/editor.ts` and `src/notes/list.ts` after the first chat planned `editor.ts`: "2 files planned … 1 held by another chat"; `editor.ts` with the first chat's color square and 'held by your chat "Request Team Plan for Editor Toolbar"'. No presence chip (solo).

The other sidebar rows are older test chats in the dev home.
