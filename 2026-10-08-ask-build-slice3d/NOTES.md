# 2026-10-08 — "Ask" and "Build on top" (PREVENTION_PLAN.md slice 3d), live self-test

- `main` commit under test: `17465d94e` (slice 3d), on top of `68282754b` (small fixes). The "holds it/them" wording fix seen in r4-05 came after.
- Setup: fresh `~/code/team-demo12` from `team-cold-start-seed.ts` (local bare remote), one dev server `vp run dev --home-dir ~/.t3-dev` as `mouhssine` (login override, local remote), Playwright headless 1440×900. Codex GPT-6-Astra in every chat. Sara and Omar are a scratch script acting as their servers through the real `GitTeamService` (claim with a branch, record a pushed branch, ask, answer).
- Light pictures with the browser's light scheme, dark with `prefers-color-scheme: dark`.

| Picture | What it shows |
| --- | --- |
| r4-01-card-ask-light | Codex planned `src/api/routes.ts` (Sara holds it). The card: Find another way, Go anyway, Wait for Sara, "Build on top of Sara's work · not pushed yet" (disabled: that claim has no branch), Ask Sara. Sidebar: "Input". |
| r4-02-ask-line-light | After "Ask Sara": the line field with "Only the 404 body, one line", Send question, Cancel. |
| r4-03-asked-light | "Asked Sara just now · the answer comes here; you can still choose below"; the other choices stay. Codex ended its turn on the held answer. Sidebar no longer says "Input". |
| r4-04-agreed-app-message-light | Sara answered yes with a line (script, 22:44:15); 42 s later: "Sara said yes: go anyway, agreed · "Fine, I'm not touching the 404 path" · sent as a new message", and the new turn's message drawn as "Sent by T3 Code". Codex then changed routes.ts. |
| r4-05-question-on-holder-chat-light | Roles reversed: my chat planned `src/auth/login.ts`; Sara asked me about it. The question card on that chat with a line field, "Yes, go ahead", "No"; the chip reads "synced · 1 question". (Wording "holds them" for one file, fixed after.) |
| r4-06-popover-question-light | The presence popover: "Questions for you" with Sara's question, line and answer form, above teammates and handoffs. |
| r4-07-popover-question-dark | The same, dark. |
| r4-08-holder-answered-no-dark | Answered "No" with a line from the popover: the chat's card reads "You said no · "Wait until my plan lands, about an hour"", the chip count is gone. Sara's script read the answer from the team state. |
| r4-09-declined-not-pushed-dark | A third chat planned `src/pins/search.ts`; Asked Sara; she said no: "Sara said no · "Not yet, my branch changes that function"", the card open again without Ask, sidebar "Input"; Build on top still "not pushed yet" (her branch only on her computer). |
| r4-10-build-on-top-enabled-dark | Sara pushed `sara/search-filter` and her server recorded it: "Build on top of Sara's work" enabled (card only). |
| r4-11-build-on-top-enabled-light | The same moment, whole window, light. |
| r4-12-built-on-top-light | After the click: "Built on top of Sara's work · on sara/search-filter · sent as a new message", the "Sent by T3 Code" message, and Codex's turn: notes matching added on top of Sara's version (kept her empty-query rule and newest-first). No new card on the next plan. |
| r4-13-built-on-top-dark | The same, dark. |
