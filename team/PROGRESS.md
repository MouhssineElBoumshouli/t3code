# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

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
- `vp run dev --home-dir ~/code/t3code/.t3` started. Server listened on 127.0.0.1:13773, web on 127.0.0.1:5733. State went to the repo's gitignored `.t3`, not ~/.t3/userdata. Web root returned HTTP 200 with title "T3 Code (Alpha)". Pairing from the Windows browser worked (confirmed by the developer).
- Dev server stopped by signalling the process group it was started in, after confirming both port owners belonged to that group and had cwd inside the repo. Both ports were free afterwards.
- No typecheck or tests run: this step changed only Markdown.

**What's left**

- No team-layer features yet. Next step is planning the first feature.

**Unsure about / notes**

- Vite logged "Failed to resolve dependency: @clerk/clerk-js, present in client 'optimizeDeps.include'" at startup. It comes from upstream's apps/web/vite.config.ts; the app still loaded. Not investigated.
- The fork note sits above the `# T3 Code` heading in AGENTS.md, as asked. A future upstream pull could conflict on that first line; it is easy to resolve.
