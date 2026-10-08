# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

## 2026-10-08 — Honest status while the card waits; token fixes; the guard (3b)

**Step 1: "Awaiting Input" while the card waits**

- An open warning card now counts as pending user input in the thread shell (`pendingUserInputCount`), so the sidebar shows "Awaiting Input" (web and mobile both read `hasPendingUserInput`), the thread is not auto-settled, and the input notification fires. Open means: no choice made, and no newer turn (if the user ignores the card and sends a message, the card stops counting; it still takes a click).
- Timeline: while an open card is in the running turn, the "Working for" row reads "Waiting for your input" and the "Thinking" row is not added.
- New: `apps/server/src/team/openTeamChoices.ts` (+ test: the count, and a run through the real projection pipeline: open card 1, choice made 0, unanswered card then a new turn 0), `apps/web/src/components/team/teamChoiceTimeline.test.ts`.
- `team-layer:` edits in upstream files: `ProjectionPipeline.ts` (import; refresh the shell on the two card kinds; add the open-card count), `persistence/Layers/ProjectionThreadActivities.ts` (the summary query also reads `team.choice` and `team.choice.made`), `MessagesTimeline.logic.ts` (`awaitingInput` on the working row, its equality check, no thinking row), `MessagesTimeline.tsx` (the label).
- Checked: `vp test run src/team/openTeamChoices.test.ts src/orchestration/Layers/ProjectionPipeline.test.ts` 37 passed; mutation (count left out of the pipeline) fails the test. Web: `teamChoiceTimeline.test.ts` + `MessagesTimeline.logic.test.ts` 123 passed. `tsc --noEmit` server and web: 0 errors. Lint: only old warnings in `MessagesTimeline.tsx`.
- Not changed: manual settle (the decider's own pending check) does not know cards, so a user can settle a thread with an open card; the card then still counts. The mobile thread screen's own live row was not checked. Threads whose card opened before this build are counted at their next summary refresh.

**Step 2: token fixes 1 and 2 (VISION.md 6.5)**

- Fix 1: the briefing resolver keeps each thread's last briefing and reuses it when the lookup takes over 2 s or fails; only "not in a team" (and no `t3-code` MCP server) removes it. So the cached prompt prefix no longer changes for one turn (`mcp/toolkits/team/briefing.ts`, fork file).
- Fix 2: Codex gets the briefing as its own `additionalContext` entry, `t3_code_team`, instead of inside `t3_code_runtime`, so switching model or effort no longer resends it (`team-layer:` edit in `provider/CodexDeveloperInstructions.ts`; `CodexSessionRuntime` unchanged, it already passes `teamContext`). After compaction both entries are injected again, as before.
- Checked: `vp test run src/mcp/toolkits/team/briefing.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/provider/Layers/CodexSessionRuntime.test.ts`: 62 passed. New test: briefing, then a broken team file (reused), then a team this server cannot use (none), then broken again (none). Two mutations (no reuse; no removal) each fail it. `tsc` server 0 errors; lint clean.
- Unsure: a team whose state is "unavailable" (e.g. offline fetch) resolves as "not in a team", so it drops the briefing, as before. The 2 s timeout itself was not exercised (it needs a slow git); the failure path shares the reuse code.

## 2026-10-08 — Live check: agents call team_plan on their own; 3a self-test live; two bugs fixed; token research

**What changed**

- **Live check (step 1).** Normal tasks on held files, never naming team_plan or claims, in `~/code/team-demo8` (team) and a fresh `~/code/solo-demo3` (solo). Each run: did the agent call `team_plan` before its first edit?

  | Run                                                          | Provider | Mode | Briefing | team_status then team_plan before editing?                                                |
  | ------------------------------------------------------------ | -------- | ---- | -------- | ----------------------------------------------------------------------------------------- |
  | "Add a GET /pins/count route" (routes.ts, Sara)              | Codex    | team | old      | yes                                                                                       |
  | "Sessions should last 1 day instead of 7" (session.ts, Omar) | Claude   | team | old      | yes                                                                                       |
  | "Show each note's date" (format.ts, nobody yet)              | Claude   | solo | old      | yes                                                                                       |
  | "Cut note text to 40 characters" (format.ts, chat A)         | Codex    | solo | old      | yes                                                                                       |
  | "Number the list from 1" (format.ts, chats A, B)             | Claude   | solo | old      | **no**: no team call at all; edited format.ts and cli.ts with a `python3` heredoc in Bash |
  | "Show (empty) for notes with no text"                        | Claude   | solo | new      | yes                                                                                       |
  | "Put a * in front of today's notes"                          | Codex    | solo | new      | yes                                                                                       |
  | "Search ignores a leading #" (search.ts, Sara)               | Claude   | team | new      | yes                                                                                       |

  So 7 of 8; the miss was Claude, solo, on a small edit. The run had the briefing and the tools (server log "Team briefing added"; the tools were in its list).

- **Briefing fix** (both briefings): "Before any edit, even a small one, call team_status, then team_plan the files you will change." and "Follow team_plan's answer; it may wait for the user." (replaces "if it reports overlaps, tell the user": team_plan now holds instead). The solo one opens with why: "Other chats of this user may be changing this project too." Team briefing still about 148 tokens with the longest names (budget 150); solo down from about 133 to 126. Tool descriptions unchanged. Three runs after the change: all planned first (table). Few runs, so this is a sign, not proof.
- **Bug found and fixed (3a fallback).** Stop while the card holds Codex, then click: the click went to the held call (`delivery: "held"`), because Codex does not cancel the MCP call when its turn stops. Nobody read the answer: no turn started, and the card said "sent to the agent" (picture 09). Now a held call counts only while the turn that made it is still running (the waiter keeps its turn id); otherwise the stale call is freed with "not yet" and the choice goes out as a new turn. Live after the fix: Stop then "Find another way" was "sent as a new message" and the agent re-planned (picture 12). And a second case: Codex ended a turn on its own while its `team_plan` call was still open; the click then also started a new turn (picture 13).
- **Bug found and fixed: Claude's handoff notes lost their text.** Claude Code defers MCP tools, so Claude calls `team_handoff` before reading its schema. It sent `{summary}`, got "Missing key changed", then sent the file list as `changed`; `summary` was an unknown key and was dropped. Two of three Claude handoffs were saved as `["src/format.ts"]` with no files (the Codex ones were fine). The input is now `summary` ("What changed, in words."); the stored field keeps its name. Live after the change (one Claude run, solo): saved `{summary, files, risks}` on its first real call, and it planned before editing. Making unknown keys an error would be better still, but the Toolkit decoder ignores the struct's `onExcessProperty` annotation.
- **VISION.md 6.5, token use (research).** Briefing about 120 to 150 tokens per message (cached for Claude, Codex, OpenCode; repeated in history for Cursor, Grok, Antigravity); 6 tool definitions 750 to 1,000 (cached; Claude loads them on demand); about 700 to 1,600 input tokens per editing task. One cache break found: a briefing lookup over 2 s or failing leaves the briefing out for that turn, which changes OpenCode's system text (cache miss) and makes Codex resend its entry twice. Fix proposed (reuse the last briefing), not built. Six cuts listed, cheapest first.
- **Test:** `team.choose` is refused to an `orchestration:read` session (real server, `ChatGptRpcScopes.test.ts`): `EnvironmentAuthorizationError`, required scope `orchestration:operate`.

**3a self-test, live (step 2)**: what I clicked and saw

- Codex, team: card held; still held at 2 min (past the old 60 s, so the raised `tool_timeout_sec` works); "Find another way": Codex re-planned with `src/server.ts` (nobody holds it) and left routes.ts alone (pictures 01 to 03).
- Claude, team: card held; "Go anyway": session.ts edited, team activity "mouhssine went ahead on src/auth/session.ts, held by Omar." pushed to the state ref (04 to 06).
- Codex, solo: "Another chat holds a file", chip with the other chat's title, only "Wait for that chat" coming soon (07); the Stop bug above (08, 09) and the fix (12, 13).
- Claude, solo: held with two holder chats; "Find another way": re-planned with `src/cli.ts`, edited only that (10, 11).
- Light and dark: both cards read well in both (01/02, 04/05).
- Screenshots: branch `test-screenshots`, folder `2026-10-08-ui-slice3a/` (13 pictures + NOTES.md), commit 7a00653fa.

**Files touched**

- `apps/server/src/team/TeamChoices.ts` (the fix), `apps/server/src/mcp/toolkits/team/handlers.test.ts` (stop-then-click test; the harness can stop a thread's turn; handoff calls use `summary`), `apps/server/src/auth/ChatGptRpcScopes.test.ts`, `apps/server/src/team/TeamBriefing.ts` (+ test), `apps/server/src/mcp/toolkits/team/tools.ts` and `handlers.ts` (`summary`), `team/VISION.md` (6.5).

**How it was checked**

- `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/cli/team.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/auth/ChatGptRpcScopes.test.ts`: 19 files, **180 passed**. The new stop-then-click test fails without the fix (`{ delivery: 'held' }` instead of `'turn'`).
- After the `summary` rename: `vp test run src/team/ src/mcp/toolkits/team/ src/cli/team.test.ts`: 17 files, 170 passed.
- `tsc --noEmit` in `apps/server`: 0 errors (both times). `vp lint` and `vp fmt` on the changed files: clean.
- Live runs as above; dev server and browser stopped after (ports free).

**What's left / findings not fixed**

- **"Working" while the card waits for the user.** During a hold the sidebar says "Working 2m" and the timeline "Thinking", but the agent waits on the user. The honest state is the sidebar's "input" status. It comes from `hasPendingUserInput`, which the projection derives from `user-input.*` activities (`ProjectionPipeline.ts`, its SQL filter and the backfill migration), and it also drives settling and queued sends. Making an open card count there is an upstream change in several places: your call before I do it.
- Codex keeps thinking while its call is held, and can end its turn by itself with the call still open (seen once, after about 3 min). The fix covers the click; the agent's own text then says "waiting", which is right.
- Claude calls deferred MCP tools once with empty arguments before loading their schema: the server logs `Invalid parameters for tool 'team_plan': Missing key` as ERROR, then the real call works. Noise only.
- Claude's miss edited files through Bash (`python3` heredoc), not Edit or Write. Slice 3b's planned PreToolUse hook on Edit/Write would not catch that; only the turn diff would.
- The two broken handoff notes from before the fix stay in the solo state of `solo-demo3` (dev home only); `team_status` shows them as `You, …: ["src/format.ts"]`.
- 6.5's fixes 1 and 2 (reuse the last briefing; Codex's own key) are a few lines each: say if you want them next.

**Unsure about / notes**

- 8 live runs is small; Claude's skip may come back on other small tasks.
- Dev home `~/.t3-dev` now has projects team-demo8 and solo-demo3 with these chats.

## 2026-10-08 — The warning card, slice 3a (PREVENTION_PLAN.md section 5): code and tests; live runs not done

**What changed**

- **`team_plan` holds the call** when a planned file is held by someone else (a teammate, or another chat). `apps/server/src/team/TeamChoices.ts` adds a `team.choice` activity (the card) in the running turn and waits for the click, up to a cap per provider, taken from the thread's session driver: Claude 24 h, Codex 55 min, the others 45 s. The waiter is registered before the card shows, and the cap timer is armed before it too, so a fast click always finds the call.
- **Codex:** `CodexAdapter` passes `-c mcp_servers.t3-code.tool_timeout_sec=3600` next to its two `-c` args (default 60 s).
- **The click:** new WebSocket method `team.choose` (scope `orchestration:operate`, like sending a message). "Find another way" releases this chat's claims on the held files; "Go anyway" writes an `overlap.accepted` line to the team activity ("Mouhssine went ahead on src/a.ts, held by Omar.") and is not asked again for those files in that chat. Then delivery: to the held call if one is waiting, else **a new turn whose message is the choice** (cap reached, server restarted, turn stopped). Then a `team.choice.made` activity, so the choice stays on the card. A second click, or a click naming another chat, is refused.
- **What the agent is told:** chosen: "User chose: find another way. Do the task without changing `src/auth/login.ts`; your claims on them are released. Call team_plan again with your new plan before editing." At the cap: "Paused: … held by Omar, and the user has not chosen yet. Do not edit it. End your turn now; the user's choice comes as the next message." Planning again before the user chose holds on the same card (no second card).
- **The card** (`apps/web/src/components/team/TeamChoiceCard.tsx`): "Omar holds a file in this plan" (solo: "Another chat holds …"), the held files with the holder chips, "Find another way" and "Go anyway", and, disabled under "Coming soon:", "Wait for Omar", "Build on top of Omar's work", "Ask Omar" (solo: only "Wait for that chat"). After the click: "You chose: Go anyway · sent to the agent" (or "· sent as a new message").
- **Client:** `packages/client-runtime/src/work-log/teamCards.ts` folds the choice into its card at the card's place (cached, so the row is not redrawn) and decodes both team cards; the work entry's `teamPlan` field became `teamCard` (plan or choice), so the timeline's five team-layer conditions cover both. `teamFeed.choose` is the command.
- `TeamService.recordActivity` (new) and the `overlap.accepted` activity kind.

**Files touched**

- New: `packages/contracts/src/teamChoice.ts`, `apps/server/src/team/TeamChoices.ts`, `apps/web/src/components/team/TeamChoiceCard.tsx`, `packages/client-runtime/src/work-log/teamCards.ts` (+ test).
- `apps/server/src/mcp/toolkits/team/handlers.ts` (+ test), `tools.ts` (`choice` in the result), `apps/server/src/team/TeamService.ts`, `state/GitTeamService.ts`, `packages/contracts/src/team.ts`, `packages/client-runtime/src/state/teamFeed.ts`, `package.json` (export).
- `team-layer:` edits in upstream files: `packages/contracts/src/index.ts`, `rpc.ts` (method and RPC), `apps/server/src/auth/RpcAuthorization.ts`, `ws.ts` (handler), `server.ts` (layer next to `TeamFeed`), `server.test.ts` (mock), `provider/Layers/CodexAdapter.ts` (2 args), `apps/web/src/session-logic.ts` (fold + decode), `MessagesTimeline.logic.ts` (the 5 conditions renamed), `MessagesTimeline.tsx` (the row), `MessagesTimeline.logic.test.ts` (1 test).

**How it was checked**

- `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/cli/team.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/auth/ChatGptRpcScopes.test.ts`: 19 files, **178 passed**. New or rewritten: team hold and click (plan card then warning card with only the held files; refused click from another chat; "Find another way" answers the held call, releases the held files and keeps the free one; no turn started; second click refused); solo "Go anyway" (activity line written; planning the same file again does not ask again); Codex cap with the test clock (still held at 54 min, "Paused" at 55; planning again holds on the same card; the click then starts a turn with the choice as its message, recorded as `delivery: "turn"`); the cap per provider. The tests wait on receipts (the card's dispatch, a hold notice), never on sleeps. Mutation: skipping the release fails the hold test.
- `CodexSessionRuntime.test.ts` and `server.test.ts`: 253 passed. `packages/client-runtime`: `teamCards.test.ts` + `teamMarkers.test.ts` 9 passed. `apps/web`: `MessagesTimeline.logic.test.ts`, `session-logic.test.ts` 205 passed (new: the choice folds into the card, which keeps its own row after the turn folds).
- `tsc --noEmit`: server, web, contracts, client-runtime, mobile: 0 errors. `vp lint` on the changed files: no errors (warnings in `MessagesTimeline.tsx` were there before).
- **Not done: the live check of step 1 and the live self-test of 3a.** The dev server started, but this session's permission checker refused to let me read the `pairingUrl:` line from the dev log, so the Playwright browser could not pair. I stopped the server by its PIDs (ports free). No screenshots yet.

**What's left**

- Step 1: live check, in `~/code/team-demo8` (seeded; its rulebook's "Claim files with team_claim" line removed so nothing names the tools), Claude and Codex each given a normal task on a held file, without naming team_plan.
- 3a live: Claude and Codex, solo and team, light and dark; the Codex hold past 60 s (the raised `tool_timeout_sec`); screenshots to `test-screenshots`.
- Mobile: the card shows there as a plain row with its summary ("1 planned file is held: your choice"), no buttons yet.

**Unsure about / notes**

- `overlap.accepted` is a new value in the writer files: a teammate on an older build would fail to read the file that holds it. Nobody runs an older build yet.
- The cap comes from the session's `providerName`; with no session yet, the instance id is used, so a custom instance of Claude with no session would get 45 s.
- A turn started by the click while the old turn still runs (the agent ignored "end your turn") goes through the same path as a message sent during a turn.

## 2026-10-08 — VISION.md 3.6: working on the same files often (research)

**What changed**

- New section 3.6 in `team/VISION.md`, research only, no code. Seven points (same part of a file, a "Shared files" list, stale view, breaks without file overlap, duplicate work, merge order, work outside the app), each with what the code has today, how useful, how hard, and its step. First two to build: the "Shared files" list, then the stale-view line at turn start.

**Files touched**

- `team/VISION.md`.

**How it was checked**

- Read in the code: `teamPathsOverlap` (paths only, no lines), `TeamAutoNotes` (files and hashes, no line ranges), `readDoNotTouchSection`, `checkFreshness` and `lateOverlaps`, `TeamClaimAutoRelease`, the `defaultThreadEnvMode` default (`local`; `t3 team init` turns worktrees on, solo does not). No `merge-tree` anywhere in the server. Nothing was run.

**What's left**

- Your call on solo worktrees: I suggest offering "Give this chat its own copy" when a second chat starts, not a default.

**Unsure about / notes**

- The test-combine command (typecheck and tests) has no home yet: a `t3.json` field or the rulebook.

## 2026-10-08 — The plan card (UI_PLAN.md slice 2)

**What changed**

- New team tool **`team_plan`** (`files`, optional `note`): before its first edit for a task, the agent lists the files it expects to change. It claims them (one claim, as `team_claim` does; held files too, so the holder sees the overlap early), checks them against everyone's claims, and answers with the overlaps. `team_claim` stays for files added later and for releasing. The team and solo briefings now say "call team_status, then team_plan the files you will change" (both stay under their token budgets).
- The server adds **one thread activity, `team.plan`**, in the running turn: per file, who else held it when the plan was checked: a teammate (`member`, with the name), or another chat of the same person (`chat`, always in solo), plus whether the claim was shared. Contract: `packages/contracts/src/teamPlan.ts`. If adding the activity fails, the claim stands and the agent is still answered (logged).
- **The card** (`apps/web/src/components/team/TeamPlanCard.tsx`) in the agent's message: "3 files planned, checked against claims · 2 held by others" (solo: "by another chat"; none held: "nobody else holds them" or "no other chat holds it"), then each file with its icon and, when held, the same chip as the markers and "held by Omar" or 'held by your chat "…"'. "Not shared yet" line when the claim could not be pushed. It is a record of the check: it does not update later (the tree and sidebar marks show who holds what now).
- Timeline: a plan entry is its own row, like an answered question: never grouped with tool calls, never folded away when the turn settles. `planHolders` (client-runtime) builds the chips from the activity, so web and mobile color them like the markers.
- Mobile: no card yet; the activity shows there as an ordinary row with its summary ("3 files planned, checked against claims").
- Two of our earlier test files imported `vitest` instead of `vite-plus/test`, which failed the contracts and client-runtime typechecks; fixed.

**Files touched**

- New: `packages/contracts/src/teamPlan.ts`, `apps/web/src/components/team/TeamPlanCard.tsx`.
- `apps/server/src/mcp/toolkits/team/tools.ts`, `handlers.ts` (+ test; `team_claim` and `team_plan` share `claimAndSummarize`), `apps/server/src/team/TeamBriefing.ts` (+ test), `packages/client-runtime/src/state/teamMarkers.ts` (+ test), `apps/web/src/components/team/TeamHolderMarks.tsx` (`TeamHolderNames`), `packages/contracts/src/teamFeed.test.ts`.
- `team-layer:` edits in upstream files: `packages/contracts/src/index.ts`, `apps/web/src/session-logic.ts` (decode the plan into the work entry), `components/chat/MessagesTimeline.logic.ts` (5 one-line conditions, next to `questionAnswer`'s), `components/chat/MessagesTimeline.tsx` (the row), `MessagesTimeline.logic.test.ts` (1 test).

**How it was checked**

- `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/cli/team.test.ts src/provider/Layers/CodexTeamBriefing.test.ts`: 18 files, **170 passed**. New: a team plan (a teammate's folder claim, another of my chats, a free file) claims the three files and dispatches one `team.plan` activity in the running turn with exactly those holders; solo, the second chat's plan names the first chat. Mutation: counting every holder as a teammate fails both tests.
- `packages/client-runtime`: `teamMarkers.test.ts` 6 passed (plan chips equal the markers' chips). `packages/contracts`: `teamFeed.test.ts` passed. `apps/web`: `MessagesTimeline.logic.test.ts`, `session-logic.test.ts`, `RightPanelTabs.test.tsx`, `Sidebar.logic.test.ts`: **392 passed**; the new test runs a real `team.plan` activity (and a malformed one) through `deriveWorkLogEntries` and the row derivation of a settled turn. Mutation: without the fold exception it fails.
- `tsc --noEmit`: server, web, contracts, client-runtime, mobile: 0 errors. `vp lint` on the changed files: no errors (the warnings in `MessagesTimeline.tsx` and `Sidebar.tsx` were there before).
- **Self-test in the real app** (Playwright, headless, 1440×900), `vp run dev --home-dir ~/.t3-dev` with `T3CODE_TEAM_LOGIN_OVERRIDE=mouhssine` (origin is a local folder), stopped by its task after (ports free). Projects: `~/code/team-demo7` (seeded with `team-cold-start-seed.ts`: Sara holds `src/pins/search.ts` and `src/api/routes.ts`, Omar `src/auth/session.ts`) and `~/code/solo-demo2` (plain Git repo, no remote). Codex (GPT-6-Astra) in all chats.
  - Team: told to call `team_plan` with `src/auth/session.ts`, `src/pins/search.ts`, `src/auth/RememberMe.tsx` and not edit. The card: "3 files planned, checked against claims · 2 held by others", OM "held by Omar", SA "held by Sara", the third file with no chip; it stays visible under "Worked for 14s" after the turn folded. Codex's own reply named the same overlaps. (`team-light.png`, `team-dark.png`)
  - Tooltips (step 1): hovering the chat's sidebar row shows the details card ending in "Also held by Sara, Omar" with the chips (`team-light-row-tooltip.png`); hovering the `session.ts` tab shows "session.ts / Also held by Omar" (`team-light-tab-tooltip.png`).
  - Solo: chat 1 planned `src/notes/editor.ts` ("1 file planned … no other chat holds it", after the singular fix below); chat 2 planned `editor.ts` and `list.ts`: "1 held by another chat", `editor.ts` with chat 1's color square and 'held by your chat "Request Team Plan for Editor Toolbar"'. No presence chip (solo). (`solo-light.png`, `solo-dark.png`)
  - Found and fixed during the test: a one-file plan said "nobody else holds them"; now "it". Seen fixed in the app after the reload.
  - Console: one React error, the upstream `ChatView` key-spread warning already noted last round.
  - Screenshots: `test-screenshots` branch, folder `2026-10-08-ui-slice2/` with NOTES.md. I looked at every picture; none shows a pairing link or token.

**What's left**

- Slice 3 waits for your review of PREVENTION_PLAN.md.
- Mobile card (the rules and `planHolders` are shared; the activity already reaches mobile as a plain row).
- Agents call `team_plan` here because the prompt said so; whether they call it unprompted, from the briefing alone, is not tested yet (needs a live run without the instruction).

**Unsure about / notes**

- In light mode the card's background (`bg-secondary`, as the changed-files card) is close to the page's; it reads, but it is quiet.
- No performance numbers measured. The card renders only when its row changes (work entries are cached per activity; rows compared by identity); nothing ticks.

## 2026-10-08 — PREVENTION_PLAN.md: how the agent stops for the warning card (research)

**What changed**

- New `team/PREVENTION_PLAN.md` (research only, for your review before slice 3). In short: one mechanism for every provider, because all six mount T3's own MCP server. `team_plan` holds the tool call when a planned file is held elsewhere, shows the card, and answers with your choice. Per provider: Claude can hold (SDK MCP timeout effectively unbounded); Codex can hold once T3 passes `tool_timeout_sec`; OpenCode and the ACP agents only briefly. Fallback: at a per-provider cap the agent is told to end its turn, and the click starts a normal turn with the choice. Also covered: what each of the five choices does in the code, the pause in the middle (Claude `PreToolUse` hook, Antigravity's writes through T3, Codex/Cursor/Grok/OpenCode interception points with an interrupt-after fallback), what is testable without a provider, and the build order (3a hold + "another way" + "go anyway", 3b guard, 3c wait, 3d ask and build on top).

**Files touched**

- `team/PREVENTION_PLAN.md` (new).

**How it was checked**

- Read in the code: every adapter's MCP wiring, `PreviewAutomationBroker` (the hold pattern), `ProviderCommandReactor` (how approvals and user input route back to providers), `TeamClaimAutoRelease`, the timeline's work-log entries. Read in the installed packages: the Claude Agent SDK 0.3.276 types (`hooks`, `PreToolUse` `deny`, MCP tool timeout, `onElicitation`), the Codex app-server schema (hooks, `mcp_tool` handler, hook trust states) for codex-cli 0.160.0.
- Nothing in it was run. The "Sure?" column says which parts need a live run.

**What's left**

- Your review. Slice 3 is not started.

**Unsure about / notes**

- About 1,600 words, a bit over the two pages asked for, mostly the two tables.
- Codex hooks: the schema shows them; whether hooks passed with `-c` run without the user trusting them is not known.
- OpenCode's tool-call timeout: not found in the code; 60 s is the MCP TypeScript SDK default, assumed.

## 2026-10-08 — The dev login override stays on local origins; holder names in the row and tab tooltips

**What changed**

- **`T3CODE_TEAM_LOGIN_OVERRIDE` applies only to an origin on this computer** (a `file://` URL or a folder path; `TeamHost.isLocalTeamRemote`). For a remote on GitHub (or any host) the gh login is always used, even on a dev server with the override set, so the override can never write a made-up name to a GitHub team's state ref. `TeamHost.login` now takes the remote URL as well as its parsed location, so a host URL this app cannot parse (`git://…`) is not mistaken for a local one: it answers "signed out" without the override. The `writers/mouhssine` file in `t3-team-scratch` was left alone, as asked.
- **Holder names on hover in the sidebar row and the file tab.** A tooltip inside another tooltip's trigger never opens, so there the marks no longer carry their own tooltip; the row's tooltip (the thread details card) gets a line "Also held by …" with the chips, and the file tab's title tooltip gets the same line under the file name. Both lines render only while that tooltip is open. The file tree's marks keep their own tooltip (no outer one there). The holder lookups moved into two hooks (`useThreadHolders`, `useFileHolders`) shared by the mark and the line.
- `TeamFeed.test.ts`: a typing fix (`memberId` is branded); the server typecheck had 1 error before this change.

**Files touched**

- `apps/server/src/team/state/TeamHost.ts` (+ test), `GitTeamService.ts`, `apps/server/src/cli/team.ts` (callers), `apps/server/src/team/TeamFeed.test.ts`.
- `apps/web/src/components/team/TeamHolderMarks.tsx`; `team-layer:` edits in `Sidebar.tsx` (the line in `SidebarThreadTooltip`) and `RightPanelTabs.tsx` (the line in the tab tooltip).
- `team/WORKING_RULES.md` (one line), `team/STORAGE_PLAN.md` (the override line rewritten).

**How it was checked**

- `apps/server`: `vp test run src/team/ src/cli/team.test.ts src/mcp/toolkits/team/`: 17 files, **165 passed**. New `isLocalTeamRemote` test (file URLs, POSIX, relative, Windows drive and UNC paths are local; HTTPS, SSH, scp-style, `host:path`, `git://` are not); the override test now checks a GitHub remote gets the gh login (`sara`) with the override set in dev mode, a `git://` remote is signed out, and a local remote outside dev mode asks no gh. Mutation: without the local check, the test fails (`expected { status: 'signedIn', … } to deeply equal …`).
- `apps/web`: `RightPanelTabs.test.tsx`, `Sidebar.logic.test.ts`: 188 passed. `tsc --noEmit` server and web: 0 errors. `vp lint` on the changed files: no errors (the Sidebar warnings were there before).
- The tooltips are checked live in the slice 2 self-test (next entry).

**What's left**

- Nothing for these two items.

**Unsure about / notes**

- Slice 8's way of testing two people on GitHub (`Yassine-T3Test` through the override) no longer works; it needs a second gh account now (written in WORKING_RULES.md).

## 2026-10-08 — First visible slice: holder marks and the presence chip (UI_PLAN.md slice 1)

**What changed**

- **Holder marks** in three places, from the team feed: the **file tree** (a short pill in the tree's decoration lane: a teammate's initials, or "+1 chat"), the **sidebar thread rows** (the holders' faces, or another chat's color square), and the right panel's **open-file tabs**. One chip everywhere: a person's initials in a stable hue, or a chat's color square. Each mark has an accessible label "Also held by …".
- Rules (`packages/client-runtime/src/state/teamMarkers.ts`, shared so mobile can reuse them): a teammate's claim marks every file and folder it covers (a parent folder is not marked for one claim inside it); the person's own chats mark a file only when two or more of them hold it, so **solo shows nothing until two chats collide**; a thread is marked when its claims overlap a teammate's or another of the person's chats. Claim paths are mapped into a project that is a folder of the repo (`pathPrefix`); case is ignored.
- **Presence chip** (Option B) in the chat header: teammates' faces and "synced" / "sharing…" / "offline" / "not fresh" with a dot; a click opens a popover: the team, a sentence about sync, each teammate (seen when, tasks in progress, held paths) and the latest handoffs. **Solo shows no chip.** A team with no teammates yet says so in the popover.
- **Performance**: nothing in the composer or message list. The feed is one subscription per environment; marks recompute only when the feed changes (memos keyed by ids, not ref objects); the tree builds once and reads the marks from a ref, re-rendering its rows only when they change; no animation, times are worded when drawn and never tick.

**Files touched**

- New: `apps/web/src/components/team/TeamHolderMarks.tsx`, `TeamPresenceChip.tsx`, `useTeamTreeDecoration.ts`; `packages/client-runtime/src/state/teamMarkers.ts` (+ test); `packages/client-runtime/package.json` (export).
- `team-layer:` edits in upstream files: `components/files/FileBrowserPanel.tsx` (decoration + CSS), `files/FilePreviewPanel.tsx` (passes the thread), `RightPanelTabs.tsx` (tab mark), `ChatView.tsx` (passes the thread, 2 places), `Sidebar.tsx` (row mark, both row styles), `chat/ChatHeader.tsx` (chip).

**How it was checked**

- `packages/client-runtime`: `teamMarkers.test.ts` 5 passed (teammate folder claim marks files under it and not the parent; solo needs two chats; viewing chat excluded; repo-folder projects; thread overlaps; initials). `apps/web`: the existing tests of the touched components, `RightPanelTabs.test.tsx`, `ChatHeader.test.ts`, `FilePreviewPanel.test.ts`, `Sidebar.logic.test.ts`: 212 passed. `tsc --noEmit` web: 0 errors. `vp lint` on the changed files: no errors (one React Compiler warning in `FileBrowserPanel.tsx` was there before).
- **Self-test in the real app** (Playwright, headless, 1440×900), dev server `vp run dev --home-dir ~/.t3-dev` with `T3CODE_TEAM_LOGIN_OVERRIDE=mouhssine` (needed for a local-folder origin), stopped by its task after. Round projects: `~/code/solo-demo1` (plain Git repo, no remote) and `~/code/team-demo6` with origin `~/code/team-demo6-remote.git`. The team was started and a teammate `yassine-a` (claim `src/auth/`, task "Login page", a handoff) was written from a scratch script through the real `GitTeamService` while the server was stopped.
  - Solo: two Codex chats in solo-demo1, told to claim `src/notes/editor.ts` and `src/notes/`. The second chat's `team_claim` reported the overlap with the other chat. State landed in `~/.t3-dev/userdata/team/solo-….git` (writer "me", "You"); `git status` in solo-demo1 stayed clean. Seen: each sidebar row shows the other chat's color square; the tree marks `editor.ts` "+1 chat" and not `list.ts`; the `editor.ts` tab has the square; no presence chip. (`solo-light.png`, `solo-dark.png`)
  - Team: a Codex chat in team-demo6 (worktree) told to claim `src/auth/login.ts`; it reported the overlap with yassine-a's `src/auth` claim, "not merged yet". Seen: the header chip "YA · synced"; the popover with yassine-a, "Login page", "holds src/auth" and the handoff; the tree marks `auth/`, `login.ts`, `LoginForm.tsx` YA and not `search/`; the tab and the sidebar row show YA. (`team-light.png`, `team-light-popover.png`, `team-dark.png`, `team-dark-popover.png`)
  - Screenshots: `test-screenshots` branch, folder `2026-10-07-ui-slice1/` with NOTES.md. I looked at every picture; none shows a pairing link or token.

**What's left**

- Slice 2 (plan card), 3 (inline warning card), 4 (Team home / Today), 5 (glass). Mobile markers on the thread list (the rules are in client-runtime already).
- Hover tooltips on the marks do not open where the mark sits inside another tooltip trigger (the sidebar row, the tab title); the names are only in the accessible labels there. Fix: fold "Also held by …" into those outer tooltips.
- A chat's own color is not shown on its own row, so "which chat is green" is only in the label. The plan card / Today page can show chat colors with titles.

**Unsure about / notes**

- **Side effect on the GitHub scratch repo**: the login override applies to every team the dev server opens, so the warm-up joined `t3-team-scratch` as `mouhssine` and pushed `writers/mouhssine/<dev env>.json` to its hidden state ref. It is the test repo and only the state ref, but it now lists a member "mouhssine" next to "MouhssineElBoumshouli". I did not rewrite the remote (our design never force-pushes). To remove it, delete that writer file from the ref by hand, or leave it. Next rounds: use a separate dev home for local-origin tests, or make the override apply only to remotes with no Git host.
- No measured performance numbers; the claims above are from how the code is built (no work in the typing path, one subscription, memoized), not a profile.
- The console showed one React error ("key prop spread into JSX" in `ChatView`), present without these changes' code paths (upstream).

## 2026-10-07 — Team data in the client: the team feed (UI_PLAN.md slice 0)

**What changed**

- New read-only WebSocket subscription **`subscribeTeamFeed`** (contracts `teamFeed.ts`). First event: a snapshot of every team and solo project on the server that has a project there; then one team's view each time it changes, or "removed". Each view: name, solo or team, the server's projects in it with their folder relative to the team root (`pathPrefix`, so claims can be matched to a project's file tree), who this server writes as, members, active claims (with thread refs), open tasks (≤ 50), the 5 newest written handoffs (headline only, ≤ 5 files), and sync state (`solo`, `synced`, `offline`, `notFresh`; writes not shared yet; when last read while offline or not fresh).
- **Cheap**: no polling from the browser. `GitTeamService` publishes a team id on every write, read and online/offline change (`TeamService.subscribeChanges`); `TeamFeed` (server) rebuilds that one team's view and sends it only if it differs from the last one sent. `readAt` is only sent while offline or not fresh, so a read that changed nothing pushes nothing. Polls that find nothing new never reload, so nothing is pushed while nothing changes.
- **Authorization**: same pattern as the other reads: `orchestration:read` in `RPC_REQUIRED_SCOPES`, handler through `observeRpcStream`.
- Client: `packages/client-runtime/src/state/teamFeed.ts` (subscription atom family that folds events into the list, `applyTeamFeedEvent` in contracts), `apps/web/src/state/teamFeed.ts` (`useTeamFeed(environmentId)`). Mobile can use the same atom.

**Files touched**

- New: `packages/contracts/src/teamFeed.ts` (+ test), `apps/server/src/team/TeamFeed.ts` (+ test), `packages/client-runtime/src/state/teamFeed.ts`, `apps/web/src/state/teamFeed.ts`.
- `team-layer:` edits in upstream files: `packages/contracts/src/rpc.ts` (method, RPC, group), `packages/contracts/src/index.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/ws.ts` (one handler), `apps/server/src/server.ts` (layer), `apps/server/src/server.test.ts` (a mock), `packages/client-runtime/src/rpc/client.ts` (tag), `packages/client-runtime/package.json` (export).
- `apps/server/src/team/TeamService.ts`, `state/GitTeamService.ts` (`syncState`, `subscribeChanges`, online tracking), `apps/server/src/auth/ChatGptRpcScopes.test.ts`.

**How it was checked**

- `apps/server`: `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts src/server.test.ts`: 19 files, **374 passed** (server.test.ts run because its layers changed). `packages/contracts`: `teamFeed.test.ts` passed. `tsc --noEmit`: server, contracts, client-runtime, web, mobile: 0 errors. `vp lint` on the changed files: no errors (the warnings in `server.test.ts` were there before).
- Scope test (real server, real pairing): an `orchestration:read` session subscribes and gets `{ snapshot, teams: [] }`; a session with only `relay:read` is refused with `EnvironmentAuthorizationError`, `requiredScope: orchestration:read`. Mutation: with the handler not going through the scope check, the refusal test fails.
- Feed test (real Git team service): a solo project's snapshot (solo, "You", project, `solo` sync), then a claim pushes a view with the claim, then a handoff pushes a view with its headline; a team project in `packages/web` of a team repo shows `pathPrefix: "packages/web"`, the member, `synced`, and its claim.

**What's left**

- Step 4 (next entry): the markers and the presence chip use this.

**Unsure about / notes**

- That an unchanged view is not sent again is not proven by a test: views are built when a change is handled, so a test cannot tell "skipped" from "built later with the next change" without waiting. A mutation removing the check still passes.
- Each subscriber builds its own views (one browser tab = one subscriber). Fine for a few clients; a shared broadcaster would be the next step if many connect.
- The feed works out project → team per change (reads `.team/team.json` per project), as the team tools do. A few small file reads per change.

## 2026-10-07 — Quick Windows fixes: W2, W5, W8, W15

**What changed**

- **W2**: Git calls that talk to `origin` (state repo fetch, push, `ls-remote`; `t3 team init`'s `ls-remote`) run with `GCM_INTERACTIVE=never`, so Git Credential Manager fails instead of opening a sign-in window from a background sync; the existing offline path takes over.
- **W5**: `teamPathsOverlap` ignores case (`src/Auth/Login.ts` overlaps `src/auth/`), on every OS, since teammates may be on Windows or macOS. The stored spelling is kept.
- **W8**: "same checkout as you" and the memory search's "written in your copy" compare working folders by their real path (links resolved), and on Windows without case or slash differences. New `apps/server/src/team/folders.ts` (`folderKey`, `realFolder`), also used for the solo team id.
- **W15**: tests build `file://` URLs with `pathToFileURL` (`team/testing/teamState.ts`, `GitTeamService.test.ts`, `TeamStateRepo.test.ts`, `cli/team.test.ts`).

**Files touched**

- `packages/contracts/src/team.ts`, `apps/server/src/team/state/TeamStateRepo.ts`, `apps/server/src/cli/team.ts`, `apps/server/src/mcp/toolkits/team/handlers.ts`, `apps/server/src/team/folders.ts` (new), `apps/server/src/team/state/SoloTeam.ts` (uses it).
- Tests: `apps/server/src/team/folders.test.ts` (new), `handlers.test.ts` (1 new), the four W15 files.
- `team/WINDOWS_AND_SOLO.md` (each item marked fixed).

**How it was checked**

- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts`: 17 files, **166 passed**. `tsc --noEmit` in `apps/server` and `packages/contracts`: 0 errors. `vp lint` on the changed files: clean.
- New handler test: thread B works in the project through a symlink and claims `src/Auth/Login.ts`; thread A claims `src/auth/login.ts` and gets one overlap, "same checkout as you". Mutation checks: without the lower case, no overlap (`expected []`); comparing folder strings, "their own copy". `folderKey` unit test: four Windows spellings of one folder give one key; Linux keeps case.
- **Not run on Windows.** W2 has no test: whether GCM honours the variable can only be seen on Windows (WINDOWS_AND_SOLO.md plan step 6). W15 is only proven on Linux here: the URLs are the same as before on Linux; plan step 2 runs the team tests on a Windows runner.

**What's left**

- Steps 3 and 4 (next entries). From the audit: W3 (fewer Git processes per read), W10 (rename retry), W4, W6, W7.

**Unsure about / notes**

- W5 ignores case on Linux too: two files that differ only by case now count as overlapping. Rare, and a false warning is better than a missed clash.
- W2: `gh auth setup-git` belongs to the sign-in step (VISION.md step 6).

## 2026-10-07 — Solo mode (WINDOWS_AND_SOLO.md S1, S5)

**What changed**

- A project with no `.team/team.json` now gets a **solo team**: the team tools, the briefing, automatic notes and memory search work in any project folder, with no GitHub remote and no gh sign-in. Claims between your own chats report overlaps ("other chats of the user hold overlapping paths").
- Its state is a state repo in T3 home (`<state dir>/team/solo-<hash>.git`) with **no origin**: no poller, no fetch, no push. Nothing is written into the project. The id is a hash of the project folder (links resolved; on Windows lower case and `\`), so every chat of the project, worktrees included, shares it.
- The person shows as "You" (writer login `me`). The solo briefing (`<project_memory>`, about 100 tokens) has no team name and no rulebook line.
- **Solo to team keeps the notes**: `t3 team init` in that folder (or its repo root) gives the new team the solo id; when the team opens, the solo writer file is renamed to the GitHub login (claims, tasks with their owner, notes, activity), `team.json`'s `createdBy` becomes the login, and the first push carries it all. A chat in an older worktree without `.team/team.json` then gets the team, not a new solo state.
- `t3 team status` lists solo teams as "solo, on this computer only".
- New `TeamService` methods: `openSolo`, `isSolo`; `refresh`/`sync` answer `solo` for a solo team.

**Files touched**

- New: `apps/server/src/team/state/SoloTeam.ts`.
- `apps/server/src/team/state/GitTeamService.ts`, `TeamStateRepo.ts` (no origin when the remote is null; `removeMine`), `apps/server/src/team/TeamService.ts`, `TeamBriefing.ts`, `TeamProjectFiles.ts` (`teamId` option), `apps/server/src/mcp/toolkits/team/resolve.ts`, `briefing.ts`, `handlers.ts`, `apps/server/src/cli/team.ts`.
- Tests: `GitTeamService.test.ts` (2 new), `handlers.test.ts` (the old "not in a team" test became the solo test), `briefing.test.ts`, `TeamBriefing.test.ts` (solo budget), `TeamAutoNotes.test.ts` (a checkout without a team file now gets a solo note), `cli/team.test.ts` (1 new).
- `team/WINDOWS_AND_SOLO.md` (S1, S5 fixed; how solo mode works).

**How it was checked**

- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts`: 16 files, **163 passed** (159 + 4 new). `tsc --noEmit` in `apps/server`: 0 errors. `vp lint` on the changed folders: clean.
- New tests: a plain folder (not Git, signed out) gets claims with overlaps between two chats, a handoff, search, and `team_status` handoffs, with nothing written in the folder and nothing on origin; a solo team survives a restart; a solo team with a claim, a task and a note becomes a team as `Mouhssine`, and origin holds only `team.json` and `writers/Mouhssine/...`; a teammate then sees the note; `t3 team init` in a folder used solo reuses its id and pushes its note.
- Mutation checks: without the rename on open, the conversion test fails (`[ 'Mouhssine', 'me' ]` members); with a sync on solo claims, the solo test fails.

**What's left**

- Steps 2 to 4 of this session (next entries).

**Unsure about / notes**

- That no poller runs for a solo team is from the code (`makeEntry` forks it only with a remote), not a test: proving "nothing happened" after moving the test clock would need a wait, since the poller runs real Git.
- Every project now gets the solo briefing and automatic notes, as asked. That costs about 100 tokens per first turn and one small state repo per project in T3 home, made on the first turn.
- A team project you cannot use right now (signed out, no remote) still says why and does not fall back to solo: mixing its notes into a solo state would split them.
- Moving a project folder starts a fresh solo state; the old one stays in T3 home.

## 2026-10-07 — Design pick recorded; UI_PLAN.md

**What changed**

- Your pick (Option C with Option B's presence chip in the tab bar) recorded in `team/DESIGN_DIRECTION.md` (status line, section 5) and `team/VISION.md` (status, step 3).
- `team/UI_PLAN.md` (new, one page): the build order in six slices (0 data in the client, 1 holder markers and the presence chip, 2 plan card, 3 inline warning card, 4 Team home / Today page, 5 glass), what each shows, and how it looks with a team and solo.

**Files touched**

- `team/DESIGN_DIRECTION.md`, `team/VISION.md`, `team/UI_PLAN.md`, `team/PROGRESS.md`. No code.

**How it was checked**

- Read back; `vp fmt` on the three files. No tests: no code changed.

**What's left**

- Slices 0 and 1 are steps 3 and 4 of this session (next entries).

**Unsure about / notes**

- T3 has no chat tabs; "the tab bar" for the presence chip means the chat header row, and "tabs" for markers means the right panel's open-file tabs. Said again where slice 1 is built.

## 2026-10-07 — Step 4: WINDOWS_AND_SOLO.md (research); design screenshots pushed

**What changed**

- `team/WINDOWS_AND_SOLO.md` (new, research only): 18 Windows findings (Git and gh, paths and files, scripts and dev setup, the desktop app), each with how sure (seen / likely / guess) and the fix; a section on the step 1 bug and slow disks; what works solo today and what is missing (5 items); a 9-step test plan for the installed app on your laptop.
- Screenshots for step 3: `test-screenshots` **1fd6aed62**, folder `2026-10-07-design/` (34 pictures and NOTES.md).

**Files touched**

- `team/WINDOWS_AND_SOLO.md`, `team/PROGRESS.md`.

**How it was checked**

- Read the code each finding names: `TeamStateRepo.ts` (Git env, process count per read, `saveMine` rename), `TeamHost.ts` (how gh is run), upstream `resolveSpawnCommand` (`.exe`/`.cmd` through `PATHEXT`), `contracts/team.ts` (path compare), `handlers.ts` (folder compare), `paths.ts`, `TeamProjectFiles.ts`, `rulebook.ts`, `memory.ts`, `ServerSecretStore.ts`, `scripts/setup-worktree.ts`, package scripts, `.gitattributes`, `DesktopWindow.ts`, `DesktopWslBackend.ts`, `windows-tests.yml`.
- Nothing was run on Windows. "Likely" items come from how Windows and Git for Windows behave as I know them; the plan says how to confirm each.

**What's left**

- Your pick for step 3.
- The Windows fixes are not made. Top of the list: `GCM_INTERACTIVE=never` (W2), case-insensitive overlaps (W5), fewer Git processes per read (W3), rename retry (W10), `pathToFileURL` in tests (W15), then local-only solo mode (S1).

**Unsure about / notes**

- W2 (Git Credential Manager popping a window from a background push) is the one I would check first; I could not test it here.
- Upstream's own Windows test lane says nothing in the suite passes on Windows yet, so expect upstream failures in plan step 2 that are not ours.

## 2026-10-07 — Step 3: design proposal (options A, B, C, index, DESIGN_DIRECTION.md)

**What changed**

- `team/DESIGN_DIRECTION.md`: what we take from the reference and what we do differently; how the glass works on Windows 11 (Mica), macOS (vibrancy), Windows 10 / Linux / web / mobile (solid colors), and how the page switches; 3 lines per option; the pick: **C with B's presence chip**, and why.
- Mockups (`team/mockups/`):
  - Glass much stronger, as asked: a desktop picture with clear color fields, and lighter layers (`--chrome` 0.40, `--surface` 0.66, new `--panel` 0.50 for the right panel; dark 0.46 / 0.66 / 0.50). The wallpaper shows softly through the sidebar, rail and right panel; the chat column stays readable.
  - The mockup switcher moved to the top-right corner, in a 50 px margin above the window, so it covers nothing. Screenshots hide it.
  - Option B checked in light and dark, team and solo, with card and popover. Found and fixed: the chat chips (`.held.chat`) picked up the main column's `.chat` styles and lost their color (renamed `.held.by-chat`); the popover opened by default and hid the holder chips on the plan card (now closed by default, `pop=1` or the switcher opens it); the face stack overlapped too much.
  - New: `option-c.html` (Team home / Today page, sidebar who-is-around block, warning card inside the agent's message), `index.html` (live previews of the three, links to every state, light/dark).
  - Empty favicon on every page (the only console error before).

**Files touched**

- `team/DESIGN_DIRECTION.md` (new), `team/mockups/shared.css`, `shared.js`, `option-a.html`, `option-b.html`, `option-c.html` (new), `index.html` (new), `team/PROGRESS.md`. No app code.

**How it was checked**

- Playwright (headless Chromium, 1440×900), pages served by a `python3 -m http.server` on 127.0.0.1 started for this and stopped by its PID after (and its child Python process, checked by `/proc/<pid>/cwd`). Browser closed.
- 34 screenshots in `test-screenshots`, folder `2026-10-07-design/` (hash in the next entry): A, B and C × light/dark × team/solo, each with and without the warning card (24); B's popover × 4; C's home × 4; the index light and dark. No console errors in the run. I looked at every picture (4 contact sheets); no pairing links or secrets can appear in them (static mockups, no app).
- No tests: no code changed.

**What's left**

- The pick (section 5 of DESIGN_DIRECTION.md).
- The glass on a real Windows 11 machine (does Mica fill the area under `titleBarOverlay`?) belongs to the Windows test plan.

**Unsure about / notes**

- The glass strength is a judgment call: in the dark theme the wallpaper colors are strong in the sidebar. Easy to tune with the three alpha values in `shared.css`.
- `nativeTheme.prefersReducedTransparency` is named from memory; DESIGN_DIRECTION.md says to check it against Electron 44's docs.

## 2026-10-07 — A failed read of the team state keeps the last one, marked not fresh

**What changed**

- `TeamStateRepo.localTip` told "no state ref" and "Git failed or timed out" apart only by luck: any failure counted as "no tip", so a `read` after a timed-out `rev-parse` returned only this server's files and every teammate vanished until the next good read. Now only `rev-parse --verify --quiet` exiting 1 with nothing on stderr means "no ref"; a failure or timeout fails the read.
- `GitTeamService.reload` catches a failed read: it keeps the last view, logs a warning and marks the team not fresh until a read works again. New `TeamService.freshness(teamId)`: `{ fresh: true }` or `{ fresh: false, readAt }` (when the last good read was).
- `team_status` gets `notFresh` only when not fresh: "Not fresh: the team state could not be read just now, so this is the last state read (<time>). Teammates' newer claims may be missing; call team_status again before editing shared files."
- Loading a state repo at startup: if Git cannot tell whether there are unpushed writes, the poller syncs once to find out (before, the failed tip read made it push too, by accident).

**Files touched**

- `apps/server/src/team/state/TeamStateRepo.ts`, `GitTeamService.ts` and `.test.ts`, `apps/server/src/team/TeamService.ts`, `apps/server/src/mcp/toolkits/team/handlers.ts`, `tools.ts`. No upstream file.

**How it was checked**

- New test (`GitTeamService.test.ts`, "keeps the last state read when Git cannot read it"): a teammate's claim is seen; then the state repo's `rev-parse --verify` fails like a timeout; a refresh fetches, the read fails, the teammate's claim and both members are still listed, `freshness` says not fresh with a time; the next good read is fresh again.
- Mutation check: putting back "failure = no tip" makes the test fail with `expected [] to deeply equal [ [ 'Friend', [ 'src/auth' ] ] ]`, the original bug. Restored with `cmp`.
- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts`: 16 files, **159 passed** (158 + 1). The file 3 times in a row: green. `tsc --noEmit` in `apps/server`: 0 errors. Lint on the changed folders: exit 0. `vp fmt` applied.

**What's left**

- Steps 3 and 4 (next entries).

**Unsure about / notes**

- The `notFresh` line in `team_status` is a spread of `freshness`; there is no handler-level test for it, since the handler test harness cannot make Git fail without new plumbing. The service test covers the behaviour.
- A corrupt ref file (not a timeout) still reads as "no ref" with `--quiet`, as before.
- The briefing and `t3 team status` do not show "not fresh"; only `team_status` does, as asked.

## 2026-10-07 — Steps 1 and 2 marked done; "Local folder" fix; handoffs in `team_status`; design mockups started (unfinished)

**What changed**

- VISION.md: steps 1 and 2 marked done; two requirements in section 6 (great solo; native Windows). STORAGE_PLAN.md status: done. (fa6bc5480)
- "Add project → Local folder" now waits for the project before opening the first draft, so `t3.json` is read (one `team-layer:` edit in `CommandPalette.tsx`). Write-up for upstream in `team/UPSTREAM_REPORTS.md`. No test: the flow lives inside the palette callback. (3ebfef4a4)
- `team_status` lists other chats' 3 newest written handoff notes, one line each ("who, when: first line", 20 words max). `team_memory_search` matches written notes for "handoff"/"handoffs". (d48976515)
- Started step 3 (design): reference screenshots in `team/mockups/reference/`, `shared.css`, `shared.js`, `option-a.html`, `option-b.html`.

**How it was checked**

- Server: `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts` → 16 files, **158 passed** (156 + 2 new). New tests ran 3 times, all green. Mutation checks: dropping the handoff words fails the search test; listing automatic notes fails the status test. `tsc --noEmit` in `apps/server`: 0 errors. Lint on `mcp/toolkits/team/`: exit 0.
- Web: `tsc --noEmit` in `apps/web`: 0 errors; lint on `CommandPalette.tsx`: exit 0, the same 4 upstream warnings before and after.
- Mockups: only Option A was looked at once in Playwright (light, team); it renders, the only console error is a missing favicon. B is written but not opened yet.

**What's left**

- Step 3: Option C, an index page, `team/DESIGN_DIRECTION.md`, the screenshots (light/dark × team/solo per option, plus each warning card) pushed to `test-screenshots`, and the pick.
- Step 4: `team/WINDOWS_AND_SOLO.md` not started.

**Unsure about / notes**

- Found while writing the status test: `TeamStateRepo.read` treats a failed `rev-parse` (a Git call that times out) as "no tip", so a reload then shows only this server's files and teammates disappear until the next good reload. In the test it came from `TestClock.adjust` firing the timeout of a background sync; in real use a slow disk or antivirus on Windows could do it. Not fixed; the test avoids clock jumps after the teammate syncs. Worth a fix (keep the last view when the read fails) and a line in the Windows audit.
- The reference screenshots show the layout and palette, but no wallpaper shows through them.

## 2026-10-07 — The poller pushes writes that did not land; why the first chat used the local checkout; slice 8 (two people for real)

**What changed**

- **Poller retry** (3f85420c2): every sync now records whether this server's files reached the remote (`unshared` on the team entry: set when a sync is not confirmed or fails, cleared when one is). While it is set, the poller syncs instead of its ETag check, with the same backoff (30 s doubling to 15 min). When a state repo is loaded, a new `TeamStateRepo.pending` (no network) compares this server's files with the tree as last fetched, so writes a previous run could not push are retried too, once the team is opened in this run. New poll outcome `pushed`.
- **"Local checkout" in the slice 6/7 self-test: upstream, not our code.** No code change. Details under "Unsure about / notes".
- **Slice 8**, as written in STORAGE_PLAN.md 3.7: two dev servers (`~/.t3-dev` as you, `~/.t3-dev-member` as `Yassine-T3Test` through the dev login override), two clones of the private scratch repo, one Playwright chat on each. For it I added four small source files to the scratch repo's `main` (d744af6) and cloned `~/code/t3-team-scratch-member`.

**Files touched**

- `apps/server/src/team/state/GitTeamService.ts` and `.test.ts`, `apps/server/src/team/state/TeamStateRepo.ts`. No upstream file.
- `team/PROGRESS.md`.

**How it was checked**

- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts` in `apps/server`: 16 files, **156 passed** (154 before + 2 new). Typecheck `apps/server` (`tsc --noEmit`, no dev server running): 0 errors. Lint on `src/team/state/`: clean.
- New tests: a claim made with origin offline: the next check retries and fails (backs off 30 s), origin back, the next check says `pushed` and origin holds the claim, gh was not asked while it waited, then back to ETag checks with no further push. And: a claim a stopped server could not push is pushed at the first check after a restarted server opens the team.
- Mutation checks, restored with `cmp`: poller ignoring `unshared`: both new tests fail; `pending` always false: the restart test fails.
- **Slice 8 self-test** (`test-screenshots` 0d896c09c, folder `2026-10-07-slice8/`, 23 pictures, NOTES.md has every step and picture). Timing from Git: a script read both state repos every 0.5 s; "seen" is when the other server's state ref held that version (or a newer one) of the writer file.

  | What                                | Direction                     | Pushed      | Seen by the other |
  | ----------------------------------- | ----------------------------- | ----------- | ----------------- |
  | Member joins                        | member → host                 | 5.8 s       | 9.0 s             |
  | Claim `query.ts`                    | host → member                 | 2.7 s       | 10.6 s            |
  | Task (search)                       | host → member                 | 5.1 s       | 7.9 s             |
  | Claim `avatar.ts`                   | member → host                 | 2.7 s       | 5.3 s             |
  | Task (avatar)                       | member → host                 | 5.3 s       | 19.1 s            |
  | Handoff (search)                    | host → member                 | 4.8 s       | 5.9 s             |
  | Handoff (avatar)                    | member → host                 | 4.3 s       | 15.8 s            |
  | Race 1 claim `format.ts`            | member → host / host → member | 3.2 / 5.3 s | 5.8 / 9.5 s       |
  | Race 2 claim `client.ts`            | member → host / host → member | 3.2 / 3.2 s | 7.9 / 19.5 s      |
  | Host claims `avatar.ts` (edit test) | host → member                 | 3.2 s       | 12.2 s            |

  All 12 under 20 s (5.3 to 19.5 s, median about 9 s), both ways.
  - Claims and tasks: each side's agent listed the other's claim and task when asked "what is the team working on" (no tool named). Once the host's agent asked 1 s before its poller fetched Yassine's task, so that answer had the claim but not the task; asked again it had both.
  - Handoffs: both crossed (checked in each state repo). The host's agent read Yassine's note; Yassine's agent first said it could not (see notes), then found it when asked about `src/search/query.ts`.
  - Race: both chats got "claim src/shared/format.ts as your first action" in the same second. The agents' claims landed 2.1 s apart, so the second (host) was warned in its claim result; the first (member) got "No overlaps", then at its next `team_status` the late overlap ("Since you claimed, MouhssineElBoumshouli also claimed src/shared/format.ts. Tell the user before editing those.", from the agent's transcript). Both warned. A second race (`client.ts`) landed 8 s apart, same result.
  - Edit a file the other holds, tools not named: both agents stopped before editing, named the teammate, their task and handoff, and asked whether to go ahead. `git status` clean in both clones and worktrees.
  - Both servers stopped by their PIDs, then their four children on the ports (working folders in this checkout). Monitor stopped, browser closed. No typecheck ran while the servers ran.

**What's left**

- Read-only mode without push access (from slice 5).
- Handoffs are hard for agents to find (see notes). Not fixed; say if you want it.
- Step 1 of VISION.md is otherwise done (slices 0 to 8).

**Unsure about / notes**

- **Why the first chat used the local checkout.** Upstream reads `defaultThreadEnvMode` in `useHandleNewThread.ts` (`resolveDefaultEnvMode`): project override, then the environment setting, then `t3.json`, then the built-in `local` (`packages/shared/src/projectSettings.ts`). It reads `t3.json` only when `project !== undefined`, and `project` comes from `readProjects()` at call time. "Add project → Local folder" (`CommandPalette.tsx`, about line 2235) calls `handleNewThread` right after `createProject` returns, before the new project reaches the client, so `t3.json` is skipped and the draft gets `local`. The clone flow in the same file waits first (`waitForProject(projectRef, 3_000)`, with a comment saying why). `~/.t3-dev` has no environment-level or project value set, so nothing else decided it. Seen live in slice 8: the draft right after adding the member's clone said "Current checkout" (`m00`), the next new thread for the same project said "New worktree" (`m01`), and the host's (known project) said "New worktree" (`h00`). Every chat after the first follows `t3.json`. **Smallest fix (upstream, not made):** in that local-folder branch, add `await waitForProject(scopeProjectRef(input.environmentId, projectId), 3_000).catch(() => null);` before `handleNewThread`, as the clone flow does. The setup wizard's project import (`WelcomeWizard.tsx`) may have the same race; not checked.
- **The true same-second race was not reached in the UI**: agents made their claim calls 2.1 s and 8 s apart, outside the ~3 s window where neither sees the other. That case is covered by the GitTeamService test and the 6 GitHub races in STORAGE_PLAN.md Q4, not by this self-test.
- **Handoffs are hard to find.** `team_status` shows "X wrote a handoff note" but not the note; `team_memory_search` with "handoff" finds nothing, since it searches the note's text. Both agents tried "handoff" first. A small fix would be listing teammates' latest handoffs in `team_status`.
- In the edit test the host's agent claimed `avatar.ts` for its own thread before asking, so there is now a second overlapping claim on it. It still asked before editing.
- Retry backoff: while offline, the retry waits like a failed check (up to 15 minutes), so after a long outage the push can take up to 15 minutes after the network is back. Say if you want a shorter cap for retries.
- Left in place: `~/code/t3-team-scratch-member`, `~/.t3-dev-member`, the two chat worktrees and their branches in the scratch clones, the scratch repo's state ref (now with this round's claims, tasks and handoffs) and its `main` commit d744af6.

## 2026-10-07 — First-turn briefing fix; slice 6 (`t3 team init` on the remote); slice 7 (the poller); self-test on GitHub

**What changed**

- **First-turn briefing** (caea4e50a, 0c0bfe32d): a new `TeamWarmup` layer (`apps/server/src/team/TeamWarmup.ts`, one `team-layer:` line in `server.ts`) opens the team of every project at server start and of each project added later (`project.created`). `GitTeamService` lets one open per team run at a time, so a turn that comes during the warm-up waits for it instead of asking gh again. `TeamHost` keeps a signed-in gh login per host for 10 minutes (signed-out answers are not kept). The briefing keeps its 2-second limit; it now logs "Team briefing added." or, past the limit, a warning (before, a slow lookup dropped it without a word).
- **Slice 6** (f258aa82b, df397ce55): `t3 team init [path] [--name] [--yes] [--public-ok] --base-dir`.
  - Before writing anything (through `initTeamProject`'s `register` step) it checks the remote: on a public repo it refuses unless `--public-ok`; if the remote already holds a team's state and the checkout has no `.team/team.json`, it refuses and says to pull first. Both write nothing.
  - It still writes `.team/` and `t3.json` and never commits. Then it shows what it will create on `refs/t3-team/state` (`team.json` and this server's writer file) and creates it after `--yes` or a prompt; from a script without `--yes` it creates nothing and says so.
  - In a clone whose remote has the team's state it joins (pushes this server's writer file, no prompt); a second init changes nothing on the remote.
  - When it cannot start the state (no origin, signed out, no access or push access, origin unreachable or timed out) it writes the files and says why.
  - `t3 team status` fetches each team's ref (new `TeamService.refresh`: fetch, no push) and lists members and active claims; offline it says "as last fetched".
- **Slice 7** (d3a50e77c): a poller per team in `GitTeamService`. Every 15 s an ETag check of the state ref through gh, a depth-1 fetch only when it moved, then the state is read again (which finds late overlaps). `TeamHost.refChanged` answers `noApi` when gh is missing or signed out (or GitHub says 401); then, and for a remote on no Git host, `git ls-remote` every 60 s. After a failed check it waits 30 s, doubling up to 15 minutes, and back to normal after one works. An ETag is kept only once its fetch landed. Only teams opened in this run are watched; pollers stop with the server, and a replaced entry's poller is stopped.
- Test fix (01175a77c): the init join test cloned nothing under the repo-root test config (the bare origin's HEAD named `master`); it now clones `main`.

**Files touched**

- New: `apps/server/src/team/TeamWarmup.ts` and `.test.ts`.
- Changed (ours): `team/state/GitTeamService.ts` and test, `team/state/TeamHost.ts` and test, `team/state/TeamStateRepo.ts`, `team/TeamService.ts` (`refresh`), `team/TeamProjectFiles.ts` (`findTeamFile`, moved from `resolve.ts`), `mcp/toolkits/team/resolve.ts`, `mcp/toolkits/team/briefing.ts`, `cli/team.ts` and test.
- Upstream: `apps/server/src/server.ts`, one `team-layer:` line plus its import.

**How it was checked**

- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts` in `apps/server`: 15 files, 150 tests passed. With `src/server.test.ts` and `src/auth/ChatGptRpcScopes.test.ts`: 17 files, 358 passed (after the self-test, dev server stopped). `GitTeamService.test.ts` 5 runs in a row and `cli/team.test.ts` 9 runs: all passed.
- Typecheck `apps/server` (`tsc --noEmit`, no dev server running): 0 errors after each step. Lint on the changed files: no new warnings (the old `server.ts:8` one is upstream's). `packages/contracts` not changed.
- New tests:
  - Warm-up (real clock): a restarted server whose gh would hang after start-up gives the first turn its briefing, and the turn asks gh nothing; a project added while the server runs is opened then. TeamHost: one `gh auth status` per host for 10 minutes; signed-out answers not kept.
  - Init (local bare origin, fake host): asks, then creates the ref with `team.json` and the writer file in one commit; "no" leaves the remote alone; a second init changes nothing and does not ask; a clone with `.team/` joins (2 commits, `createdBy` unchanged, same teamId); public refused with nothing written, accepted with `--public-ok`; remote state without a team file refused; no push access, signed out and a timed-out `ls-remote` write the files and start nothing. Status lists a teammate's claim pushed after the home last fetched.
  - Poller (test clock, a GitHub-like fake host whose ETag is origin's commit): 304s fetch nothing and later checks send the ETag; a teammate's push is fetched once, with their claim and the late overlap; after a fetch fails, the next check fetches even though the ETag would say 304; backoff 30 s, 60 s, then 15 s again; `noApi` falls back to `ls-remote` every 60 s and never asks gh again; stops when the server's scope closes; does not watch a team not opened in this run; `nextPollDelay` caps at 15 minutes.
- Mutation checks, each restored with `cmp`: warm-up off: the first-turn test fails ("expected undefined", after 2.25 s), and the project-added test times out; no public refusal: 1 fails; never asks: 2; join does not push: 2; no remote-without-file refusal: 1; ls-remote timeout not caught: 1; fetch even when the tip is ours: 3; no backoff: 1; no fallback: 1; poller detached from the scope: 1; watching unopened teams: 1; ETag kept before the fetch landed: 1 (that one went uncaught until I added the test for it).
- **Self-test** (`test-screenshots` f99a5e4a0, folder `2026-10-07-slice6-7/`, transcripts in its NOTES.md):
  - `t3 team init ~/code/t3-team-scratch --base-dir ~/.t3-dev` for real: without a terminal it showed the plan and created nothing; in a pseudo-terminal it asked "Create it?", I answered yes, and it created `refs/t3-team/state` on GitHub (1 commit, `team.json` + your writer file). `t3 team status` listed you as owner. I committed and pushed `.team/` and `t3.json` to the scratch repo's `main` (2c074c0).
  - Public refusal: with a fake host (see Unsure).
  - Dev server, Playwright: added the scratch repo; the warm-up fetched the team 2 s later. New Claude Sonnet 5.5 chat, "Call team_status and show me the raw result.": the server logged "Team briefing added." for that first turn, no skip warning; the raw result showed the team, you, no claims (`q1-team-status-first-turn.png`).
  - Fake teammate `Sara-T3Test` (dev login override, second state repo in my scratchpad) claimed `src/auth`. The dev server's state repo had her commit **3.8 s** after her push was confirmed. "Call team_status again." showed her claim (`q2-team-status-teammate-claim.png`).
  - Dev server stopped by its PID, then its two children on the ports (working folders in this checkout). Browser closed.

**What's left**

- Slice 8: two people for real (two dev servers, two clones, the same-second claim race).
- A claim made offline ("not shared yet") is pushed by the next write, not by the poller (slice 7 as written only checks and fetches). Say if the poller should also retry unpushed writes.
- Read-only mode without push access (from slice 5) is still not built.

**Unsure about / notes**

- **Public refusal tested with a fake.** A real test needs a public repo you can push to: a new one (I do not create repos on your account) or your public fork (you asked me not to touch your other repos). A public repo you cannot push to stops at "cannot push" before the public check.
- **The 3.8 s is luck of timing**: the poller checks every 15 s, so expect up to about 16 s (one check interval plus a 1 s fetch). One measurement, not a range.
- **Briefing evidence** is the new log line plus no warning; the agent itself was not asked about its instructions.
- **First init try timed out** on `git ls-remote` after 20 s (by hand it took 1.2 s right after; the next CLI run took 4.6 s in all). I treated it as a network stall and made a timeout end as "could not reach origin" instead of a raw error (df397ce55).
- **The chat used the current checkout**, not a new worktree, though the scratch repo's `t3.json` asks for worktrees: the composer showed "Current checkout" when the project was new. Not looked into; the team lookup works either way.
- **My mistake in the scratch repo:** my first commit of `.team/` used an email I typed by hand; GitHub refused the push (email privacy), so it never reached GitHub. I amended it with the repo's configured noreply address and pushed that.
- Left on GitHub on purpose: the scratch repo's state ref (your writer file and Sara-T3Test's claim on `src/auth`) and its `main` commit with `.team/`. Say if you want the ref deleted.
- `team/DESIGN.md` still describes host-mode `t3 team init` (registration, "Already hosted by …"). I left it, as earlier slices did; STORAGE_PLAN.md is the current plan.
- The warm-up and per-team open lock are tested through the warm-up; there is no separate test that two concurrent opens make one gh call (I found no way to order them without sleeps).

## 2026-10-07 — Slice 5: the switch to the Git team store; cold start self-test

**What changed** (commit 5e7f7bb79)

- **The switch:** `server.ts` provides `GitTeamService.layer` as `TeamService` (one `team-layer:` line, plus its import). State repos live in `<state dir>/team/<teamId>.git` (`~/.t3-dev/userdata/team/` for a dev home with `--home-dir`).
- **`TeamService.ts` is the interface only**, shaped as STORAGE_PLAN.md 3.4: `openTeam` (membership with a reason) and `currentMember` replace `findMemberByEnvironment`; `ensureTeam` takes `{ teamFile, checkout }`; `claimPaths` returns `confirmed`; `takeLateOverlaps` and `sync` are new. `TeamMembership` and `OpenTeamInput` moved there from `GitTeamService.ts`.
- **`TeamMember` in contracts:** `lastSeenAt` instead of `joinedAt`, no `environmentId`, `memberId` is the login (as agreed after slice 4).
- **`resolve.ts`** opens the team from the checkout and gives the real reason when this server cannot use it: no origin, not signed in to GitHub, no access, no push access, no team state yet ("t3 team init starts it"), another team's state, or unreadable. A tool call or briefing never starts the state.
- **Handlers:** `team_claim` says "Claimed on this computer, not shared yet … Overlaps with teammates' newest claims are unknown" when the push did not land (overlaps already known are still listed). `team_claim` and `team_status` carry `lateOverlaps` ("Since you claimed, Sara also claimed src. Tell the user before editing those."), each handed out once, only to the claiming thread.
- **Parked** with `git mv` to `team/parked/sqlite-service/` (history kept; `git log --follow` reaches back past the move): the SQLite `TeamService.ts`, its test, `TeamMigrations.ts` and its test, `Migrations/001`–`004`. README updated.
- **`t3 team`:** `init` writes `.team/` and `t3.json` only, and says the remote state is not started yet; `status` lists the teams a home has opened, from its local state repos (no network), with role and last seen.
- **Tests on the new store:** a helper `apps/server/src/team/testing/teamState.ts` (local bare `origin` over `file://`, a fake host, `GitTeamService` as `TeamService`). `handlers.test.ts`, `briefing.test.ts`, `TeamAutoNotes.test.ts`, `TeamClaimAutoRelease.test.ts` and `cli/team.test.ts` use it; `memory.test.ts` needed no change.
- **Seed script** (`apps/server/scripts/team-cold-start-seed.ts`) adapted: a local bare remote `<project>-remote.git` (marked, so a re-run rebuilds only its own), the state written by three `GitTeamService`s (you, Sara, Omar) as real servers would, the dev home's old copy of the team's state deleted. Prints the start command with `T3CODE_TEAM_LOGIN_OVERRIDE`. COLD_START_TEST.md setup updated.
- Also: dropped a now-dead `catch` in `TeamClaimAutoRelease` (`listClaimedThreads` cannot fail any more).

**Files touched**

- New: `apps/server/src/team/testing/teamState.ts`; `team/parked/sqlite-service/…` (moved).
- Changed (ours): `TeamService.ts`, `state/GitTeamService.ts` and its test, `mcp/toolkits/team/{resolve,handlers,tools,handlers.test,briefing.test}.ts`, `TeamAutoNotes.test.ts`, `TeamClaimAutoRelease.ts` and its test, `cli/team.ts` and its test, `scripts/team-cold-start-seed.ts`, `contracts/src/team.ts`, `team/COLD_START_TEST.md`, `team/parked/README.md`.
- Upstream: `apps/server/src/server.ts`, the two `team-layer:` lines only.

**How it was checked**

- Typecheck, no dev server running: `packages/contracts` 0 errors; `apps/server` 0 errors.
- `vp test run src/mcp/toolkits/team/ src/team/ src/cli/team.test.ts`: 14 files, 131 tests, passed 3 times (once before the self-test, twice after). `src/server.test.ts` and `src/auth/ChatGptRpcScopes.test.ts`: 208 passed.
- New handler tests: the reason for no team state (every tool, and no ref appears on origin), signed out, no origin, another team's state; a claim with origin offline says not shared yet, keeps the claim, and lands after `sync`; a late overlap from a teammate's server is told once, only to the claiming thread, and is a normal overlap after.
- Mutation checks, each restored (`cmp` with a backup): `team_status` without `lateOverlaps` fails 1 test; `team_claim` ignoring `confirmed` fails 1; `resolve` calling `ensureTeam` (starting the state) fails 3, in both handler and briefing tests.
- Lint on the changed files: one warning, `server.ts:8` unused `ProviderDriverKind`, which is upstream code I did not touch. Formatter ran.
- Seed run twice for real: 5 commits on the fresh remote's state ref, writer files for `mouhssine`, `Sara`, `Omar`; a remote folder it did not make is refused.
- **Self-test, the cold start test** (`test-screenshots` ffe0efbf1, folder `2026-10-07-slice5/`, grades in its NOTES.md): dev server as `mouhssine`, Playwright, project added by hand (the setup dialog offered to import the t3code repo; I chose "Do not import"), new chat on Claude Sonnet 5.5, the five questions as written. **5 of 5 pass**, question 5 with full marks including `data/`. Tools: Q1 shell only (no team name given), Q2 `team_status`, Q3 read the decision file and `session.ts`, Q4 `git status` and `team_status`, Q5 none (reused Q4's status). The server made its state repo and pushed nothing. Dev server stopped by its PID; vp left its two children on the ports, so I stopped those too after checking their working folders were this checkout.

**What's left**

- Slice 6: `t3 team init` starts the state ref (preview, `--yes`, the public repo refusal with `--public-ok`, a clone joins instead of creating), `status` from the ref.
- Slice 7: the poller. Until then a server sees teammates' changes only when it syncs for its own writes (or on the first open after a start).
- Not done this round: the "automatic notes" part after the five questions in COLD_START_TEST.md.

**Unsure about / notes**

- **Migrations parked too.** STORAGE_PLAN.md 3.5 says migrations 1–4 are "left alone". Only the SQLite service ran them, so I parked the migrator and the migration files with it rather than keep code nothing calls. Existing dev databases keep their tables; nothing drops them. Say if you want them back in `src/`.
- **`t3 team init` no longer registers anything** until slice 6: parking the SQLite service left it nothing to register in, and creating the ref here would skip slice 6's public repo refusal (decision 2). Its output says so. It still needs `--base-dir`, which slice 6 will use. The old "never registers a cloned repo" test went with it (host mode's rule).
- **Repos without `gh` push access are not read-only yet:** plan 3.4 says "the tools answer read-only"; slice 4 made `noPushAccess` not a member, and slice 5 gives the reason. Read-only mode is not built.
- **State folder:** `<state dir>/team` (`userdata/team`), not `<T3 home>/team` as the plan wrote: runtime state lives under userdata.
- **Briefing timeout:** the briefing has 2 s. On a GitHub remote the first open runs `gh auth status`, `gh api repos/…` and a fetch (about 2 s together, from the Q4 timings), so the first turn after a start may get no briefing. Not seen here (local remote). Slice 7's poller, or opening teams at startup, would fix it.
- **The seed's login default** is your user name (`mouhssine`), which the dev server must be told with `T3CODE_TEAM_LOGIN_OVERRIDE`; a local remote has no GitHub account.
- `team-two-person-setup.ts` (host mode's two-person bench) still deletes `team_*` rows and runs `t3 team init --base-dir`; it no longer sets up a team. Slice 8 needs a new bench.
- In the browser, Enter did not send question 1 and my first send of question 4 did not go out; I resent both. The chat has each question once.

## 2026-10-07 — GitHub timing check; slice 3 (TeamHost) and slice 4 (GitTeamService, not wired)

**What changed**

- **Timing check** (commit c4bc85cc6): the real `TeamStateRepo` with two writers against the private scratch repo `t3-team-scratch`, cloned to `~/code/t3-team-scratch`. Numbers in STORAGE_PLAN.md Q4, in a table next to the estimates. In short: a claim's sync 2.55–3.04 s (median 2.7 s, estimate about 3 s); a teammate's depth-1 fetch 0.99–1.21 s (estimate 0.7 s); ETag check 0.45–0.64 s, and every `304` left `X-Ratelimit-Used` unchanged; claim to teammate 4.2–4.7 s plus the wait for their next 15 s check, so about 12 s on average and 19 s at worst (estimates 10 s and 18 s). 6 of 6 same-moment races: both pushes landed, the later one on its 2nd attempt. The ref's history was linear (17 commits, 16 with one parent). The ref was deleted afterwards; the scratch repo has only `main` again.
- **Slice 3** (commit 1fe6fac5e): `apps/server/src/team/state/TeamHost.ts`. A `TeamHost` service with three calls, GitHub through `gh` (run by upstream's `VcsProcess`):
  - `login`: `gh auth status --json hosts --hostname <host>`, parsed with upstream's `parseGitHubAuthStatus`. Only the **active** account counts (it is the one gh and Git pushes use); if it does not work, the answer is "signed out", even when another account works.
  - `repoAccess`: `gh api repos/<o>/<r>` → push permission and whether the repo is public; a 404 is "not found" (also what GitHub says without access).
  - `refChanged`: `gh api -i` with `If-None-Match`; reads 200/304/404 from the status line, because gh exits 1 on a `304`.
  - `T3CODE_TEAM_LOGIN_OVERRIDE` is used only in dev mode (the server has a dev URL); otherwise a warning is logged and the gh login is used.
  - `parseTeamRemoteUrl` (HTTPS, `ssh://`, `git@host:o/r`); local paths and `file://` give null. Also a `layer` (env + `ServerConfig`), unused until slice 5.
- **Slice 4** (commit 366275d91): `apps/server/src/team/state/GitTeamService.ts`, built on the model, the repo and TeamHost. `make({ environmentId, stateDirectory })` returns the service; nothing provides it to the server yet.
  - Same reads and writes as `TeamService` (claims, releases, tasks, handoffs, automatic notes, activity, claimed threads), with the 3.4 changes: `openTeam({ teamFile, checkout })` returns a membership with a reason (`member`, `noRemote`, `signedOut`, `noAccess`, `noPushAccess`, `noTeamState`, `otherTeam`, `unavailable`); `currentMember(teamId)` replaces `findMemberByEnvironment`; `ensureTeam({ teamFile, checkout })` has no owner input and starts the state ref when the remote has none. Joining is opening: the first open writes this server's writer file with a `member.joined` activity line.
  - `claimPaths` syncs at once (fetch, then push, 3 s per network call) and computes overlaps after that fetch; it returns `confirmed: false` when the push did not land. Other writes are pushed together 2 s later (STORAGE_PLAN.md 4.9). Every sync finds late overlaps; `takeLateOverlaps(teamId, thread)` hands each out once. `sync(teamId)` pushes and fetches now (slice 7's poller will call it).
  - Teams opened before a restart are found again from the state repos in `<T3 home>/team/`, with no network, so `listClaimedThreads` and `releaseThreadClaims` work at startup.
  - TeamHost changed a little in this commit: `login(null)` for a remote on this computer (a folder or `file://`), where only the dev override can name the person. Slice 5's self-test uses a local bare remote.
- **`TeamMember.joinedAt` becomes `lastSeenAt`** (the newest `lastSyncAt` of the person's writer files; each save sets it). Why: nothing reads `joinedAt` (only the SQLite service writes it); the Git state cannot give it reliably (`--depth=1` fetches have no history, the `member.joined` activity line drops out after 100 lines, and adding a field nobody reads is not worth a format change); and what the team needs is "when was this person last online", for STORAGE_PLAN.md 4.4's "probably free" claims. Members are sorted by login. In slice 4 this is `GitTeamMember` in `GitTeamService.ts`; slice 5 moves it into `contracts/team.ts` as `TeamMember` (also dropping `environmentId`), when the SQLite service is parked.

**Files touched**

- New: `apps/server/src/team/state/TeamHost.ts` and `.test.ts`, `apps/server/src/team/state/GitTeamService.ts` and `.test.ts`.
- Changed: `team/STORAGE_PLAN.md` (Q4 table, one line in slice 2), `team/PROGRESS.md`.
- Not changed: `TeamService.ts`, `contracts/team.ts`, `server.ts` and every other upstream file. No running dev server behaves differently.

**How it was checked**

- `vp test run src/team/state/` in `apps/server`: 4 files, 42 tests passed (10 model, 5 repo, 10 TeamHost, 17 GitTeamService). `GitTeamService.test.ts` run 5 times in a row: 5 of 5 passed.
  - TeamHost (fake `VcsProcess`): remote URL forms; the active account wins over an inactive one; a broken active sign-in is "signed out"; no account; gh not installed; unreadable output; the override in dev, ignored outside dev, refused when it is not a login, and the only way in for a local remote; push access and visibility (with and without `visibility`, without `permissions`); 404 vs other failures; `--hostname` off github.com; ETag sent, 200/304/404 read from the status line (304 with exit code 1), rate limit 403, garbled body, offline.
  - GitTeamService: a local bare `origin` over `file://`, one state folder per server, a fake TeamHost. The 11 behaviour tests of `TeamService.test.ts`, adapted (the friend is a second server with its own login, not a second environment row). New: a claim fetches first (the friend's unseen claim shows in the overlaps, and is not reported again as late; the friend hears of it once as a late overlap); two claims made with origin offline are `confirmed: false` with no overlaps, kept locally, then both sides hear of the overlap once, with the same key, and not again after another sync; two writes close together are one commit, pushed only after the clock moves 2 s (waits on the push, no sleep); a teammate's task edit wins on both servers when both clocks agree; a restarted service with origin offline finds its team and claims and releases them; the membership reasons (no team state, no remote, signed out, no access, no push access, another team, an unsafe team id).
- Mutation checks, each restored afterwards (`cmp` with a backup):
  - TeamHost: using any signed-in account instead of the active one fails 1 test; the override outside dev mode fails 1; deciding 304 by exit code fails 2.
  - GitTeamService: a claim that does not sync first fails 3; keeping a claim's own overlaps as late fails 1; never queueing late overlaps fails 2; syncing each write at once fails the batching test; no "newer than the version it edits" guard fails the task test; ignoring push access fails the membership test. Two of my first mutations were wrong (one crashed every test, one still forked the sync so nothing changed); I redid both, and the results above are from the redone ones.
- Live check of TeamHost against the real gh (not a test file): login `MouhssineElBoumshouli`; scratch repo `found, canPush: true, isPublic: false`; a missing repo `notFound`; with `main` pushed as a temporary `refs/t3-team/state` on the scratch repo: `current` with an ETag, then `unchanged` with that ETag; ref deleted afterwards.
- Typecheck (`tsc --noEmit` in `apps/server`, no dev server running): 0 errors. `packages/contracts` not changed, so not run.
- Lint on `apps/server/src/team/state/`: no warnings. The formatter ran on all three commits.

**What's left**

- Slice 5: the switch. `server.ts` provides GitTeamService as `TeamService`; `TeamService.ts`'s interface and `contracts` `TeamMember` follow 3.4; `resolve.ts` calls `openTeam` and gives the new reasons; handlers show late overlaps and "not shared yet"; the other team suites run on the new store; park the SQLite service; self-test with the cold start test on a local bare remote.

**Unsure about / notes**

Choices the plan did not spell out (say if you disagree):

- **Offline membership:** when gh cannot answer (offline, gh missing, or signed out), a server that has written in the team before goes on as that login, and checks again on the next call. Only a clear "no" (no access, no push access) takes membership away. So signing out of gh does not stop the tools; the pushes fail instead and claims say "not shared yet". A passing check is kept 10 minutes; a failing one is not kept.
- **Remote:** only the checkout's `origin`. A checkout without `origin` gets `noRemote`.
- **Display name** is the login; the commit author is `<login> <login@users.noreply.github.com>`.
- **`lastSyncAt`** keeps its format 1 name but is set on every save, not on every sync, so a sync with nothing new pushes nothing. A server that writes nothing for days looks offline; slice 7 may need a daily touch for 4.4.
- **Task edits:** a new version is at least 1 ms newer than the version it edits, so a teammate whose clock runs ahead cannot make an edit lose on every reader.
- **Late overlaps already reported** are kept in memory only. After a restart, an overlap reported before can be reported once more.
- **A contested claim** can take longer than 3 s: each network call has 3 s, and a push refused as behind is redone up to 5 times.
- **Creating a team** whose first push failed: `team.json` stays in this server's files and the next `ensureTeam` retries the push. Opening (not creating) such a team works on this computer only.
- `normalizeClaimPaths`, `keepHashesOf` and `optionalText` are copied from `TeamService.ts`, like the model copied its texts. The copies go when the SQLite service is parked.
- **Timing check:** three runs; my terminal cut off the first run's summary, so the table uses the other two (10 rounds, 6 races). The rounds of the first run I saw were in the same range.
- **Your other repos:** in the live TeamHost check I also called `repoAccess` on your public fork `t3code` (one read-only `GET repos/MouhssineElBoumshouli/t3code`, which gave `canPush: true, isPublic: true`). Nothing was written there. All pushes went to `t3-team-scratch` only.

## 2026-10-07 — Slices 1 and 2: the team state format and model, and the Git repo for it

**What changed**

- **Slice 1** (commit 55e678047), no I/O:
  - `packages/contracts/src/teamState.ts` (new): format 1 of the state on `refs/t3-team/state`. `team.json` (`format`, `teamId`, `name`, `createdBy`, `createdAt`) and the writer file `writers/<login>/<environmentId>.json` (`format`, `login`, `displayName`, `environmentId`, `lastSyncAt`, `claims`, `tasks`, `notes`, `activity`). Claims have the optional `branch` field from STORAGE_PLAN.md 4.5. Constants: the ref name, the caps (200 claims, 7 days for released claims, 200 notes, 100 activity lines). One export line added next to the existing `team-layer:` line in `contracts/src/index.ts`.
  - `apps/server/src/team/state/TeamStateModel.ts` (new): `parseTeamState` (tree files → `team.json` + writer files + warnings), `buildTeamView` (members, active claims, tasks after last writer wins, notes, activity, all as the existing contract types with the login as member id), `claimOverlaps`, `findLateOverlaps`, `compactWriterFile` (the caps), and one function per write: `addClaim`, `releasePaths`, `releaseThreadClaims`, `saveTask`, `addHandoff`, `saveAutomaticNote`, `addActivity`.
- **Slice 2** (commit 781610fdf): `apps/server/src/team/state/TeamStateRepo.ts` (new). A bare repo per team (the caller passes `<T3 home>/team/<teamId>.git`) with `origin` set to the project's remote URL. `fetch` gets only the state ref at depth 1. `saveMine` writes one of this server's files to disk (no network). `read` gives the tree at the last fetched tip with this server's own files on top. `sync` fetches, puts this server's files into the remote tree (temporary index), commits on top of the remote tip and pushes with no `+` and no `--force`. A push refused as behind is redone, up to 5 attempts. Results: confirmed, or not confirmed with `unreachable`, `behind`, `refused` or `missing`.
- Nothing is wired into the server. No running dev server behaves differently.

**Files touched**

- New: `packages/contracts/src/teamState.ts`, `apps/server/src/team/state/TeamStateModel.ts` and `.test.ts`, `apps/server/src/team/state/TeamStateRepo.ts` and `.test.ts`.
- Changed: `packages/contracts/src/index.ts` (one export line, next to the existing team one), `team/PROGRESS.md`.

**How it was checked**

- `vp test run src/team/state/` in `apps/server`: 2 files, 15 tests passed (10 model, 5 repo).
  - Model tests: two writers merge into one view; one person on two servers is one member with two writers; concurrent task edits give the same winner for three different file orders, including a tie on `updatedAt`; caps for claims, notes and activity, with active claims kept before released ones; a released claim is still there after 6 days and gone after 8; a broken writer file is skipped, while a newer one (format 2, unknown fields, one entry with an unknown task status) is read with only that entry skipped; a late overlap is found from both sides with the same key, not again on the next sync, and forgotten once released; the same person's other server counts as someone else for late overlaps; one automatic note per thread; folder release.
  - Repo tests: origin is a local bare repo over `file://` (real Git protocol, no network) and each writer has its own state repo. Two writers syncing at once both land. A push refused because Sara's push landed between Yassine's fetch and push is redone (`attempts: 2`; the test slips Sara's sync in through a wrapped Git driver). With origin renamed away, the sync says `unreachable`, `read` still has the write, and after renaming origin back the next sync lands it. Without `create` a missing ref is reported, not created. A second sync with nothing new makes no commit. Paths outside the state tree are refused. Every test checks origin's reflog: each update's parent is the update before, and no push used `+`, `--force` or `-f`.
  - Repo test file run 10 times in a row: 10 of 10 passed (the concurrent test did not flake).
- Mutation checks, each restored afterwards (`cmp` with a backup): model: tie-break `>=` → `>` fails the task test; ignoring `reported` fails the late-overlap test; no 7-day cutoff fails the drop test. Repo: `--force` on the push fails 4 tests; no retry fails 2; `read` without this server's files fails the offline test. (My first try at the `--force` mutation used `sed`, which did not apply the change; redone with an exact replacement and the diff checked.)
- Typecheck (`tsc --noEmit`, no dev server running): `packages/contracts` and `apps/server`, 0 errors.
- Lint on the new files and `contracts/src/index.ts`: exit 0, no warnings. The formatter ran on both commits.
- **Not done: the timing check against GitHub** (slice 2's "time a real sync once, on a scratch private repo"). There is no scratch repo yet, so I skipped it. The Q4 numbers in STORAGE_PLAN.md are still estimates from parts measured one at a time. None of your GitHub repos were touched.

**What's left**

- Slice 3: `TeamHost.ts` (login, `canPush`/`isPublic`, ETag check) with a fake process runner.
- The GitHub timing check, once you have a private scratch repo.

**Unsure about / notes**

Choices the plan did not spell out (say if you disagree):

- **Unknown fields:** readers ignore them. If a newer app wrote this server's own file and an older app then rewrites it, the unknown fields are lost. Writer file entries are decoded one at a time, so an entry the app does not understand (say a new task status) is skipped with a warning instead of hiding the whole file. A higher `format` number is read if its fields still decode.
- **Claim cap:** if a server ever has more than 200 active claims, the oldest active ones are dropped. That follows "at most 200" literally.
- **Field names:** a task's owner is stored as `owner` (a login). Claims, notes and activity lines have no member field; the writer is the member.
- A writer file whose path and contents name different writers is skipped.
- Members have no `joinedAt` in the model (sorted by login, with `lastSyncAt`). Slice 4 decides what `TeamMember.joinedAt` becomes.
- `sync` creates the ref only with `create: true`, so only `t3 team init` (slice 6) can start a team; for a member a missing ref is reported as `missing`. The creator's `team.json` goes through the same "own files" path.
- A push without access (HTTP 403) shows up as `unreachable`, not as its own reason. Slice 3's `canPush` will tell the two apart.
- A push that loses the race for origin's ref lock (`[remote rejected] ... lock`) is retried like "behind". That comes from how Git reports it; I did not see it happen in the tests.
- The commit author (name and email) is passed in by the caller; slice 4 picks it. `commit-tree` runs with `--no-gpg-sign`, and Git runs with `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C` (so the "couldn't find remote ref" message can be matched).
- The model repeats the activity texts and the release rules of `TeamService.ts`. The copy goes away when the SQLite service is parked after slice 5.

## 2026-10-07 — Part 0 finished, the five storage decisions, slice 0 (host mode parked)

**What changed**

- **Part 0 (self-testing):** finished. Dev server on `~/.t3-dev`, paired in the Playwright browser, screenshots checked and pushed (`test-screenshots` 8536f7735, folder `2026-10-07-part0/`).
- **Decisions:** your five answers to STORAGE_PLAN.md section 5 (all as recommended) are recorded in section 5 and in the short version, 3.2, 3.6 and 4.1 (commit 5d5974925). VISION.md: a "Decided (2026-10-07)" list in section 2; `team-state` becomes `refs/t3-team/state` everywhere; "each person writes their own files" becomes one writer file per (GitHub login, T3 server).
- **Slice 0** (commit 55b070421):
  - Tag `team-host-mode-m2.3` on fc0dc2691, pushed.
  - `git mv` to `team/parked/host-mode/` (same layout): `team/http/*` (routes, guard, TeamSessionMembers, guard and security tests), `TeamInvites.ts` and its test, `contracts/src/teamHttp.ts`. Full copies of `cli/team.ts` and `team.test.ts` as at the tag, since only parts of them moved. `team/parked/README.md` says what is there.
  - Unmounted: the `/api/team/v1` routes in `server.ts`, the `teamHttp` export, `t3 team invite` and `invites`.
  - Reverted: `team:read`/`team:write` (`contracts/auth.ts`, `EnvironmentAuth.test.ts`) and the `discoverPairTarget` export in `cli/pair.ts`. Those five upstream files now match the commit before M2.2 exactly (`git diff 98a07b653~1` is empty).
  - Kept: the `ws.ts` fix (comment now points at its test). New test `apps/server/src/auth/ChatGptRpcScopes.test.ts`: a real server on a temp home, a session from a pairing link with only `orchestration:read`; the three ChatGPT RPCs must be refused with `EnvironmentAuthorizationError` / `orchestration:operate`, and a control call (`serverGetConfig`) must succeed.
  - Also, not in the plan's list (say if you disagree): removed `TeamService.addMember` (only `/join` used it); the "not joined" texts in `cli/team.ts` and `resolve.ts` no longer say "ask the host for an invite" (now "joining from a clone / from another server is not supported yet"); one line in M2_MANUAL_TESTS.md saying M2.2/M2.3 run only at the tag. Migration 4 (`team_invites`) and the `member.joined` activity kind stay, as the plan says.

**Files touched**

- Docs: `team/STORAGE_PLAN.md`, `team/VISION.md`, `team/M2_MANUAL_TESTS.md`, `team/PROGRESS.md`, new `team/parked/README.md`.
- Moved to `team/parked/host-mode/`: the 8 files above, plus the 2 copies.
- Ours: `apps/server/src/cli/team.ts`, `cli/team.test.ts`, `team/TeamService.ts`, `mcp/toolkits/team/resolve.ts`, `handlers.test.ts`, new `auth/ChatGptRpcScopes.test.ts`.
- Upstream (back to upstream's text): `server.ts`, `cli/pair.ts`, `auth/EnvironmentAuth.test.ts`, `contracts/src/auth.ts`, `contracts/src/index.ts`. Upstream, `team-layer:` comment changed: `ws.ts`.
- Branch `test-screenshots`: `2026-10-07-part0/`, `2026-10-07-slice0/`.

**How it was checked**

- `vp test run` in `apps/server` on `src/team src/mcp/toolkits/team src/cli/team.test.ts src/cli/pair.test.ts src/auth/RpcAuthorization.test.ts src/auth/EnvironmentAuth.test.ts src/auth/http.test.ts src/auth/ChatGptRpcScopes.test.ts`: 17 files, 143 tests passed. `src/server.test.ts` (because `server.ts` changed): 204 passed. `packages/contracts`: 26 files, 462 passed.
- Mutation check: with the `ws.ts` fix put back to its pre-M2.2 text, `ChatGptRpcScopes.test.ts` had 3 failed (got `ProviderSetupError`, `ProviderSetupError` and no error for the stream), 1 passed (the control). Restored, 4 passed; `git diff` on `ws.ts` empty before the commit.
- Typecheck (`tsc --noEmit`, no dev server running): `packages/contracts`, `apps/server`, `apps/web` all 0 errors.
- Lint on the 12 changed `.ts` files: 0 errors, 1 warning that was already there (`ProviderDriverKind` unused in `server.ts`). Lint on `team/parked`: exit 0. The formatter ran on the commit.
- Self-test on a dev server (`~/.t3-dev`), details in `test-screenshots` `2026-10-07-slice0/NOTES.md`: `GET /api/team/v1/me` 404 without a session and with a real bearer session (control `/api/orchestration/snapshot` 200 with the same token); `t3 team --help` lists only `init` and `status`; the app pairs and loads (`01-welcome-after-pairing.png`, `02-app-after-dev-home-fix.png`).
- Both dev servers stopped by their process groups (checked that the port owners were in the group first); ports free after. Browser closed.

**What's left**

- Slice 1: the state format and model (`teamState.ts`, `TeamStateModel.ts`), no I/O.

**Unsure about / notes**

- **Found in the self-test:** dev homes used since M2.2 have sessions that stored `team:read`/`team:write`. After the revert, those rows do not decode, so `GET /api/auth/clients` (Settings → Connections) gives 500 on such a home. Seen on `~/.t3-dev`: part 0's session was made before slice 0. Fixed there by marking the rows with a `team:` scope revoked (1 session, 1 used pairing link); after a restart `/api/auth/clients` was 200. Any other dev home from M2.2 to now needs the same, or a fresh home. Upstream and real installs never stored these scopes. I did not add code to skip bad rows (that would be an upstream change).
- I did not look at the Connections page itself: the app sends a new browser to `/welcome` until setup is done, and I did not go through setup. The 500 and the fix were checked through the API from the paired page.
- `t3 team invite` now prints the team help instead of an "unknown command" error; I did not check its exit code.
- `knip:check` not run (repo-wide). No exports were added; the removed ones had no other users.

## 2026-10-07 — New direction (VISION.md), storage swap plan, self-testing setup (part done)

**What changed**

- `team/VISION.md`: copied from `C:\Users\Mouhssine\Downloads\VISION.md` with the text unchanged. One difference in bytes: the repo's pre-commit formatter added an empty `>` line inside the blockquote in section 3.1 (line 49). The words are the same and it renders the same; restoring the exact bytes would fail the formatter check. It replaces DESIGN.md section 7 (host mode); DESIGN.md 7 now says so at the top. M1 stays.
- `team/STORAGE_PLAN.md`: answers to VISION.md's four open questions (facts measured against GitHub or read in the code and docs, each marked with how it was checked), the plan for step 1 (the storage swap) in 8 slices plus slice 0 (park host mode), what in VISION.md the code shows is a bad idea, and 5 decisions for you (section 5). Research and planning only: no feature code.
- Self-testing (part 0), **not finished**:
  - `.mcp.json` (new): the Playwright MCP server for this project, `@playwright/mcp@0.0.83`, headless Chromium, fresh profile, output in `.playwright-mcp/`.
  - `.gitignore`: `.playwright-mcp/` (marked `team-layer:`).
  - Chromium 1247 downloaded to `~/.cache/ms-playwright` without sudo.
  - Orphan branch `test-screenshots` created and pushed (commit 51e5dbc37, a README only), checked out as a worktree at `../t3code-screenshots`.
  - WORKING_RULES.md: a "Self-testing" section.
- `vp i` run on the fresh clone (done, 10.8 s); `git push --dry-run origin main` worked.

**Files touched**

- New: `team/VISION.md`, `team/STORAGE_PLAN.md`, `.mcp.json`.
- Changed: `team/DESIGN.md` (one note at section 7), `team/WORKING_RULES.md`, `team/PROGRESS.md`, `.gitignore` (one marked line).
- Branch `test-screenshots`: `README.md`.

**How it was checked**

- Playwright MCP: started from `.mcp.json` by a small stdio client (the same handshake Claude Code does). It answered `initialize` as "Playwright 1.64.0-alpha", listed 25 tools, and `browser_navigate` picked the downloaded Chromium. The browser then **failed to start**: `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, `libasound.so.2` not found (`ldd`). Installing them needs sudo, which I don't have, so I stopped there as you asked. Not done yet: the dev server run, pairing, the screenshot and its push.
- The plan's facts: see STORAGE_PLAN.md; each is marked [code], [measured] or [docs]. Measured: `git ls-remote` of one ref 0.50 to 0.52 s, a shallow fetch of one ref 0.71 to 0.74 s, a conditional `gh api` request got `304` without using rate limit, and a push to a non-branch ref (`refs/t3-team/probe`) works on GitHub and is served by the REST API. The probe ref was pushed twice and deleted twice; `git ls-remote origin 'refs/t3-team/*'` now returns nothing.
- No tests or typecheck: no code changed.

**What's left**

- You: run `sudo apt-get install -y libnss3 libnspr4 libasound2t64`, then restart Claude Code in this folder so it loads the Playwright MCP server (approve it when asked). Then I finish part 0: dev server on `~/.t3-dev`, pair, screenshot, push it to `test-screenshots`, stop the server by its PID.
- You: the 5 decisions in STORAGE_PLAN.md section 5. Slice 0 (parking host mode) can start once decisions 4 and 5 are made; slice 1 needs 1 to 3.

**Unsure about / notes**

- The end-to-end claim delay in Q4 is an estimate built from parts measured one at a time (fetch 0.7 s, this commit's push 2.11 s, a 15 s check interval); slice 7 measures a full sync.
- GitHub publishes no limits for authenticated Git operations, so the plan avoids polling with Git; Q2 says why.
- "GitHub shows a 'recent pushes' banner for a busy branch" in STORAGE_PLAN.md 4.1 is from memory, not checked; the other reasons there were checked.
- Our fork is public, so anything put on a team ref in it is public. Use a private scratch repo for slice 8.

## 2026-10-04 — M2.3 `t3 team invite` and `/join` on the host; a Vite cache per dev server

**What changed**

- **Vite cache per dev server** (your M2.2 manual test: "error loading dynamically imported module: …/node_modules/.vite/deps/useOpenChangeComplete-….js"). Cause: both dev servers of one checkout used `apps/web/node_modules/.vite`, and the member's dependency rebuild replaced files the host page was loading. The dev runner now sets `T3CODE_VITE_CACHE_DIR=node_modules/.vite-dev-<web port>` and `apps/web/vite.config.ts` uses it as `cacheDir` (one `team-layer:` line each). Keyed by web port, not home folder: two running servers can never share a port.
- **Auto-bootstrap off by default** in `scripts/dev-runner.ts` (one `team-layer:` line): with no flag and no setting, the server gets `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`. `.env.local` still works (`=0` or `=1` arrive as an explicit value).
- Deleted the empty `apps/server/userdata` (with its empty `attachments`, `logs` subfolders), `apps/server/caches` and `apps/server/worktrees`. They held no files; Git never tracked them.
- **M2.3** (DESIGN.md 7.1, decisions 2, 3, 9; S5, S6, S8, S12):
  - `team_invites` (own migration 4) and `TeamInvites` (`apps/server/src/team/TeamInvites.ts`): invites, `/join`, and which member a session is. The row keeps the pairing link's id, never the credential.
  - `t3 team invite [path] --name Sara [--ttl 30m] --base-dir <home>`: checks the team is hosted here and this server owns it, the name (1 to 60 characters, one line, no `< > "` or backtick, not taken by a member or a pending invite), and the lifetime (more than 0, at most 24 hours; default 30 minutes). Then a one-time pairing link with exactly `[team:read, team:write]`, subject `team-invite:<id>`, label "Team <team>: Sara", and the invite row. Prints the URL once with "Expires at HH:MM". Needs the host server running (the URL points at it).
  - `t3 team invites [--revoke <id>] --base-dir <home>`: pending, used, expired, revoked; revoke marks the invite and revokes its link.
  - `POST /api/team/v1/join`, body `{ environmentId }`: the invite comes from the session's subject; adds a `member` with the invite's name and an activity line "Sara joined team …" (new kind `member.joined`); the same session again gets the same member. Refusals (403 `TeamJoinRefusedError`): `not_an_invite`, `invite_not_found`, `invite_used`, `invite_revoked`, `invite_expired`, `team_not_found`, `already_member`.
  - `TeamSessionMembers` now reads the invite table, so `/me` answers for a joined session and the board path checks its team.
  - **A change from the plan, say if you disagree:** the invite URL is `http://localhost:5733/team-invite#invite=<code>`, not `t3 pair`'s `/pair#token=<code>`. The web app takes a `#token=` from any page it opens and exchanges it for a browser session (`resolveInitialServerAuthGateState`), so clicking the invite URL would have used it up. M2.4's `t3 team join` reads `invite`.
  - Not in this slice: `--tailscale` (M2.10, where it can be tried with two machines) and `--member` re-invites (M2.9).
- Manual test: `team/M2_MANUAL_TESTS.md`, M2.3 (Part A is the cache fix).

**Files touched**

- New: `apps/server/src/team/TeamInvites.ts`, `TeamInvites.test.ts`, `Migrations/004_TeamInvites.ts`, `scripts/team-dev-runner.test.ts`.
- Our files: `apps/server/src/cli/team.ts`, `cli/team.test.ts`, `apps/server/src/team/{TeamMigrations,TeamMigrations.test,TeamService}.ts`, `apps/server/src/team/http/{routes,TeamSessionMembers,security.test}.ts`, `packages/contracts/src/{team,teamHttp}.ts`.
- Upstream, marked `team-layer:`: `scripts/dev-runner.ts` (2 lines), `apps/web/vite.config.ts` (1 line), `apps/server/src/cli/pair.ts` (`export` on `discoverPairTarget`).
- `team/DESIGN.md` (sections 4, 5, 7 status, 7.1 M2.2/M2.3/M2.4, 7.2 S5 to S8 and S12, 7.3, 7.4), `team/M2_MANUAL_TESTS.md`, `team/WORKING_RULES.md` (the `.env.local` rule, the cache folders), `team/PROGRESS.md`.

**How it was checked**

- Cache: unit tests (offsets 0 and 20 give `.vite-dev-5733` and `.vite-dev-5753`, every mode, an inherited value is replaced, and a check that the `vite.config.ts` line is still there). Live: two `dev:web` runs from this checkout (offsets 40 and 60, scratch homes) served their deps from `/node_modules/.vite-dev-5773/deps/` and `/node_modules/.vite-dev-5793/deps/` (4,711 files each, both 200), and the old `.vite` was not touched; again with the final `vite.config.ts` line for one server. Not checked: the original failure (a page breaking while the other server rebuilds) is not reproduced on purpose; with separate folders the two cannot touch each other's files. Part A of the manual test checks it in your browser.
- Auto-bootstrap: unit test (unset gives `0`, `true` gives `1`, `false` gives `0`). Live: a full `vp run dev` on a scratch home with `.env.local` moved aside (restored after, `cmp` identical): the server process had `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0` and `projection_projects` stayed empty.
- M2.3 live on that scratch dev server (port 5773): `t3 team init` on a scratch repo, `t3 team invite --ttl 2m` printed `http://localhost:5773/team-invite#invite=…`; through the web proxy the exchange gave `scope: team:read team:write`, a second exchange 401, `/me` 403 `not_a_member`, `/join` 200 as Sara `member`, `/me` 200, the snapshot 403. `t3 team status` listed Sara (member), `t3 team invites` showed her invite used. A second invite, revoked with the CLI, then gave 401 on exchange. Neither token nor credential in the logs, the dev output or the repo. Inviting "sara" again was refused. All scratch servers stopped by their process groups (checked their `T3CODE_HOME` first); the scratch cache folders deleted.
- Tests: `vp test run` in `apps/server` on `src/team src/mcp/toolkits/team src/cli/team.test.ts src/auth/RpcAuthorization.test.ts src/auth/EnvironmentAuth.test.ts src/auth/http.test.ts src/cli/pair.test.ts` → 19 files, 182 tests passed, including `security.test.ts` (23, against a real server, running the real `t3 team invite` and `invites`) and `TeamInvites.test.ts` (11, test clock). `vp test run packages/contracts` → 462 passed. `vp test run` in `scripts` on `team-dev-runner.test.ts dev-runner.test.ts` → 79 passed (upstream's runner tests unchanged and passing).
- Mutation checks: removing the expired, the used or the revoked check from `join` made 1, 2 and 2 unit tests fail; restored, all pass.
- One flaky assertion found and fixed in my own test: under the test clock the owner and the new member have the same `joined_at`, so member order was random; the test now sorts. Six runs in a row passed after.
- One migration test pinned the list of team tables; `team_invites` added to it.
- Typecheck (`tsc --noEmit`, both dev servers stopped): `apps/server` 0 errors (the first run caught `HttpClient` leaking from `t3 pair`'s discovery into the whole CLI, and a too narrow test helper type), `packages/contracts` 0, `scripts` 0, `apps/web` 0 (it caught `cacheDir: undefined` under `exactOptionalPropertyTypes`; now a conditional spread).
- Lint (`vp lint --report-unused-disable-directives`) on the 17 changed `.ts` files: exit 0. `vp fmt --check`: clean (the formatter rewrote a few lines before the final test run).

**What's left**

- Your manual test for M2.3 (Parts A to C). It leaves a member "Probe" in Demo team 6, so M2.4's test should start from a fresh demo (`--demo ~/code/team-demo7`).
- Then M2.4: `t3 team join` on the member (reads `#invite=`), `team_links`, the token in the secret store at mode 0600 (decision 9), and the S13 origin check.

**Unsure about / notes**

- The invite URL change above is a small departure from the plan's wording, for the reason given; DESIGN.md 7.1 M2.3 records it.
- `/join` refuses once the invite has expired even if the link was exchanged in time. A member whose exchange lands in the last second could see `invite_expired`; M2.4's join exchanges and joins back to back, so this should not happen in practice.
- Unknown fields in the `/join` body are ignored, not rejected (Effect's default); the row is right either way and a test checks it.
- `t3 team invite` refusals print like `t3 team init`'s: the message on the first line, then a stack trace. Same as before; not changed here.
- The upstream pairing link table (`auth_pairing_links`) stores the credential itself, as for every `t3 pair` link; the team layer adds no copy of it.

## 2026-10-03 — M2.2 scopes and the team API skeleton; no "server" project in dev runs

**What changed**

- Dev runs no longer add this repo as a project. Cause: upstream's web mode turns on `autoBootstrapProjectFromCwd` by default (`apps/server/src/cli/config.ts:352`), and `vp run dev` starts the server in `apps/server`, so every start added `apps/server` as a project called "server" (with a "New thread"). Fix without code: a gitignored repo-root `.env.local` with `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`, which the dev runner loads. Not committed (the rules forbid committing `.env` files); WORKING_RULES.md and DESIGN.md 7.3 now say every checkout needs it.
- `team:read` and `team:write` in `packages/contracts/src/auth.ts`, in the administrative preset only.
- `TeamHttpApi` (`packages/contracts/src/teamHttp.ts`) mounted next to the environment API with the same session middleware (`apps/server/src/team/http/routes.ts`, one `team-layer:` line in `server.ts`). Endpoints: `GET /api/team/v1/me` and a placeholder `GET /api/team/v1/teams/:teamId/board`. Every handler starts with `requireTeamMember` (`guard.ts`): scope, then the member bound to the session, not removed, then the path's team. No session is bound to a member until `/join` (M2.3), so both endpoints answer 403 `not_a_member` to everyone with a team scope, and return no team data yet.
- Security tests (`apps/server/src/team/http/security.test.ts`) against a real server on a temp home. The team-only session comes from a real pairing link with exactly the two team scopes, exchanged at `/oauth/token`. S1 walks every `EnvironmentHttpApi` endpoint and S2 every `WsRpcGroup` RPC (148) as listed at test time, each with a valid payload generated from its schema, so the refusal is the scope check and new upstream routes are covered without edits. Plus raw routes, S3 import rule and forged asset/upload URLs, S4 `/mcp`, S5, S7, the guard on every team endpoint, and no token in the logs.
- **Security fix in upstream code.** The S2 walk found three RPCs whose handlers skipped the scope check that `RPC_REQUIRED_SCOPES` declares: `chatGptReconnectProfile` (returns the host's saved ChatGPT registration and ID token hint), `chatGptImportProfile` (replaces the host's ChatGPT credentials) and `chatGptHandoffSubscribe` (starts a sign-in flow). Any session could call them, a team-only one included. `ws.ts` now wraps them in `authorizeEffect` / `authorizeStream` (marked `team-layer:`).
- Manual test: `team/M2_MANUAL_TESTS.md`, M2.2.

**Files touched**

- New: `packages/contracts/src/teamHttp.ts`, `apps/server/src/team/http/{routes,guard,TeamSessionMembers}.ts`, `apps/server/src/team/http/{security,guard}.test.ts`.
- Upstream, marked `team-layer:`: `packages/contracts/src/auth.ts` (2 literals, preset), `packages/contracts/src/index.ts` (1 export), `apps/server/src/server.ts` (import + 1 line), `apps/server/src/ws.ts` (3 handlers), `apps/server/src/auth/EnvironmentAuth.test.ts` (2 lines: the admin session's scope list).
- `team/DESIGN.md` (sections 4, 5, 6, 7.1 M2.2, 7.2 S1 to S5, S7, S12, 7.3, 7.4), `team/M2_MANUAL_TESTS.md`, `team/WORKING_RULES.md`, `team/PROGRESS.md`.
- Local only, not committed: `.env.local`.

**How it was checked**

- "server" project cause: a server-only dev run (`node scripts/dev-runner.ts dev:server`, offset 40) on a scratch home with `.env.local` in place made no project; the same run with `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1` made "server" at `apps/server`. On that scratch home, `t3 project remove ~/code/t3code/apps/server` refused (the project has a chat); with `--force` the project and its "New thread" were marked deleted and `git status` stayed clean. Not run against `~/.t3-dev` or `~/.t3-dev-member`: that is yours (manual test step 1).
- Security tests: 20 passed. Before the `ws.ts` fix the RPC walk failed on exactly the three ChatGPT RPCs; after it, all 148 are refused with `EnvironmentAuthorizationError`. Mutation checks: with the guard removed from the board handler, 2 tests failed; with `ws.ts` back at HEAD, the final version of the test failed on exactly the three RPCs again. Both restored.
- `vp test run` in `apps/server`: `src/team/http src/auth/RpcAuthorization.test.ts src/auth/EnvironmentAuth.test.ts src/auth/http.test.ts src/cli/team.test.ts src/team src/mcp/toolkits/team` → 17 files, 154 tests passed (one upstream test pinned the admin scope list; updated). `vp test run packages/contracts` → 462 passed.
- Both of your dev servers restarted on the new code (`node --watch`) and answer `/api/team/v1/me` with 401 `missing_credential`, directly and through the web proxies (5733, 5753).
- Lint (`vp lint --report-unused-disable-directives`) on the 11 changed `.ts` files: exit 0; one warning is upstream's unused `ProviderDriverKind` import in `server.ts`. `vp fmt --check`: clean. Typecheck: `tsc --noEmit` in `packages/contracts` → 0 errors. `tsc --noEmit` in `apps/server` (after you stopped both dev servers; it peaked at about 6 GB) → 0 errors, and no diagnostics in the changed files. The first run caught a real problem the tests did not: the handlers asked for `TeamSessionMembers` per request, which leaked it as a requirement of the whole routes layer (550 type errors in upstream files); the group now takes it once when it is built. It also made me rewrite the security test in the repo's Effect test style (`it.layer`, `HttpClient`, schema-decoded JSON).
- Not run: `server.test.ts` (13,000 lines; the routes layer it builds gains the team routes, whose only new need, `TeamSessionMembers`, is provided inside `routes.ts`; the typecheck covers it).

**What's left**

- Your manual test for M2.2 (remove the "server" project from both homes first).
- Then M2.3: `team_invites`, `t3 team invite`, `/join`, and binding a session to a member, which makes `/me` answer for real.

**Unsure about / notes**

- The ChatGPT RPC hole is in upstream too (pingdotgg/t3code), for any session without `orchestration:operate`. Worth reporting upstream; I did not, since that is outward-facing.
- `.env.local` is per checkout and not in Git, so a fresh clone (the friend in M2.10) adds "server" again until they create it. The alternative is a one-line `team-layer:` default in `scripts/dev-runner.ts`; say if you want that.
- `apps/server/{userdata,caches,worktrees}` exist in the repo: empty folders, no files, dated 2026-09-30 21:46 (Git does not track empty folders, so `git status` never showed them). Some command once ran with a home inside the repo. Nothing uses them now; safe to delete.
- The security test starts a full server; the whole file takes about 10 seconds.

## 2026-10-03 — M2.0 test bench and M2.1 only the host registers a team

**What changed**

- Decisions recorded first (DESIGN.md 7.5, from your review): the nine open questions answered, with 4 ("cached, as of <time>"), 6 (the offline claim result says host offline, not confirmed, overlaps unknown), 7 (a member changes only its own tasks or takes unowned ones; the host's owner changes any; every change in the activity feed) and 9 (token file mode 0600, with a test) as you changed them, plus 10 (`--base-dir` required). New security items in 7.2: S13 (no team token over plain HTTP except to localhost or a Tailscale address, refused with a message, tested) and S14 (teammate-written text labelled as data, not instructions). D1's invite lifetime and poll interval updated to match.
- M2.0: `apps/server/scripts/team-two-person-setup.ts` builds `~/code/team-demo6-remote.git` (bare), `-host` (Pinboard app, then the real `t3 team init --base-dir ~/.t3-dev`, committed and pushed) and `-member` (a clone). Marker files make it safe to re-run: a re-run deletes only folders it made and the old team's rows in the host database. It refuses foreign folders, anything in the t3code repo, `~/.t3`, and one home for both. The Pinboard app and Git helpers moved from the cold start seed into `apps/server/scripts/teamDemoRepo.ts`.
- M2.1: `t3 team init` needs `--base-dir` and registers the team in that home with its server as owner (and the repo's `canonicalKey`), after every file check and before any write. On a repo that already has `.team/team.json` and no row in that home (a clone), it writes and registers nothing and says the team is hosted elsewhere: ask the host for an invite. New `t3 team status --base-dir` lists the hosted teams with members. The tool, briefing and automatic-note lookup (`resolve.ts`) no longer registers on first use: a team file with no row gives "This project is in team <name>, which is hosted on another T3 server. … To join, ask the team's host for an invite."
- Manual tests for both slices: new `team/M2_MANUAL_TESTS.md`.

**Files touched**

- New: `apps/server/scripts/team-two-person-setup.ts`, `apps/server/scripts/teamDemoRepo.ts`, `team/M2_MANUAL_TESTS.md`.
- Our files: `apps/server/src/cli/team.ts`, `cli/team.test.ts`, `apps/server/src/mcp/toolkits/team/{resolve,handlers.test,briefing.test}.ts`, `apps/server/src/team/{TeamProjectFiles,TeamService,TeamAutoNotes.test}.ts`, `apps/server/scripts/team-cold-start-seed.ts`.
- No upstream files.
- `team/DESIGN.md` (D1, D4, D5, milestones, 7.1 M2.0/M2.1 and the slices the decisions touch, 7.2, 7.3, 7.5), `team/PROGRESS.md`.

**How it was checked**

- Two dev servers from one checkout ([verify] in the plan): with your host `vp run dev --home-dir ~/.t3-dev` running, `T3CODE_PORT_OFFSET=20 vp run dev --home-dir ~/.t3-dev-member` started on exactly 13793/5753; each answered `/.well-known/t3/environment` with its own environment id, directly and through its web port; your host kept running. I then stopped the member server (by its process group, after checking its `T3CODE_HOME`). Not checked in a browser: that the two UIs do not log each other out (M2.0 manual test step 6).
- A CLI writing `state.sqlite` while the server runs ([verify]): the setup script's `t3 team init --base-dir ~/.t3-dev` registered Demo team 6 while your host server ran on that home; it kept serving with the same process. Not checked: that the running server's chat tools see the new team (M2.1 manual test step 6).
- The setup script, against scratch folders: a first run, a re-run (old team's rows gone, new team registered), `t3 team init` on the scratch member clone (refused, exit 1, clone clean, member home hosts no teams), and five refusals (foreign folder, demo in the repo, `~/.t3/userdata` as home, same home twice, unknown flag), each exit 1. Then the real run for `~/code/team-demo6-*`: `t3 team status` lists Demo team 6 (owner MouhssineVic) in `~/.t3-dev` next to Demo team 4 and 5, and `~/.t3-dev-member` hosts no teams.
- The cold start seed after the move, against a scratch home and project: it built the repo (3 commits) and seeded Demo team 5. Not run against `~/.t3-dev` or `team-demo5`.
- Tests: `vp test run src/cli/team.test.ts src/mcp/toolkits/team src/team` in `apps/server` → 12 files, 103 tests passed. New: every tool from a cloned repo on a fresh server returns the hosted-elsewhere result and leaves every `team_*` table empty (S7); no briefing and no row for a team hosted elsewhere; `--base-dir` required (init and status); init registers one team and one owner, and twice keeps one; init on a clone with a fresh home refuses, writes no file, leaves every team table empty; status on a home with no database.
- Typecheck: `npx tsc --noEmit` in `apps/server` (includes `scripts/`) → 0 errors. The first try was killed for memory with two dev servers running; it passed after I stopped the member server. `vp lint --report-unused-disable-directives` on the 11 changed `.ts` files → exit 0. `vp fmt --check` on them → clean.
- Not run: `server.test.ts` (it mocks `TeamService`; the typecheck covers the new `listTeams` there).

**What's left**

- Your manual tests for M2.0 and M2.1 (`team/M2_MANUAL_TESTS.md`). I already ran the setup script once for `team-demo6`; re-running it resets the demo.
- Then M2.2: scopes and the team API skeleton, with the S1 to S5 security tests.

**Unsure about / notes**

- A repo set up with M1's `t3 team init` that no chat ever used has no team row, so `t3 team init` now refuses it like a clone. The way out is `t3 team host --adopt` (decision 1), not built. Teams registered on first use in M1 (Demo team 4, 5) keep their rows and work as before.
- The hosted-elsewhere message does not name `t3 team join` yet, since that command arrives in M2.4.
- `t3 team status` creates the home's folders (`userdata`, `caches`, `worktrees`), as every CLI command that resolves the server config does, but no database when there is none.
- S13 treats `100.64.0.0/10` as Tailscale. That range is the shared carrier-grade NAT range, so another network can use it too; refining it would mean asking Tailscale for its peers. Fine for M2, noted in case you want it stricter.
- Memory: this laptop cannot run two dev servers and a full `tsc` at once.

## 2026-10-03 — M2 plan: a second person (docs only)

**What changed**

- New section 7 in DESIGN.md: the M2 plan. No code.
  - 7.1: eleven slices, each with its own manual test. M2.0 test bench; M2.1 only the host registers a team (`t3 team init` registers, no more registration on first use); M2.2 `team:read` / `team:write` and the team API skeleton; M2.3 `t3 team invite` and `/join`; M2.4 `t3 team join`; M2.5 local or remote per team, remote reads; M2.6 remote writes with member-made ids; M2.7 polling and board cache; M2.8 offline queue; M2.9 remove, re-invite, leave; M2.10 a friend over Tailscale.
  - 7.2: security, S1 to S12. Each says how it is blocked and which test proves it: non-team HTTP routes (a test that walks every `EnvironmentHttpApi` endpoint, so new upstream ones are covered), WebSocket RPCs, files, threads and `/mcp`, getting `orchestration:read`, used/expired/revoked invites, a member making itself owner, acting as another member, another team, removed members, flooding, token leaks. Plus manual checks and what is not protected on purpose.
  - 7.3: two dev servers on one laptop (`~/.t3-dev` host, `~/.t3-dev-member` with `T3CODE_PORT_OFFSET=20`), a local bare remote and two clones of `team-demo6`; then the Tailscale step.
  - 7.4: upstream files M2 edits. 7.5: nine open questions with recommendations.
- One design rule the plan adds: a team's rows exist only on its host. A member's server keeps a link, a cached board and an outbox in its own tables, so "has the team row" means "hosts it", and local or remote is chosen per team.
- Small pointers: D5 (registration fix is M2.1), section 5 (M2 planned), section 6 question 1 (answered by M2.2).

**Files touched**

- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- Read the auth code the security section relies on, and cited file and line where I did: scope check (`auth/http.ts` `requireEnvironmentScope`), the token endpoint's fixed scope list, exchange only narrows (`EnvironmentAuth.ts:809`), the session keeps the grant's subject (`:816`), pairing links are one-time with expiry (`PairingGrantStore.ts`), every RPC has a non-team scope (`RpcAuthorization.ts`), any session can get a WebSocket ticket, assets need signed expiring URLs (`AssetAccess.ts:723`), OTLP and device hub proxies check scopes, `t3 pair` mints links in-process with `--ttl` (`cli/pair.ts:436`), 30-day sessions (`SessionStore.ts:423`), secrets folder at 0700, cookie names per instance, dev port offset and auto-shift (`scripts/dev-runner.ts`), `/api` proxied in dev, CLI `--base-dir` → `<dir>/userdata`.
- The resolver (`resolve.ts`) calls `ensureTeam` on first use today, and `TeamClaimAutoRelease` only releases this server's own threads: both read in the code.
- No typecheck or tests: only Markdown changed. DESIGN.md is on the formatter's ignore list; the pre-commit formatter ran on PROGRESS.md.

**What's left**

- Your answers to the nine open questions in section 7.5 (none blocks M2.0).
- Then M2.0 (test bench) and M2.1.

**Unsure about / notes**

- Not checked, marked [verify] in the plan: two `vp run dev` from one checkout side by side; a CLI writing `state.sqlite` while the server runs (`t3 pair` does it, not tested with our tables); a second `HttpApiBuilder.layer` sharing the auth middleware (section 6 question 1); whether the WebSocket sends anything before the first RPC; whether the cloud `health` and `mintCredential` handlers give a team token anything; how the host's Connections settings show a session with only team scopes.
- I read the scope checks of the orchestration, pull request, relay and pairing routes, not every auth admin route. The S1 test is what proves them all.
- In M2.1, `t3 team init` without `--base-dir` registers in the real install's home, like `t3 pair` uses it. Our commands always pass `--base-dir`; say if you want init to refuse to run without it.

## 2026-10-03 — M1 done: cold start test passed; handoff wording and "Do not touch" in `team_status`

**What changed**

- Cold start test (D8) passed 5/5 with Claude (Sonnet 5) and with Codex (GPT-5.6-Luna), run by the developer. M1 is marked done in DESIGN.md (milestones, D8 result). Two problems from the run are fixed here.
- Junk handoffs. In the Codex run, question 2 ("Who is working on what right now?") made Codex write a handoff. The note in `~/.t3-dev` (team "Demo team 5", 2026-10-03 00:03 UTC, no files, no task): changed "No code changes; reviewed the live team status for a progress update.", left "No implementation work was started in this thread.", risks "Status reflects the current claims and task notes at check time." Codex gets the briefing every turn, and "When you finish or stop, write a team_handoff" read as every turn end.
  - Briefing line 4 is now "Write a team_handoff only after editing files or if the user stops work partway; keep claims unless the user drops it." 148 of 150 tokens with the longest names (was about 146). The `team_handoff` description (36 words) now starts "Save a handoff note after editing files, or when the user stops work partway" and says "Not after only answering questions."
  - Server guard: warn, don't reject. When a handoff names no files, the thread holds no claims, and it has no automatic note (no turn of it changed files), the note is saved and the result gets a `message`: "Saved, but this chat changed no files and holds no claims. Write a handoff only after editing files or when the user stops work partway, not after answering a question."
- "Do not touch" in `team_status`. Neither agent read `.team/rulebook.md` for question 5, so both missed `data/`. `team_status` now has `doNotTouch` (right after `team` and `you`): the items of the rulebook's "Do not touch" section, at most 5 of 120 characters, the last one saying "+N more in <rulebook path>" when cut. No section or an empty one: no field. The `t3 team init` template's example line is left out, so a fresh team shows nothing. The `team_status` description mentions it.

**Why warn and not reject (the guard)**

- The server cannot tell junk from a useful "looked into X, nothing to change" note; rejecting loses those, and you asked not to block them.
- A reject-unless-confirmed parameter would show in every agent's tool schema, and agents would learn to pass it every time.
- The warning corrects the agent in the same session, where the habit forms, at no cost to other calls. A junk note that still gets through costs little: no files, so search finds it only by keywords, with freshness "unknown: no files".
- Signals used: files named in the note, the thread's active claims, and its automatic note. The first editing turn has no automatic note until it ends, but the briefing asks for claims before editing, so a normal edit-then-handoff turn gets no warning.

**Files touched**

- New: `apps/server/src/mcp/toolkits/team/rulebook.ts`, `rulebook.test.ts`.
- Our files: `apps/server/src/mcp/toolkits/team/{handlers,handlers.test,tools}.ts`, `apps/server/src/team/{TeamBriefing,TeamBriefing.test,TeamProjectFiles}.ts` (the template's example line is now an exported constant).
- No upstream files.
- `team/DESIGN.md` (D4 item 4 and why, D5 table rows, token cost, "Do not touch in `team_status`", "Handoffs only after work", D8 result, milestones), `team/COLD_START_TEST.md` (note under question 5), `team/PROGRESS.md`.

**How it was checked**

- New tests. Briefing: the new sentence, and no "when you finish/stop" or "at the end of a turn"; the 150-token test still passes. Handoff: the Codex note gets the message and is still saved; no message when the note names files, when the thread holds claims, or when the thread has an automatic note; all 4 notes saved. Description test for `team_handoff`. Rulebook: the demo's list; nothing without a section, with an empty one, for an empty file, or for the init template; `*`, `+` and numbered items; wrapped lines and paragraphs; a subheading's items; code blocks skipped; "Don't touch ##"; a `###` section ending at `##`; caps (5 items, 120 characters, "+4 more in ../../.team/rulebook.md"). `team_status`: no field without a rulebook or with the template, the list right after `you` with one.
- Deliberate breaks, each failed tests, all restored: no automatic-note check (1 failed), no claims check (1), no template filter (2), no section end (6).
- `vp test run src/team/ src/mcp/toolkits/team/` 3 times → 11 files, 92 passed each time. Wider, from `apps/server`: the same plus `src/provider/RuntimeInstructions.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/mcp/McpHttpServer.test.ts src/server.test.ts` → 15 files, 325 passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` and `packages/contracts` → 0 errors (only old suggestions, none on changed lines). `vp lint --report-unused-disable-directives` on the 8 changed `.ts` files → exit 0, no output. `vp fmt --check` → clean.
- The parser on the real `~/code/team-demo5/.team/rulebook.md` → ``["`data/`: the sample data. A human updates it."]``.
- Read the handoff from a copy of `~/.t3-dev`'s database (not the live file).
- Not done: no agent has seen the new briefing, description, warning or `doNotTouch` yet. A rerun of questions 2 and 5 with Codex would show whether the junk handoff is gone and `data/` is named. The junk note is still in `~/.t3-dev`; re-seeding resets the team.

**What's left**

- M2 (not started): limit registration-on-first-use to host mode; team HTTP API and invites.
- Optional: rerun the cold start test (Codex questions 2 and 5) to confirm both fixes with a real agent.
- Still open from M1.5: open question 5 (poll branch-only pull requests). Q4 passed, so `team_status` does not list "your other tasks".

**Unsure about / notes**

- Codex may still hand off after questions if it ignores the "only"; the server warning then corrects it once per session. If it keeps happening, the next step would be to hide such notes from search, not to reject them.
- In local mode a thread's automatic note can come from someone else's edits in the same checkout (D6), so the warning may be skipped there. It never fires wrongly because of that.

## 2026-10-01 — M1.5: freshness reasons, automatic notes, cold start test setup

**What changed**

- From manual test round 4 (passed: "not merged yet", "fresh", "maybe outdated" after a hand edit, and "not in a team" all showed up right). Two problems it found are fixed here.
- Freshness reasons. The agent got "maybe outdated: src/login.ts changed since", said it meant the work was not committed, and told the user to commit. Every mark but "fresh" now says why: "maybe outdated: content of src/login.ts changed since this note was written (+1 -0 lines)"; deleted and new files named as such; commit-only notes say "changed since commit abc1234, when this was written (+1 -1 lines)"; "not merged yet: this note's version of src/login.ts is not in your copy's history (another chat's uncommitted or unmerged work)" or the commit reason; "unknown: <why>" for no files, not a Git checkout, nothing stored, or a failed check. The search message now says "Each mark compares the note with the files in your copy now. Code wins over notes."
- Line counts need the old content, which for uncommitted work Git never had. `team_handoff` (and automatic notes) now store it with `git hash-object -w`. Unreferenced objects, pruned by `git gc` after two weeks by default; then the counts are just left out. Counts use the `diff` package already in the server; files over 256 KB or binary get none.
- Automatic notes. Chat A wrote no handoff until asked. New `apps/server/src/team/TeamAutoNotes.ts`: on each ready turn diff with files, it saves one automatic note per thread (files changed across turns, newest first, max 50; content hashes; `HEAD`; task), updated in place. Migration `3_TeamAutomaticNotes`: `automatic` column plus a unique index per thread for automatic rows. No activity line, no word cap, never touches real handoffs. Search shows kind `automatic note`, always below matching handoffs and decisions.
- Bug found by the new tests, from M1.4: `git hash-object --stdin-paths` reads paths from the repo root, so when `.team/` is in a repo subfolder, handoffs stored no hashes and fell back to the commit. Hashing now passes full paths.
- Cold start test (D8): `apps/server/scripts/team-cold-start-seed.ts` builds `~/code/team-demo5` and seeds the team in `~/.t3-dev` through `TeamService`; `team/COLD_START_TEST.md` has the steps, the five questions and the expected answers.
- DESIGN.md: D5 (search row, ranking), D7 (reasons, stored content, automatic notes), D8 (M1 setup), section 4 `server.ts` row, milestones.

**Design points to flag (none blocking, all written into DESIGN.md)**

- Storing note content in the repo's Git objects (`hash-object -w`) is new. Invisible to the user, deduplicated by Git, pruned by `gc`. The alternative was storing file content in our database.
- D8 Q4 "What is left on my task?" does not fit M1 as is: a new chat has no task card, and every chat on this server is the same member. The seed makes "my task" a task owned by you, linked to no chat; the agent must spot it in `team_status` by owner. If agents fail Q4 this way, `team_status` could list "your other tasks"; not done, your call.
- "Claims from two other chats" are seeded as chats of two teammates (Sara, Omar) on other servers: claims of this server's threads that do not exist are released at server start (claim lifetime), so fake chats of your own would lose them on restart.
- Automatic notes add up files across a thread's turns. In local mode they can name files changed by someone else in the same checkout (same limit as D6).

**Files touched**

- New: `apps/server/src/team/TeamAutoNotes.ts`, `TeamAutoNotes.test.ts`, `apps/server/src/team/Migrations/003_TeamAutomaticNotes.ts`, `apps/server/scripts/team-cold-start-seed.ts`, `team/COLD_START_TEST.md`.
- Our files: `mcp/toolkits/team/{memory,memory.test,handlers,handlers.test,tools}.ts`, `team/{TeamService,TeamService.test,TeamMigrations}.ts`, `packages/contracts/src/team.ts` (`automatic` on `TeamHandoff`, `TEAM_AUTOMATIC_NOTE_MAX_FILES`).
- Upstream edit, marked `team-layer:`: `apps/server/src/server.ts` (1 import + 1 layer line).
- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- New tests. Reasons: line counts from stored content (+1 -0), deleted, new, three-file list with counts and "+2 more", no counts without stored content, "not merged yet" reason, commit-only reasons (changed with counts, not in history, unknown commit), each "unknown" reason; hashing from a `.team/` subfolder. Automatic notes: one per thread updated in place (same id, files merged newest turn first, old hashes kept, unhashable file loses its hash, time moves), separate per thread, a real handoff on the same thread untouched, no activity line, 50-file cap, a full 150-word handoff still allowed; ranking below handoffs and decisions even with a higher score and newer, in `rankMemory` and through the tool; reactor with real Git: placeholder, empty and non-team turn diffs skipped, hashes and stored content, second turn updates the same note, paths mapped from a repo subfolder and a worktree, files outside the project dropped.
- Deliberate breaks, each made tests fail, all restored: no automatic-last ranking (2 failed), relative hash paths (2), no line counts (5), handoff not storing content (1), any diff status counts (1), always insert a new automatic note (2), merge dropping earlier turns' files (2).
- `vp test run src/team/ src/mcp/toolkits/team/` 5 times in a row → 84 passed each time. Wider, from `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/provider/RuntimeInstructions.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/mcp/McpHttpServer.test.ts src/server.test.ts` → 14 files, 317 tests passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` (includes `scripts/`) and `packages/contracts` → 0 errors. `vp lint --report-unused-disable-directives` on the 14 changed `.ts` files → only the old `server.ts` line 8 warning. `vp fmt --check` → clean.
- Seed script, against a scratch home (a `VACUUM INTO` copy of `~/.t3-dev`, plus its environment id) and a scratch project: ran, re-ran (same row counts: 1 team, 3 members, 2 tasks, 2 claims, 2 handoffs, 7 activity lines), refused a foreign folder (left it alone), `~/.t3`, and a folder inside this repo.
- What a fresh chat would see: a throwaway test (deleted after) called the real tool handlers on the seeded scratch database from a new worktree of the demo repo. `team_status`, `team_task`, and three searches returned what the expected answers in COLD_START_TEST.md say; Sara's handoff was "maybe outdated: content of src/pins/search.ts changed since this note was written (+1 -1 lines)" (the demo commit was then fixed to really ignore case; it now changes 2 lines, re-seeded, not re-probed).
- Real server on the scratch home (port 13992): started, no errors or warnings, `team_sql_migrations` = 1, 2, 3, and the seeded teammates' claims were still active after startup. Stopped by the PID captured at start, after checking it owned the port.
- Not done: no real agent turn has produced an automatic note yet, and no agent has seen the new reasons. That is the manual test. I did not run the seed script against `~/.t3-dev` or `~/code/team-demo5`; you run it as step 2 of the test.

**Manual test (to run)**

`team/COLD_START_TEST.md`: seed, start the dev server with `--home-dir ~/.t3-dev`, add `~/code/team-demo5`, new chat, five questions, grade; then the automatic-note check at the end.

**What's left**

- The cold start test, per provider (Claude Code and Codex for M1).
- Decide whether `team_status` should list your tasks that no chat holds (if Q4 fails).
- Decide open question 5 (poll branch-only pull requests).
- M2: limit registration-on-first-use to host mode; team HTTP API and invites. M3's overlap detection can reuse the turn-diff subscription in `TeamAutoNotes.ts`.

**Unsure about / notes**

- Stored content objects live in the user's repo until `git gc` prunes them. I think that is fine; say if you would rather keep content in our database.
- An automatic note's text is fixed, so a keyword search finds it mainly by file path, author name or task title.
- Line counts are counted by the `diff` package (`diffLines`), not by Git, for hash-based notes; they match Git's numbers on the tested cases.

## 2026-10-01 — M1.4 `team_memory_search`, and manual tests move to `~/.t3-dev`

**What changed**

- Setup fix: round 3's dev server ran with `--home-dir ~/code/t3code/.t3`, so chat worktrees lived inside this repo. Agents in demo projects walked up the folders, read this repo's CLAUDE.md and WORKING_RULES.md, and followed them (one asked to push to origin main, one wrote team/PROGRESS.md in a demo project). WORKING_RULES.md has a new "Manual tests" section: always `vp run dev --home-dir ~/.t3-dev`, never a home folder inside this repo, never `~/.t3/userdata`. The setup entry below notes the old command is no longer used. `~/code/t3code/.t3` (round 1-3 state and worktrees) was left as is.
- Design problem found before building, and fixed with the developer's go-ahead: handoffs stored only `HEAD`, but agents hand off before committing. In round 3's database, two of the three handoffs that named files stored the "team setup" commit while their files were uncommitted. D7 as written would have called a new uncommitted file "fresh" forever, an edited one "maybe outdated" at once, and never said "not merged yet" in another chat's copy. Now `team_handoff` also stores each file's content hash (`git hash-object`; null for a missing file; folders skipped) in a new `file_hashes_json` column, through our own migration `2_TeamHandoffFileHashes`.
- New tool `team_memory_search` (31-word description): keyword search over the newest 200 handoffs and up to 200 `.team/decisions/*.md` files in the caller's checkout. Score = distinct query words found (stop words dropped, paths kept); ties newest first; top 5, with "N more matches left out" when more matched. Each result: kind, says (about 40 words at most), who, when, files (5 at most), freshness, and the file for decisions. An empty query (only stop words) is a tool error; no matches is a normal result.
- Freshness, checked in the caller's folder holding `.team/`: "fresh", "maybe outdated: <files> changed since" (3 files at most, then "+N more"), "not merged yet", or "unknown". Handoffs with hashes compare content, then ask Git whether the noted content ever reached this copy's history (`git log --find-object`), so squash merges work. Decisions and older handoffs use the commit only (`merge-base --is-ancestor`, then `git diff <commit>` including uncommitted edits). Every check is caught and becomes "unknown"; each Git call has a 5 second limit.
- Decision files: front matter `title`, `author`, `date`, `files`, `commit`, all optional. The `t3 team init` rulebook template now shows this format.
- The briefing is unchanged (146 of 150 tokens). DESIGN.md: D3 (decision format), D5 (tool row, caps, "Memory search (v1)" with smarter search later), D7 rewritten (hashes, why, marks table, limits), milestones.

**Files touched**

- New: `apps/server/src/mcp/toolkits/team/memory.ts`, `memory.test.ts`, `apps/server/src/team/Migrations/002_TeamHandoffFileHashes.ts`, `apps/server/src/team/testing/gitRepo.ts` (test helper).
- Our files: `mcp/toolkits/team/{tools,handlers,handlers.test}.ts`, `team/{TeamService,TeamService.test,TeamMigrations,TeamMigrations.test,TeamProjectFiles}.ts`, `packages/contracts/src/team.ts` (`fileHashes` on `TeamHandoff`, `TEAM_DECISIONS_DIRECTORY_NAME`).
- No upstream files.
- `team/DESIGN.md`, `team/WORKING_RULES.md`, `team/PROGRESS.md`. Outside the repo: my saved notes now say to use `~/.t3-dev`.

**How it was checked**

- New tests: query words; ranking by matches then newest, undated last; cap of 5 with the count; decision parsing (inline and dash lists, quotes, `..` dropped, no front matter, heading or file name as title, 40-word cap); decisions folder missing, non-Markdown and oversized files skipped. Freshness with real Git repos: fresh, then "maybe outdated" after an edit in the same checkout (new and edited uncommitted files); "not merged yet" from another worktree, "fresh" after a squash merge, "maybe outdated" after a later edit there; 3-file cap in the mark; commit-only fresh, unrelated commits still fresh, uncommitted edit "maybe outdated", commit on another branch and unknown commit "not merged yet"; a `.team` folder below the repo root; "unknown" for no files, no commit or hashes, a plain folder, and a missing folder.
- Through the tool, with real Git: handoff and decision ranked and shaped right; "maybe outdated" after editing the file; "not merged yet" from a second chat's worktree; 7 handoffs → 5 results and "2 more matches left out"; no decisions folder; no matches; stop-words-only query; the not-in-team result; stored hashes (null for a missing file, folder skipped). `TeamService`: hash keys normalized, extra keys dropped, notes without hashes read back null. Migration tests now take ids from the manifest.
- Deliberate breaks, each made tests fail, all restored: no history check, ignore same checkout, no newest-first tie break, no hashes on handoff, unreachable commit not "not merged yet", no catch around a check, no result cap.
- `vp test run src/team/ src/mcp/toolkits/team/` 8 times in a row → 75 passed each time. Wider, from `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/provider/RuntimeInstructions.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/mcp/McpHttpServer.test.ts src/server.test.ts` → 13 files, 308 tests passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` and `packages/contracts` → 0 errors. `vp lint --report-unused-disable-directives` on the 13 changed `.ts` files → no findings. `vp fmt --check` → clean.
- Real server on a `VACUUM INTO` copy of round 3's database (scratch base dir, port 13991): logged "Team migrations ran successfully" with `2_TeamHandoffFileHashes`; `team_sql_migrations` = 1, 2; the 7 old handoffs kept, all with null hashes. No errors. Stopped by the PID captured at start, after checking it owned the port.
- Not done: no real agent has called the tool yet. That is the manual test.

**Manual test (to run)**

Given in chat on 2026-10-01: fresh project `~/code/team-demo4`, dev server with `--home-dir ~/.t3-dev` (new home: pair again, re-add projects). Covers fresh, "not merged yet" from a second chat, "maybe outdated" after a hand edit, a decision going "maybe outdated", "unknown", and a control project.

**What's left**

- The manual test.
- Decide open question 5 (poll branch-only pull requests).
- M2: limit registration-on-first-use to host mode; team HTTP API and invites.
- Delete `~/code/t3code/.t3` once you no longer need rounds 1-3 (then `git worktree prune` in team-demo, team-demo2, team-demo3).

**Unsure about / notes**

- Round 3's old handoffs have no hashes, so they use the commit-only check and can get the wrong mark. New handoffs are fine.
- Keyword matching is substring based: "log" matches "login". Fine for v1; DESIGN.md says a smarter search can come later.
- `team_memory_search` is not in the briefing (no room). Agents find it from the tool list; whether they do so unprompted is part of the manual test.
- A file that did not exist when the note was written cannot be traced through history, so it counts as "maybe outdated" once it appears.
- Decisions only have a commit, so one written before its code is committed shows "maybe outdated" once the code lands.

## 2026-09-30 — Claim lifetime fix (from the M1.3 manual test)

**What changed**

- The problem: in the M1.3 manual test, chat A released its claims at the end of its turn. Chat B then got no overlap warning for `src/login.ts`, which was still unmerged in chat A's worktree, and could not see the file.
- A claim now lasts until the thread's work is merged or dropped. The briefing says: "When you finish or stop, write a team_handoff, but keep your claims: release them only if the user drops the work." (about 146 of 150 tokens with the longest names; "If team_claim reports overlaps" became "If it reports overlaps" to make room). The `team_claim` description (36 words): "Claim files or folders before editing them; returns overlaps with others' claims. Claims last until your work merges or this thread is archived: don't release when done. release: true only if the user drops the work."
- Auto-release: new `apps/server/src/team/TeamClaimAutoRelease.ts`, started in `ReactorLayerLive`. It releases a thread's claims on `thread.archived`, `thread.deleted` (a deleted project deletes its threads first), `thread.pull-request-synced` with state `merged` (linked pull requests), and T3's own merge action (`PullRequestService.subscribeMerges`, matched to the thread's linked or branch pull request). A merge releases only claims made before the merge time, and only when none of the thread's other linked pull requests is still open. At startup it releases claims of threads that are no longer active. Each release writes an activity line.
- `TeamService`: new `releaseThreadClaims` and `listClaimedThreads`. Claims are now ordered by `rowid` after `claimed_at` (same-millisecond claims came back in random order; found by the new test failing 3 of 5 runs).
- `team_status` claims and `team_claim` overlaps have a new `where` field: "their own copy; not merged into yours yet", or "same checkout as you" when both threads work in the same folder. When any overlap is in another copy, the overlap message adds: "Their changes are in their own copy and not merged yet, so you may not see them."
- DESIGN.md: D4 line 4, D5 (new "Claim lifetime" part with the event table and the gap, `where`), section 4 `server.ts` row, milestones, open question 5.
- Deleted the stray `hello.ts` at the repo root (never committed).

**Files touched**

- New: `apps/server/src/team/TeamClaimAutoRelease.ts`, `apps/server/src/team/TeamClaimAutoRelease.test.ts`.
- Our files: `team/TeamService.ts`, `team/TeamService.test.ts`, `team/TeamBriefing.ts`, `team/TeamBriefing.test.ts`, `mcp/toolkits/team/{handlers,tools,handlers.test}.ts`.
- Upstream edit, marked `team-layer:`: `apps/server/src/server.ts` (1 import + 1 layer line).
- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- New tests: auto-release on archive and on delete; on a linked pull request merging (only claims from before the merge; a claim made after it stays); a stack waits until every open linked pull request has merged; T3's merge action releases a branch-only pull request's thread and ignores the same number in another project; startup releases claims of a thread that no longer exists; `where` for another worktree vs the same checkout; the briefing and description texts; `releaseThreadClaims` (only that thread, only that server, only before the time, no activity when there is nothing to release).
- "Released at turn end doesn't happen by default", as far as code can test it: a test sends turn-diff-completed, session-set, settled, and a pull request synced as open then closed, and the claim is still there. The briefing test fails if the text asks to release claims when done. Whether a real agent obeys can only be checked by hand (below).
- Deliberate breaks, each made the named test fail, all restored: no archive handling, no delete handling, ignore other open pull requests, release all claims on merge (ignoring the time), release on session-set, no startup release, no T3 merge handling, T3 merge from any project (this one first passed; I fixed the test, then it failed as it should), `where` always "own copy", briefing saying "release your claims".
- `vp test run src/team/ src/mcp/toolkits/team/` 10 times in a row → 59 passed each time.
- Wider set, from `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/provider/RuntimeInstructions.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/provider/Layers/CodexSessionRuntime.test.ts src/provider/Layers/{Claude,Cursor,Grok,Antigravity,OpenCode}Adapter.test.ts src/mcp/McpHttpServer.test.ts src/server.test.ts` → 18 files, 705 tests passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` → 0 errors. Lint on the 10 changed `.ts` files → only the existing `server.ts` line 8 warning. `vp fmt --check` → clean.
- Real server (scratch base dir, port 13990): first start ran migrations and listened. Stopped, then seeded a team, member and a claim held by a thread id that does not exist. Second start logged "Released team claims." with reason "its thread was archived or deleted"; the claim had `released_at` set and the activity line read "Released Seeder's claims on src/login.ts: its thread was archived or deleted." No errors in either log. Both servers stopped by the PID captured at start, after checking they owned the port.
- Not done: no real agent run, no real archive/merge through the UI. That is the manual test below.

**Manual test (to run)**

Given in chat on 2026-09-30: fresh project `~/code/team-demo3`, control test in a separate plain folder.

**What's left**

- The manual test.
- Decide open question 5 (poll branch-only pull requests).
- M1.4: `team_memory_search` and freshness marks.
- M2: limit registration-on-first-use to host mode.

**Unsure about / notes**

- Not detected in M1: a pull request T3 only found from the branch (for example the agent ran `gh pr create`), merged outside T3. T3 stores no state for those, so no event fires. Its claims stay until the thread is archived or deleted. Linking the pull request in T3, or creating it with T3's create-PR action, avoids this.
- Linked-merge release depends on this server's one-minute pull request sync and its git host login, like D9. If the server is off when the pull request merges, the release comes at the next sync after it starts.
- The briefing is now 146 of 150 estimated tokens at worst. The next addition must cut something.
- `where` compares folders exactly. Two local-mode threads in different projects of one repo would be called "their own copy" though they share a checkout. Rare; not handled.
- In the M1.3 test no code released chat A's claim: the agent chose to, and the old wording never told it not to.

## 2026-09-30 — M1.3 team briefing

**What changed**

- `buildRuntimeInstructions()` takes an optional `teamContext`. When it is missing or empty, the output is exactly what it was before (a test checks this).
- The briefing (`apps/server/src/team/TeamBriefing.ts`) is about 107 tokens with normal names and at most about 132 with 60-character names. It says: this project is in team "<name>" and you are "<member>"; before editing files, call `team_status`, then `team_claim` the paths you will touch; if `team_claim` reports overlaps, tell the user before editing those files; when you finish or stop, write a `team_handoff`; project rules are in `.team/rulebook.md`, read it before your first change; code is the truth, team notes can be out of date. No claims, tasks or other live data.
- All six providers pass it: Claude (session prompt, once per session), Codex (`additionalContext`, through `CodexSessionRuntime` and `CodexDeveloperInstructions`), Cursor, Grok, Antigravity (every prompt) and OpenCode (per-prompt system addendum). Slash and native commands get no briefing, like the rest of the runtime instructions.
- How adapters get it: `TeamBriefingLive` (in `ReactorLayerLive`) installs a resolver at startup; adapters call `readTeamBriefing(threadId)`. The resolver uses the same thread → team lookup as the tools, now shared in `mcp/toolkits/team/resolve.ts`. No briefing when the session has no `t3-code` MCP server, the project is not in a team, or this server is not a member; a failure or a lookup over 2 seconds logs a warning and gives no briefing.
- `team_status` claims and `team_claim` overlaps now show `task`: the claiming thread's task title, or "no task". The overlap message now says "Tell the user before editing those", to match the briefing.
- Fixed a flaky test from M1.2: `listActivity` broke ties between same-millisecond entries by random id, so "newest first" was a coin flip (`TeamService.test.ts` failed about half the time). It now breaks ties by insertion order (`rowid`). This also fixes the order of `team_status`'s "recent" lines.
- DESIGN.md: D4 rewritten (block contents, why the task was dropped, the new plumbing), D5 (claims show their task), D6 layer 2, section 4 table, milestones.

**Files touched**

- New: `apps/server/src/team/TeamBriefing.ts`, `apps/server/src/team/testing/teamBriefing.ts` (test helper), `apps/server/src/mcp/toolkits/team/resolve.ts`, `apps/server/src/mcp/toolkits/team/briefing.ts`; tests `apps/server/src/team/TeamBriefing.test.ts`, `apps/server/src/mcp/toolkits/team/briefing.test.ts`, `apps/server/src/provider/Layers/CodexTeamBriefing.test.ts`.
- Our files: `mcp/toolkits/team/handlers.ts` (lookup moved to `resolve.ts`, task on claims), `tools.ts`, `handlers.test.ts`, `team/TeamService.ts` (activity order).
- Upstream edits, marked `team-layer:`: `provider/RuntimeInstructions.ts`, `provider/CodexDeveloperInstructions.ts`, `provider/Layers/{Claude,Cursor,Grok,Antigravity,OpenCode}Adapter.ts`, `provider/Layers/CodexSessionRuntime.ts`, `server.ts` (1 import + 1 layer line), and one appended test in each of `{Claude,Cursor,Grok,Antigravity,OpenCode}Adapter.test.ts`.
- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- Tests, from `apps/server`: `vp test run src/team/ src/mcp/toolkits/team/ src/provider/RuntimeInstructions.test.ts src/provider/Layers/CodexTeamBriefing.test.ts src/provider/Layers/CodexSessionRuntime.test.ts src/provider/Layers/CodexCollabRuntime.integration.test.ts src/provider/Layers/{Claude,Cursor,Grok,Antigravity,OpenCode}Adapter.test.ts src/mcp/McpHttpServer.test.ts src/server.test.ts` → 18 files, 708 tests passed.
- Provider tests: each adapter test sends a turn outside a team (exact old text, or ends at `</pull_request_linking>`) and one inside (briefing appended). Cursor, Grok and Antigravity check a thread that joins mid-session gets it on the next turn, and that slash commands get nothing. Codex is tested through the real session runtime and the mock app-server, reading the context back from the compaction restore.
- Deliberate breaks: removing the briefing line in each of the six provider paths made that provider's test fail; raising the name cap to 200 made the token-budget test fail. All restored.
- Resolver tests: not in a team, in a team (and registering it), subfolder project (`../../.team/rulebook.md`), worktree, no MCP server, not a member, broken `team.json` → no briefing instead of an error.
- `TeamService.test.ts`: failed 2 of 4 runs before the `rowid` fix, passed 8 of 8 after.
- Typecheck: `npx tsc --noEmit` in `apps/server` → 0 errors.
- Lint: `vp lint --report-unused-disable-directives` on all 25 changed `.ts` files → only the existing `server.ts` line 8 warning (unused `ProviderDriverKind`, upstream, from before M1.1). `vp fmt --check` → clean.
- Real server start on a scratch base dir (port 13989): upstream migrations, team migrations, listening, no errors. Stopped by the PID captured at start, after checking it owned the port.
- Not done: no real agent has seen the briefing yet. That is the manual test below. No repo-wide checks.

**Manual test (to run)**

Given in chat on 2026-09-30. The steps never name the tools: they check whether agents claim, warn and hand off on their own.

**What's left**

- The manual test.
- M1.4: `team_memory_search` and freshness marks.
- M2: limit registration-on-first-use to host mode (see D5).

**Unsure about / notes**

- Token counts are estimates (the higher of 4 characters per token and 3/4 word per token), not a real tokenizer. No tokenizer is in the repo's dependencies.
- The briefing asks agents to claim and warn; it cannot force them. Full-access mode never asks for approval, so an agent that ignores the briefing can still edit a claimed file. Turn-diff overlap detection (M3) is the backstop.
- Claude reads the briefing once per session. A project that joins a team mid-session gets it in the next Claude session.
- The first turn in a team project registers the team (same rule as the tools). M2 must narrow this.
- The resolver is module-level state, like `McpProviderSession`'s map. Two servers in one process would share it; only tests do that, and the test helper installs and removes it around each test.

## 2026-09-30 — M1.2 team tools: `team_status`, `team_claim`, `team_task`, `team_handoff`

**What changed**

- New toolkit `apps/server/src/mcp/toolkits/team/`, built like `pullRequests/`: `tools.ts` (schemas, errors, the four tools), `handlers.ts`, `paths.ts`. Registered with one `team-layer:` line in `McpHttpServer.ts`'s `layer`, plus its two imports.
- Every tool starts the same way: thread → project → working folder (`worktreePath`, else the project root) → `.team/team.json`, falling back to the root of that folder's Git repo. No team file → a normal `{ inTeam: false, message }` result, not an error. Team file but no team in the database → `ensureTeam` registers it with this server as owner (display name = the environment's label). Team known but this server not a member → a normal "not a member" result.
- Paths: a full path inside the project becomes project-relative; a relative path is read from the working folder; a path outside the project (or climbing out with `..`) is rejected with a message naming the project folder. Windows paths work too.
- `team_status`: your task, open tasks (max 8), other threads' claims (max 10, 5 paths each), your claims, the last 5 activity lines, newest first, plus a count of what was left out. Done tasks are left out.
- `team_claim`: claim paths with a note; returns overlaps with other threads' claims and says to coordinate. `release: true` releases the paths given, or all of this thread's claims.
- `team_task`: reads this thread's task; `status`/`note` update it; with no task, `title` creates one for this thread (status `in_progress` unless given, owner = this member). A title for a thread that already has a task is ignored, and the result says so.
- `team_handoff`: `changed`, `left`, `risks`, `files`; the 150-word cap comes from the service. The commit is filled in with `git rev-parse HEAD` in the working folder (null if that fails), and the note is linked to the thread's task.
- Each tool description is under 40 words (a test checks it).
- `TeamService.createTask` now takes optional `status` and `thread`, so a task an agent creates starts on its thread in one transaction.
- DESIGN.md: D5 now describes the registration rule, the repo-root fallback, paths and the token caps; section 4 and milestones updated (M1.3 = `teamContext`, M1.4 = `team_memory_search`).

**Files touched**

- New: `apps/server/src/mcp/toolkits/team/{tools,handlers,paths}.ts`, tests `handlers.test.ts`, `paths.test.ts`.
- Our files: `apps/server/src/team/TeamService.ts`, `apps/server/src/team/TeamService.test.ts`.
- Upstream edits, marked `team-layer:`: `apps/server/src/mcp/McpHttpServer.ts` (2 imports + 1 layer line), `apps/server/src/server.test.ts` (1 import + a mocked `TeamService` for the routes layer, which now needs it).
- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- Tests, from `apps/server`: `vp test run src/mcp/toolkits/team/ src/team/TeamService.test.ts` → 3 files, 22 tests passed. Covered: the not-a-team case for all four tools, registering on first use (once), not-a-member, repo-root fallback, full/relative/outside paths (posix and win32), overlaps, partial and full release, task read/create/update, handoff commit from the worktree (not the project root), the word cap, and the `team_status` caps.
- A deliberate break (sorting oldest first) made the `team_status` cap test fail; restored.
- Also ran the upstream files I touched: `vp test run src/mcp/McpHttpServer.test.ts src/server.test.ts src/team/TeamService.test.ts` → 3 files, 231 tests passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` → 0 errors.
- Lint: `vp lint --report-unused-disable-directives` on the new files, `McpHttpServer.ts` and `TeamService.ts` → no findings. `server.test.ts` has 25 existing warnings, the same count before and after my edit. `vp fmt --check` on every changed file → clean.
- Real server start on a scratch base dir (port 13988): team migrations ran, the server listened, `POST /mcp` without a credential returned 401 (so the MCP routes, including the team toolkit, were built), no errors in the log. Stopped by the PID captured at start, after checking it owned the port.
- Not done: no real agent called the tools (as asked). No repo-wide checks.

**What's left**

- M1.3: the `teamContext` block in runtime instructions, which tells agents to call these tools.
- M1.4: `team_memory_search` and freshness marks.
- M2: limit registration-on-first-use to host mode (see D5).

**Unsure about / notes**

- The owner's display name is the environment label (usually the machine name), not a person's name. There is no rename yet.
- Paths are compared as text; symlinked folders (for example `/tmp` vs `/private/tmp` on macOS) are not resolved, so a full path through a symlink can be rejected as outside the project.
- `team_status` hides done tasks entirely; the board UI (M3/M4) will show them.

## 2026-09-30 — M1.1 foundation: schemas, storage, team service, `t3 team init`

**What changed**

- Contracts: `packages/contracts/src/team.ts` with the team file (`teamId`, `name`), team, member, claim, claim overlap, task, handoff (with files and commit) and activity schemas, plus path helpers (`normalizeTeamPath`, `teamPathsOverlap`) and word caps (rulebook 1,500, handoff 150).
- Storage: our own migrator (`apps/server/src/team/TeamMigrations.ts`) with table `team_sql_migrations`, and migration `001_TeamCore` creating `team_teams`, `team_members`, `team_claims`, `team_tasks`, `team_handoffs`, `team_activity`. Upstream's migration list is untouched.
- Service: `apps/server/src/team/TeamService.ts`. It creates a team with its owner (safe to call again), reads teams and members, claims and releases paths (returns overlaps with other threads' claims; releasing a folder releases paths inside it), creates, updates and finds tasks (by id or thread), writes and lists handoffs (150-word cap), and records every write in the activity feed. Runs team migrations when built.
- Server start: `TeamService.layer` added to `RuntimeCoreDependenciesLive` in `server.ts`, just above `PersistenceLayerLive`.
- CLI: `t3 team init [path] [--name]` (`apps/server/src/cli/team.ts`, logic in `apps/server/src/team/TeamProjectFiles.ts`). Finds the repo root by walking up to `.git`. Writes `.team/team.json` and `.team/rulebook.md` only if missing. Sets `"defaultThreadEnvMode": "worktree"` in `t3.json` by editing only that field, so comments, trailing commas and other keys stay; the edit is re-parsed and compared before it is written. Checks everything before writing anything. Never commits; prints what it did and says to review and commit.
- DESIGN.md: answered open questions 2 (second migrator) and 5 (where the layer starts, where CLI commands register) in section 6; updated D3, D6 layer 4, the section 4 table and milestones.

**Files touched**

- New: `packages/contracts/src/team.ts`, `apps/server/src/team/TeamErrors.ts`, `apps/server/src/team/TeamMigrations.ts`, `apps/server/src/team/Migrations/001_TeamCore.ts`, `apps/server/src/team/TeamService.ts`, `apps/server/src/team/TeamProjectFiles.ts`, `apps/server/src/cli/team.ts`, and tests `apps/server/src/team/TeamMigrations.test.ts`, `apps/server/src/team/TeamService.test.ts`, `apps/server/src/team/TeamProjectFiles.test.ts`, `apps/server/src/cli/team.test.ts`.
- Upstream edits, all marked `team-layer:` (10 lines in 3 files): `packages/contracts/src/index.ts` (one export), `apps/server/src/server.ts` (import + one layer line), `apps/server/src/bin.ts` (import + one subcommand).
- `team/DESIGN.md`, `team/PROGRESS.md`.

**How it was checked**

- Tests, from `apps/server`: `vp test run src/team/TeamMigrations.test.ts src/team/TeamService.test.ts src/team/TeamProjectFiles.test.ts src/cli/team.test.ts` → 4 files, 24 tests passed.
- Typecheck: `npx tsc --noEmit` in `apps/server` → 0 errors; in `packages/contracts` → 0 errors.
- Lint: `vp lint --report-unused-disable-directives` on every changed and new file → no findings in our code. One existing upstream warning remains in `server.ts` line 8 (unused `ProviderDriverKind` import); it is in the committed upstream file and I did not touch it.
- Real CLI run: `node apps/server/src/bin.ts team init <scratch repo made with git init> --name "Demo team"` created the three files and kept a comment in the existing `t3.json`. A second run reported all three unchanged. `git log` showed no commits.
- Real server run: `node apps/server/src/bin.ts serve --base-dir <scratch> --port 13987 --no-browser`. The log shows upstream migrations, then "Team migrations ran successfully" (`1_TeamCore`) about 0.4 s later. The database had `team_sql_migrations` = [1], `effect_sql_migrations` = 1-54, and all seven `team_*` tables. A restart ran no migrations and logged no errors.
- No repo-wide checks were run.

**What's left**

- M1.2: the five team tools in `apps/server/src/mcp/toolkits/team/`, the call-time membership check, and registering the team in the database from `.team/team.json` (the service's `ensureTeam`) when a team project is first used. `t3 team init` writes files only and does not touch the database.
- M1.3: the `teamContext` block in runtime instructions.

**Unsure about / notes**

- A mistake during the server check: my first background start used `setsid`, so the PID I recorded was the wrapper's, not the server's. My first "restart" then ran against a port that was still in use, and that second server exited with address-in-use. I found the real server by its port, confirmed its working folder and arguments, stopped it, and redid the restart check with the correct PID. No other process was touched.
- `t3.json` with the key only inside a comment before the real key cannot be edited safely; `t3 team init` then stops and asks the user to add the field by hand. Covered by a test.
- `.team/team.json` uses a UUID for `teamId`.

## 2026-09-30 — Design doc v2

**What changed**

- Rewrote team/DESIGN.md as v2 using the accepted "Instead" fixes from team/CODE_FINDINGS.md: team HTTP API with `team:read` / `team:write` and polling (D1), `.team/team.json` with `teamId` (D2), own migrator with `team_sql_migrations` and `team_*` tables (D3), a small ~150-token team block through `teamContext` (D4), five tools with a membership check at call time (D5), turn-diff claims as overlap detection, and team creation turning on worktrees (D6), cards keyed by thread with both PR link paths (D9), and a realistic list of upstream files (section 4). Every claim is marked [checked] or [verify] again. Section 6 now lists the remaining [verify] items.
- Removed the `team-layer:` ignore line from vite.config.ts, so the formatter formats DESIGN.md normally. vite.config.ts is back to the upstream version.
- Docs only, no feature code.

**Files touched**

- team/DESIGN.md
- team/PROGRESS.md
- vite.config.ts (line removed; file matches upstream again)

**How it was checked**

- Before writing, checked a few new details in the code: all six adapters have T3's thread id where they call `buildRuntimeInstructions()`, Codex has it in its session runtime options, HTTP groups are mounted in `makeRoutesLayer` in `apps/server/src/server.ts`, and pairing link lifetime is settable in the server-side auth service but not over HTTP.
- `git diff` of vite.config.ts against the commit before the ignore line was added: no difference.
- No typecheck or tests: only Markdown and one removed config line changed. The pre-commit formatter ran on the commit.

**What's left**

- The six [verify] items in DESIGN.md section 6. Then start M1.

**Unsure about / notes**

- D2 small choice not spelled out in the findings: the host address is **not** stored in `.team/team.json`. It comes from the invite and stays on each member's server, so public repos don't carry a private Tailscale address.
- D6 layer 4: team creation writes `.team/team.json` and the `t3.json` field in one commit that the creator reviews and pushes. Whether our code should make that commit itself or leave the files for the user to commit is open.

## 2026-09-30 — Design doc added and checked against the code

**What changed**

- Copied DESIGN.md from the Windows Downloads folder to team/DESIGN.md, unchanged.
- Wrote team/CODE_FINDINGS.md: answers to the 9 questions in DESIGN.md section 6, a re-check of every [checked] claim, and a list of design parts the code says won't work, with what to do instead. Research only; no feature code.

**Files touched**

- team/DESIGN.md (new, byte-identical copy)
- team/CODE_FINDINGS.md (new)
- team/PROGRESS.md
- vite.config.ts (one `team-layer:` line: formatter ignores team/DESIGN.md)

**How it was checked**

- `cmp` between the Downloads file and team/DESIGN.md: identical.
- The first commit (21a375e) went through the pre-commit formatter, which padded the two tables in DESIGN.md with spaces. The follow-up commit restores the exact bytes and adds team/DESIGN.md to the formatter's ignore list. `vp fmt --check` on DESIGN.md and vite.config.ts now checks only vite.config.ts, which passes, and `cmp` shows the committed file matches the original.
- Every answer comes from reading the code at the file and line numbers given in CODE_FINDINGS.md. Nothing was run; no typecheck or tests, because only Markdown changed.
- Did not pull from upstream.

**What's left**

- Decide on the design changes in the last section of CODE_FINDINGS.md before M1. The big ones: a small static instruction block instead of the full board in runtime instructions, a separate team migration table, an HTTP API for team calls instead of WebSocket RPCs, and an explicit team id instead of `canonicalKey` alone.

**Unsure about / notes**

- Claim 4 in the design (`canonicalKey` matches across clones) is partly wrong: the key prefers the `upstream` remote.
- Not checked: the web UI's scope display, every HTTP route's scope check, and whether all six providers read CLAUDE.md/AGENTS.md. Listed at the end of CODE_FINDINGS.md.
- AGENTS.md says not to commit research notes. These two files were asked for explicitly, so I committed them under team/.

## 2026-09-30 — Dev environment setup and fork working rules

**What changed**

- Set up the dev environment in WSL (Ubuntu 26.04) under the Linux home folder: Node v24.21.0 via nvm 0.40.3, npm 11.19.0, vp v1.0.0 (repo pins vite-plus 0.3.3), gh 2.101.0, git 2.53.0.
- Cloned the fork into ~/code/t3code and added `upstream` → https://github.com/pingdotgg/t3code. Did not pull from upstream (fork main was 2 commits behind upstream/main at clone time).
- Added team/WORKING_RULES.md and this log.
- CLAUDE.md now also imports @team/WORKING_RULES.md. AGENTS.md has a one-line fork note at the top pointing to the working rules.

**Files touched**

- team/WORKING_RULES.md (new)
- team/PROGRESS.md (new)
- CLAUDE.md
- AGENTS.md

**How it was checked**

- `vp i` finished with exit 0 (one warning: peer dependency issues; `pnpm peers check` lists them). Working tree was clean afterwards.
- `vp run dev --home-dir ~/code/t3code/.t3` started (no longer used: since 2026-10-01 manual tests use `--home-dir ~/.t3-dev`, see WORKING_RULES.md). Server listened on 127.0.0.1:13773, web on 127.0.0.1:5733. State went to the repo's gitignored `.t3`, not ~/.t3/userdata. Web root returned HTTP 200 with title "T3 Code (Alpha)". Pairing from the Windows browser worked (confirmed by the developer).
- Dev server stopped by signalling the process group it was started in, after confirming both port owners belonged to that group and had cwd inside the repo. Both ports were free afterwards.
- No typecheck or tests run: this step changed only Markdown.

**What's left**

- No team-layer features yet. Next step is planning the first feature.

**Unsure about / notes**

- Vite logged "Failed to resolve dependency: @clerk/clerk-js, present in client 'optimizeDeps.include'" at startup. It comes from upstream's apps/web/vite.config.ts; the app still loaded. Not investigated.
- The fork note sits above the `# T3 Code` heading in AGENTS.md, as asked. A future upstream pull could conflict on that first line; it is easy to resolve.
