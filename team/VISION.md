# Team layer: vision and plan (v3)

Status: v3, 2026-10-06, updated 2026-10-07 (steps 1 and 2 done, two new requirements in section 6, design picked for step 3). Written by Claude (chat) with Mouhssine. This replaces the "host server" direction in DESIGN.md section 7. M1 (team tools, briefing, memory, freshness) stays.

## 1. What we are building

A desktop app (our fork of T3 Code) where a small team builds one project together, each person with their own AI agent (Claude Code, Codex, and others). The agents know about each other, avoid stepping on each other's work, and remember the project.

First users: Mouhssine and classmates on a real school group project.

Success looks like: a team of 3 to 4 uses it for a whole project, has no surprise merge clashes, and never has to re-explain the project to a fresh chat.

## 2. The big change: team state lives in GitHub

Old plan: one teammate's computer hosts the team brain, others connect to it.
Problem: if the host's laptop is off, the team loses live team info. Setup needs networking (Tailscale, invites, tokens).

New plan: the team's live state lives in the project's own GitHub repo, on a hidden ref the app manages, `refs/t3-team/state` (not a branch, so normal fetches and branch lists never show it). No host. No special network. Everyone who has write access to the repo is on the team.

### How it works

- The `refs/t3-team/state` ref has no code. It only holds small JSON files: members, claims, tasks, handoff notes, automatic notes, activity.
- **Each writer only writes its own file**, one per GitHub login per T3 server: `writers/<github-login>/<server id>.json`. A person running two T3 servers (laptop and desktop, or two clones) has two writer files and still counts as one member. Two servers never edit the same file, so pushes never conflict. If a push is rejected because someone else pushed first, the app fetches and pushes again.
- The app fetches the branch every 10 to 20 seconds and pushes right after each change. Updates reach teammates in a few seconds.
- Rules and decisions stay where they are: `.team/rulebook.md` and `.team/decisions/` on the normal branch, reviewed like code.
- Offline: the app keeps working from its last copy and queues changes. It pushes when back online and tells the agent "claims not confirmed, overlaps unknown" while offline.
- Identity: the person's GitHub login, taken from the git/GitHub sign-in they already have.

### What this removes from the old plan

Host mode, invite links with tokens, the team HTTP API, team scopes, server-to-server connections, Tailscale. Joining a team becomes: get added to the GitHub repo, open the project in the app.

### Decided (2026-10-07)

Answers and reasons are in [STORAGE_PLAN.md](STORAGE_PLAN.md) section 5.

- State lives on the hidden ref `refs/t3-team/state`, not a `team-state` branch.
- Public repos: `t3 team init` refuses unless run with `--public-ok`. Private repos are recommended.
- Writer files are per (GitHub login, T3 server), not per person.
- Team scopes (`team:read`, `team:write`) are removed while host mode is parked.
- Host mode is parked in `team/parked/host-mode/` with the tag `team-host-mode-m2.3`. The upstream `ws.ts` security fix stays, with its own test.

### Open questions to answer in the code

1. **Public repos.** Anything on the state ref is public if the repo is public. Options: recommend private repos, keep team state in a separate private repo, or encrypt it. Pick one and say why.
2. **Polling cost.** Is fetching one small branch every 10 to 20 seconds fine for GitHub with a few teammates? Can we use something cheaper to check for changes first?
3. **Git hosting.** GitHub only for v1. Note what GitLab or others would need later.
4. **Speed.** Is "a few seconds" enough for claims? If two people claim the same file within the same few seconds, both should be warned once the state syncs.

## 3. What happens when two people work on the same thing

The core of the app. Example: Yassine is working on "login page" and holds `src/auth/`.

### 3.1 Before anyone starts (catch it here first)

When you give your agent a task, it first makes a short plan of which files it expects to touch, then checks claims, before writing any code. If there is an overlap, you get a card:

> **Yassine is working on login right now.** Your task will probably change `login.ts` too.
>
> - **Wait for him.** Start automatically when his work is merged, on top of his version.
> - **Build on top of his work.** Start from his unmerged branch.
> - **Ask Yassine.** Send him "Can I touch login.ts?" He answers from the app or his phone.
> - **Find another way.** The agent tries to do the task without his files.
> - **Go anyway.** Both are warned; help merging later.

### 3.2 In the middle

If the agent finds halfway through that it needs a claimed file, it pauses and shows the same card instead of editing silently.

### 3.3 Same file, both working

The agent can read the teammate's unmerged changes to that file (their pushed branch), and writes its code to fit with them instead of against them.

### 3.4 Before merging

The app test-combines active branches in the background and warns early: "your work and Yassine's will clash in 2 places." When a clash happens, the agent resolves it using both people's handoff notes, so it knows why each change was made. The person approves.

### 3.5 Someone disappears

A claim with no activity for a few days gets a question to its owner: "Still working on login?" No answer, and the claim fades and others are told the files are probably free.

### 3.6 Working on the same files often (research, 2026-10-08)

Research only, nothing built. Each point: what we have in the code today, how useful, how hard, and which step of section 7 it belongs to.

**1. Warn on the same part of a file, not just the same file.** Most same-file work merges cleanly in Git, so a file-level warning is often a false alarm.

- Have: claims are paths only. `teamPathsOverlap` (contracts `team.ts`) matches the same file or a folder and what is inside it; it knows nothing about lines. Each turn's diff (the checkpoint ref) knows which files changed, and Git can give the changed line ranges, but automatic notes keep only files and hashes (`TeamAutoNotes.ts`).
- Knowing the part in advance: (a) the agent names it: an optional `parts` per file in `team_plan` ("function login, the routes list"); cheap, early, but self-reported. (b) Use what is already written: once the holder has edits (pushed branch or turn diff), compare their changed line ranges and function names with the planned part. (c) `git merge-tree --write-tree` on the two branches says exactly whether they clash; this is 3.4's check and needs both sides to have edits. So: warn at file level at plan time (we cannot know better before code exists), but word it by what is known: "Sara changed `login()` in this file" when her diff is known, "Sara holds this file, no edits yet" when not; and lower it to a quiet mark once merge-tree says the two branches merge cleanly.
- Useful: high (the "no false alarms" rule). Hard: medium. Step 5 for (b) and (c); the `parts` hint can go in step 4.

**2. A "Shared files" list in `.team/rulebook.md`** (routes, config, global styles): files everyone appends to; no warnings for those.

- Have: the rulebook's "Do not touch" section is already parsed (`readDoNotTouchSection`, `rulebook.ts`) and shown in `team_status`. A "Shared files" section can use the same parser. `planFiles` and `claimAndSummarize` (`handlers.ts`) would skip holders on those paths; the claim is still recorded, so the markers can still show who is in there, quietly.
- Risk: a real clash in a shared file goes unwarned. 3.4's test-combine catches it before merging.
- Useful: high. Hard: low. Step 4.

**3. Stale view: an agent plans from its memory of a file that changed since.** At the start of each turn the agent is told which files it touched or planned changed since its last turn, by whom, and whether merged, and to re-read them.

- Have: the files a thread touched (each turn's diff), the files it planned (its claims and the `team.plan` activity), and other threads' automatic notes with file hashes and commits. Freshness (D7, `checkFreshness`) already compares a note's hashes with the caller's copy, but only inside `team_memory_search`. `lateOverlaps` tells an agent about new claims once, not about changed files. Nothing compares "my files" between my turns.
- Build: at turn start, for this thread's touched and planned files, compare the hash at the end of its last turn with the hash now (same checkout), and look for other threads' notes naming those files since then (worktrees: "Sara changed `login.ts`, not merged into your copy" or "merged into main"). It must be a separate line added only when something changed: the briefing is fixed text under 150 tokens, and Cursor, Grok and Antigravity add it to every message.
- Solo: solo chats share the checkout today (the built-in default is `local`; only `t3 team init` turns worktrees on), so one chat can change a file under another, and that chat's turn diff then shows the other chat's edits too. Should solo parallel chats get their own worktree by default? I would not make it the default for every chat: a worktree means the person merges their own chats, waits for setup scripts, and uses disk, which is a lot for one chat at a time. I would offer it at the moment it matters: when a chat starts while another chat of the same project is running or holds claims, the composer offers "Give this chat its own copy". Your call.
- Useful: high, solo and team. Hard: medium. Step 4.

**4. Breaks without file overlap** (a function renamed in one branch and still called in another).

- Have: nothing for 3.4 yet. `merge-tree` is not used anywhere in the server.
- Build: the background test-combine merges the active branches in a temporary worktree (`git merge-tree` first, which needs no checkout), then runs the project's typecheck and tests on the result. The command has to come from somewhere: a field in `t3.json` or the rulebook. It is heavy: dependencies to install, minutes of CPU on a laptop that already runs out of memory. So one at a time, only for branches that changed, when the machine is idle or on request.
- Useful: high, though rare. Hard: high. Step 5.

**5. Duplicate work in different files** (two people writing the same helper).

- Have: tasks with titles and notes; `team_status` lists open tasks; `team_plan` takes a `note`; keyword matching exists for memory search (`queryTerms`, `rankMemory` in `memory.ts`).
- Build, cheap: `team_plan`'s answer lists the other open tasks whose title matches the plan's note, or whose claims are in the same folders, and says "if one of these already does part of your task, tell the user". The agent judges better than keyword matching does. Richer later: "agents agree between themselves" (section 5).
- Useful: medium. Hard: low for the cheap version. Step 4.

**6. Merge order: suggest who merges first and update the other copy.**

- Have: linked pull requests per thread (`visibleThreadPullRequests`), merges seen from T3 and from GitHub (`TeamClaimAutoRelease`), merging from T3 (`PullRequestService`). "Wait" (3c) will already rebase a thread when the holder's claim is released.
- Build: when two branches overlap, suggest the one that is ready first (pull request open, checks green, smaller diff) and, after it merges, rebase the other with the same code as "Wait".
- Useful: medium. Hard: medium, mostly shared with Wait. Step 5.

**7. Someone working outside the app.**

- Can still see: anything pushed to GitHub: branches and their diffs against the base (a fetch), pull requests (`gh`), commits on main (freshness already compares files with the copy). Cannot see: unpushed edits, and no claims, since only the app makes them.
- Build: with step 5's fetch of active branches, show "a pushed branch changes this file" as a weaker mark, with the commit author's name, for branches no claim covers.
- Useful: medium (classmates who never install it). Hard: medium. Step 5.

**First two to build:** the "Shared files" list (2), because it cuts the false alarms the new warning card will raise, and it is small; then the stale-view line at turn start (3), because it helps every user, solo included, and uses data we already keep. Test-combine (4) is the most valuable of the rest, but it is step 5's main work.

### Rules

- Never block. Always inform and offer choices.
- No false alarms. One accurate warning beats ten useless ones.
- Visible everywhere: files someone else is working on show a small marker with their name in the file list.

## 4. How a team gets started (what the user sees)

1. **One person starts it.** Opens their project in the app, clicks "Make this a team project," gives it a name. The app creates `.team/` files and the `refs/t3-team/state` ref, and shows what it created before committing.
2. **Others join.** The starter adds them to the GitHub repo. A friend installs the app, opens the project (the app can clone it from GitHub), and is in.
3. **First session.** "Plan together?"
   - New project: describe the goal; the agent splits it into tasks that don't overlap and shows who could take what.
   - Existing project: the agent reads the code and writes a short summary and starting rules.
4. **Every day.** "Catch me up" shows what changed since you left and who is on what. You pick a task and work with your agent as usual.

## 5. Going further (after the core works)

- **Split the work before anyone starts.** The planner suggests tasks with no shared files.
- **Agents agree between themselves.** If two agents need the same new function, they decide who writes it and tell both people.
- **Live view.** See what every teammate's agent is doing right now.
- **Team language setting.** Shared notes are written in one team language, whatever language each person chats in.

## 6. What makes people actually use it

1. Install in 2 minutes, no terminal: download, open, sign in with Claude or ChatGPT.
2. Visible: a team screen and a clear warning card. Nothing important hidden inside chats.
3. **Great solo, not only with a team.** Without a team, team features stay out of the way, and one person still gets the useful parts: memory between chats, catch me up, handoff notes, notes that know when they are outdated, and overlap warnings between their own parallel chats. So the first person keeps it before friends join.
4. Never worse than plain Claude Code or Codex.
5. **Works perfectly as a native Windows app**, not only in WSL: paths, git and `gh`, shells, line endings and the installer all hold up on plain Windows. Audit and test plan: [WINDOWS_AND_SOLO.md](WINDOWS_AND_SOLO.md).

### 6.5 Token use (research, 2026-10-08)

Research only. Numbers are estimates (characters / 4, or / 3 for JSON), measured on our text and on the tool results of the 2026-10-08 live runs; no provider tokenizer was run.

**What the team layer adds**

| Part                   | Size                                                                                                                                                               | When                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Briefing               | about 120 tokens (team, usual names), 150 at most (longest names); solo about 126                                                                                  | Claude: once, in the system prompt. Codex: once, as a developer message. OpenCode: in each request's system addendum (same text). Cursor, Grok, Antigravity: **appended to every user message**. |
| 6 tool definitions     | 750 to 1,000 (name, description, input schema; no output schema is sent, since every result is a union)                                                            | Codex and the ACP agents: in the tool list of every request. Claude Code defers MCP tools: only the names (about 60) until it loads a tool with ToolSearch.                                      |
| A typical editing task | `team_status` 230 to 800 (grows with the team, capped lists), `team_plan` 200 to 330, `team_handoff` about 80 back plus 100 to 200 output tokens for its arguments | Once per task, then in history. Questions with no edit call nothing. Claude adds 1 to 3 small failed calls: it calls a deferred tool with `{}` before loading it.                                |

So, per message: about 120 to 150 tokens of briefing (cached for Claude, Codex and OpenCode; repeated in history for Cursor, Grok and Antigravity) plus the tool list (cached). Per editing task: about 700 to 1,600 input tokens and 150 to 300 output tokens.

**Does anything change per turn inside the cached part?** The text itself does not: names, rulebook path and solo text are fixed per thread, and live state comes only through tool results. One case does: the briefing lookup is skipped for a turn when it takes over 2 s or fails (`mcp/toolkits/team/briefing.ts`). Then OpenCode's system addendum changes and the whole cached prefix is missed for that request and the next one, Codex resends its `t3_code_runtime` entry twice (without, then with the briefing), and a Claude session that starts in that moment has no briefing at all. Fix: keep the last briefing per thread and reuse it when the lookup is slow or fails; only "not in a team" removes it. Smaller: on Codex the briefing shares the `t3_code_runtime` entry with model and effort, so switching model or effort resends it too; its own `additionalContext` key would not.

**Cheapest cuts that keep quality**, cheapest first:

1. Reuse the last briefing on a slow lookup (above). A few lines; fixes the only cache break.
2. Its own Codex key for the briefing. A few lines.
3. Briefing only on the first message of a Cursor, Grok or Antigravity session, and again after a resume. Saves about 130 tokens per message there. Risk: if an agent compacts its history without telling us, the briefing is gone until the next session.
4. Shorter results: `team_status` and `team_plan` return JSON objects with a key on every value, `null` fields and empty lists. One line per claim ("Sara: src/pins/search.ts, src/api/routes.ts, task tag filters, her copy, not merged") and no empty fields would cut them by about a third.
5. Check whether Codex or Claude Code shows the model both copies of each result: our MCP server sends the JSON as text and again as `structuredContent`. If one of them does, results cost double, and dropping `structuredContent` (we declare no output schema) halves them.
6. One call instead of two per task: let `team_plan` also return what `team_status` gives for the planned files (handoff notes on them, "Do not touch" hits), and brief the agent to call `team_status` only to look around. Saves 230 to 800 tokens and a round trip per task, but needs a live check that agents still read the team's state.

Not worth cutting: the tool descriptions (already under 40 words) and the tool count (Claude loads them on demand; for the others 6 tools are about 1,000 cached tokens).

## 7. Order of work

1. **Storage swap.** Done 2026-10-07 (slices 0 to 7 of [STORAGE_PLAN.md](STORAGE_PLAN.md)). Replace the local team database with the GitHub state ref (`refs/t3-team/state`) behind the same team service, so M1's tools, briefing, memory search and freshness keep working. Park the host-mode code (M2.2, M2.3) instead of deleting it; keep the upstream security fix.
2. **Two people, for real.** Done 2026-10-07 (slice 8, self-tested on GitHub with two dev servers). Two clones of one GitHub repo on one laptop, then two laptops. Claims, tasks, handoffs sync through `refs/t3-team/state`.
3. **Visible.** Team screen, file markers, the warning card from 3.1. Picked 2026-10-07: Option C (a Team home page, "Today" when solo, and the warning card inside the agent's message) with Option B's presence chip in the tab bar ([DESIGN_DIRECTION.md](DESIGN_DIRECTION.md) section 5). Build order: [UI_PLAN.md](UI_PLAN.md).
4. **Prevention.** Plan-first claim check (3.1) and pause-in-the-middle (3.2).
5. **Merging help.** Background clash check and note-aware conflict fixing (3.4).
6. **Installer.** Our own name, Windows installer, sign-in, "Make this a team project," joining.
7. **Classmates test** on a real group project. Fix what they hate.
8. **Launch.** 30-second demo video, one-page site, Reddit, X, Hacker News, Product Hunt.
