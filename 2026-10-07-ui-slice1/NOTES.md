# UI slice 1: holder marks and presence chip (2026-10-07/08)

`main` commit: b1acf26b8. Dev server on `~/.t3-dev`, headless Chromium 1440×900.
Projects: `~/code/solo-demo1` (no remote, solo) and `~/code/team-demo6` (local origin, teammate `yassine-a` holding `src/auth/`).

- `solo-light.png`, `solo-dark.png`: two Codex chats in solo-demo1 claimed `src/notes/editor.ts` and `src/notes/`. Sidebar rows show the other chat's color square; the tree marks `editor.ts` "+1 chat" (not `list.ts`); the `editor.ts` tab has the square; no presence chip (solo).
- `team-light.png`, `team-dark.png`: a chat in team-demo6 claimed `src/auth/login.ts` and was told it overlaps yassine-a. Header chip "YA · synced"; tree marks `auth/`, `login.ts`, `LoginForm.tsx` with YA (not `search/`); the tab and the sidebar row show YA. The other sidebar rows are older test threads of the dev home (t3-team-scratch shows Yassine-T3Test's mark).
- `team-light-popover.png`, `team-dark-popover.png`: the chip's popover: "Up to date with the team", yassine-a (seen 5 min ago, task "Login page", holds src/auth) and the latest handoff.
