# Team layer design (v2)

Status: draft v2, 2026-09-30. Owner: Mouhssine. v1 written by Claude (chat). v2 updated by Claude Code from [team/CODE_FINDINGS.md](CODE_FINDINGS.md), reading the T3 Code source at commit 0f323ef5 (same upstream code as v1's a8e385e6).

Every claim about T3 Code below is marked **[checked]** (read in the code or docs) or **[verify]** (still needs checking in the code before we build on it). File and line references for most [checked] claims are in CODE_FINDINGS.md.

## What changed from v1

- D1: team calls are a separate HTTP API in our own files, not WebSocket RPCs. Members poll the host. Members never get `orchestration:read`.
- D2: a team is identified by `.team/team.json` with a `teamId`, not by `canonicalKey`.
- D3: our own migrator and `team_*` tables. Upstream's migration list is never touched.
- D4: a small, rarely changing team block (about 150 tokens), not the whole board.
- D5: five tools, no new MCP capability, membership checked when a tool is called. `team_decision_propose` dropped for now.
- D6: turn-diff claims are overlap detection, not prevention. Creating a team turns on worktrees.
- D9: cards keyed by thread, both PR link paths handled, `projectThreadAwareness()` reused.
- Section 4: realistic list of upstream files we edit.
- Section 6: v1 questions are answered; new [verify] items listed.

## 1. What we are building

T3 Code lets one person run real agents (Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity) from one app. We add a team layer so many people can work on the same Git repo at once:

- every agent knows the project rules, who is doing what, and its own task
- agents warn before two people touch the same files
- work can be handed from one person to another with its context
- nothing about normal single-person use gets worse

Non-goals for v1: our own editor, our own agent, replacing Git or pull requests, live co-typing in one file.

## 2. Facts from T3 Code that shape the design

- **One environment owns the work.** Each person runs their own T3 server (an "environment"). It owns their files, agents, Git and database. Environments do not share databases. [checked: docs/internals/remote.md, environment-auth.md]
- **Pairing grants scopes.** A pairing link gives a limited set of scopes. Every WebSocket RPC must declare one (a type error otherwise). HTTP routes check their scope by hand in each handler. [checked: auth/RpcAuthorization.ts, auth/http.ts]
- **`orchestration:read` can read any file the server account can read**, not only project files. So team members must never get it. [checked: docs/internals/environment-auth.md]
- **Making a pairing link needs `access:write` plus every scope being handed out.** An exchange can narrow scopes, never widen them. Links are one-time and expire in 5 minutes by default. Sessions last 30 days. [checked: environment-auth.md, PairingGrantStore.ts, SessionStore.ts]
- **Narrow grants already exist.** `t3 connect` issues a link with only `relay:write`. [checked: cli/connect.ts]
- **Remote reach exists for clients.** Direct network, Tailscale, SSH and T3 Connect all reach a server the same way. Server-to-server is new. [checked: docs/internals/remote.md]
- **The full client session needs `orchestration:read` to connect**, because it subscribes to server config first. A team-only token cannot use it. The smaller pieces (`bootstrapRemoteBearerSession`, `HttpApiClient`) already run in Node. [checked: client-runtime/rpc/session.ts, authorization/remote.ts, cli/project.ts]
- **A server already pushes per-thread state outward.** `AgentAwarenessRelay` listens to orchestration events and pushes with `HttpApiClient`. [checked: relay/AgentAwarenessRelay.ts]
- **Repos have an identity, but it is fragile.** `canonicalKey` comes from the `upstream` remote if there is one, else `origin`. Two clones of one repo can get different keys, and forks can share one. [checked: project/RepositoryIdentityResolver.ts]
- **Every agent gets a T3 tool server** named `t3-code`, with preview, device and pull request tools. [checked: mcp/McpHttpServer.ts]
- **Every agent sees every tool.** Tools are not hidden per thread. A tool that is not allowed returns an error when called. Allowed capabilities are fixed when the provider session starts. [checked: McpHttpServer.ts, McpSessionRegistry.ts, ProviderService.ts, McpHttpServer.test.ts]
- **A tool call knows its thread.** The call context has `environmentId` and `threadId`. The project and repo are looked up from the thread. [checked: mcp/McpInvocationContext.ts, toolkits/pullRequests/handlers.ts]
- **Every agent gets extra instructions**, but not the same way. `buildRuntimeInstructions()` takes no thread input. Claude gets it once per session. Codex gets it each turn but only resends when the text changes. Cursor, Grok and Antigravity add it to every user message. OpenCode sends it as a per-prompt system addendum. [checked: provider/RuntimeInstructions.ts and the six adapters]
- **T3 knows what each turn changed.** `thread.turn-diff-completed` fires after each turn from hidden Git checkpoints. There are also mid-turn placeholders with `status: "missing"` and no files. File `kind` is always `"modified"`. [checked: CheckpointReactor.ts, ProviderRuntimeIngestion.ts]
- **Server code can subscribe to orchestration events** with `subscribeDomainEvents`. [checked: OrchestrationEngine.ts, ThreadPullRequestReactor.ts]
- **Approvals only fire in modes that ask**, and the default mode is full access, which never asks. So they cannot be our main way to stop conflicts. [checked: ClaudeAdapter.ts, CodexSessionRuntime.ts, contracts orchestration.ts]
- **Worktrees are opt-in.** The built-in default is `"local"`. A repo can set `defaultThreadEnvMode` in its checked-in `t3.json`; a per-project setting overrides the file. [checked: contracts t3ProjectFile.ts]
- **The migrator skips any id at or below the highest one already run.** A shared id list with upstream is unsafe. The migrator accepts its own table name. [checked: persistence/Migrations.ts, effect sql Migrator.ts]
- **Upstream moves fast** (5 to 69 commits a day in late September) and does not run Windows tests in CI. We develop in WSL. [checked: git log, .github/workflows]

## 3. Decisions

### D1. The Brain is a T3 server in "team host" mode

One T3 environment on the team acts as the host. It stores team state and serves team calls. Other members' T3 servers connect to it server-to-server.

- **v1 host:** a teammate's computer (Option A). Reached over Tailscale, which T3 already supports. [checked]
- **Later:** the same thing on a small online server with `npx t3 serve`. No code change, only where it runs. [checked: `serve` command exists]
- **Rejected:** a separate Brain service. It would need its own auth, install and hosting.

**Team API.** The host serves a team HTTP API that lives in our own files. It is a separate API merged into the server's routes, not a new group inside upstream's `EnvironmentHttpApi` contract. [verify: that a separate `HttpApiBuilder.layer` can reuse `environmentAuthenticatedAuthLayer`] Every handler calls `requireEnvironmentScope("team:read")` or `requireEnvironmentScope("team:write")`, like `orchestration/http.ts` does. [checked: pattern] No WebSocket RPCs, so `WsRpcGroup` and `RpcAuthorization.ts` stay untouched.

**Scopes.** Two new scopes, `team:read` and `team:write`, are added to the scope list and to the administrator preset, so the host owner can hand them out. [checked: delegation rule] Members never get `orchestration:read` or any other upstream scope. They cannot see the host's files, threads or agents.

**Invites.** The host owner runs a command (for example `t3 team invite`) that makes a one-time pairing link with only `team:read` and `team:write`, like `t3 connect` does for `relay:write`. [checked: pattern] The link expires in 30 minutes by default, `--ttl` up to 24 hours (decided for M2, section 7.5; it was 5 minutes). The member pastes it into their own T3. Their server exchanges it with `bootstrapRemoteBearerSession` and stores the session locally. [checked: works in Node, used by desktop main]

**Sessions.** A member's session lasts 30 days. When it expires, team features show "re-invite needed" and the member asks for a new invite. No refresh flow in v1.

**Member → host.** The member's server has a small team client built on `HttpApiClient`. [checked: pattern] It copies the `AgentAwarenessRelay` pattern: listen to local orchestration events, turn them into team updates (claims, card status), push with retry.

**Host → member.** The member's server polls the host every 20 seconds for the board and any warnings, every 2 minutes while the host is offline (section 7.5). No push channel in v1.

**The host owner is a member too.** Their own server reads and writes team state directly, not over HTTP.

**When the host is offline:** everyone keeps working normally. Team features show "offline". Writes (claims, handoffs, card updates) wait in a local queue in the member's own `team_*` tables and send when the host is back. Rules and decisions still work, because they live in the repo (D3).

### D2. A team is one Git repo, identified by `.team/team.json`

The project repo holds `.team/team.json`:

```json
{ "teamId": "<random id made when the team is created>", "name": "Short team name" }
```

When a member opens a project whose `.team/team.json` has a `teamId` they joined, the team layer turns on for that project. Other projects are untouched.

- The host address is **not** in the repo. It comes from the invite and is stored on each member's server. Public repos should not carry a private Tailscale address.
- `canonicalKey` is only a sanity check. The host records the key when the team is created. If a member's project has the right `teamId` but a different key, the UI shows a warning. The team still works. [checked: key can differ between clones]
- A project with no git remote has no `canonicalKey`. That is fine, since the team does not depend on it. [checked: `repositoryIdentity` can be null]

### D3. Memory lives in three places

| What                  | Where                                                     | Why                                                                                                 |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Team identity         | `.team/team.json` in the project repo                     | Same `teamId` for everyone who clones the repo (D2).                                                |
| Rulebook              | `.team/rulebook.md` in the project repo                   | Changes go through Git and pull requests like code. Hard cap: 1,500 words.                          |
| Decisions             | `.team/decisions/NNNN-short-title.md` in the project repo | One short file per decision. Front matter lists files it is about and the commit it was written at. |
| Live state            | Host database, `team_*` tables                            | Members, active agents, claims, tasks, handoff notes, activity feed. Changes too often for Git.     |
| Member-side state     | Member's own database, `team_*` tables                    | Joined teams, host address, session, offline queue, last board snapshot.                            |
| Personal chat history | Each provider's own history, unchanged                    | Private. Only summaries get shared.                                                                 |

The `.team/` folder is in the user's project, not in our app's repo.

**Tables.** Team tables live in the same SQLite database as the rest of T3, all named `team_*`. They get their own migrator with its own tracking table, `team_sql_migrations`, started from our team layer. [checked: the migrator accepts a `table` option] A second migrator runs cleanly on the same `SqlClient` at startup, after upstream's. [checked in M1.1: `apps/server/src/team/TeamMigrations.ts`, its tests, and a real server start; see section 6] We never add to upstream's `migrationEntries` in `persistence/Migrations.ts`: any id we pick would clash with upstream's next one or make the migrator skip upstream's future migrations. [checked]

Decisions are written by people, or by agents with normal file edits. The rulebook template (`t3 team init`) shows the front matter: `title`, `author`, `date`, `files` (`[a, b]` or a `- ` list) and `commit`. All are optional; a file without front matter is still searched, with its first heading or file name as title, "unknown" author and date, and "unknown" freshness. [checked: built in M1.4] There is no decision tool in v1 (D5).

### D4. How memory reaches agents

A small team block, about 150 tokens, goes into the runtime instructions through a new optional input: `buildRuntimeInstructions({ ..., teamContext })`. When `teamContext` is missing, the output is exactly what it is today, so single-person use does not change.

The block holds only things that rarely change: the team, the member, and how to use the team tools. It says, in plain words:

1. "This project is in team "<name>". You are "<member name>"."
2. "Before editing files, call `team_status`, then `team_claim` the paths you will touch."
3. "If it reports overlaps, tell the user before editing those files."
4. "Write a `team_handoff` only after editing files or if the user stops work partway; keep claims unless the user drops it." (See "Claim lifetime" and "Handoffs only after work" in D5.)
5. "Project rules are in `.team/rulebook.md`; read it before your first change." (The path is relative to the thread's working folder, so a project in a repo subfolder gets `../../.team/rulebook.md`.)
6. "Code is the truth; team notes can be out of date."

Until the M1 wrap-up, item 4 said "When you finish or stop, write a `team_handoff`, but keep your claims: release them only if the user drops the work." Codex gets the block every turn and read "when you finish or stop" as every turn end: in the cold start test it wrote a handoff after question 2, with nothing changed. The new wording names the two cases. [checked: built in the M1 wrap-up; a test fails if the block says "when you finish" or "when you stop"]

v2 also put the thread's task title in the block. M1.3 dropped it: a task changes during a session, so it would go stale for Claude and cost tokens on every message for Cursor, Grok and Antigravity. The task comes from `team_status` and `team_task`. [checked: built in M1.3]

Names are cut to 60 characters, kept on one line, and stripped of `<`, `>`, `"` and backticks. A test fails if the block, with the longest names, goes over 150 tokens (estimated as the higher of 4 characters per token and 3/4 word per token). [checked: `apps/server/src/team/TeamBriefing.test.ts`]

The board, the task card, handoff notes and decisions come **only through tools** (D5), never pasted into the instructions.

**Why small and static:**

- Claude only gets the instructions at session start, so anything that changes would go stale. [checked]
- Cursor, Grok and Antigravity add the instructions to every user message, so every token stays in history for every turn. At 150 tokens that is about 7,500 tokens after 50 turns. A full board at 1,200 tokens would have been about 60,000. [checked]
- Codex only resends when the text changes, so static text is sent once. [checked]

**Plumbing.** v2 planned a per-thread map of team blocks that adapters read, like `McpProviderSession`. Nothing could fill that map before a session starts without editing `ProviderService.ts` (on the "do not edit" list), and a reactor on orchestration events would race the provider command reactor. So M1.3 turned it around: the team layer installs a resolver at startup (`TeamBriefingLive`, one `team-layer:` line in `server.ts`), and each adapter asks for the thread's block with `readTeamBriefing(threadId)` when it builds its instructions. That is one small `team-layer:` edit per adapter, plus a few lines in `CodexSessionRuntime.ts` and `CodexDeveloperInstructions.ts` for Codex. [checked: built in M1.3]

- The resolver uses the same thread → team lookup as the team tools (`mcp/toolkits/team/resolve.ts`), so the block appears exactly where the tools work. Neither registers a team (D5, since M2.1).
- No block when the provider session has no `t3-code` MCP server (the agent could not call the tools the block names), when the project is not in a team, or when this server is not a member.
- A failed or slow lookup (over 2 seconds) logs a warning and gives no block. It never holds up or breaks a turn.
- Without the resolver (tests, or a build without the team layer), `readTeamBriefing` gives nothing, and `buildRuntimeInstructions` returns exactly what it did before.
- When the block appears: Claude, once per session (a team made mid-session shows up in the next session). Codex, Cursor, Grok, Antigravity and OpenCode, on the next turn. Slash commands for Cursor, Grok and OpenCode native commands get no block, like the rest of the runtime instructions.

Later, if 150 tokens per turn is too much for Cursor, Grok and Antigravity, send the block only on the first turn for those three. [verify: whether they keep earlier user-message text in context across turns]

### D5. Team tools

A new toolkit at `apps/server/src/mcp/toolkits/team/`, built like `pullRequests/`. [checked: pattern]

| Tool                 | What it does                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `team_status`        | Returns the team board: who, what task, which paths, and the rulebook's "Do not touch" list.                                                                                                     |
| `team_claim`         | Claim paths (files or folders) with a short note. Returns any overlap with others' claims. `release: true` only for dropped work.                                                                |
| `team_task`          | Read this thread's task card, or update its status and note. With no card yet, pass a title to create one for this thread.                                                                       |
| `team_handoff`       | Save a handoff for this thread: what changed, what's left, risks. Max 150 words. The commit is filled in from the working folder. Only after editing files, or when the user stops work partway. |
| `team_memory_search` | Search decisions, handoffs and automatic notes by keywords. Top 5, short, each with a freshness mark and why (D7). M1.4.                                                                         |

`team_decision_propose` is dropped for now.

**No new MCP capability.** Every agent sees these five tools, the same way every agent sees the preview tools today. [checked] Each tool checks team membership **when it is called**: thread → project → working folder → `.team/team.json` → team and member. [checked: built in M1.2] Because the check happens at call time, a user who joins a team mid-session gets working tools without restarting the agent. This avoids edits to `McpInvocationContext.ts` and `ProviderService.ts`. [checked: capabilities are frozen at session start]

- **No team file:** a normal result, `{ inTeam: false, message }`, not an error, so the agent does not retry.
- **Team file, but the team is not in this server's database:** a normal result saying the team is hosted on another T3 server and to ask its host for an invite. Nothing is registered. Until M2.1 the server registered the team on first use and made itself owner, which would let a member's server own a team it only found in a cloned repo; now only `t3 team init` on the host registers (section 7.1, M2.1). [checked: built in M2.1]
- **Team known, but this server is not a member:** a normal "not a member" result.

**Files come from the thread's own checkout.** Any team file read or write (reading `.team/team.json` and `.team/rulebook.md`, checking decision freshness with Git) uses `thread.worktreePath` when it is set, else the project's workspace root. A worktree can be on a branch whose `.team/` differs from the main checkout. [checked: thread shell has `worktreePath`] If `.team/team.json` is not in that working folder, the tools look at the root of its Git repo, because `t3 team init` writes `.team/` at the repo root and a project can be a subfolder of a repo. [checked: built in M1.2]

**Paths.** Claims and handoff files are stored relative to the folder that holds `.team/`, with `/` separators. Agents often send full paths: a full path inside the project is turned into a project-relative one, a relative path is read from the working folder, and a path outside the project (or climbing out with `..`) is rejected with a message saying so. Windows drive letters and `\` work the same way.

**Claims show their task and where the work is.** Each claim in `team_status` and each overlap from `team_claim` shows who holds it, the task of the thread that made it (task title, or "no task"), so two chats of the same person can be told apart [checked: built in M1.3], and `where`: "their own copy; not merged into yours yet", or "same checkout as you" when the other thread works in the same folder (both in local mode). In worktree mode the other chat's files are in its own worktree until they merge, so the agent may not find them; `where` tells it why. The overlap message says the same once. [checked: built in the claim lifetime fix]

**Claim lifetime.** A claim lasts until the thread's work is merged or dropped, not until a turn ends. The M1.3 manual test showed why: an agent released its claims at the end of its turn, and a second chat then got no overlap warning for a file that was still unmerged in the first chat's worktree. So the briefing (D4) and the `team_claim` description tell agents to keep their claims when they finish and to release only if the user drops the work. The team layer releases claims itself (`apps/server/src/team/TeamClaimAutoRelease.ts`, one `team-layer:` line in `server.ts`):

| When                                                   | Event                                                                                       | Reliable in M1?                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Thread archived                                        | `thread.archived`                                                                           | Yes. [checked]                                                                             |
| Thread deleted (also each thread of a deleted project) | `thread.deleted` (`project.delete` deletes its threads first)                               | Yes. [checked: decider.ts]                                                                 |
| Linked pull request merged                             | `thread.pull-request-synced` with `snapshot.state === "merged"`                             | Yes, within about a minute, while this server runs and its git host login works. [checked] |
| Pull request merged from T3's own merge action         | `PullRequestService.subscribeMerges`, matched to the thread's linked or branch pull request | Yes, right away. [checked]                                                                 |
| Branch-only pull request merged outside T3             | none                                                                                        | **No.** See below.                                                                         |

- "Linked" means the thread's `pullRequests` list: made by T3's create-PR action, the agent's link tool, a manual link, or a native stack. The sync reactor stores their state and emits `thread.pull-request-synced`. [checked: PullRequestSyncReactor.ts]
- A pull request T3 only found from the thread's branch (`branchPullRequest`, for example one the agent opened with `gh pr create`) is stored as a reference with no state. No event says it merged. Only T3's own merge action announces it. So if that pull request is merged on GitHub, its claims stay until the thread is archived or deleted, or the user drops them. Fixing this means polling the git host for claimed threads' branch pull requests; not done, pending a decision.
- A merge releases the thread's claims only when none of its other linked pull requests is still open (a stack, or a follow-up pull request), and only claims made before the merge time, so a thread that carries on after its pull request merged keeps its new claims.
- A closed (not merged) pull request releases nothing: it can be reopened. Unarchiving a thread does not bring its claims back; the briefing tells its agent to claim again before editing.
- At startup the layer also releases claims of threads that are no longer active (archived or deleted while it was not listening). [checked: tests and a real server start]
- Every release writes an activity line, for example "Released Mouhssine's claims on src/login.ts: its pull request merged."

**Token cost.** Every agent in every project sees the tool list, so each tool description stays under 40 words (a test checks it). `team_status` is capped: 8 open tasks, 10 other threads' claims (5 paths each), 5 activity lines, newest first, with a count of what was left out. Done tasks are not listed. `team_memory_search` is capped at 5 results (5 files each, about 40 words of text each) and says how many more matched. `team_status` also shows at most 5 "Do not touch" items, 120 characters each. The briefing (D4) does not mention it: it is at about 148 of 150 tokens, and the tool's own description is enough for an agent to find it.

**Do not touch in `team_status`.** In the cold start test neither agent read `.team/rulebook.md` to answer a question, so both missed that `data/` is off limits. `team_status` now carries the rulebook's "Do not touch" list as `doNotTouch`, right after `team` and `you` (`apps/server/src/mcp/toolkits/team/rulebook.ts`). It reads the first heading named "Do not touch" (or "Don't touch"), at any level, until the next heading of the same or a higher level: one item per list item or paragraph, wrapped lines joined, code blocks skipped. At most 5 items of 120 characters; past that, the last item says how many more are in the rulebook, with its path from the agent's working folder. The template's example line ("Files or folders that need a human first.") is left out. No section, an empty one, no rulebook, a rulebook over 64 KB, or a failed read: no `doNotTouch` field, and `team_status` still works. The rest of the rulebook stays in the file; the briefing still asks agents to read it before their first change. [checked: built in the M1 wrap-up]

**Handoffs only after work.** The briefing and the `team_handoff` description ask for a handoff only after editing files or when the user stops work partway, "not after only answering questions". The server also checks: when a handoff names no files, the thread holds no claims, and it has no automatic note (D7: no turn of it changed files), the note is **saved** but the result carries a `message` saying the chat changed nothing and when to write one. Why warn instead of reject: the server cannot tell a junk note from a useful "looked into X, nothing to change" note, and rejecting would lose those. A reject-unless-confirmed flag would add a parameter that every agent sees, and agents would learn to pass it. The message corrects the agent in the same session, where the habit forms, and costs nothing on other calls. The cost of a junk note that still gets through is small: no files, so it is only found by keywords, and its freshness is "unknown: no files". Claims cover the first editing turn, whose automatic note is only written when the turn ends. [checked: built in the M1 wrap-up]

**Memory search (v1).** `team_memory_search` takes a query and searches the newest 200 handoff notes in the team database and up to 200 `.team/decisions/*.md` files (32 KB each at most) in the caller's own checkout (D5). Matching is simple: the query is split into lowercase words and paths, common stop words are dropped, and an entry's score is the number of distinct words found anywhere in its text, author or files. Results are ranked with handoffs and decisions before automatic notes (D7), then by score, then newest first (decisions with no date last). Each result says its kind (`handoff`, `automatic note` or `decision`), what it says, who wrote it, when, which files, its freshness with the reason (D7), and for decisions, the file. The message says that each mark compares the note with the files in the caller's copy now, and that code wins over notes. [checked: built in M1.4, kinds and reasons in M1.5] A smarter search (word stems, synonyms, embeddings, or SQLite full-text search) can replace the matching later without changing the tool.

### D6. Conflicts

Five layers, cheapest first:

1. **Split the work.** Tasks come with paths. (Planner UI comes after v1.)
2. **Claims (main early warning).** The team block (D4) tells agents to call `team_status` and `team_claim` before editing files, and to tell the user about overlaps before editing those. The claim returns overlaps right away, before any edit.
3. **Overlap detection from turn diffs.** On `thread.turn-diff-completed`, the member's server records every file the turn touched and checks it against others' claims. Overlap sends a warning to both people. This is detection after the fact, not prevention: the event fires after the turn ends, so both people may already have edited. [checked] Rules:
   - Only use events with `status: "ready"`. Mid-turn placeholders have `status: "missing"` and no files. [checked]
   - Treat every file as "touched". The event's `kind` is always `"modified"`, even for new or deleted files. [checked]
   - Works for every provider and every permission mode, because it does not rely on the agent obeying. [checked]
4. **Separate copies.** Each thread works on its own worktree and branch. Worktrees are opt-in in T3 (default `"local"`), so **creating a team turns them on**: `t3 team init` writes `.team/team.json` and sets `"defaultThreadEnvMode": "worktree"` in the project's `t3.json` (creating the file or adding the field, keeping everything else). It never commits; it tells the creator to review and commit the files. [checked: t3.json field exists; built in M1.1] A member's per-project setting can still override the file. [checked] If it is set to `"local"`, the team UI shows a notice, because in local mode a turn's diff also includes human edits and other threads' edits in the same checkout. [checked]
5. **Pull requests.** Git stays the final judge.

Later, not v1:

- Hard blocking through the approval layer for teams that want it.
- A dry-run merge check between teammates' pushed branches.
- **Research item:** mid-turn file-change events from providers, for warnings during a turn instead of after it. [verify: which providers emit them and what they contain]

### D7. Keeping memory fresh

- Every decision and handoff stores the files it is about and the commit it was written at. Handoffs also store each file's content hash (`git hash-object`) at that moment, or null for a file that did not exist; folders are not hashed. [checked: built in M1.4, own migration `2_TeamHandoffFileHashes`] Since M1.5 the content itself is also kept in the repo's Git objects (`hash-object -w`), so a later check can count the lines that changed. These objects are not referenced by any commit, so `git gc` prunes them after its grace period (two weeks by default); after that the reason just has no line counts. Hashing uses full paths, so a `.team/` in a repo subfolder works (M1.4 stored no hashes there; fixed in M1.5).
- **Why hashes, not only the commit:** agents usually write the handoff before committing, so the stored commit is the base commit, not the work. In the round 3 manual test, two of the three handoffs that named files stored the "team setup" commit while their files were uncommitted. With the commit alone, a new uncommitted file always looked fresh, an edited one always looked outdated, and another chat's copy could never be told it was "not merged yet". [checked: round 3 database]
- When `team_memory_search` returns a result, the server checks it in the caller's own checkout (the folder holding `.team/`, D5) and marks it. Every mark but "fresh" says why in plain words, because in round 4 an agent got "maybe outdated: src/login.ts changed since", guessed the mark meant "not committed", and told the user to commit to clear it:

| Mark             | Handoff with hashes                                                                                                                                                                                 | Decision, or older handoff (commit only)                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "fresh"          | Every hashed file has the same content as when the note was written.                                                                                                                                | The commit is in this copy's history and no listed file changed since it (uncommitted edits count). |
| "maybe outdated" | Some files differ, and the note's content did reach this copy: the note was written in this same checkout, or Git finds that content in `HEAD`'s history for that path (also after a squash merge). | The commit is in this copy's history and a listed file changed since.                               |
| "not merged yet" | Some files differ, and the note's content for one of them never reached this copy's history (another chat's uncommitted or unmerged work).                                                          | The commit is not in this copy's history, or this repo does not have it.                            |
| "unknown"        | No files; not a Git checkout; or any check failed or took over 5 seconds.                                                                                                                           | No files, no commit, not a Git checkout, or a check failed.                                         |

- The reasons, as the agent sees them [checked: built in M1.5, one test each]:
  - "maybe outdated: content of src/login.ts changed since this note was written (+1 -0 lines)". Several files: "content of a.ts (+2 -1 lines), b.ts (deleted), c.ts (new) +2 more changed since this note was written" (3 files at most). One file: "src/x.ts was deleted since this note was written", "src/x.ts is new since this note was written". Line counts come from the stored content and the file now; without the stored content (older notes, pruned objects, files over 256 KB, binary files) the counts are left out. Commit only: "content of src/db.ts changed since commit abc1234, when this was written (+1 -1 lines)", from `git diff --numstat`.
  - "not merged yet: this note's version of src/login.ts is not in your copy's history (another chat's uncommitted or unmerged work)"; commit only: "not merged yet: commit abc1234, which this was written at, is not in your copy's history", or "this repo does not have commit abc1234, which this was written at".
  - "unknown: the note names no files to check", "your folder is not a Git checkout", "no commit or file contents were stored to compare with", "the Git check failed or took too long".
- One failed check marks that result "unknown"; it never fails the search. [checked: tests]
- Limits we accept: a decision written before its code is committed shows "maybe outdated" once that code lands (it only has a commit). A file that did not exist when the note was written cannot be traced, so it counts as "maybe outdated" when it appears. If the noted content was changed again before it was ever committed, other copies will say "not merged yet" even after the later version merges. Notes from before M1.4 have no hashes and use the commit only.

**Automatic notes.** Agents forget to write handoffs (round 4: chat A wrote none until asked), so memory had gaps. On each `thread.turn-diff-completed` with `status: "ready"` and at least one file, the team layer (`apps/server/src/team/TeamAutoNotes.ts`, one `team-layer:` line in `server.ts`) saves an automatic note for that thread [checked: built in M1.5]:

- One per thread, updated in place: a row in `team_handoffs` with `automatic = 1` and a unique index on (team, environment, thread) where `automatic = 1` (own migration `3_TeamAutomaticNotes`). It can never pile up.
- It holds the files the thread changed across its turns (this turn's first, earlier ones kept, 50 at most), each file's content hash (stored, as above), `HEAD`, and the thread's task. Its time is its last update. Its text is fixed: "Automatic note, not written by the agent: this chat changed N files for task "<title>"."
- Turn diff paths are relative to the Git repo root; they are turned into paths relative to the folder holding `.team/`, and files outside it are dropped.
- It writes no activity line, so `team_status` stays readable.
- It is not the agent's handoff: no word cap applies, the 150-word cap of `team_handoff` counts only that handoff's own text, and a real handoff is a separate row it never touches.
- Search shows it with kind `automatic note`, below every matching handoff and decision, with a freshness mark like any handoff. So a second chat learns that chat A changed `src/login.ts` and that the change is "not merged yet", even if chat A wrote nothing.
- The same thread → team lookup as the tools (D5): nothing for projects outside a team. Any failure logs a warning and skips the note; it never affects the turn.
- In local mode a turn's diff also holds edits by people or other threads in the same checkout (D6), so the note can name files this thread did not write.

- Code always wins over memory. The briefing says so, and every search result message says "Code wins over notes."
- Later: a cleaner job after merges to main that merges duplicates and flags stale decisions for a human.

### D8. Proof: the cold start test

A test repo with a `.team/` folder and seeded host state. For each provider, open a fresh thread and ask:

1. What is this project?
2. Who is working on what right now?
3. Why did we choose X? (answer is in a decision file)
4. What is left on my task?
5. Which files should I avoid right now?

Pass = all 5 correct from a cold start. Manual in M1, scripted later.

**M1 result (2026-10-03): passed 5/5 with Claude (Sonnet 5) and with Codex (GPT-5.6-Luna).** Two problems, both fixed in the M1 wrap-up:

- Neither agent named `data/` for question 5 (the pass bar is the three claimed files; `data/` was for full marks). Neither read `.team/rulebook.md` to answer a question. `team_status` now includes the rulebook's "Do not touch" list (D5).
- Codex wrote a handoff after question 2 with nothing changed: "No code changes; reviewed the live team status for a progress update." The briefing's "when you finish or stop" read as every turn end. Reworded (D4), and the server now warns on such notes (D5, "Handoffs only after work").

**M1 setup (built in M1.5).** `apps/server/scripts/team-cold-start-seed.ts` builds `~/code/team-demo5` and seeds its team in `~/.t3-dev` through `TeamService`; the steps, exact questions and expected answers are in [team/COLD_START_TEST.md](COLD_START_TEST.md), outside the demo project. Two things M1 forces on the seed:

- The other chats belong to teammates (Sara and Omar) on their own servers. Claims of this server's threads that do not exist are released at startup (D5), so fake chats of your own would lose their claims on the next restart.
- "My task" is a task owned by you and not linked to any chat: a new chat has no task card of its own, so `team_task` says "no task yet", and the agent must find the task in `team_status` whose owner is "you". This is part of what the test checks.

The script refuses `~/.t3`, folders inside the t3code repo, and an existing folder it did not make; re-running it resets the team (fixed id) and rebuilds the demo repo.

### D9. The task board moves itself

A Kanban board (columns: To do, In progress, In review, Done) built on the same task cards agents read through `team_task` (D5). One source of truth for people and agents.

**Cards are linked to threads by thread id**, stored as environment id plus thread id, because thread ids belong to one environment. [checked: tool calls carry both] Not by branch name: branches start as random `t3code/<8 hex>` names and are renamed by a model after the first turn. [checked]

Cards move from real activity, not by hand. The member's server watches its own orchestration events and pushes card changes to the host (D1). [checked: events below exist]

- A thread starts on a card → **In progress** (`thread.session-set` with status `"running"`)
- A pull request is tied to the card's thread → **In review**. There are two ways this happens, and both count:
  - explicit link: `thread.pull-request-linked`
  - found from the thread's branch: `thread.meta-updated` with `branchPullRequest`
- The PR merges → **Done** (`thread.pull-request-synced` with `snapshot.state === "merged"`)
- The agent waits on an approval or a question, or keeps failing, for a set time → card turns red, owner gets told

For "running / waiting / failed" we reuse `projectThreadAwareness()` from `packages/shared/src/agentAwareness.ts`. It already turns a thread into one phase: `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `stale`. [checked]

Limits we accept in v1:

- Merge detection comes from T3's one-minute PR sweep on the member's own server, using that member's git host login. If their server is off, the host does not hear about the merge until it is back. [checked]
- Settled and archived threads are not swept for PR changes. [checked]

Each card shows its paths. Two cards touching the same paths are flagged on the board before anyone starts.

Smart features on top of the board, after v1:

- **Plan to cards.** Describe a feature, the planner splits it into cards with paths and flags overlaps between cards.
- **Waiting on.** Card B can wait for card A. When A merges, B's owner is told, and B's agent gets a catch-up note.
- **Auto standup.** A short daily summary per person, written from real activity.
- **Decisions from merges.** When a PR merges, the cleaner suggests decision notes for a human to approve.
- **GitHub Issues sync.** Cards can link to GitHub Issues both ways, so teams keep the tracker they already use.

## 4. How we keep upstream merges easy

- New code goes in new folders: `apps/server/src/mcp/toolkits/team/`, `apps/server/src/team/`, `packages/contracts/src/team.ts`, and a `team/` area in the web UI.
- Team state lives in its own `team_*` tables with its own migrator (D3), and its own services, outside the orchestration decider. We only read orchestration events; we do not add team events to the orchestration log.
- Edits to upstream files stay small and are marked `team-layer:`.
- Pull from upstream weekly, on its own branch, then merge.

**Upstream files we expect to edit:**

| File                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/provider/RuntimeInstructions.ts`                                                                                               | Optional `teamContext` input (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                                                                                              | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`                                                                                        | Pass the T3 thread id's `teamContext` down (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                     |
| `apps/server/src/provider/CodexDeveloperInstructions.ts`                                                                                        | Accept and forward `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                               |
| `apps/server/src/provider/Layers/CursorAdapter.ts`                                                                                              | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/provider/Layers/GrokAdapter.ts`                                                                                                | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/provider/Layers/OpenCodeAdapter.ts`                                                                                            | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/provider/Layers/AntigravityAdapter.ts`                                                                                         | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                                                                             |
| `apps/server/src/mcp/McpHttpServer.ts`                                                                                                          | Add the team toolkit to `layer` (D5). [checked: done in M1.2]                                                                                                                                                                                                                                                                                                |
| `apps/server/src/server.test.ts`                                                                                                                | Test only: provide a mocked `TeamService` to the routes layer, which now needs it for the team tools. [checked: done in M1.2]                                                                                                                                                                                                                                |
| Adapter tests: `ClaudeAdapter.test.ts`, `CursorAdapter.test.ts`, `GrokAdapter.test.ts`, `AntigravityAdapter.test.ts`, `OpenCodeAdapter.test.ts` | Test only: one appended team-briefing test each, marked `team-layer:` (D4). [checked: done in M1.3]                                                                                                                                                                                                                                                          |
| `packages/contracts/src/index.ts`                                                                                                               | `export * from "./team.ts"` and `"./teamHttp.ts"` lines for the team schemas and API. [checked: done in M1.1 and M2.2]                                                                                                                                                                                                                                       |
| `packages/contracts/src/auth.ts`                                                                                                                | Add `team:read`, `team:write`, and add them to `AuthAdministrativeScopes` (D1). [checked: done in M2.2]                                                                                                                                                                                                                                                      |
| `apps/server/src/ws.ts`                                                                                                                         | Scope check on three ChatGPT RPCs that skipped it, found by the S2 test (section 7.1 M2.2). [checked: done in M2.2]                                                                                                                                                                                                                                          |
| `apps/server/src/auth/EnvironmentAuth.test.ts`                                                                                                  | Test only: the administrative scope list gains `team:read`, `team:write`. [checked: done in M2.2]                                                                                                                                                                                                                                                            |
| `apps/server/src/server.ts`                                                                                                                     | Start the team layer: `TeamService.layer` in `RuntimeCoreDependenciesLive`, just above `PersistenceLayerLive` (D3), and `TeamBriefingLive`, `TeamClaimAutoReleaseLive` and `TeamAutoNotesLive` in `ReactorLayerLive` (D4, D5, D7). Later, merge the team HTTP API into the routes layer (D1). [checked: done in M1.1, M1.3, the claim lifetime fix and M1.5] |
| `apps/server/src/bin.ts`                                                                                                                        | Register `t3 team` in `makeCli`'s subcommand list (`init` now, `invite` in M2). [checked: done in M1.1]                                                                                                                                                                                                                                                      |
| Web UI entry points                                                                                                                             | Team screens (M3 and later). [verify]                                                                                                                                                                                                                                                                                                                        |

**Upstream files we do not edit:** `persistence/Migrations.ts`, `persistence/Layers/Sqlite.ts`, `WsRpcGroup` in contracts, `auth/RpcAuthorization.ts`, `mcp/McpInvocationContext.ts`, `provider/Layers/ProviderService.ts`, and `EnvironmentHttpApi` in `packages/contracts/src/environmentHttp.ts`.

## 5. Milestones

- **M1, solo (done 2026-10-03):** team tools, host mode on your own machine, `<team_context>` block through `teamContext`, handoff notes, `.team/` files (`team.json`, rulebook, decisions), own migrator and `team_*` tables, team creation that turns on worktrees. Pass the cold start test with Claude Code and Codex.
  - **M1.1, foundation (done 2026-09-30):** team schemas in contracts, own migrator and `team_*` tables, `TeamService` (teams, members, claims, tasks, handoffs, activity), `t3 team init`. No tools, networking or UI yet.
  - **M1.2, team tools (done 2026-09-30):** `team_status`, `team_claim` (with release), `team_task`, `team_handoff` in `apps/server/src/mcp/toolkits/team/`, with the call-time team check and registration (D5).
  - **M1.3, team briefing (done 2026-09-30):** the `teamContext` block in runtime instructions for all six providers (D4), and the task of each claim in `team_status` and `team_claim` (D5).
  - **Claim lifetime fix (done 2026-09-30):** claims last until the work merges or is dropped; auto-release on merge, archive and delete; `where` on claims (D5).
  - **M1.4, memory search (done 2026-10-01):** `team_memory_search` over handoffs and `.team/decisions/`, keyword ranking, and freshness marks from file hashes and commits (D5, D7).
  - **M1.5, cold start (built 2026-10-01; test passed 5/5 with Claude Sonnet 5 and Codex GPT-5.6-Luna, 2026-10-03):** plain reasons on freshness marks and automatic notes per thread (D7, from the round 4 manual test); the cold start seed script and questions (D8).
  - **M1 wrap-up (done 2026-10-03):** from the cold start test: handoffs only after edits or stopped work (briefing, tool description, a warning on notes from chats that changed nothing), and the rulebook's "Do not touch" list in `team_status` (D4, D5, D8).
- **M2, two people (planned 2026-10-03, in progress):** team HTTP API, `team:read` / `team:write` scopes, `t3 team invite`, member join with `bootstrapRemoteBearerSession`, member push (AgentAwarenessRelay pattern) and 20 second polling, offline queue. Test with one friend over Tailscale. Slices M2.0 to M2.10, security checks, the two-server test setup and decisions: section 7.
  - **M2.0, test bench, and M2.1, only the host registers a team (done 2026-10-03):** `apps/server/scripts/team-two-person-setup.ts`; `t3 team init --base-dir` registers, `t3 team status`, no registration on first use. Manual tests: [team/M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md).
  - **M2.2, scopes and the team API skeleton (done 2026-10-03):** `team:read` / `team:write`, `TeamHttpApi` mounted next to the environment API, the member guard, and the security tests against a real server; they found and fixed three upstream RPCs that skipped their scope check.
- **M3, conflicts:** overlap detection from turn diffs, overlap warnings, team board in the UI.
- **M4, team features:** the self-moving task board (D9), catch me up, handoff UI, then guide mode.
- **Later:** mid-turn file-change warnings (research first), plan to cards, waiting on, auto standup, decisions from merges, GitHub Issues sync, phone approvals, shared skills, usage per person, online host, own name, open source launch.

## 6. Open questions before building

The 9 questions from v1 are answered in [team/CODE_FINDINGS.md](CODE_FINDINGS.md). Still open, each marked [verify] above:

1. Can a separate `HttpApiBuilder.layer` for the team API reuse `environmentAuthenticatedAuthLayer` and be merged into `makeRoutesLayer` in `server.ts`? (D1) **Answered in M2.2: yes**, with no change to the middleware (section 7.1 M2.2). [checked]
2. Do Cursor, Grok and Antigravity keep earlier user-message text in context, so the team block could be sent only on the first turn? (D4)
3. Which providers emit mid-turn file-change events, and what do they contain? (D6 research item)
4. Which web UI files are the entry points for team screens? (Section 4)
5. Should the team layer poll the git host for claimed threads' branch-only pull requests, so a merge made outside T3 releases their claims? (D5, claim lifetime)

### Answered in M1.1

**Does a second migrator run cleanly on the same `SqlClient`, after upstream's?** Yes.

- `apps/server/src/team/TeamMigrations.ts` calls the same `Migrator` with `table: "team_sql_migrations"`. The table name is an option of the migrator's run call, not of `Migrator.make`.
- `TeamService` runs it when the service is built. It asks for the `SqlClient` from the SQLite persistence layer, and that layer finishes upstream's migrations before it hands the client out. So team migrations always run second.
- Tests (`apps/server/src/team/TeamMigrations.test.ts`): team migrations run and record only in their own table; running them again does nothing; with upstream migrated to an older id, then team migrations, then a newer upstream, every newer upstream migration still runs; running team migrations first leaves all of upstream's to run.
- A real server start against a scratch home dir logged upstream's "Migrations ran successfully" at 16:50:50.676 and "Team migrations ran successfully" at 16:50:51.110. `team_sql_migrations` held `1 TeamCore`, and `effect_sql_migrations` held ids 1-54 only. A second start ran neither.

**Where does the team layer start, and which file registers CLI subcommands?**

- The team layer starts in `apps/server/src/server.ts`, as one `Layer.provideMerge(TeamService.layer)` in `RuntimeCoreDependenciesLive`, just above `Layer.provideMerge(PersistenceLayerLive)`. That placement gives it the persistence layer's `SqlClient` (after upstream's migrations), and makes `TeamService` available to the layers above it, including the MCP toolkit we add in M1.2. `OrchestrationReactor.ts` was not needed: the service is storage, not a reactor. Where M3's turn-diff reactor starts is still to be decided then.
- CLI subcommands are registered in `apps/server/src/bin.ts`, in the `Command.withSubcommands([...])` list inside `makeCli`.

## 7. M2 plan: a second person

Status: plan, 2026-10-03. M2.0, M2.1 and M2.2 are built (2026-10-03); the rest is not. Based on D1 and CODE_FINDINGS.md, plus a new read of the auth code (marked [checked] with the file). Decisions on the open questions are in 7.5. Manual tests per slice: [team/M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md).

**Goal.** Two people, each with their own T3 server, work on one repo as one team. One server is the host (D1). The other joins with an invite, reads and writes team state on the host over the team HTTP API, and keeps working when the host is off. A member can reach team data and nothing else on the host.

**One rule that keeps it simple.** A team's rows (`team_teams`, `team_members`, claims, tasks, handoffs, activity) exist only on its host. A member's server never has a row in `team_teams` for a team it joined; it has a link to the host, a cached board, and an outbox, in three new member-side tables. So "this server has the team row" means "this server hosts it", and the team layer picks local or remote per team from that. One server can host team A and be a member of team B.

### 7.1 Slices

Each slice ends with a commit, a push, a PROGRESS.md entry, and a manual test you can run. The order matters: M2.1 closes the "member makes itself owner" hole before any member exists, and M2.2 lands the security tests before any data endpoint does.

**M2.0 Test bench (done 2026-10-03).** No feature code.

- `apps/server/scripts/team-two-person-setup.ts` makes `<demo>-remote.git` (bare), `<demo>-host` (the Pinboard demo app, then `t3 team init --base-dir <host home>`, committed and pushed) and `<demo>-member` (a clone made after the push). Defaults: `--demo ~/code/team-demo6`, `--host-home ~/.t3-dev`, `--member-home ~/.t3-dev-member`, `--name` from the folder ("Demo team 6"). It runs the real `t3 team init` as a child process, so the bench also exercises M2.1. [checked: built]
- Safe to re-run: each folder it makes holds a marker file (`.t3-team-two-person-setup`, in `.git/` for clones), and a re-run deletes only marked folders, plus the old team's rows in the host's database (read from the old host clone's `.team/team.json`). It refuses folders it did not make, anything inside the t3code repo, the real T3 home (`~/.t3`), and the same home for host and member. It never touches the member's home. Every check runs before anything is deleted. [checked: scratch runs of each refusal, and a re-run that removed the old team's rows]
- The Pinboard app and the Git helpers moved from the cold start seed to `apps/server/scripts/teamDemoRepo.ts`, shared by both scripts. [checked: the seed still builds its demo against a scratch home]
- Two dev servers from one checkout: [checked 2026-10-03] with the host's `vp run dev --home-dir ~/.t3-dev` running, `T3CODE_PORT_OFFSET=20 vp run dev --home-dir ~/.t3-dev-member` started on exactly 13793/5753 (`[dev-runner] mode=dev source=T3CODE_PORT_OFFSET=20 serverPort=13793 webPort=5753`), each answered `/.well-known/t3/environment` with its own environment id, directly and through its web port's proxy, and the host kept running. Both servers run `node --watch` on the same source, so editing server code restarts both. On this 8 GB laptop, two dev servers plus a typecheck ran out of memory (`tsc` was killed); stop the member server before typechecking.
- A CLI writing `state.sqlite` while the server runs: [checked 2026-10-03] the setup script's `t3 team init --base-dir ~/.t3-dev` registered Demo team 6 while the host dev server ran on that home; the server kept serving with the same process. SQLite runs in WAL mode with a 5 second busy timeout (`persistence/Layers/Sqlite.ts`).
- Manual test: [team/M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md), M2.0. Session cookie names include a hash of the state folder (`apps/server/src/auth/utils.ts:25`, checked), so the two web UIs should not log each other out; the manual test is what checks it in a browser.

**M2.1 Only the host registers a team (done 2026-10-03).** The D5 fix for "a member's server must not make itself owner".

- `t3 team init <path> --base-dir <home>` registers the team in that home's database, with that server's environment id (the same `environment-id` file the server uses, created the same way if missing) and its name (the server's own label) as owner, and records the repo's `canonicalKey` when it has one. Registration runs after every file check and before any write (`initTeamProject`'s `register` step, `apps/server/src/team/TeamProjectFiles.ts`), so a refused or failed registration writes nothing. Running it again changes nothing and says "Already hosted by the T3 home at …". [checked: built, tests in `apps/server/src/cli/team.test.ts`]
- When `.team/team.json` already existed and the home has no row for it (a clone), init writes and registers nothing and fails with: "This repo is already team "Demo team 6", and the T3 home at … does not host it. Its host is another T3 server: ask the host for an invite. Nothing was written or registered." Taking over hosting is `t3 team host --adopt` (decision 1 in 7.5, not built). This also covers a repo that M1's `t3 team init` set up but no chat ever used: it has no row, so init refuses it the same way; `--adopt` will be the way out.
- `--base-dir` is required for now (decision 10): without it, init and status refuse with a message that says they would otherwise use the real install. [checked: test]
- `t3 team status --base-dir <home>` lists the teams that home hosts, with members and roles, or says it hosts none. A home with no database yet says so and gets no database. Member links are added in M2.4. [checked: tests]
- The tool and briefing lookup (`resolve.ts`) no longer calls `ensureTeam`, and no longer needs `ServerEnvironment`. A team file with no team row gives a normal not-in-team result: "This project is in team Demo team 6, which is hosted on another T3 server. This server has not joined it, so team tools do nothing here. To join, ask the team's host for an invite." It does not name `t3 team join` yet, because the command does not exist until M2.4. Briefing and automatic notes use the same lookup, so they skip such projects too. [checked: tests]
- The cold start seed registers through `TeamService` and keeps working. Teams registered on first use in M1 keep their rows, so they stay hosted where they are.
- Tests: every tool, called from a project whose team file has no row on a fresh in-memory database, returns the hosted-elsewhere result, and every `team_*` table (listed from `sqlite_master`, so later tables are covered) stays empty; the briefing gives no block and registers nothing; init on a fresh repo registers one team and one owner; init twice keeps one of each; init on a clone with a fresh home refuses, writes no file, and leaves every team table empty; status on an empty home. The tool, briefing and automatic-note tests now register the team first, as `t3 team init` does.
- Manual test: [team/M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md), M2.1.

**M2.2 Scopes and the team API skeleton (host) (done 2026-10-03).**

- `packages/contracts/src/auth.ts`: `team:read` and `team:write`, in `AuthEnvironmentScope` and in `AuthAdministrativeScopes` only, never in `AuthStandardClientScopes`. `team:write` alone does not imply `team:read`. The token endpoint keeps its own fixed list of the 8 upstream names, so no client can ask for a team scope there; a team session only comes from a pairing link that holds them. The owner's own new sessions (startup pairing URL, desktop) now carry both. [checked: built, `EnvironmentAuth.test.ts` updated, `security.test.ts`]
- A separate API in our files: `packages/contracts/src/teamHttp.ts` (`TeamHttpApi`, paths under `/api/team/v1/`) and `apps/server/src/team/http/` (`routes.ts`, `guard.ts`, `TeamSessionMembers.ts`). Mounted in `makeRoutesLayer` with `environmentAuthenticatedAuthLayer`, one `team-layer:` line in `server.ts` plus its import. A second `HttpApiBuilder.layer` shares the session middleware with no change (section 6 question 1). [checked: both dev servers answer `/api/team/v1/me` with 401 and no token]
- `/api/` paths are already proxied by the web dev server (`packages/shared/src/devProxy.ts:11`, checked), so team calls work against the dev port.
- The guard, `requireTeamMember(scope, teamId?)` in `guard.ts`, is the first call of every handler: the scope (`EnvironmentScopeRequiredError`, 403), then the member bound to the session (`TeamMembershipRequiredError` with `not_a_member` or `member_removed`, 403), then, when the path names a team, that it is the member's team (`other_team`, 403). A failed lookup is a 500, never access. The lookup is `TeamSessionMembers.findBySession`; until `/join` binds sessions (M2.3) it finds no one, so every team endpoint answers 403 `not_a_member`, the admin's own session included.
- Endpoints: `GET /api/team/v1/me` (your member row and team) and `GET /api/team/v1/teams/:teamId/board`, a placeholder (`placeholder: true`) that exercises the path team check until the board read lands in M2.5. Neither returns team data to anyone yet.
- Security tests (section 7.2) in `apps/server/src/team/http/security.test.ts`, against a real server process on a temp home (real routes, real `EnvironmentAuth`, real handlers). The team-only session comes from a pairing link with exactly `[team:read, team:write]`, exchanged at `/oauth/token` without asking for scopes: the way M2.3 and M2.4 will make one. Built: S1, S2 (all three parts), S3 (import rule, forged asset and upload URLs), S4 (`/mcp`), S5 (all but the invite's pairing row, M2.3), S7 (route listing), the guard on every team endpoint (no token 401, standard session 403 scope, team and admin sessions 403 `not_a_member`), and S12 groundwork (the server output and log files never hold the credential or the token). Guard paths no session can reach yet (member found, removed, other team, failed lookup) are unit tests in `guard.test.ts`.
- **Upstream hole found by S2 and fixed:** `chatGptReconnectProfile`, `chatGptImportProfile` and `chatGptHandoffSubscribe` were the only RPCs whose handlers skipped the scope check `RPC_REQUIRED_SCOPES` declares (`orchestration:operate`), so any session could call them: read the host's saved ChatGPT registration and its ID token hint, replace the host's ChatGPT credentials with another valid profile, or start a sign-in flow on the host. `ws.ts` now wraps the three in `authorizeEffect` / `authorizeStream`, marked `team-layer:` (no extra tracing). Before the fix the RPC walk failed on exactly these three; after it, all 148 RPCs are refused with a scope error. This affects upstream too, for any session without `orchestration:operate`.
- Dev runs: upstream's web mode adds the server's working folder as a project on every start, so `vp run dev` added `apps/server` as a project called "server". A gitignored repo-root `.env.local` with `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0` turns it off; the dev runner loads that file (`scripts/lib/public-config.ts`). [checked: a server-only dev run on a scratch home with the file made no project; the same run with the setting forced on made "server" at `apps/server`]
- Manual test: [team/M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md), M2.2.

**M2.3 `t3 team invite` and the join endpoint (host).**

- New table `team_invites` (own migration 4): invite id, team, member name, created by, pairing link id, created, expires, used at, used by session, revoked at. There is no role column: every invite makes a `member`.
- `t3 team invite --name Sara [--ttl 30m] [--tailscale] [--member Sara]` (default 30 minutes, `--ttl` at most 24 hours, decision 2) makes a one-time pairing link through `EnvironmentAuth.createPairingLink` in the CLI process, the way `t3 pair` does (`apps/server/src/cli/pair.ts:436`, checked), with scopes exactly `[team:read, team:write]`, subject `team-invite:<invite id>`, and label "Team <team>: Sara". It prints the invite URL once (same URL builder as `t3 pair`) with its expiry. The URL is never logged and never written to the repo. `--member` re-invites an existing member (M2.9).
- `POST /api/team/v1/join` (`team:write`). The host reads the invite id from the session's subject (the session keeps the grant's subject, `EnvironmentAuth.ts:816`, checked), creates the member row with role `member` and the invite's name, stores the member's environment id from the request, binds the session id to the member, and marks the invite used. The same session calling again gets the same member. Rejected: a subject that is not a team invite, an invite already used by another session, a revoked invite, a removed team.
- `t3 team invites [--revoke <id>]` lists pending, used and expired invites; revoke also revokes the pairing link.
- Manual test: `t3 team invite --name Sara --ttl 2m --base-dir ~/.t3-dev` prints a URL and "expires at HH:MM". `t3 team invites` shows it pending; after 2 minutes, expired. A new invite, revoked, shows revoked.

**M2.4 `t3 team join` (member).**

- `t3 team join <invite URL> --base-dir ~/.t3-dev-member`: exchanges the credential with `bootstrapRemoteBearerSession` **without** asking for scopes (the token endpoint only accepts the 8 upstream scope names, `apps/server/src/auth/http.ts`, checked; with no request the session gets the link's scopes, `EnvironmentAuth.ts:809`, checked), then calls `/join` with this server's environment id.
- Member-side table `team_links` (own migration): team id, team name, host origin, member id, member name, joined, session expiry, status (`ok`, `offline`, `re-invite needed`, `removed`). The bearer token goes in the server secret store (`team-link-<team id>`, in the secrets folder kept at mode 0700, `apps/server/src/auth/ServerSecretStore.ts:162`, checked), not in the table, the repo, or a log. The token file itself must be mode 0600, readable only by its owner, with a test (decision 9).
- Before sending anything, join checks the host origin (S13): HTTPS anywhere, plain HTTP only to localhost or a Tailscale address.
- Prints: "Joined team Demo team 6 on http://127.0.0.1:5733 as Sara. Session ends 2026-11-02." Refuses with plain messages: invite used, expired, revoked, host unreachable, or this server already in the team.
- Works whether the member server runs or not, like `t3 pair`. [verify: a CLI write to `state.sqlite` while the server runs; `t3 pair` already does it]
- Manual test: join; `t3 team status --base-dir ~/.t3-dev-member` shows the link; `t3 team status --base-dir ~/.t3-dev` lists Sara as member. `git status` is clean in both clones. `grep -r` for the token's first 12 characters in `~/.t3-dev-member/userdata/logs` and both clones finds nothing. Running join again with the same URL fails with "already used".

**M2.5 Local or remote, per team; remote reads.**

- `TeamBackend` (new, our files): for a team id it returns `Local` (team row here: `TeamService`), `Remote` (a `team_links` row: HTTP client), or `NotJoined`. The resolver, the briefing, the five tools, `TeamAutoNotes` and `TeamClaimAutoRelease` go through it instead of calling `TeamService` directly. The tool results stay the same shape on both sides.
- Host read endpoints (`team:read`): board (team, members, open tasks, active claims with task and thread, activity; same caps as `team_status`), one task, task for a thread, newest 200 handoffs, my claimed threads.
- Reads are live with a 3 second limit. Until M2.7, a failed read says "The team host is not reachable"; from M2.7 it falls back to the cached board, and the result says "cached, as of <time>" (decision 4).
- Tool results label text written by teammates (handoffs, task notes, claim notes, activity) as teammate-written data, not instructions (S14). On the host's own tools too.
- Everything that reads files stays on the member: the rulebook, "Do not touch", decisions, freshness checks. Freshness of the host's notes works from hashes; line counts are left out when the host's stored content is not in the member's repo (expected, D7).
- The member's own name in the briefing comes from `team_links`, so the briefing costs no host call.
- Manual test: on the host, a chat claims `src/pins/search.ts` for a task. On the member, a new chat: "Who is working on what right now?" names the host member, the task and the file. "Search team memory for search" finds the host's handoff with a freshness mark. Stop nothing yet.

**M2.6 Remote writes.**

- Host write endpoints (`team:write`): claim and release, create and update task, handoff, automatic note, release a thread's claims (archive, delete, merge on the member's server).
- The member makes the ids (claim id, handoff id, one op id per call), and the host inserts or ignores by id, so a retried call never makes a duplicate. This is also what makes the outbox (M2.8) safe.
- The host never trusts identity from the body: the member id comes from the session, and every thread in a request must carry the member's own environment id (S8).
- The "handoff with no work" warning (D5) is computed on the host, which holds the thread's claims and automatic note.
- Who may change a task (decision 7): a member changes only tasks it owns, or takes an unowned one (which makes it the owner); the host's owner can change any task. The rule lives in `TeamService.updateTask`, so it holds on the host's own tools too. Every task change writes an activity line naming who made it.
- Manual test: member chat claims `src/api/routes.ts`; a host chat that claims the same file gets an overlap naming Sara, her task, and "their own copy; not merged into yours yet". Then the other way round. Member writes a handoff; the host's memory search shows it as "not merged yet" until the member pushes and the host pulls, then "fresh". Archive the member chat: within a few seconds its claims are gone from the host's `team_status`.

**M2.7 Polling and the board cache (member).**

- Every 20 seconds per linked team (decision 5), the member server fetches the board into `team_board_cache` and records the link state: last success, `offline` after 2 failed polls, `re-invite needed` on 401, `removed` on a removed-member 403. Offline backs off to every 2 minutes and returns to 20 seconds on success.
- Tools read live and fall back to the cache; the result says "cached, as of 14:02" (decision 4). With no cache, they say the host is unreachable.
- `t3 team status` on the member shows each link's state, last sync, session expiry and outbox size.
- Manual test: stop the host. Within a minute `t3 team status --base-dir ~/.t3-dev-member` says offline; a member chat's `team_status` answers from the cache with "as of". Start the host; the link is `ok` again within about 40 seconds.

**M2.8 Offline queue (member).**

- Member-side `team_outbox` (own migration): op id, team, kind, payload, created, attempts, last error. Every write in M2.6 goes through it: it is saved first, then sent right away if online. The poller flushes it in order, oldest first, per team.
- A 400 or 403 for one op: drop that op, keep a line in `t3 team status` and the server log. A 401: stop flushing and mark `re-invite needed`; nothing is dropped.
- A claim made offline is saved, and the result tells the agent plainly (decision 6): the team host is offline; the claim is not confirmed yet and is sent when the host is back; overlaps are unknown until then. It may add what the cached board (as of 14:02) shows, labelled as cached. Overlaps found when it is delivered show up on the board as usual (warnings to people are M3).
- Cap: 1,000 ops or 7 days per team; past that, the oldest are dropped with a log line (decision 6).
- Manual test: stop the host. In a member chat, claim `src/pins/tags.ts`, then make an edit (automatic note) and write a handoff. `t3 team status` shows 3 queued. Restart the member server: still 3. Start the host: within about 40 seconds the host's `team_status` shows the claim and memory search finds the handoff, each once.

**M2.9 Member lifecycle.**

- `t3 team remove Sara` (host): marks the member removed, revokes her sessions (`EnvironmentAuth.revokeSession`, checked), releases her claims, writes an activity line. Her handoffs stay, with her name.
- Re-invite after the 30-day session ends, or after a remove: `t3 team invite --member Sara` binds the new session to the same member row and revokes the old session. No refresh flow (D1).
- `t3 team leave` (member): best effort tells the host, then deletes the link, the token and the outbox locally.
- Manual test: remove Sara; her next chat's `team_status` says "removed from team Demo team 6" and her `t3 team status` shows `removed`. Re-invite and join: she is back with the same name, and her old handoffs are still hers.

**M2.10 A friend over Tailscale.**

- The friend runs this fork (same commit, from source) with their own home folder. Both machines are on one tailnet.
- Host: `t3 team invite --name <friend> --tailscale`, which reuses `t3 pair --tailscale`'s Tailscale Serve setup (`apps/server/src/cli/pair.ts`, checked) so the URL is the host's MagicDNS name. Send the URL over a private chat; it is one-time and expires.
- The team repo is a private GitHub repo shared with the friend; the friend clones it and adds it in T3.
- Run the manual tests of M2.5 to M2.9 across the two machines, plus the manual security checks in 7.2.
- Pass: both agents see each other's claims and handoffs, overlaps are reported both ways, a host restart loses nothing, and every manual security check is refused.

### 7.2 Security: what a member must not reach

A member holds a bearer session with `team:read` and `team:write` on the host. It must reach team data for its own team and nothing else. Each item says how it is blocked and which test proves it. Automated tests live next to the team API (`apps/server/src/team/http/security.test.ts`) and run against the real routes layer with a real `EnvironmentAuth`, not mocks of the scope check.

**S1. A member token on any non-team HTTP route.**

- Blocked by: `EnvironmentHttpApi` handlers check an upstream scope by hand (checked for `orchestration/http.ts`, `pullRequest/http.ts`, the relay handlers in `cloud/http.ts`, and `pairingCredential` in `auth/http.ts`; the other auth admin routes are what the test below proves). Raw routes check too: the OTLP proxy needs `orchestration:operate`, the device hub proxy `orchestration:read` or `operate` (`http.ts`, `device/DeviceHubProxy.ts`, checked).
- Test: for **every endpoint of `EnvironmentHttpApi`**, listed from the API definition at test time (so a new upstream endpoint is covered without editing the test), call it with a team-only token and expect 401 or 403. Allow-list, checked by name: `/api/auth/session` (says what the token can do), `/oauth/token`, the descriptor, the browser-session exchange. Plus the raw routes: OTLP, device hub, asset, attachment upload, `/mcp`.
- Also: the cloud `health` and `mintCredential` handlers have no session check; they verify cloud-signed payloads instead. [checked in M2.2: with a team token and a made-up payload, `health`, `mintCredential` and `t3MintCredential` answer 500 on a server with no cloud link; the test requires 4xx or 5xx]
- Built in M2.2 (`security.test.ts`): the walk sends each endpoint a valid payload generated from its schema (`effect/unstable/arbitrary`), so a refusal is the scope check, not a decode error. Also `webSocketTicket` (200, decision 8), the raw routes (OTLP and device hub 401/403; forged asset and upload URLs 404). `/mcp`: S4. A control shows an admin token gets 200 from routes the team token is refused.

**S2. A member token on WebSocket RPCs.**

- Blocked by: any session can get a WebSocket ticket (`auth/http.ts`, `webSocketTicket`, checked), but every RPC needs a scope from `RPC_REQUIRED_SCOPES`, and a missing entry is a type error (`auth/RpcAuthorization.ts`, checked). None of them is a team scope.
- Tests: (a) no value in `RPC_REQUIRED_SCOPES` is `team:*`; (b) open `/ws` with a team-only ticket and call every RPC of `WsRpcGroup`, listed at test time, with a payload generated from its schema: each fails with `EnvironmentAuthorizationError` naming an upstream scope; (c) the socket sends nothing in the 2 seconds before the first RPC. If (c) fails, block tickets for team-only sessions (decision 8).
- [checked in M2.2: (a), (b) and (c) pass. (c) passing keeps decision 8: tickets stay allowed. (b) first failed on three RPCs whose handlers skipped the check, `chatGptReconnectProfile`, `chatGptImportProfile` and `chatGptHandoffSubscribe`; fixed in `ws.ts`, see 7.1 M2.2.]

**S3. Reading files on the host.**

- Blocked by: file access goes through `orchestration:read` (RPCs and `getTurnDiff`), or through asset URLs that are signed and expire (`assets/AssetAccess.ts:723`, checked) and are only made by orchestration calls. The team API never reads the host's disk: paths in requests are stored as text and never opened.
- Tests: an import test fails if any file under `apps/server/src/team/http/` imports `FileSystem`, Git or VCS services, `ProjectionSnapshotQuery`, orchestration, terminal or provider modules. Claims with `/etc/passwd`, `../x`, `C:\x` or a NUL byte are rejected with 400 (same rules as D5 paths). An asset URL with a forged or expired signature gives 404.
- [checked in M2.2: the import test (also `node:fs`, workspace and checkpoint modules) and the forged asset and upload URLs. The claim path rejections land with the claim endpoint, M2.6.]

**S4. Starting or seeing threads, agents or terminals.**

- Blocked by: `dispatchCommand` needs `orchestration:operate`, the snapshot and shell need `orchestration:read`, terminals `terminal:operate`. `/mcp` takes only per-thread MCP tokens, not environment sessions (`mcp/McpHttpServer.ts:85`, checked). The team board shows thread ids, task titles and paths only; an id without `orchestration:read` opens nothing.
- Tests: in S1 and S2. Plus a team token sent as `Authorization: Bearer` to `/mcp` gets 401, and a board response has no thread title, message, path to a worktree, or branch.
- [checked in M2.2: `/mcp` 401. The board check lands with the board, M2.5.]

**S5. Getting `orchestration:read` or any other upstream scope.**

- Blocked by: making a pairing link needs `access:write` plus every scope handed out (`auth/http.ts`, `pairingCredential`, checked). An exchange can only narrow (`EnvironmentAuth.ts:809`, checked). `t3 team invite` always passes exactly the two team scopes and has no scope flag. Team scopes are only in the administrative preset.
- Tests: a team token calling `/api/auth/pairing-token` for any scopes, including only team ones, gets 403. Exchanging a team invite while asking for `orchestration:read` fails. The pairing link row behind every invite holds exactly `[team:read, team:write]`. `AuthStandardClientScopes` has no team scope.
- [checked in M2.2: all but the invite's pairing row, which needs `t3 team invite` (M2.3). Also: asking the token endpoint for `team:read` gets 400 (it accepts only the 8 upstream names, which is why join asks for none), and a used team credential gets 401.]

**S6. Reusing an invite: used, expired, or revoked.**

- Blocked by: pairing links are consumed once and checked for expiry (`auth/PairingGrantStore.ts`, `consume`, checked). On top, `team_invites` binds an invite to one session.
- Tests: a second exchange of the same link fails; an exchange after the TTL (test clock) fails; an exchange after `t3 team invites --revoke` fails; `/join` from a second session whose subject names an already used invite gets 403; `/join` again from the same session returns the same member and makes no second row.

**S7. A member making itself owner, or an admin.**

- Blocked by: no API sets a role. `/join` has no role field and always makes `member`. `ensureTeam` and member management are not reachable over HTTP; `t3 team remove` and `t3 team invite` run on the host only. M2.1 removes registration on first use, so a member's server never creates the team locally either. A member editing its own database changes only its own server: the host is the source of truth.
- Tests: `/join` with `role: "owner"` in the body is rejected (unknown fields fail decoding) or ignored, and the row is `member` either way; there is no route for roles, members or invites in `TeamHttpApi` (checked by listing the API) [checked: built in M2.2]; a cloned repo on a fresh server never gets a `team_teams` row, from the tools, the briefing or `t3 team init` [checked: built in M2.1, `handlers.test.ts`, `briefing.test.ts`, `cli/team.test.ts`].

**S8. Acting as another member.**

- Blocked by: the member comes from the session binding, never from the body. Every thread in a request must have the member's own environment id.
- Also: a member changes only tasks it owns or takes an unowned one; only the host's owner changes any task (decision 7).
- Tests: member A releasing B's claim, writing a handoff or automatic note for B's thread, or claiming under B's thread gets 403 and changes nothing. A body with B's member id is rejected or ignored. A updating B's task gets 403; A taking an unowned task becomes its owner; the host's owner can update both; each change writes an activity line naming who made it.

**S9. Reading or writing another team on the same host.**

- Blocked by: the guard checks that the team in the path is the session's member's team.
- Test: a host with two teams; a member of team X calling every endpoint with team Y's id gets 403.

**S10. A removed member or an old session.**

- Blocked by: `t3 team remove` revokes the sessions (401 after), and the guard also checks the member row is not removed (403 even if a session were missed). An expired session (30 days, `auth/SessionStore.ts:423`, checked) gives 401.
- Tests: after remove, the old token gets 401 on every team endpoint; with the session left in place but the member row removed, 403; after a re-invite, the old session gets 401 and the new one works.

**S11. Flooding the host.**

- Blocked by: request body limit (64 KB), per-request caps (50 paths, 150-word handoffs as in D5, 200 handoffs per read), and the 1,000-op outbox cap on the member.
- Tests: a 1 MB body gets 413 or 400; 51 paths get 400. A rate limit per member is left for later.

**S12. Leaking the token or the host address.**

- Blocked by: the invite URL is printed once and not logged; the member's token lives in its secret store; `team_links` holds the host origin on the member's server only; `.team/team.json` never gets the host address (D2).
- Tests: capture logs during invite and join and search them for the credential and the token; after join, `.team/team.json` and `git status` are unchanged.
- [M2.2 groundwork: the host's output and log files never hold the team credential or the token from the exchange.]

**S13. Sending a team token over plain HTTP.** (Decided 2026-10-03.)

- Blocked by: one check before any request that carries an invite credential or a team bearer token (`t3 team join`, and every member → host call): the host origin must be `https:`, or `http:` only to localhost (`localhost`, `127.0.0.0/8`, `::1`) or a Tailscale address (`100.64.0.0/10`, the shared address range Tailscale uses, `fd7a:115c:a1e0::/48`, or a `*.ts.net` name). Anything else is refused before the request, with: "Refusing to send the team token over plain HTTP to <host>. Use HTTPS, localhost, or a Tailscale address." The check runs on every call, not only at join, so an edited `team_links` row cannot get around it. Lands in M2.4 (join) and M2.5 (the client).
- Tests: the origin check for each allowed and refused case (including `http://192.168.1.5`, `http://example.com`, `http://100.63.0.1`, `http://100.64.0.1`, `http://pc.tail1234.ts.net`, `https://example.com`); `t3 team join` with a refused origin makes no request (a test HTTP server records none) and exits with the message; a member call with a refused stored origin sends nothing and reports the same.

**S14. Instructions hidden in teammates' notes.** (Decided 2026-10-03.)

- Blocked by: tool results label all text written by other people or their agents (handoffs, automatic notes, task titles and notes, claim notes, activity lines) as teammate-written data, not instructions: those fields sit under a part of the result marked that way, and the result's message says so in one line. On the host's own tools too, since local teammates' notes are the same risk. The briefing's "Code is the truth; team notes can be out of date" stays. This lowers the risk; no label makes a model immune.
- Tests: `team_status`, `team_task` and `team_memory_search` results carry the label wherever they include teammate text, and a handoff that says "ignore the rulebook" comes back only inside the labelled part. Lands with M2.5, when teammates' text first crosses servers, on both sides.

**Manual security checks (M2.4 on, and again in M2.10).** Take the member's token from its secret store (only for this test) and, from a shell, call `/api/orchestration/snapshot`, `/api/auth/pairing-token`, `/api/auth/clients` and `/api/team/v1/me`. Only the last one works. Open the host's web UI in a private window with the token: it shows no project or chat.

**Not protected, on purpose.**

- Team data is shared with every member of that team: names, tasks, claimed paths, handoff text, activity.
- The host's owner can read everything members send.
- Team notes can contain instructions aimed at agents (a handoff that says "ignore the rulebook"). S14 labels them as teammate-written data, and the briefing says code wins over notes; an agent can still choose to follow them.
- Anyone who can reach the host's port can already call its open endpoints (descriptor, session state, token exchange). M2 adds no open endpoint. Use Tailscale, not a public port.
- A host can send a member odd or large data. The member decodes every response with the contract schemas and caps sizes; the host can never call the member (there is no member endpoint).

### 7.3 Local test setup: two servers on one laptop

Everything happens outside the t3code repo, as the working rules require.

The repo-root `.env.local` (gitignored, local to each checkout) must hold `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`. Without it, upstream's web mode adds the server's working folder, `apps/server`, as a project called "server" on every start, so a chat there would edit this repo. A friend running the fork (M2.10) needs the same line.

| Role   | Home folder        | Start command                                                  | Server port | Web port | Project clone              |
| ------ | ------------------ | -------------------------------------------------------------- | ----------- | -------- | -------------------------- |
| Host   | `~/.t3-dev`        | `vp run dev --home-dir ~/.t3-dev`                              | 13773       | 5733     | `~/code/team-demo6-host`   |
| Member | `~/.t3-dev-member` | `T3CODE_PORT_OFFSET=20 vp run dev --home-dir ~/.t3-dev-member` | 13793       | 5753     | `~/code/team-demo6-member` |

Shared remote: a bare repo at `~/code/team-demo6-remote.git`. Both clones have it as `origin`, so they also get the same `canonicalKey` (D2 sanity check).

Steps (M2.0's script, `node apps/server/scripts/team-two-person-setup.ts`, does steps 1 and 2):

1. `git init --bare ~/code/team-demo6-remote.git`, then clone it to `~/code/team-demo6-host` and put a small demo app in it (like the Pinboard app of the cold start test). Commit and push.
2. On the host clone: `node apps/server/src/bin.ts team init ~/code/team-demo6-host --name "Demo team 6" --base-dir ~/.t3-dev` (from M2.1 this also registers the team on the host). Commit `.team/` and `t3.json`, push. Clone the remote to `~/code/team-demo6-member`.
3. Start both servers (two terminals, table above). The member's home is new, so pair the browser with it once and add `~/code/team-demo6-member` as a project. On the host, add `~/code/team-demo6-host`.
4. Host: `node apps/server/src/bin.ts team invite --name Sara --base-dir ~/.t3-dev`. Member: `node apps/server/src/bin.ts team join '<URL>' --base-dir ~/.t3-dev-member`.
5. Run each slice's manual test. To share code between the two, push from one clone and pull in the other, as two people would.

Notes:

- The invite URL uses the host's web dev port (5733), like `t3 pair` does in dev (`pair.ts:137`, checked); the dev proxy forwards `/api/` and `/oauth/` to the server.
- The ports in the table are the expected ones, and M2.0 got exactly those with the host running [checked 2026-10-03]. The dev runner moves to the next free offset when a port is taken (`findFirstAvailableOffset`, `scripts/dev-runner.ts:575`, checked), so read the ports it prints.
- Each new round uses a new demo (`--demo ~/code/team-demo7`, then 8...), as the working rules say. Re-running the setup script resets a demo it made, including the old team's rows in the host's database.
- The cold start demo (`team-demo5`) stays in `~/.t3-dev` and keeps working; it is hosted there.

**Later: a friend over Tailscale (M2.10).** The friend runs the fork with their own home folder (any path outside the repo). The host runs `t3 team invite --tailscale`; the friend runs `t3 team join`. The demo repo moves to a private GitHub repo. Only after M2.1 to M2.9 pass locally.

### 7.4 Upstream files M2 edits

- `packages/contracts/src/auth.ts`: two scope literals, and the administrative preset (M2.2). Already in section 4.
- `apps/server/src/server.ts`: mount the team API, and start the member poller in `ReactorLayerLive` (M2.2, M2.7). One `team-layer:` line each. [checked: mount done in M2.2, plus its import]
- `apps/server/src/ws.ts`: the scope check on three ChatGPT RPCs that skipped it (M2.2, a security fix found by S2). [checked: done]
- `apps/server/src/auth/EnvironmentAuth.test.ts`: test only, the administrative session's scope list gains the two team scopes (M2.2). [checked: done]
- Maybe `apps/web/src/components/settings/ConnectionsSettings.tsx`: its list of scope titles does not know team scopes, so a member's session in the host's Connections list may show no scope summary. [verify in M2.3; a label is a small `team-layer:` edit, or we leave it]
- Maybe `apps/server/src/auth/http.ts`: only if S2 (c) fails (decision 8).

Not edited: `EnvironmentHttpApi`, `WsRpcGroup`, `RpcAuthorization.ts`, `persistence/Migrations.ts`.

### 7.5 Decisions for M2

The nine open questions of the plan, answered by the developer on 2026-10-03, plus one more. Where a slice above depends on one, it says "decision N".

1. **Taking over hosting a team that already has `.team/team.json`** (the host lost its database, or the team moves): only with an explicit `t3 team host --adopt` on that machine, which registers the team with this server as owner and warns that every member must be invited again. Never automatic. Not built yet; `t3 team init` refuses such a repo (M2.1).
2. **Invite lifetime:** 30 minutes by default, `--ttl` up to 24 hours, one-time, revocable (M2.3). D1 said 5 minutes.
3. **Who names the member:** the host, with `t3 team invite --name Sara`. The member cannot pick a name. Renaming is a host command, later.
4. **Live reads or cache:** tools read the host live with a 3 second limit and fall back to the cached board; a result from the cache says "cached, as of <time>" (M2.5, M2.7).
5. **Poll interval:** 20 seconds, 2 minutes while the host is offline (M2.7).
6. **Offline claims:** saved in the outbox and sent later, not refused. The result tells the agent plainly that the host is offline, the claim is not confirmed, and overlaps are unknown (M2.8). Cap: 1,000 ops or 7 days per team.
7. **Who may change a task (changed from the recommendation):** a member changes only its own tasks, or takes an unowned one; only the host's owner can change any task. Every change records who made it in the activity feed (M2.6, S8). Only the host's owner removes members (M2.9).
8. **WebSocket tickets for team-only sessions:** allowed, unless S2's test shows the socket sends anything before the first RPC; then tickets are blocked for sessions with only team scopes (one `team-layer:` line in `auth/http.ts`).
9. **Where the member's token lives:** the server secret store, not `state.sqlite`, so a database copy shared for debugging never carries it. The token file is mode 0600, readable only by its owner, with a test (M2.4).
10. **`--base-dir` for `t3 team` commands:** required for now, so a test never registers a team in the real install. [checked: built in M2.1]

Security additions decided the same day: S13 (no team token over plain HTTP, except to localhost or a Tailscale address) and S14 (teammate-written text labelled as data, not instructions), in 7.2.
