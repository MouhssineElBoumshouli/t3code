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

**Tables.** Team tables live in the same SQLite database as the rest of T3, all named `team_*`. They get their own migrator with its own tracking table, `team_sql_migrations`, started from our team layer. [checked: the migrator accepts a `table` option] [verify: that a second migrator runs cleanly on the same `SqlClient` at startup] We never add to upstream's `migrationEntries` in `persistence/Migrations.ts`: any id we pick would clash with upstream's next one or make the migrator skip upstream's future migrations. [checked]

Decisions are written by people, or by agents with normal file edits. The rulebook explains the format. There is no decision tool in v1 (D5).

### D4. How memory reaches agents

A small team block, about 150 tokens, goes into the runtime instructions through a new optional input: `buildRuntimeInstructions({ ..., teamContext })`. When `teamContext` is missing, the output is exactly what it is today, so single-person use does not change.

The block changes rarely: only when the thread gets a task or the team's rules path changes. It holds:

1. "This project is in team <name>. Project rules are in `.team/rulebook.md`. Read it before your first change."
2. "Your task: <card title> (<card id>)", or "No task yet."
3. "Before editing files you have not touched in this thread, call `team_claim`. Call `team_status` to see who is working on what."
4. "Code always wins over memory."

The board, the task card, handoff notes and decisions come **only through tools** (D5), never pasted into the instructions.

**Why small and static:**

- Claude only gets the instructions at session start, so anything that changes would go stale. [checked]
- Cursor, Grok and Antigravity add the instructions to every user message, so every token stays in history for every turn. At 150 tokens that is about 7,500 tokens after 50 turns. A full board at 1,200 tokens would have been about 60,000. [checked]
- Codex only resends when the text changes, so static text is sent once. [checked]

**Plumbing.** Our team layer keeps a per-thread map of team blocks, the same way `McpProviderSession` keeps per-thread MCP config. Each adapter reads it by thread id and passes it as `teamContext`. That is one small `team-layer:` edit per adapter. All six adapters have T3's thread id where they call the function. [checked] For Codex, the T3 thread id is in the session runtime options, and the call goes through `buildCodexAdditionalContext()`, so the edit is a few lines across `CodexSessionRuntime.ts` and `CodexDeveloperInstructions.ts`. [checked]

Later, if 150 tokens per turn is too much for Cursor, Grok and Antigravity, send the block only on the first turn for those three. [verify: whether they keep earlier user-message text in context across turns]

### D5. Team tools

A new toolkit at `apps/server/src/mcp/toolkits/team/`, built like `pullRequests/`. [checked: pattern]

| Tool                 | What it does                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `team_status`        | Returns the team board: who, what task, which paths.                                                                             |
| `team_claim`         | Claim paths (files or folders) with a short note, or release them with `release: true`. Returns any overlap with others' claims. |
| `team_task`          | Read this thread's task card, or update its status and note.                                                                     |
| `team_handoff`       | Save a handoff for this thread: what changed, what's left, risks. Max 150 words.                                                 |
| `team_memory_search` | Search decisions and handoffs. Returns the top 3 to 5, short, each marked fresh or maybe-outdated (D7).                          |

`team_decision_propose` is dropped for now.

**No new MCP capability.** Every agent sees these five tools, the same way every agent sees the preview tools today. [checked] Each tool checks team membership **when it is called**: thread → project → `.team/team.json` → is this `teamId` joined on this server? If not, it returns a short "This project is not in a team" result. [checked: thread and project lookup pattern] Because the check happens at call time, a user who joins a team mid-session gets working tools without restarting the agent. This avoids edits to `McpInvocationContext.ts` and `ProviderService.ts`. [checked: capabilities are frozen at session start]

**Files come from the thread's own checkout.** Any team file read or write (reading `.team/team.json` and `.team/rulebook.md`, checking decision freshness with Git) uses `thread.worktreePath` when it is set, else the project's workspace root. A worktree can be on a branch whose `.team/` differs from the main checkout. [checked: thread shell has `worktreePath`]

### D6. Conflicts

Five layers, cheapest first:

1. **Split the work.** Tasks come with paths. (Planner UI comes after v1.)
2. **Claims (main early warning).** The team block (D4) tells agents to call `team_claim` before editing new files. The claim returns overlaps right away, before any edit.
3. **Overlap detection from turn diffs.** On `thread.turn-diff-completed`, the member's server records every file the turn touched and checks it against others' claims. Overlap sends a warning to both people. This is detection after the fact, not prevention: the event fires after the turn ends, so both people may already have edited. [checked] Rules:
   - Only use events with `status: "ready"`. Mid-turn placeholders have `status: "missing"` and no files. [checked]
   - Treat every file as "touched". The event's `kind` is always `"modified"`, even for new or deleted files. [checked]
   - Works for every provider and every permission mode, because it does not rely on the agent obeying. [checked]
4. **Separate copies.** Each thread works on its own worktree and branch. Worktrees are opt-in in T3 (default `"local"`), so **creating a team turns them on**: team creation writes `.team/team.json` and sets `"defaultThreadEnvMode": "worktree"` in the project's `t3.json` (creating the file or adding the field), in one commit the creator reviews and pushes. [checked: t3.json field exists] A member's per-project setting can still override the file. [checked] If it is set to `"local"`, the team UI shows a notice, because in local mode a turn's diff also includes human edits and other threads' edits in the same checkout. [checked]
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

| File                                                     | Why                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/provider/RuntimeInstructions.ts`        | Optional `teamContext` input (D4). [checked]                                                                                                                                   |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`       | Pass `teamContext` (D4). [checked]                                                                                                                                             |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | Pass the T3 thread id's `teamContext` down (D4). [checked]                                                                                                                     |
| `apps/server/src/provider/CodexDeveloperInstructions.ts` | Accept and forward `teamContext` (D4). [checked]                                                                                                                               |
| `apps/server/src/provider/Layers/CursorAdapter.ts`       | Pass `teamContext` (D4). [checked]                                                                                                                                             |
| `apps/server/src/provider/Layers/GrokAdapter.ts`         | Pass `teamContext` (D4). [checked]                                                                                                                                             |
| `apps/server/src/provider/Layers/OpenCodeAdapter.ts`     | Pass `teamContext` (D4). [checked]                                                                                                                                             |
| `apps/server/src/provider/Layers/AntigravityAdapter.ts`  | Pass `teamContext` (D4). [checked]                                                                                                                                             |
| `apps/server/src/mcp/McpHttpServer.ts`                   | Add the team toolkit to `layer` (D5). [checked]                                                                                                                                |
| `packages/contracts/src/auth.ts`                         | Add `team:read`, `team:write`, and add them to `AuthAdministrativeScopes` (D1). [checked]                                                                                      |
| `apps/server/src/server.ts`                              | Merge the team HTTP API into the routes layer, and start the team layer (D1). [verify: best place to start the team reactor; `OrchestrationReactor.ts` is the other candidate] |
| CLI command registration                                 | Add `t3 team` commands (create, invite). [verify: which file registers subcommands]                                                                                            |
| Web UI entry points                                      | Team screens (M3 and later). [verify]                                                                                                                                          |

**Upstream files we do not edit:** `persistence/Migrations.ts`, `persistence/Layers/Sqlite.ts`, `WsRpcGroup` in contracts, `auth/RpcAuthorization.ts`, `mcp/McpInvocationContext.ts`, `provider/Layers/ProviderService.ts`, and `EnvironmentHttpApi` in `packages/contracts/src/environmentHttp.ts`.

## 5. Milestones

- **M1, solo:** team tools, host mode on your own machine, `<team_context>` block through `teamContext`, handoff notes, `.team/` files (`team.json`, rulebook, decisions), own migrator and `team_*` tables, team creation that turns on worktrees. Pass the cold start test with Claude Code and Codex.
- **M2, two people:** team HTTP API, `team:read` / `team:write` scopes, `t3 team invite`, member join with `bootstrapRemoteBearerSession`, member push (AgentAwarenessRelay pattern) and 15-30 second polling, offline queue. Test with one friend over Tailscale.
- **M3, conflicts:** overlap detection from turn diffs, overlap warnings, team board in the UI.
- **M4, team features:** the self-moving task board (D9), catch me up, handoff UI, then guide mode.
- **Later:** mid-turn file-change warnings (research first), plan to cards, waiting on, auto standup, decisions from merges, GitHub Issues sync, phone approvals, shared skills, usage per person, online host, own name, open source launch.

## 6. Open questions before building

The 9 questions from v1 are answered in [team/CODE_FINDINGS.md](CODE_FINDINGS.md). These are still open, each marked [verify] above:

1. Can a separate `HttpApiBuilder.layer` for the team API reuse `environmentAuthenticatedAuthLayer` and be merged into `makeRoutesLayer` in `server.ts`? (D1)
2. Does a second `Migrator.make({ table: "team_sql_migrations" })` run cleanly on the same `SqlClient` at startup, after upstream's migrations? (D3)
3. Do Cursor, Grok and Antigravity keep earlier user-message text in context, so the team block could be sent only on the first turn? (D4)
4. Which providers emit mid-turn file-change events, and what do they contain? (D6 research item)
5. Where is the best place to start the team layer: `server.ts` or `OrchestrationReactor.ts`? Which file registers CLI subcommands? (Section 4)
6. Which web UI files are the entry points for team screens? (Section 4)
