# Syncing with upstream T3 Code

How to pull in pingdotgg/t3code, and where our team layer hooks into upstream files. Aim for a weekly sync: small syncs are routine, big ones become ports.

## Steps

1. **Look first.** `git fetch upstream`, then `git log --oneline main..upstream/main | wc -l`. Check `git diff --stat main...upstream/main -- $(git grep -l 'team-layer' -- ':!team/')`: a hooked file that upstream deleted or rewrote means a port, not a merge. Stop and plan it (as `team/V2_PORT_PLAN.md` did).
2. **Safety tag.** `git tag pre-upstream-sync-YYYY-MM-DD main && git push origin pre-upstream-sync-YYYY-MM-DD`.
3. **Branch.** `git switch -c sync/upstream-YYYY-MM-DD main`. `main` does not move until step 9.
4. **Merge, not rebase.** `git merge upstream/main`. For each conflict: take upstream's version, then put our `team-layer:` edit back on top. If upstream refactored the spot, follow its new pattern. Commit the merge, push the branch.
5. **Install.** `vp i`.
6. **Typecheck, one package at a time** (this laptop has 7 GB; a server `tsc` peaks near 4 GB). In each package: `GOMEMLIMIT=2500MiB npx tsc --noEmit -p . --singleThreaded`. Nothing else running next to the server one.
7. **Tests, one run at a time**, from each package's folder.
   - Server: `vp test run src/team/ src/mcp/toolkits/team/ src/cli/team.test.ts src/auth/ChatGptRpcScopes.test.ts`, plus the upstream tests of every conflicted or hooked server file.
   - Web: `src/components/team/`, `MessagesTimeline.logic`, `session-logic`, `Sidebar.logic`, `ThreadNotificationCoordinator`.
   - client-runtime: `src/work-log/`, `src/state/teamMarkers`. Contracts: `teamFeed`, `teamCards`.
   - Run upstream's tests for conflicted files too: they catch hook edits that changed upstream's behavior.
8. **Lint the changed files**, then a live run per `team/WORKING_RULES.md` (solo and team: plan card, warning card, Find another way, Wait, Ask). Screenshots go to `test-screenshots`.
9. **Land.** `git switch main && git merge --no-ff sync/upstream-YYYY-MM-DD && git push origin main`. Add a PROGRESS.md entry, and update the file list below if it changed.

## Upstream files we hook into

Every edit carries a `team-layer` comment, so `git grep -n team-layer -- ':!team/'` is the source of truth. As of 2026-10-12:

- **Server wiring:** `apps/server/src/server.ts` (team layers, team MCP tools), `ws.ts` (team RPC handlers), `binCli.ts` (`t3 team`), `auth/RpcAuthorization.ts`, `observability/RpcInstrumentation.ts`.
- **Turns and providers:** `orchestration-v2/RunExecutionService.ts` (turn text), `orchestration-v2/ThreadSettlementService.ts` (+ its test: no auto-settle while a card is in play), `orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `CodexAdapterV2.ts` (+ its test's expected config), `AntigravityAdapterV2.ts`, `provider/CodexDeveloperInstructions.ts`, `packages/provider-core/src/server/runtimeInstructions.ts`, `packages/provider-acp/src/server/adapter.ts`.
- **Contracts and client runtime:** `packages/contracts/src/index.ts`, `rpc.ts`, `clientRpcPermissions.ts`; `packages/client-runtime/package.json` (exports), `src/rpc/client.ts`, `src/work-log/presentation.ts` (+ its test: "Could not change 1 file").
- **Web:** `ChatView.tsx`, `CommandPalette.tsx`, `RightPanelTabs.tsx`, `Sidebar.tsx`, `ThreadNotificationCoordinator.tsx` (+ its two tests), `chat/ChatHeader.tsx`, `chat/MessagesTimeline.tsx`, `chat/MessagesTimeline.logic.ts`, `files/FileBrowserPanel.tsx`, `files/FilePreviewPanel.tsx`, `session-logic.ts`, `apps/web/vite.config.ts`.
- **Tooling:** `scripts/dev-runner.ts`, `.gitignore`. Fork-only text: `AGENTS.md` (fork note), `CLAUDE.md`, `README.md`.

## What was hard (2026-10-11 sync, 805 commits)

- **Upstream replaced its orchestrator** (orchestration-v2). Thread activities, which our cards were built on, were gone, and about 20 team files used removed services. This took a planned port (`team/V2_PORT_PLAN.md`), not conflict fixes: cards moved to our own store and reach clients through the team feed; app-sent messages became upstream's system notifications; provider hooks moved to the v2 adapters and `RunExecutionService`.
- **Effect moved APIs**: `effect/unstable/*` became `effect/*`, `Stream.scan` takes its seed as a function, `HostProcess` became a namespace. Mostly mechanical, but spread across every file.
- **Tests**: our mocked snapshot queries no longer matched anything, so team tests now run on a real v2 orchestrator (`team/teamOrchestrator.testkit.ts`). Two kinds of event race only showed up there: separate typed streams reordering events, and subscribing after a snapshot.
- **Memory**: a full server typecheck while other things ran likely restarted the laptop. Run checks one at a time.
- **Our ws.ts security wrapper** was no longer needed: upstream's scope checks now cover those methods (our test passes on plain upstream). The test stays and guards it on every sync.
