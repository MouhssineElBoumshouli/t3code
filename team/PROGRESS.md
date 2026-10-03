# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

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
