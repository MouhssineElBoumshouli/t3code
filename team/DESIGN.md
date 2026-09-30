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

**Invites.** The host owner runs a command (for example `t3 team invite`) that makes a one-time pairing link with only `team:read` and `team:write`, like `t3 connect` does for `relay:write`. [checked: pattern] The link expires in 5 minutes, so it is meant to be used right away. The member pastes it into their own T3. Their server exchanges it with `bootstrapRemoteBearerSession` and stores the session locally. [checked: works in Node, used by desktop main]

**Sessions.** A member's session lasts 30 days. When it expires, team features show "re-invite needed" and the member asks for a new invite. No refresh flow in v1.

**Member → host.** The member's server has a small team client built on `HttpApiClient`. [checked: pattern] It copies the `AgentAwarenessRelay` pattern: listen to local orchestration events, turn them into team updates (claims, card status), push with retry.

**Host → member.** The member's server polls the host every 15 to 30 seconds for the board and any warnings. No push channel in v1.

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

Decisions are written by people, or by agents with normal file edits. The rulebook explains the format. There is no decision tool in v1 (D5).

### D4. How memory reaches agents

A small team block, about 150 tokens, goes into the runtime instructions through a new optional input: `buildRuntimeInstructions({ ..., teamContext })`. When `teamContext` is missing, the output is exactly what it is today, so single-person use does not change.

The block holds only things that rarely change: the team, the member, and how to use the team tools. It says, in plain words:

1. "This project is in team "<name>". You are "<member name>"."
2. "Before editing files, call `team_status`, then `team_claim` the paths you will touch."
3. "If `team_claim` reports overlaps, tell the user before editing those files."
4. "When you finish or stop, write a `team_handoff`."
5. "Project rules are in `.team/rulebook.md`; read it before your first change." (The path is relative to the thread's working folder, so a project in a repo subfolder gets `../../.team/rulebook.md`.)
6. "Code is the truth; team notes can be out of date."

v2 also put the thread's task title in the block. M1.3 dropped it: a task changes during a session, so it would go stale for Claude and cost tokens on every message for Cursor, Grok and Antigravity. The task comes from `team_status` and `team_task`. [checked: built in M1.3]

Names are cut to 60 characters, kept on one line, and stripped of `<`, `>`, `"` and backticks. A test fails if the block, with the longest names, goes over 150 tokens (estimated as the higher of 4 characters per token and 3/4 word per token). [checked: `apps/server/src/team/TeamBriefing.test.ts`]

The board, the task card, handoff notes and decisions come **only through tools** (D5), never pasted into the instructions.

**Why small and static:**

- Claude only gets the instructions at session start, so anything that changes would go stale. [checked]
- Cursor, Grok and Antigravity add the instructions to every user message, so every token stays in history for every turn. At 150 tokens that is about 7,500 tokens after 50 turns. A full board at 1,200 tokens would have been about 60,000. [checked]
- Codex only resends when the text changes, so static text is sent once. [checked]

**Plumbing.** v2 planned a per-thread map of team blocks that adapters read, like `McpProviderSession`. Nothing could fill that map before a session starts without editing `ProviderService.ts` (on the "do not edit" list), and a reactor on orchestration events would race the provider command reactor. So M1.3 turned it around: the team layer installs a resolver at startup (`TeamBriefingLive`, one `team-layer:` line in `server.ts`), and each adapter asks for the thread's block with `readTeamBriefing(threadId)` when it builds its instructions. That is one small `team-layer:` edit per adapter, plus a few lines in `CodexSessionRuntime.ts` and `CodexDeveloperInstructions.ts` for Codex. [checked: built in M1.3]

- The resolver uses the same thread → team lookup as the team tools (`mcp/toolkits/team/resolve.ts`), so the block appears exactly where the tools work, and it registers the team on first use the same way (D5).
- No block when the provider session has no `t3-code` MCP server (the agent could not call the tools the block names), when the project is not in a team, or when this server is not a member.
- A failed or slow lookup (over 2 seconds) logs a warning and gives no block. It never holds up or breaks a turn.
- Without the resolver (tests, or a build without the team layer), `readTeamBriefing` gives nothing, and `buildRuntimeInstructions` returns exactly what it did before.
- When the block appears: Claude, once per session (a team made mid-session shows up in the next session). Codex, Cursor, Grok, Antigravity and OpenCode, on the next turn. Slash commands for Cursor, Grok and OpenCode native commands get no block, like the rest of the runtime instructions.

Later, if 150 tokens per turn is too much for Cursor, Grok and Antigravity, send the block only on the first turn for those three. [verify: whether they keep earlier user-message text in context across turns]

### D5. Team tools

A new toolkit at `apps/server/src/mcp/toolkits/team/`, built like `pullRequests/`. [checked: pattern]

| Tool                 | What it does                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `team_status`        | Returns the team board: who, what task, which paths.                                                                              |
| `team_claim`         | Claim paths (files or folders) with a short note, or release them with `release: true`. Returns any overlap with others' claims.  |
| `team_task`          | Read this thread's task card, or update its status and note. With no card yet, pass a title to create one for this thread.        |
| `team_handoff`       | Save a handoff for this thread: what changed, what's left, risks. Max 150 words. The commit is filled in from the working folder. |
| `team_memory_search` | Search decisions and handoffs. Returns the top 3 to 5, short, each marked fresh or maybe-outdated (D7). Comes in M1.4.            |

`team_decision_propose` is dropped for now.

**No new MCP capability.** Every agent sees these five tools, the same way every agent sees the preview tools today. [checked] Each tool checks team membership **when it is called**: thread → project → working folder → `.team/team.json` → team and member. [checked: built in M1.2] Because the check happens at call time, a user who joins a team mid-session gets working tools without restarting the agent. This avoids edits to `McpInvocationContext.ts` and `ProviderService.ts`. [checked: capabilities are frozen at session start]

- **No team file:** a normal result, `{ inTeam: false, message }`, not an error, so the agent does not retry.
- **Team file, but the team is not in this server's database:** the server registers the team and adds itself as owner (`ensureTeam`). Right for M1, where every team lives on the owner's own server. **M2 must narrow this** to host mode: a member's server must not make itself owner of a team it only found in a cloned repo.
- **Team known, but this server is not a member:** a normal "not a member" result.

**Files come from the thread's own checkout.** Any team file read or write (reading `.team/team.json` and `.team/rulebook.md`, checking decision freshness with Git) uses `thread.worktreePath` when it is set, else the project's workspace root. A worktree can be on a branch whose `.team/` differs from the main checkout. [checked: thread shell has `worktreePath`] If `.team/team.json` is not in that working folder, the tools look at the root of its Git repo, because `t3 team init` writes `.team/` at the repo root and a project can be a subfolder of a repo. [checked: built in M1.2]

**Paths.** Claims and handoff files are stored relative to the folder that holds `.team/`, with `/` separators. Agents often send full paths: a full path inside the project is turned into a project-relative one, a relative path is read from the working folder, and a path outside the project (or climbing out with `..`) is rejected with a message saying so. Windows drive letters and `\` work the same way.

**Claims show their task.** Each claim in `team_status` and each overlap from `team_claim` shows who holds it and the task of the thread that made it (task title, or "no task"), so two chats of the same person can be told apart. [checked: built in M1.3]

**Token cost.** Every agent in every project sees the tool list, so each tool description stays under 40 words (a test checks it). `team_status` is capped: 8 open tasks, 10 other threads' claims (5 paths each), 5 activity lines, newest first, with a count of what was left out. Done tasks are not listed.

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

- Every decision and handoff stores the files it is about and the commit it was written at.
- When `team_memory_search` returns it, the server checks whether those files changed since that commit, in the thread's own checkout (D5). If yes, it is marked "maybe outdated: files changed since".
- Code always wins over memory. Instructions say so.
- Later: a cleaner job after merges to main that merges duplicates and flags stale decisions for a human.

### D8. Proof: the cold start test

A test repo with a `.team/` folder and seeded host state. For each provider, open a fresh thread and ask:

1. What is this project?
2. Who is working on what right now?
3. Why did we choose X? (answer is in a decision file)
4. What is left on my task?
5. Which files should I avoid right now?

Pass = all 5 correct from a cold start. Manual in M1, scripted later.

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

| File                                                                                                                                            | Why                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/provider/RuntimeInstructions.ts`                                                                                               | Optional `teamContext` input (D4). [checked: done in M1.3]                                                                                                                                                                                                         |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                                                                                              | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`                                                                                        | Pass the T3 thread id's `teamContext` down (D4). [checked: done in M1.3]                                                                                                                                                                                           |
| `apps/server/src/provider/CodexDeveloperInstructions.ts`                                                                                        | Accept and forward `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                     |
| `apps/server/src/provider/Layers/CursorAdapter.ts`                                                                                              | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/GrokAdapter.ts`                                                                                                | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/OpenCodeAdapter.ts`                                                                                            | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/AntigravityAdapter.ts`                                                                                         | Pass `teamContext` (D4). [checked: done in M1.3]                                                                                                                                                                                                                   |
| `apps/server/src/mcp/McpHttpServer.ts`                                                                                                          | Add the team toolkit to `layer` (D5). [checked: done in M1.2]                                                                                                                                                                                                      |
| `apps/server/src/server.test.ts`                                                                                                                | Test only: provide a mocked `TeamService` to the routes layer, which now needs it for the team tools. [checked: done in M1.2]                                                                                                                                      |
| Adapter tests: `ClaudeAdapter.test.ts`, `CursorAdapter.test.ts`, `GrokAdapter.test.ts`, `AntigravityAdapter.test.ts`, `OpenCodeAdapter.test.ts` | Test only: one appended team-briefing test each, marked `team-layer:` (D4). [checked: done in M1.3]                                                                                                                                                                |
| `packages/contracts/src/index.ts`                                                                                                               | One `export * from "./team.ts"` line for the team schemas. [checked: done in M1.1]                                                                                                                                                                                 |
| `packages/contracts/src/auth.ts`                                                                                                                | Add `team:read`, `team:write`, and add them to `AuthAdministrativeScopes` (D1). [checked]                                                                                                                                                                          |
| `apps/server/src/server.ts`                                                                                                                     | Start the team layer: `TeamService.layer` in `RuntimeCoreDependenciesLive`, just above `PersistenceLayerLive` (D3), and `TeamBriefingLive` in `ReactorLayerLive` (D4). Later, merge the team HTTP API into the routes layer (D1). [checked: done in M1.1 and M1.3] |
| `apps/server/src/bin.ts`                                                                                                                        | Register `t3 team` in `makeCli`'s subcommand list (`init` now, `invite` in M2). [checked: done in M1.1]                                                                                                                                                            |
| Web UI entry points                                                                                                                             | Team screens (M3 and later). [verify]                                                                                                                                                                                                                              |

**Upstream files we do not edit:** `persistence/Migrations.ts`, `persistence/Layers/Sqlite.ts`, `WsRpcGroup` in contracts, `auth/RpcAuthorization.ts`, `mcp/McpInvocationContext.ts`, `provider/Layers/ProviderService.ts`, and `EnvironmentHttpApi` in `packages/contracts/src/environmentHttp.ts`.

## 5. Milestones

- **M1, solo:** team tools, host mode on your own machine, `<team_context>` block through `teamContext`, handoff notes, `.team/` files (`team.json`, rulebook, decisions), own migrator and `team_*` tables, team creation that turns on worktrees. Pass the cold start test with Claude Code and Codex.
  - **M1.1, foundation (done 2026-09-30):** team schemas in contracts, own migrator and `team_*` tables, `TeamService` (teams, members, claims, tasks, handoffs, activity), `t3 team init`. No tools, networking or UI yet.
  - **M1.2, team tools (done 2026-09-30):** `team_status`, `team_claim` (with release), `team_task`, `team_handoff` in `apps/server/src/mcp/toolkits/team/`, with the call-time team check and registration (D5).
  - **M1.3, team briefing (done 2026-09-30):** the `teamContext` block in runtime instructions for all six providers (D4), and the task of each claim in `team_status` and `team_claim` (D5).
  - **M1.4:** `team_memory_search` and freshness marks (D5, D7).
- **M2, two people:** team HTTP API, `team:read` / `team:write` scopes, `t3 team invite`, member join with `bootstrapRemoteBearerSession`, member push (AgentAwarenessRelay pattern) and 15-30 second polling, offline queue. Test with one friend over Tailscale.
- **M3, conflicts:** overlap detection from turn diffs, overlap warnings, team board in the UI.
- **M4, team features:** the self-moving task board (D9), catch me up, handoff UI, then guide mode.
- **Later:** mid-turn file-change warnings (research first), plan to cards, waiting on, auto standup, decisions from merges, GitHub Issues sync, phone approvals, shared skills, usage per person, online host, own name, open source launch.

## 6. Open questions before building

The 9 questions from v1 are answered in [team/CODE_FINDINGS.md](CODE_FINDINGS.md). Still open, each marked [verify] above:

1. Can a separate `HttpApiBuilder.layer` for the team API reuse `environmentAuthenticatedAuthLayer` and be merged into `makeRoutesLayer` in `server.ts`? (D1)
2. Do Cursor, Grok and Antigravity keep earlier user-message text in context, so the team block could be sent only on the first turn? (D4)
3. Which providers emit mid-turn file-change events, and what do they contain? (D6 research item)
4. Which web UI files are the entry points for team screens? (Section 4)

### Answered in M1.1

**Does a second migrator run cleanly on the same `SqlClient`, after upstream's?** Yes.

- `apps/server/src/team/TeamMigrations.ts` calls the same `Migrator` with `table: "team_sql_migrations"`. The table name is an option of the migrator's run call, not of `Migrator.make`.
- `TeamService` runs it when the service is built. It asks for the `SqlClient` from the SQLite persistence layer, and that layer finishes upstream's migrations before it hands the client out. So team migrations always run second.
- Tests (`apps/server/src/team/TeamMigrations.test.ts`): team migrations run and record only in their own table; running them again does nothing; with upstream migrated to an older id, then team migrations, then a newer upstream, every newer upstream migration still runs; running team migrations first leaves all of upstream's to run.
- A real server start against a scratch home dir logged upstream's "Migrations ran successfully" at 16:50:50.676 and "Team migrations ran successfully" at 16:50:51.110. `team_sql_migrations` held `1 TeamCore`, and `effect_sql_migrations` held ids 1-54 only. A second start ran neither.

**Where does the team layer start, and which file registers CLI subcommands?**

- The team layer starts in `apps/server/src/server.ts`, as one `Layer.provideMerge(TeamService.layer)` in `RuntimeCoreDependenciesLive`, just above `Layer.provideMerge(PersistenceLayerLive)`. That placement gives it the persistence layer's `SqlClient` (after upstream's migrations), and makes `TeamService` available to the layers above it, including the MCP toolkit we add in M1.2. `OrchestrationReactor.ts` was not needed: the service is storage, not a reactor. Where M3's turn-diff reactor starts is still to be decided then.
- CLI subcommands are registered in `apps/server/src/bin.ts`, in the `Command.withSubcommands([...])` list inside `makeCli`.
