# 2026-10-12 · Team home / Today (UI_PLAN.md slice 4, part 1)

`main` at the commit after cdc6b24cb (this round's feature commit). Dev server `vp run dev --home-dir ~/.t3-dev` with `T3CODE_TEAM_LOGIN_OVERRIDE=mouhssine`, headless Chromium 1440×900, Codex GPT-6-Astra only.

Projects: fresh `~/code/solo-demo8` (plain Git repo, two Codex chats both on `src/greet.ts`) and fresh `~/code/team-demo14` (seed script: Sara and Omar on their own servers, two tasks, two handoffs; one Codex chat of mine adding a README sentence).

- `01-today-solo-light.png`: Today, opened from the sidebar icon row while in the second chat. First visit, so "In the last day": both chats started on `src/greet.ts`, the first finished, the second waits for you. Both chat cards hold `src/greet.ts` and name the overlap; the second reads "waiting for you" (its warning card is open). Notes slot and the "Working with others?" card.
- `02-today-make-team-explainer.png`: "Make this a team project" opens an explanation only (what it adds, who can join, use a private repo, done today with `t3 team init`). No action.
- `03-team-home-light.png`: Team home for team-demo14: "synced", the catch-up line (Sara and Omar's claims, Sara's handoff, 2 new tasks), people cards (you first: task, claim note, `README.md` held, own branch not merged yet, latest handoff), tasks, recent handoffs, Notes slot. The sidebar entry still showed the solo house icon here; fixed right after (see 04).
- `04-team-home-dark.png`: the same in dark, after the fix: the sidebar entry shows the team icon on the page. The catch-up line had updated by itself when my chat finished ("Your chat finished: …").
- `05-today-second-visit-dark.png`: Today again two hours later: "Since 2:54 PM" (the first visit), and only the chat still waiting is named. The Codex update toast is upstream's.
