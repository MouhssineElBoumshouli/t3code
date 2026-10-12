# Porting the team layer to upstream's new orchestrator

Status: approved 2026-10-11, all five decisions, with the two additions in D1 and D3. Branch `sync/upstream-2026-10-11`. `main` is untouched and tagged `pre-upstream-sync-2026-10-11` (004f283df).

## 1. What happened

On 2026-10-02 upstream replaced its orchestrator ("feat(orchestrator): introduce new orchestrator", de3439142, 1,907 files). It is the 60th of the 805 commits we are behind; 744 sit on top of it. The new code lives in `apps/server/src/orchestration-v2/`; providers moved to `packages/provider-*`.

What it removed that we build on:

- **Thread activities.** Our cards (warning, question, plan, edited) are thread activities. V2 has no activity log: a thread holds a fixed union of turn items (`OrchestrationV2TurnItem` in `packages/contracts/src/orchestrationV2.ts`), and the v1 import does not carry activities over (`docs/internals/legacy-orchestration-migration.md`).
- **The old services.** `OrchestrationEngine`, `ProjectionSnapshotQuery`, `ProjectionPipeline`, `ProviderCommandReactor`, `ProjectionTurns`, `McpProviderSession`, and the six provider adapters we edited. About 20 of our server files import them.

So this round is a port, not a merge. A trial merge conflicts in 33 files; 17 of them were deleted upstream.

Upstream target for this round: `ed0f7b908` (upstream/main fetched 2026-10-11). We do not chase newer upstream commits until the port is done.

## 2. Decisions to approve

**D1. Where cards live.** A team-owned store: one small JSON file per chat under the server's state folder (`<T3 home>/userdata/team/cards/<threadId>.json`), written atomically, read through a new `team/TeamCards.ts`. The team feed (`subscribeTeamFeed`, our own RPC) carries each chat's cards to the client, sending only changed chats. The web timeline draws them among the chat's items by time. When a chat is deleted, or archived and cleaned up, its card file is deleted too.
_Not chosen:_ a new item type in upstream's turn-item union. Every sync would conflict there, and events saved with it must stay readable forever, by upstream's rules too.

**D2. App-sent messages.** "Omar said yes", "Wait is over", "Build on top": sent the way upstream sends its own restart message (`orchestration-v2/RestartContinuation.ts`): a `message.dispatch` with a `system` notification. The chat shows it as a work-log row with a short summary ("Omar agreed · continuing"), and the prompt the agent got as its detail. This replaces our "Sent by T3 Code" bubble.

**D3. The team briefing per provider** (150 tokens, `team/TeamBriefing.ts`):

- Claude: appended to the system prompt once per session, as before (one marked edit in `ClaudeAdapterV2.ts`).
- Codex: its own `t3_code_team` application-context key, as before, which Codex resends only when it changes (one marked edit in `CodexAdapterV2.ts`). Not through the turn's `appContext`: upstream marks those entries as untrusted text.
- Cursor, Grok, OpenCode, Pi, Antigravity and other ACP agents: put in front of the prompt on a provider session's first turn, and again only when the briefing text changes, to save tokens (same edit in `RunExecutionService.ts`; native `/commands` are left alone). The turn note stays per turn.

**D4. "Awaiting input".** V2 decides it in the client, from the chat shell. An open warning card or question adds to it there: one marked edit in `packages/client-runtime`, so web and mobile agree. No server projection edit any more.

**D5. Old cards are not migrated.** V2 copies `state.sqlite` to `statev2.sqlite` on first launch and leaves activities behind. Demo chats in `~/.t3-dev` lose their old cards; claims, tasks and handoffs live in the team's Git ref, so they are unaffected.

## 3. Where each hook goes

| Today (v1)                                                                                     | After the port (v2)                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team briefing in 6 adapters                                                                    | D3: `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `RunExecutionService.ts`                                                                                   |
| Turn note (`ProviderCommandReactor.ts`)                                                        | `RunExecutionService.ts`, on the provider message text, same spot as D3                                                                                   |
| Edit refusal: Claude PreToolUse hook                                                           | Same hook, in `ClaudeAdapterV2.ts` query options                                                                                                          |
| Edit refusal: Antigravity client writes                                                        | Antigravity's `clientFileSystem.writeTextFile` in `AntigravityAdapterV2.ts`                                                                               |
| Claude MCP timeout (60 s → 1 h)                                                                | Dropped: upstream now sets 65 min itself                                                                                                                  |
| Codex MCP timeout `tool_timeout_sec=3600`                                                      | `CodexAdapterV2.ts` thread config, one line                                                                                                               |
| Card counts as pending input (`ProjectionPipeline.ts`, SQL in `ProjectionThreadActivities.ts`) | D4, client side; both server edits dropped                                                                                                                |
| `thread.activity.append`                                                                       | `TeamCards` store (D1)                                                                                                                                    |
| `thread.turn.start` from the app                                                               | `ThreadManagementService.dispatch` `message.dispatch` (D2)                                                                                                |
| `snapshots.getThreadShellById` / `getProjectShells` / `getThreadCheckpointContext`             | `OrchestratorV2.getThreadShell` / `ProjectService.listShells` / `OrchestratorV2.getCheckpointContext`                                                     |
| `ProjectionTurns` (TeamGuard: did the holder run at the same time?)                            | Runs in `OrchestratorV2.getThreadProjection`                                                                                                              |
| `engine.subscribeDomainEvents`: `thread.turn-diff-completed`                                   | `OrchestratorV2.streamDomainEvents`: `checkpoint.captured` (status `ready`, `files`)                                                                      |
| `thread.archived` / `thread.deleted` / PR merged                                               | The matching v2 domain events                                                                                                                             |
| `project.created` (TeamWarmup)                                                                 | No v2 event: the warm-up checks `ProjectService.listShells` on its existing loop                                                                          |
| Team MCP tools via `McpServer.toolkit`                                                         | `toolkitRegistration` + `McpToolAccess.toLayer`; the calling chat from `McpInvocationContext`                                                             |
| `ws.ts` ChatGPT scope wrapper                                                                  | Dropped: upstream's group middleware covers those methods. Checked: our `ChatGptRpcScopes` test (ChatGPT cases) passes on plain upstream. The test stays. |

Small marked edits that carry over unchanged in spirit: contracts (`index.ts`, `rpc.ts`), `RpcAuthorization.ts` scopes, `ws.ts` team handlers, `server.ts` layer wiring, `bin.ts` (`t3 team`), `dev-runner.ts`, `vite.config.ts`, and the web UI hooks (chat header chip, sidebar, file panels, right panel tabs, command palette).

## 4. Steps

Each step is committed and pushed to the branch, with its own targeted checks and a PROGRESS.md entry. `main` moves only after step 6.

1. **Merge commit.** `git merge upstream/main` at `ed0f7b908`. Every conflict takes upstream's side; deleted files stay deleted; the small marked edits above are re-applied. The team server code does not compile until step 3, and the branch says so in PROGRESS.md.
2. **Server core.** `TeamCards` store (D1), app-sent messages (D2), and the reads and event streams in the table for TeamChoices, TeamQuestions, TeamWait, TeamGuard, TeamStaleView, TeamFeed, TeamAutoNotes, TeamClaimAutoRelease, TeamPushedBranches, TeamWarmup. Their tests move to v2's test kits.
3. **Team MCP tools.** `team_status`, `team_plan`, `team_claim`, `team_task`, `team_handoff` on the new tool-access layer; `handlers.test.ts` ported. Server typecheck is green from here.
4. **Provider hooks.** D3, the turn note, the Claude hook, Antigravity writes, the Codex timeout. Tests per provider for the briefing and refusal.
5. **Web.** Cards from the team feed into the new timeline; "awaiting input" (D4); the working row while a card waits; the other UI hooks. Logic tests ported.
6. **Checks and live run**, as asked: install, typecheck every package, all team suites, upstream tests of every touched upstream file, lint on changed files; live smoke with `--home-dir ~/.t3-dev`, solo and team: plan card, warning card with Find another way, Wait, Ask. Then merge to `main`, push, write `team/UPSTREAM_SYNC.md`.

## 5. Risks

- **Size.** About 17,800 lines of team server code and tests, 20 files coupled to the old services. Several sessions. The test harnesses are the biggest unknown: ours build on v1 engine test layers.
- **Held `team_plan` calls.** V2 releases idle provider sessions after 30 min only when no turn is busy, so a held call should survive. Checked live in step 6.
- **Drift.** Upstream moves fast (744 commits in 9 days). Pinning `ed0f7b908` keeps this round finite; the next weekly sync then starts from it.
- **Not covered:** mobile still draws no team UI (unchanged).
