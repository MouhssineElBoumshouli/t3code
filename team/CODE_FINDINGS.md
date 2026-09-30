# Code findings for the team layer design

Date: 2026-09-30. Read against fork commit a8e385e (upstream 050cfad04f). Research only, no feature code.

This answers section 6 of [team/DESIGN.md](DESIGN.md), re-checks every **[checked]** claim in it, and lists the parts of the design the code says will not work as written.

Paths are relative to the repo root. "Sure" means I read the code path end to end. "Mostly" means I read the main path but not every edge. "Not sure" means I could not confirm it from the code.

---

## Section 6 answers

### Q1. Does each provider get `buildRuntimeInstructions()` every turn, or only at session start?

**Answer.** Only Claude gets it once per session. The other five get it on every turn, but in different ways, and that matters for token cost:

| Provider    | When                                                                                  | How it is sent                                                                                                                                                                       | Where                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Once, when the session starts (and again only if the session is restarted or resumed) | `systemPrompt.append` in the SDK query options                                                                                                                                       | `apps/server/src/provider/Layers/ClaudeAdapter.ts:4391` (startSession), `:4914-4919`; `sendTurn` at `:5137` does not touch it                                                |
| Codex       | Every turn                                                                            | `turn/start.additionalContext` under the key `t3_code_runtime`. The code comment says Codex only resends an entry when its value changes. After compaction T3 re-injects it by hand. | `apps/server/src/provider/CodexDeveloperInstructions.ts:200-227`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts:589-614`, `:2566-2586`, `:1320-1323`, `:1875-1890` |
| Cursor      | Every turn (skipped for slash commands)                                               | Added as an extra **text part of the user prompt**                                                                                                                                   | `apps/server/src/provider/Layers/CursorAdapter.ts:967`, `:1090-1101`                                                                                                         |
| Grok        | Every turn (skipped for slash commands)                                               | Added as an extra **text part of the user prompt**                                                                                                                                   | `apps/server/src/provider/Layers/GrokAdapter.ts:1546`, `:1666-1674`, `:1786-1794`                                                                                            |
| OpenCode    | Every normal prompt; **not** sent for native commands                                 | `system` field of `session.promptAsync` (OpenCode appends it after its own prompts)                                                                                                  | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3096`, `:3248-3264` (command branch, no system), `:3280-3287`                                                            |
| Antigravity | Every turn                                                                            | Added as an extra **text part of the user prompt**                                                                                                                                   | `apps/server/src/provider/Layers/AntigravityAdapter.ts:974`, `:1083-1090`                                                                                                    |

Two more facts that matter for D4:

- `buildRuntimeInstructions()` takes only `{ harness, model, modelName, reasoningEffort }`. It has no thread, project or repo input, and it is a plain synchronous string function (`apps/server/src/provider/RuntimeInstructions.ts:9-24`). Per-thread team context cannot be added inside it without changing its inputs at all six call sites.
- Codex only gets the block when the turn has an `interactionMode` (`CodexSessionRuntime.ts:596-598`). The orchestration layer always sets it from the event payload, which has a default (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1503`, `packages/contracts/src/orchestration.ts:1932`).

**How sure:** sure for all six. Mostly for Claude's resume path (I saw the same options object is used on resume at `ClaudeAdapter.ts:4941`, but did not trace every restart trigger).

### Q2. Where are MCP toolkits registered and turned on per thread? What decides if preview/device tools are available?

**Answer.**

- **Registration is global and static.** One MCP server (`/mcp`) registers every toolkit once at startup: preview, pull requests, device (`apps/server/src/mcp/McpHttpServer.ts:633-674`). A new toolkit means adding it to that `layer` at `:670-674`.
- **Nothing is hidden from the tool list.** Every agent sees every tool. The MCP library builds `tools/list` from all registered tools and only filters by protocol version, not by credential (`node_modules/.../effect/src/unstable/ai/internal/mcpProtocol/v2025_06_18.ts:246-248`). The upstream test says it plainly: "surfaces a missing capability as a tool error" (`apps/server/src/mcp/McpHttpServer.test.ts:436-464`).
- **"Turned on" means two things:**
  1. A per-thread bearer credential carries a set of capabilities. It is made when the provider session starts (`apps/server/src/provider/Layers/ProviderService.ts:969-983`, called from `:1298` and `:1529`). The set is frozen for that credential.
  2. Each handler checks the capability when called and returns an error if it is missing: `requireMcpCapability(...)` (`apps/server/src/mcp/McpInvocationContext.ts:47-57`), used at `mcp/toolkits/preview/handlers.ts:63`, `mcp/toolkits/device/handlers.ts:69`, `mcp/toolkits/pullRequests/handlers.ts:163`.
- **What decides preview/device:** the settings `enableAgentBrowserAccess` and `enableAgentDeviceAccess`, with per-project overrides (`ProviderService.ts:895-940`). `pull-requests` is always granted (`apps/server/src/mcp/McpSessionRegistry.ts:128-131`).
- **Instructions follow availability, the tool list does not.** Codex's instruction text leaves out the preview/device paragraphs when those capabilities are missing, so the model is not steered toward tools that will fail (`CodexDeveloperInstructions.ts:28-45`, `CodexSessionRuntime.ts:74-82`).
- The capability names are a closed union: `"preview" | "device" | "pull-requests"` (`McpInvocationContext.ts:11`).

**How sure:** sure.

### Q3. How does a toolkit handler know which thread, project and repo it is called from?

**Answer.** The MCP auth middleware looks up the bearer token and puts an `McpInvocationScope` into the Effect context for the call (`McpHttpServer.ts:85-111`). The scope has `environmentId`, `threadId`, `providerSessionId`, `providerInstanceId`, `capabilities`, `issuedAt` (`McpInvocationContext.ts:13-20`).

It has **no project or repo**. Handlers get those by lookup, as the pull request toolkit does:

1. `threadId` → `ProjectionSnapshotQuery.getThreadShellById` → thread shell (has `projectId`, `branch`, `worktreePath`)
2. `projectId` → `getProjectShellById` → project shell (has `repositoryIdentity`, which holds `canonicalKey`)

See `mcp/toolkits/pullRequests/handlers.ts:157-180` and `:46-56`. `repositoryIdentity` can be null (no git remote), so the team layer must handle "no repo identity".

**How sure:** sure.

### Q4. How are thread worktrees and branches created and named?

**Answer.**

- **Worktrees are opt-in.** The setting `defaultThreadEnvMode` is `"local"` or `"worktree"`. Built-in default is **`"local"`**, so by default threads run in the main checkout (`packages/contracts/src/t3ProjectFile.ts:84-89`, `:120`; `packages/contracts/src/environment.ts:59`). A repo can set it in its checked-in `t3.json`; a per-project setting overrides that.
- **Branch name at creation:** the client makes a temporary name `t3code/<8 hex>` (`packages/shared/src/git.ts:13-21`, `:95-105`; used at `apps/web/src/components/ChatView.tsx:8021`, `:8359` and `apps/mobile/src/state/use-thread-outbox-drain.ts`).
- **Worktree creation:** the server runs `git worktree add -b <branch> <path> <baseRef>` during thread bootstrap (`apps/server/src/ws.ts:1333-1335`, `:1501-1510`; `apps/server/src/vcs/GitVcsDriverCore.ts:3065-3074`).
- **Worktree path:** `<T3 home>/worktrees/<repo folder name>/<branch with "/" replaced by "-">` (`GitVcsDriverCore.ts:3069-3071`, `apps/server/src/config.ts:152`). So it lives outside the repo, under T3's own data folder.
- **Rename after first turn:** if the branch is still a temporary `t3code/<hex>` name, the server asks a model for a name from the first message and renames it to `t3code/<generated-slug>`, then dispatches `thread.meta.update` (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:190-211`, `:909-965`).
- PR checkout branches are named `t3code/pr-<number>/<head branch>` (`apps/server/src/git/GitManager.ts:285`).

**How sure:** sure for the server path. Mostly for the client side (I read where the temporary name is generated, not every UI path).

### Q5. Can a server-side service subscribe to `thread.turn-diff-completed` and read the changed files?

**Answer.** Yes. This is an existing pattern:

- `OrchestrationEngine.subscribeDomainEvents` gives a live stream of persisted events (`apps/server/src/orchestration/Services/OrchestrationEngine.ts:78-93`). `ThreadPullRequestReactor` already listens for `thread.turn-diff-completed` this way (`apps/server/src/orchestration/ThreadPullRequestReactor.ts:392-394`, `:404-406`).
- The payload has `files: Array<{ path, kind, additions, deletions }>` (`packages/contracts/src/orchestration.ts:1987-1996`, `:631-636`).
- Reactors are started in one list in `apps/server/src/orchestration/Layers/OrchestrationReactor.ts:29-39`. A team reactor would either be added there (upstream edit) or started from our own layer.

Traps a team reactor must handle:

- **It fires after the turn ends.** The real event comes from `CheckpointReactor` after it captures the end-of-turn checkpoint (`apps/server/src/orchestration/Layers/CheckpointReactor.ts:259-354`).
- **There are also placeholder events mid-turn** with `status: "missing"` and `files: []` (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2622-2655`). Only `status === "ready"` has real files.
- **`kind` is always `"modified"`**, even for new or deleted files, because the list comes from `git diff --numstat` (`CheckpointReactor.ts:298-312`).
- The diff is "previous checkpoint → this checkpoint" of the thread's working folder. In `"local"` mode that folder is the shared checkout, so anything that changed there during the turn (the human, another thread) is counted as this turn's change.
- No git repo → no checkpoint → no file list (`CheckpointReactor.ts:292-297`).

**How sure:** sure.

### Q6. How are RPC scopes defined and checked? What would adding `team:read` and `team:write` touch?

**Answer.**

- Scopes are a closed list of string literals in `packages/contracts/src/auth.ts:81-100`: `orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`, `access:read`, `access:write`, `relay:read`, `relay:write`. Two presets: `AuthStandardClientScopes` and `AuthAdministrativeScopes` (`auth.ts:103-116`).
- **WebSocket RPCs:** every method in `WsRpcGroup` must map to one scope in `RPC_REQUIRED_SCOPES`. The `satisfies Record<WsRpcMethod, ...>` makes a missing entry a type error (`apps/server/src/auth/RpcAuthorization.ts:24-177`, `:179-188`). The check is `session.scopes.includes(requiredScope)` in `apps/server/src/ws.ts:680-727`.
- **HTTP routes:** each handler calls `requireEnvironmentScope(scope)` itself (`apps/server/src/auth/http.ts:191-199`; examples in `apps/server/src/orchestration/http.ts:36-100`). This is not type-enforced.
- **Opening a WebSocket needs no particular scope.** Any valid session can get a WebSocket ticket (`auth/http.ts:386-399`).
- **Storage:** scopes are saved as text in `auth_sessions` and `auth_pairing_links`, with no database constraint (`apps/server/src/persistence/Migrations/031_AuthAuthorizationScopes.ts`).
- **Delegation rule:** making a pairing link needs `access:write` **and** every scope being handed out (`docs/internals/environment-auth.md:80-85`). Exchanging a link can narrow its scopes but never widen them (`apps/server/src/auth/EnvironmentAuth.ts:804-812`).
- A narrow grant already exists: `t3 connect` issues a link with only `relay:write` (`apps/server/src/cli/connect.ts:273`). `t3 pair` always issues standard scopes (`apps/server/src/cli/pair.ts:438`).

Adding `team:read` / `team:write` would touch:

1. `packages/contracts/src/auth.ts`: add the two literals to `AuthEnvironmentScope`, and add them to `AuthAdministrativeScopes`. Without that the host owner cannot make a team invite, because of the delegation rule.
2. If team calls are WebSocket RPCs: `WsRpcGroup` in contracts, plus `RPC_REQUIRED_SCOPES` in `RpcAuthorization.ts`. If they are HTTP routes in a new group: only our new files, plus mounting the group.
3. A way to make a team-only invite: a new CLI command or flag (like `connect.ts:273`) and/or a UI.
4. Web settings screens that list or label scopes, if any show raw scope names. (Not checked.)

**How sure:** sure for the server. Not sure about the web UI's scope display.

### Q7. Can one T3 server call another as a client, or is that new?

**Answer.** Partly exists, partly new.

What exists and runs in Node:

- `bootstrapRemoteBearerSession` in `packages/client-runtime/src/authorization/remote.ts:115-120` swaps a pairing credential for a bearer session over HTTP. Desktop main (Node) already uses it (`apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts:1`, `apps/desktop/src/ipc/methods/sshEnvironment.ts:7-8`).
- The server already calls T3 HTTP APIs as a client: `t3 project` uses `HttpApiClient.make(EnvironmentHttpApi, ...)` against a live local server (`apps/server/src/cli/project.ts:228-231`). `AgentAwarenessRelay` is a server service that listens to orchestration events and pushes per-thread state out with `HttpApiClient` (`apps/server/src/relay/AgentAwarenessRelay.ts:1-60`). That is the closest existing model for "member server pushes its state to the host".

What does **not** work as-is:

- The full client session in `packages/client-runtime/src/rpc/session.ts` subscribes to server config as soon as it connects and waits for the first snapshot (`session.ts:223-290`). That RPC needs `orchestration:read` (`RpcAuthorization.ts`, `subscribeServerConfig`). A team-only token would fail to connect. So a member → host link needs its own small client, not the full client session.
- Nothing in `apps/server` imports `@t3tools/client-runtime` today.

Other limits for a long-lived link: pairing links are one-time and expire in 5 minutes by default (`apps/server/src/auth/PairingGrantStore.ts:239`, `:385-387`). Bearer sessions last 30 days (`apps/server/src/auth/SessionStore.ts:423`). So an invite must be used quickly, and the member needs a re-join or refresh story after 30 days.

**How sure:** mostly. I did not try running the client-runtime pieces inside the server.

### Q8. Where are SQLite migrations, and how do we add team tables without touching upstream ones?

**Answer.**

- One statically imported list, `migrationEntries`, ids 1 to 54 today (`apps/server/src/persistence/Migrations.ts:26-81`). Files live in `apps/server/src/persistence/Migrations/NNN_Name.ts`. They run at startup from the SQLite layer (`apps/server/src/persistence/Layers/Sqlite.ts:14-26`).
- **Big trap:** the migrator reads the highest id already recorded and skips every migration with an id at or below it (`node_modules/.../effect/src/unstable/sql/Migrator.ts:229-256`, the `currentId <= latestMigrationId` check). So:
  - If we add team migration 55, upstream's next migration will also be 55. That is a clash when we merge, and on a database that already ran our 55, upstream's new 55 would be skipped.
  - If we pick a high id like 1000, every future upstream migration (55 to 999) is skipped forever on our databases. Silent schema drift.
- **Safe way:** do not add to upstream's list. The migrator accepts its own table name (`Migrator.ts:32`, default `effect_sql_migrations` at `:111`). Run a second migrator from our own team layer with `table: "team_sql_migrations"`, on the same `SqlClient`, and prefix our tables `team_`. That needs no edit to `Migrations.ts` or `Sqlite.ts`.

**How sure:** sure about the trap. Mostly sure the second-migrator approach works (I read the option, did not run it).

### Q9. Which events tell us a thread started a turn, linked a PR, had its PR merged, or is waiting on an approval?

**Answer.** All available as orchestration events on the member's own server (full list: `packages/contracts/src/orchestration.ts:1690-1724`):

| Board signal                      | Event                                                                                                       | Detail                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Turn asked for                    | `thread.turn-start-requested`                                                                               | `orchestration.ts:1926-1937`                                                                                        |
| Turn actually running             | `thread.session-set` with `session.status === "running"` and `activeTurnId` set                             | Set from the provider's `turn.started` (`ProviderRuntimeIngestion.ts:1867-1897`); schema `orchestration.ts:608-628` |
| PR linked (explicit)              | `thread.pull-request-linked`                                                                                | `orchestration.ts:1875-1879`                                                                                        |
| PR found from the thread's branch | `thread.meta-updated` with `branchPullRequest`                                                              | `orchestration.ts:1851-1873`. This is a second, separate way a PR gets tied to a thread.                            |
| PR merged                         | `thread.pull-request-synced` with `snapshot.state === "merged"` (`mergedAt` also set)                       | `orchestration.ts:1889-1895`, `:736-753`; states `packages/contracts/src/pullRequest.ts:18`                         |
| Waiting on approval               | `thread.activity-appended` with `activity.kind === "approval.requested"` (cleared by `"approval.resolved"`) | `apps/server/src/orchestration/decider.ts:94-96`, `:2194-2195`                                                      |
| Waiting on a question             | same, with `"user-input.requested"` / `"user-input.resolved"`                                               | same lines                                                                                                          |
| Failing                           | `thread.session-set` with `status: "error"`, or latest turn state `"error"`                                 | `orchestration.ts:608-616`, `:673-678`                                                                              |

Useful shortcut: `projectThreadAwareness()` in `packages/shared/src/agentAwareness.ts:53-120` already turns a thread shell into one phase: `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `stale`. The board can reuse it instead of rebuilding this logic.

Merge detection is not instant: it comes from `ThreadPullRequestReactor`, which sweeps every minute and skips settled and archived threads (`ThreadPullRequestReactor.ts:81-104`, `:155-165`, `:404-416`). It runs on the member's own server, using that member's git host login.

**How sure:** sure for the event names and payloads. Mostly for merge timing.

---

## Re-check of every **[checked]** claim

| #   | Claim in DESIGN.md                                                                                                          | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | One environment owns the work; environments do not share databases (§2)                                                     | **Correct.**                                                                                                                                                                                                                                                                                                                                                                                                                              | `docs/internals/remote.md:3-14`, `docs/internals/environment-auth.md:119-123`                                     |
| 2   | Pairing grants scopes; every server call declares its scope (§2)                                                            | **Mostly correct.** True and type-enforced for WebSocket RPCs. HTTP routes check scopes by hand in each handler. `/mcp` is outside environment auth and uses its own per-thread tokens. Also important for D1: `orchestration:read` lets a session read **any file the server account can read** (`environment-auth.md:130-136`), so team members must never get it.                                                                      | `RpcAuthorization.ts:24-188`, `auth/http.ts:191-199`, `McpSessionRegistry.ts:71-73`                               |
| 3   | Direct network, Tailscale, SSH and T3 Connect all reach a server the same way (§2)                                          | **Correct for clients.** Every route listed is a client → server route. Server → server is new work (Q7).                                                                                                                                                                                                                                                                                                                                 | `remote.md:3-7`, `:40-53`                                                                                         |
| 4   | A repo's `canonicalKey` comes from its Git remote, so two clones of the same GitHub repo match (§2)                         | **Partly wrong.** The key comes from the `upstream` remote if there is one, else `origin`, else the first remote by name. Two clones of the same repo get **different** keys if one person added an `upstream` remote and the other did not. And every fork that has `upstream` set to the same original repo gets the **same** key. The URL is normalized (lowercase, no `.git`, ssh and https give the same key), so that part is fine. | `apps/server/src/project/RepositoryIdentityResolver.ts:58-71`, `:73-98`; `packages/shared/src/git.ts:133-165`     |
| 5   | Every agent gets an MCP tool server named `t3-code` with preview, device and PR tool sets (§2)                              | **Correct.** Attached for every provider (e.g. `ClaudeAdapter.ts:4950-4961`, `CodexAdapter.ts:2324-2338`, `CursorAdapter.ts:565-568`).                                                                                                                                                                                                                                                                                                    | `McpHttpServer.ts:633-674`                                                                                        |
| 6   | `buildRuntimeInstructions()` is a shared block used by the provider adapters (§2)                                           | **Correct**, all six adapters. The [verify] part is answered in Q1.                                                                                                                                                                                                                                                                                                                                                                       | `RuntimeInstructions.ts:9-24` and Q1 table                                                                        |
| 7   | `thread.turn-diff-completed` fires after each turn, backed by hidden Git checkpoints (§2)                                   | **Mostly correct.** The real one fires after each turn. There are also mid-turn placeholder events with no files, `kind` is always `"modified"`, and there is nothing without a git repo. See Q5.                                                                                                                                                                                                                                         | `CheckpointReactor.ts:259-354`, `ProviderRuntimeIngestion.ts:2622-2655`, `docs/internals/overview.md:72-80`       |
| 8   | Approvals exist per provider (Claude `canUseTool`, Codex `fileChange/requestApproval`) but only fire in modes that ask (§2) | **Correct, and stronger than stated.** The default runtime mode is `"full-access"`, which maps Codex to `approvalPolicy: "never"`, so by default approvals never fire.                                                                                                                                                                                                                                                                    | `ClaudeAdapter.ts:4660`, `CodexSessionRuntime.ts:2161`, `:515-548`; `packages/contracts/src/orchestration.ts:135` |
| 9   | Upstream moves fast and does not require Windows tests (§2)                                                                 | **Correct.** 5 to 69 upstream commits a day from Sept 16 to 29. `ci.yml` runs Ubuntu and macOS only. `windows-tests.yml` is manual-only and says "nothing in the suite passes on Windows yet".                                                                                                                                                                                                                                            | `git log`, `.github/workflows/ci.yml`, `.github/workflows/windows-tests.yml:1-3`                                  |

Not marked [checked] but also true: `t3 serve` exists (`apps/server/src/cli/server.ts:26`). T3 tracks PRs per thread (Q9).

---

## Parts of the design the code says are a bad idea or won't work

### 1. D4: putting the team board in `buildRuntimeInstructions()` (won't work as written, and costs a lot)

- The function has no thread or project input (Q1). Per-thread context means changing all six adapter call sites, not only `RuntimeInstructions.ts`.
- Claude gets it once per session, so the board goes stale. That is the "[verify]" risk in D4, and it is real.
- Cursor, Grok and Antigravity add it **to every user message**. A 1,200-token block becomes about 1,200 tokens per turn that stay in history: roughly 60,000 tokens after 50 turns. Codex resends whenever the text changes, and a live board changes all the time.

**Instead:** keep the injected block small (about 100-150 tokens) and nearly static: "This project is in a team. Rules: `.team/rulebook.md`. Your task: `<id>`. Call `team_status` before editing files you have not touched yet. Code wins over memory." Put the board, task card and handoff notes behind tools (D5). Add an optional `teamContext` input to `buildRuntimeInstructions()`. Fill it from a per-thread lookup, the same way adapters already call `McpProviderSession.readMcpProviderSession(threadId)`. That gives six one-line `team-layer:` edits plus the function itself.

### 2. D5: "Tools only show up when the project belongs to a team" (wrong)

Preview and device tools do **not** hide. They are listed to every agent and return an error when not allowed (Q2). Also, capabilities are frozen when the provider session starts, so a team capability would not turn on in a thread that was already running when the user joined.

**Instead:** don't add a new `McpCapability`. Register the team toolkit like `pullRequests/`, and in each handler check at call time whether the thread's project belongs to a team. If not, return a clear "this project is not in a team" result. That avoids edits to `McpInvocationContext.ts` and `ProviderService.ts`. Because every agent in every project will see these tools, keep the count low: for example `team_status`, `team_claim` (with a release flag), `team_task` (get/update), `team_handoff`, `team_memory_search`. Leave `team_decision_propose` for later. It is only a file write, which the agent can already do.

### 3. D2: team keyed only by `canonicalKey` (fragile)

See claim 4. A fork workflow (adding `upstream`) changes the key. Unrelated teams working on different forks of one open-source repo would share a key.

**Instead:** put an explicit team id in the repo, e.g. `.team/team.json` with `{ "teamId": "...", "host": "..." }`, committed with the rulebook. Match projects on that id. Use `canonicalKey` only as a sanity check.

### 4. Section 4: "Expected spots" for upstream edits is incomplete

Based on Q1-Q8, the realistic list of upstream files touched is:

- `provider/RuntimeInstructions.ts` + the six adapters (one line each), if we inject per-thread context (item 1).
- `mcp/McpHttpServer.ts` (add the team toolkit to `layer`).
- `packages/contracts/src/auth.ts` (two scope literals, plus `AuthAdministrativeScopes`).
- Where the team reactor and host HTTP group get started and mounted (`OrchestrationReactor.ts` or `server.ts`).
- **Not** `Migrations.ts` (item 6), **not** `WsRpcGroup` / `RpcAuthorization.ts` (item 5), **not** `McpInvocationContext.ts` / `ProviderService.ts` (item 2).

### 5. D1 / M2: server-to-server over the existing client session (won't work as-is)

The full client-runtime session needs `orchestration:read` just to connect (Q7), and we must not give members that scope (claim 2). Adding team calls to `WsRpcGroup` also means editing two upstream files that change often.

**Instead:** host team calls as a new HTTP API group in our own files, each handler guarded by `requireEnvironmentScope("team:read" | "team:write")`, the same way `orchestration/http.ts` works. On the member side, join with `bootstrapRemoteBearerSession`, then use a small `HttpApiClient`. Copy `AgentAwarenessRelay`'s pattern (listen to events, push with retry) for pushing claims and status to the host. For v1, have members poll the host every 15-30 s for the board and warnings instead of a push channel. Plan for: 5-minute one-time invites (make a CLI command that prints a longer-lived invite), and 30-day sessions (re-join or refresh).

### 6. D3 / section 4: team tables via the normal migration list (dangerous)

Any id we choose either clashes with upstream's next migration or silently blocks all future upstream migrations (Q8).

**Instead:** run our own migrator with `table: "team_sql_migrations"`, own `team_*` tables, started from our team layer. No upstream edit.

### 7. D6 layer 3: automatic claims from turn diffs (works, but only after the fact)

The event comes after the turn is done (Q5). Two agents can both edit the same file during long turns and only get warned at the end. In `"local"` mode the file list also includes human edits and other threads' edits in the same checkout.

**Instead:** keep it, but call it "overlap detection", not prevention. Only use `status === "ready"` events. Treat `kind` as "touched", not "modified". Make layer 2 (agent calls `team_claim`, prompted by the small instruction block) the main early warning. Later, look at mid-turn provider file-change events (not researched here) for earlier warnings.

### 8. D6 layer 4: "each thread works on its own branch or worktree, as T3 already supports" (not the default)

Built-in default is `"local"` (Q4). Worktrees are opt-in.

**Instead:** no code needed. Tell teams to commit `"defaultThreadEnvMode": "worktree"` in the repo's `t3.json`. It is already a checked-in, shared project setting. Also, branch names are random at first and then AI-renamed after the first turn, so the board should key cards by thread id, not branch name.

### 9. D9: self-moving board

The signals exist (Q9), but:

- A PR can reach a thread two ways (explicit link or branch discovery). Handle both, or "In review" will be missed.
- "Merged → Done" depends on the member's own server running its one-minute PR sweep with that member's git host login. If their server is off, the host never hears about the merge. Settled and archived threads are not swept.
- Reuse `projectThreadAwareness()` for "running / waiting / failed" instead of rebuilding it.

### 10. Small things

- `team_decision_propose` and anything else that writes files must write into `thread.worktreePath` when it is set, else the project root. Otherwise, in worktree mode the file lands in the wrong checkout.
- Claude loads project settings (`settingSources` includes `"project"`, `ClaudeAdapter.ts:1551-1555`), so a line in the repo's `CLAUDE.md` / `AGENTS.md` pointing at `.team/rulebook.md` may reach some agents with no code at all. Whether each of the other five providers reads those files is provider behavior outside this repo. **Not sure**, needs a test per provider.

---

## What I did not check

- The web UI's pairing and connections screens (how scopes are shown, and whether a team-only session breaks them).
- Every HTTP route's scope check. I read the pattern and several examples, not all routes.
- Whether the Claude SDK re-reads `systemPrompt` in every restart case (only saw that resume reuses the same options).
- I did not run anything. All answers come from reading the code.
