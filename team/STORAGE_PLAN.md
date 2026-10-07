# Storage swap plan (VISION.md step 1)

Status: done, 2026-10-07. Slices 0 to 8 landed and were reviewed; VISION.md steps 1 (storage swap) and 2 (two people, for real) are done. The plan below is kept as the record of why. Originally research and planning only, no feature code. Written by Claude Code after reading [VISION.md](VISION.md) and the team code at commit b4a8a2152.

Every fact below says how it was checked: **[code]** (read in this repo, with the file), **[measured]** (run on this laptop against GitHub on 2026-10-07), or **[docs]** (official docs, linked). Anything else is marked as my judgment.

Short version:

- Keep the `TeamService` interface. Replace its SQLite body with a store that reads and writes small JSON files on a shared Git ref in the project's own GitHub repo. M1's tools, briefing, memory search and freshness keep calling the same methods.
- One file per person **per T3 server** (not per person), because a thread belongs to one server and one person can run two.
- Check for changes with an authenticated GitHub API call that costs nothing when nothing changed. Run `git fetch` only when the ref really moved.
- Park host mode (M2.2, M2.3) outside the compiled code, with a Git tag on the last commit where it worked. Keep the `ws.ts` security fix and give it its own small test.
- Eight slices, each testable on its own (section 3.7).
- Five decisions, all made on 2026-10-07 (section 5): hidden ref `refs/t3-team/state`, public repos refused unless `--public-ok`, writer files per (login, T3 server), team scopes reverted, host mode parked with a tag.

## 1. What I read

- VISION.md, all of it. DESIGN.md D1 to D9 and section 7. The latest PROGRESS.md entries (M2.2, M2.3).
- `apps/server/src/team/`: `TeamService.ts` (all), `Migrations/001_TeamCore.ts`, `TeamMigrations.ts`, `TeamBriefing.ts`, `TeamAutoNotes.ts`, `TeamClaimAutoRelease.ts`, `TeamProjectFiles.ts` (exports), `TeamInvites.ts` (exports), `http/routes.ts`, `http/TeamSessionMembers.ts`.
- `apps/server/src/mcp/toolkits/team/`: `tools.ts`, `resolve.ts`, `handlers.ts`, `briefing.ts`, `memory.ts` (the freshness part all).
- `apps/server/src/cli/team.ts`. `packages/contracts/src/team.ts`, the `team-layer:` lines in `auth.ts`, `server.ts`, `ws.ts`, `bin.ts`, `cli/pair.ts`, `McpHttpServer.ts`.
- Upstream source control code that the plan reuses: `sourceControl/gitHubAuthStatus.ts`, `GitHubSourceControlProvider.ts`, `SourceControlRateLimit.ts`, the GitLab, Bitbucket, Azure DevOps and Forgejo providers, `pullRequest/PullRequestService.ts` (cache times).

## 2. The four open questions (VISION.md section 2)

### Q1. Public repos

**Answer: recommend private repos. For a public repo, refuse unless the person explicitly accepts that team state is public. No encryption and no second repo in v1.**

What is on the ref, and so public on a public repo: GitHub logins, task titles and notes, file paths being worked on, handoff notes (what changed, what is left, risks), and when each person works. For a school project that is more than most students want public, and likely more than the course allows.

Facts:

- GitHub Free gives unlimited private repos with unlimited collaborators, for personal accounts and organizations ("unlimited private repositories with a limited feature set") [docs: [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)]. So "make it private" costs a student team nothing.
- Every ref of a public repo can be read by anyone: `git ls-remote` on our fork (public, checked with `gh api repos/MouhssineElBoumshouli/t3code` → `"visibility":"public"`) answered `200` without sending any `Authorization` header [measured]. A hidden ref (see 4.1) does not change this: it is listed and fetchable by anyone.
- Upstream already has the API calls to read a repo's visibility through `gh` and the other host CLIs (`createRepository` takes a `visibility`; `gh api repos/{owner}/{repo}` returns `private`) [code: `sourceControl/*`; measured].

Why not the other two options:

- **Encrypt it.** Every teammate needs the key. Handing out keys is the invite and token machinery VISION.md just removed. It also breaks the simple rule "write access to the repo = on the team": someone added to the repo would still need a key. Encrypted JSON also makes the state impossible to debug by eye.
- **A separate private repo.** Two access lists, two remotes, two "add me" steps. Joining stops being "get added to the repo, open the project". Worth keeping as a later option for open source projects, not for v1.

How sure: high on the facts. The choice is my judgment.

### Q2. Polling cost

**Answer: fine, as long as the check is an authenticated conditional API request, not a bare `git fetch`. A no-change check costs nothing against the rate limit. Only real changes cost one API call plus one small fetch.**

Facts:

- GitHub's REST API allows 5,000 requests per hour per user [docs: [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)]. "Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized" [docs: [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)].
- Checked here: `gh api -i repos/…/git/ref/heads/test-screenshots` returned an `ETag` with `X-Ratelimit-Used: 6`. The same call with `If-None-Match` returned `304 Not Modified` with `X-Ratelimit-Used: 6`, so it was not counted [measured].
- The same endpoint works for a non-branch ref: `git/ref/t3-team/probe` returned `200` with an `ETag` [measured, with a throwaway ref that was deleted right after].
- One check every 15 seconds is 240 requests an hour per person. Even if every one of them counted, that would be under 5% of the budget. Upstream's pull request features use the same `gh` budget and cache for 15 to 60 seconds [code: `PullRequestService.ts:130-148`], so we do not crowd them out.
- Git reads of a public repo are anonymous: no `Authorization` header was sent [measured]. GitHub tightened limits for unauthenticated requests, cloning over HTTPS included, in May 2025 [docs: [changelog 2025-05-08](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)]. GitHub publishes no numbers for authenticated Git operations; I found none in its docs. That is why the check should not be `git ls-remote` every 15 seconds.
- Sizes and times [measured, this laptop, WSL, to github.com]: `git ls-remote origin <one ref>` took 0.50 to 0.52 s and received 409 bytes of body. A shallow `git fetch --depth=1` of one small ref into a fresh bare repo took 0.71 to 0.74 s, and the repo was 108 KB.
- GitHub says to prefer webhooks over polling [docs: best practices]. We have no server to receive them, which is the whole point of the change. The Events API is not live enough for this. Polling with ETags is GitHub's own fallback.

Plan: every 15 seconds while the app runs, a conditional `GET /repos/{owner}/{repo}/git/ref/<ref>` through `gh`'s token. On `304`, do nothing. On a new SHA, `git fetch --depth=1` that one ref. Without a signed-in `gh`, fall back to `git ls-remote` every 60 seconds. On errors, back off the way upstream's `SourceControlRateLimit` does (30 s, up to 15 min) [code].

How sure: high for the REST side. Medium for Git protocol limits, since GitHub does not publish them.

### Q3. Git hosting

**Answer: GitHub only in v1, but only three small calls are GitHub-specific. Put them behind one interface, so GitLab and others need a new implementation of those three, not a new store.**

The store itself is plain Git (fetch one ref, write a commit on top, push without force), and that works on any Git host. Host-specific:

1. **Who am I** (the login). GitHub: `gh auth status --json hosts`, which upstream already parses [code: `sourceControl/gitHubAuthStatus.ts`]. GitLab: `glab`; upstream already has `GitLabCli.ts` and `gitLabAuthStatus.ts` [code].
2. **Can I push, and is the repo public.** GitHub: `gh api repos/{o}/{r}` → `permissions.push`, `private` [measured]. GitLab: the project API (`permissions`, `visibility`). Upstream has providers for GitLab, Bitbucket, Azure DevOps and Forgejo [code: `sourceControl/`], so the plumbing exists.
3. **Did the ref change** (the cheap check). GitHub: REST with `ETag` (Q2). Others: `git ls-remote` until we check their conditional request support. GitLab.com limits on Free are 5,000 authenticated API requests an hour, 100 a minute burst, 10,000 authenticated Git HTTPS requests a minute, and 600 Git SSH operations a minute per user, project and command [docs: [GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/rate_limits/)]. So `ls-remote` polling would be fine there.

Not yet known for other hosts: whether they accept pushes to a non-branch ref (only matters if you pick option B in 4.1), and how their branch protection treats a `team-state` branch. Check both before supporting a host.

How sure: high that the Git part is portable. Medium on the GitLab details (docs only, not tried).

### Q4. Speed

**Answer: a few seconds is enough for claims, with two additions. (1) Fetch right before answering a claim. (2) An overlap found later by a sync is reported to both people, once.**

How long a claim takes to reach a teammate (estimates from the measured times above):

- Writing the claim: the local write is instant. The push takes about a fetch (0.7 s measured) plus a push: `git push origin main` of one small commit took 2.11 s [measured]. So about 3 s.
- A teammate sees it at their next check: up to 15 s later, plus 0.7 s to fetch. Worst case about 18 s, about 10 s on average.

Race: Sara and Yassine both claim `login.ts` within the same couple of seconds. Each push succeeds, because each writes only their own file (no conflict, see 3.2). Each answer was computed before the other's claim arrived, so each agent heard "no overlaps". Today overlaps are computed only inside `claimPaths` [code: `TeamService.ts:683`], so nobody would ever be told. The fix:

- **Fetch first.** `claimPaths` fetches (with a 3 s budget) before computing overlaps. That shrinks the race window from about 15 s to the other person's fetch-to-push time, about 3 s.
- **Late overlaps.** After every sync, compare this server's active claims with everyone else's. A pair that overlaps and was not reported before is saved as "late overlap", and the next `team_status` or `team_claim` result for that thread says so once: "Since you claimed, Yassine also claimed src/auth/login.ts." Both sides see it, as VISION.md asks.
- **Not confirmed.** If the push did not land (offline, or the 3 s budget ran out), the result says "Claimed on this computer, not shared yet. Overlaps unknown." VISION.md asks for this too.

Limit: the agent hears about a late overlap only at its next team tool call. Nothing in the code can put text into a turn that is already running [code: the briefing is static, D4]. VISION.md step 3 (the visible card) covers the human. VISION.md's own flow, plan first and then claim before writing code, keeps this window small in practice.

Clock differences between laptops only change the order claims are listed in, not whether they overlap. The overlap check does not use times.

How sure: medium. The parts (fetch, push, check) are measured one at a time; the end-to-end time is an estimate until slice 7 measures a full sync.

**Measured on GitHub (2026-10-07), next to the estimates above.** The real `TeamStateRepo` (slice 2) with two writers ("Sara", "Yassine": two state repos on this laptop) against the private scratch repo `t3-team-scratch`, over HTTPS with `gh auth git-credential`. Three runs of 5 rounds and 3 same-moment races each. The table uses the last two runs (10 rounds, 6 races); I cut off the first run's output when printing it, and the rounds I saw were in the same range. The ref was deleted afterwards [measured]:

| Step                                                   | Estimate      | Measured (min–max, median)                                     |
| ------------------------------------------------------ | ------------- | -------------------------------------------------------------- |
| Write a claim (sync: fetch, commit, push)              | about 3 s     | 2.55–3.04 s, 2.7 s                                             |
| First sync that creates the ref                        | –             | 2.37 s (once)                                                  |
| Sync with nothing new (fetch only, no push)            | –             | 1.07–1.48 s, 1.08 s                                            |
| Teammate's ETag check, ref moved (`200`)               | –             | 0.47–0.57 s, 0.52 s                                            |
| Teammate's ETag check, nothing moved (`304`)           | –             | 0.45–0.64 s, 0.48 s; not counted against the limit             |
| Teammate's fetch of the new tip (depth 1)              | 0.7 s         | 0.99–1.21 s, 1.1 s                                             |
| Teammate's read of the tree (local)                    | –             | 14–19 ms                                                       |
| Claim to teammate, without the wait for the next check | –             | 4.2–4.7 s, 4.35 s                                              |
| Both push at the same moment                           | "redo, works" | 6 of 6: both land, the later one on its 2nd attempt, 5.3–5.8 s |

- So a claim reaches a teammate in about **4.4 s plus the wait for their next 15 s check**: about 12 s on average and about 19 s at worst, against the 10 s and 18 s estimated. A fetch is slower than the 0.7 s measured earlier on the public fork (an authenticated fetch through the credential helper), and it is the larger part of a sync.
- "Fetch first" in `claimPaths` costs about 1.1 s, inside its 3 s budget.
- `gh api` exits with code 1 on a `304`, so TeamHost reads the status line, not the exit code.
- The ETag check used 2 rate limit points per round (the `200` and a plain read to reset the ETag); every `304` left `X-Ratelimit-Used` unchanged.
- History after a fresh run: 17 commits, 1 root and 16 with exactly one parent. Only fast-forwards landed.

## 3. Plan for step 1: the storage swap

### 3.1 What stays the same

`TeamService` (`apps/server/src/team/TeamService.ts`) is the only way M1 code reaches team state [code: every caller found by `grep`]:

| Caller                                                            | Methods it uses                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/toolkits/team/resolve.ts` (tools, briefing, automatic notes) | `getTeam`, `findMemberByEnvironment`                                                                                                                                          |
| `mcp/toolkits/team/handlers.ts` (5 tools)                         | `listMembers`, `listTasks`, `listActiveClaims`, `listActivity`, `claimPaths`, `releasePaths`, `findTaskForThread`, `createTask`, `updateTask`, `listHandoffs`, `writeHandoff` |
| `team/TeamAutoNotes.ts`                                           | `findTaskForThread`, `saveAutomaticNote`                                                                                                                                      |
| `team/TeamClaimAutoRelease.ts`                                    | `listClaimedThreads`, `releaseThreadClaims`                                                                                                                                   |
| `cli/team.ts` (`init`, `status`)                                  | `getTeam`, `ensureTeam`, `listTeams`, `listMembers`                                                                                                                           |
| `team/TeamInvites.ts` (host mode, parked)                         | `addMember`, `findMemberByEnvironment`, `getTeam`, `listMembers`                                                                                                              |

So the swap is: a new implementation of the same service, swapped in at the one `team-layer:` line in `server.ts:540`. Two methods change because the idea behind them changes (3.4).

Freshness needs nothing from storage. `checkFreshness` uses only Git in the caller's own checkout: blob hashes, `log --find-object`, `merge-base` [code: `memory.ts:463-514`]. It already handles notes written in another copy ("not merged yet"). One small loss: handoffs store their file contents with `hash-object -w` in the writer's own repo [code: `memory.ts:327-357`], so a teammate on another clone gets "content of X changed" without the `+N -M lines` counts. That is acceptable, and `linesSince` already returns null then [code: `memory.ts:391-406`].

Rulebook, decisions and "Do not touch" stay in `.team/` on the normal branch, read from the checkout [code: `rulebook.ts`, `readDecisions`]. No change.

### 3.2 The state on GitHub

One ref in the project's own repo, `refs/t3-team/state` (decision 1 in section 5). Its tree:

```
team.json                                   { "format": 1, "teamId", "name", "createdBy": "<login>", "createdAt" }
writers/<login>/<environmentId>.json        everything this one T3 server wrote
```

One writer file per **(GitHub login, T3 server)**:

```json
{
  "format": 1,
  "login": "MouhssineElBoumshouli",
  "displayName": "MouhssineElBoumshouli",
  "environmentId": "…",
  "lastSyncAt": "2026-10-07T10:00:00.000Z",
  "claims": [],
  "tasks": [],
  "notes": [],
  "activity": []
}
```

- `claims`: active ones, plus ones released in the last 7 days (so activity can still name them), at most 200.
- `tasks`: this writer's latest version of every task it created or changed (see 4.3). A reader keeps, per `taskId`, the version with the newest `updatedAt`. Ties go to the larger writer key, so every reader picks the same one.
- `notes`: handoffs and automatic notes this server wrote, newest 200 (`TEAM_MEMORY_LIMITS.handoffs` is already 200 [code: `memory.ts:23`]).
- `activity`: newest 100 lines.
- Unknown fields are kept and ignored, so an older app does not break on a newer file. A writer file that does not parse is skipped with a warning; it never breaks the others.

Why per T3 server and not per person: a thread is named by `(environmentId, threadId)` [code: `TeamThreadRef`, `contracts/team.ts:76-81`], and a person can run two T3 servers (laptop and desktop, or the two clones on one laptop in VISION.md step 2). With one file per login, two servers of the same person would edit the same file and their pushes would conflict, the thing VISION.md set out to avoid.

**Writes never conflict.** A write is: take the newest remote tree, replace only my own writer file, commit with the remote tip as parent, push without force. If the push is refused because someone pushed first, fetch and do it again (up to 5 times). Nobody else ever writes my file, so redoing it always works. Force pushes are never used.

**Offline needs no queue.** My writer file on disk is the truth for my part. A sync makes the remote copy of my file match it. While offline, nothing is lost; the next successful push carries all of it.

### 3.3 Where it lives on this computer

`<T3 home>/team/<teamId>.git`: a bare Git repo used only for team state. Its `origin` is the project's own remote URL, so pushes use the same credentials as the person's normal pushes (on this laptop, `gh auth git-credential` [measured: `git config --get-regexp credential`]). It fetches only the state ref, with `--depth=1`.

Why not use the project checkout itself: no risk of touching the person's working tree, index, branches or stash, and no team objects in their repo. Also, the folder list doubles as the list of teams this server is in, which `TeamClaimAutoRelease`'s startup pass needs [code: `releaseInactive`, `TeamClaimAutoRelease.ts:155-163`].

All Git commands run through upstream's `GitVcsDriver.execute`, like `memory.ts` does [code], with `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging.

In memory: per team, the parsed state at the last fetched tip plus my own writer file. Reads are array filters on that, so the tools never wait on the network, except `claimPaths` (Q4).

### 3.4 Identity and membership

- **Login**: the active GitHub account from `gh auth status --json hosts`, for the remote's host, parsed with upstream's `parseGitHubAuthStatus` and `findAuthenticatedGitHubAccount` [code]. Checked here: `MouhssineElBoumshouli`, token scopes include `repo` [measured].
- **In the team** means: the repo has `.team/team.json`, the state ref exists on the remote, and `gh api repos/{o}/{r}` says `permissions.push: true` (cached 10 minutes, like upstream's `VIEWER_CACHE_TTL` [code: `PullRequestService.ts:146`]). Without push access, the tools answer read-only with a plain reason.
- **Dev only**: `T3CODE_TEAM_LOGIN_OVERRIDE` lets two dev servers on one laptop act as two people (VISION.md step 2 says "two clones on one laptop", and both would otherwise be the same login). It is refused unless the server runs in dev mode.
- The "not in team" messages in `resolve.ts` change: "hosted on another T3 server" [code: `hostedElsewhere`] becomes the real reason: not signed in to GitHub, no push access, or no team state on the remote yet (run `t3 team init`).

Contract change in `packages/contracts/src/team.ts` (our file): `TeamMember` drops `environmentId` (one person, many servers) and `memberId` becomes the login. `findMemberByEnvironment(teamId, environmentId)` becomes `currentMember(teamId)`. `addMember` and `ensureTeam`'s owner input go away: a member exists once their writer file does. `role` stays: `owner` is `team.json`'s `createdBy`, everyone else `member`. That is display only; there are no owner powers left without a host.

### 3.5 Files

New (ours):

| File                                           | What                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/teamState.ts`          | Schemas for `team.json` and the writer file (format 1).                                                                                                                                                                                      |
| `apps/server/src/team/state/TeamStateModel.ts` | Pure functions. Writer files → one team view (members, active claims, tasks after last-writer-wins, notes, activity, late overlaps). Each write (claim, release, task, handoff, automatic note, activity line) → my new writer file. No I/O. |
| `apps/server/src/team/state/TeamStateRepo.ts`  | The bare repo in the T3 home: init, fetch the ref, read the tree, commit my file on top of the remote tip, push without force, retry.                                                                                                        |
| `apps/server/src/team/state/TeamHost.ts`       | The three host calls (Q3): login, `canPush`/`isPublic`, `refChanged` (ETag). GitHub through `gh`; a fake for tests.                                                                                                                          |
| `apps/server/src/team/state/GitTeamService.ts` | `TeamService` built on the three above, plus the 15 s poller and late overlaps.                                                                                                                                                              |
| Tests next to each.                            |                                                                                                                                                                                                                                              |

Changed (ours): `TeamService.ts` (interface only: 3.4, plus `confirmed` on `claimPaths`), `mcp/toolkits/team/{resolve,handlers,tools}.ts` (membership reasons, late overlaps, "not shared yet"), `cli/team.ts` (`init` creates the ref, `status` reads it), `contracts/team.ts` (3.4).

Upstream, one `team-layer:` line each: `server.ts` (provide `GitTeamService.layer` instead of `TeamService.layer`; drop `teamHttpRoutesLayer`), `bin.ts` unchanged (`t3 team` stays).

Left alone: the SQLite team tables and migrations 1 to 4. Existing dev homes have them, and removing migrations from the list buys nothing. They are simply no longer read. Old demo teams are not imported: they are test data, so re-run `t3 team init` on a fresh demo instead (YAGNI).

### 3.6 Parking host mode (M2.2, M2.3)

1. Tag the last commit where host mode worked: `git tag team-host-mode-m2.3 fc0dc2691` and push the tag. That is the runnable copy.
2. `git mv` the host-mode files to `team/parked/host-mode/` at the repo root, keeping their folder layout: `apps/server/src/team/http/*`, `TeamInvites.ts`, `TeamInvites.test.ts`, the invite and invites parts of `cli/team.ts`, `packages/contracts/src/teamHttp.ts`, and the SQLite `TeamService` once the swap is done. `team/` is in no `tsconfig` `include` [code: `apps/server/tsconfig.json`], so parked files are neither compiled nor tested and cannot rot the build. Add a short `team/parked/README.md`: what is there, the tag, and that it does not build against the current service.
3. Unmount: remove the `teamHttpRoutesLayer` line in `server.ts`, the `teamHttp.ts` export in `contracts/index.ts`, and the `invite`/`invites` subcommands.
4. Scopes `team:read`/`team:write` in `contracts/auth.ts` (and the two lines in `EnvironmentAuth.test.ts`): reverted, which leaves two fewer upstream edits (decision 4 in section 5).
5. **Keep the `ws.ts` fix** (`authorizeEffect`/`authorizeStream` on `chatGptReconnectProfile`, `chatGptImportProfile`, `chatGptHandoffSubscribe`) [code: `ws.ts:2513`]. Its only test today is the S2 walk inside `security.test.ts`, which mints team-scoped sessions, so parking would drop it. Replace it with `apps/server/src/auth/ChatGptRpcScopes.test.ts` (ours): a session from a pairing link with only `orchestration:read` calls the three RPCs and each is refused (they require `orchestration:operate` [code: `RpcAuthorization.ts:40-42`]). Mutation check: revert `ws.ts` and the test must fail.

### 3.7 Slices

Each slice: its own commit, focused tests, a PROGRESS.md entry, and a self-test where there is something to see. No slice changes what a running dev server does until slice 5.

**Slice 0: park host mode.** Section 3.6. Test: the team suites still pass without the parked files; the new ws.ts test passes, and fails with `ws.ts` reverted; on a dev server `GET /api/team/v1/me` is 404 and `t3 team --help` lists `init` and `status` only.

**Slice 1: the state format and model, no I/O.** `teamState.ts`, `TeamStateModel.ts`. Tests: two writers' files merge into one view; the same person on two servers counts as one member with two writers; concurrent task edits resolve the same way on every reader; caps; a broken or newer-format writer file is skipped or tolerated; late overlaps are found once, from both sides; a 7-day-old released claim drops out.

**Slice 2: the Git repo for state.** `TeamStateRepo.ts`. Tests use a local bare repo as `origin` (a `file://` remote: real Git, no network) and two state repos as two writers. Both push at once and both land, with no force; a push refused for being behind is redone; with `origin` unreachable, the write is kept and the result says "not confirmed", then a later sync lands it; `git log` of the ref shows only fast-forwards. Also time a real sync to GitHub once, on a scratch private repo, to check the Q4 numbers (done 2026-10-07, see the table in Q4).

**Slice 3: identity and host calls.** `TeamHost.ts`. Tests with a fake process runner: login from `gh auth status --json` (several accounts, the active one wins, signed out), `canPush`/`isPublic` from `gh api`, ETag `304` handling, the dev override refused outside dev mode.

**Slice 4: `GitTeamService`, not wired yet.** Run the behaviour tests from `TeamService.test.ts` against it, adapted for 3.4 (that suite is the contract M1 relies on). New tests: a claim fetches first; late overlaps; the "not shared yet" result.

**Slice 5: the switch.** `server.ts` provides `GitTeamService`. `resolve.ts` gives the new reasons, and the handlers show late overlaps and "not shared yet". Tests: `handlers.test.ts`, `briefing.test.ts`, `memory.test.ts`, `TeamAutoNotes.test.ts`, `TeamClaimAutoRelease.test.ts` all pass on the new store, using a local bare `origin`. Self-test: the cold start test (COLD_START_TEST.md) on a fresh demo repo with a local bare remote, run in the browser with Playwright.

**Slice 6: `t3 team init` and `status` on the new store.** `init` still writes `.team/` and never commits it (M1). It then shows what it will create on the remote and creates the state ref (`team.json`, the first writer file), after `--yes` or a prompt. On a public repo it refuses unless `--public-ok` (Q1). `status` lists members and claims from the ref. Tests: init on a repo with a local bare remote; a second init is a no-op; a clone that already has `.team/` joins instead of creating a team; the public refusal.

**Slice 7: the poller.** Every 15 s: ETag check, fetch on change, rebuild the view, find late overlaps. Fallback to `ls-remote` every 60 s without `gh`; back off on errors. Tests with the test clock and the fake host: no fetch on `304`; one fetch per change; backoff; stops when the server stops.

**Slice 8: two people for real.** The test plan of VISION.md step 2, on one laptop: two dev servers on separate homes (`~/.t3-dev`, `~/.t3-dev-member`), two clones of one **private** scratch GitHub repo, `T3CODE_TEAM_LOGIN_OVERRIDE` for the second person. Claims, tasks and handoffs cross over within about 20 s; the same-second claim race warns both. You create the scratch repo; I never create GitHub repos on your account without asking. Mind the memory rule: two dev servers at once, so no typecheck while they run.

## 4. What the code shows is a bad idea in VISION.md, and what to do instead

### 4.1 A real branch called `team-state`

Problem: Git's default fetch rule is `+refs/heads/*:refs/remotes/origin/*` [measured: `git config --get remote.origin.fetch`]. So every teammate's normal `git fetch`/`git pull` downloads the team-state commits, which change every few minutes, and `origin/team-state` shows in every branch list. That includes T3 Code's own branch list, which returns remote branches too [code: `GitVcsDriverCore.ts` `listRefs`, `isRemote: true`]. GitHub also shows the pusher a "had recent pushes — Compare & pull request" banner for recently pushed branches (from memory, not checked). And a school org's branch rulesets that "restrict creations" or "restrict updates" by name pattern can block it [docs: [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)].

Instead (option B): a hidden ref, `refs/t3-team/state`. Checked on our fork with a throwaway ref: GitHub accepted the push (`* [new reference] … -> refs/t3-team/probe`), `git ls-remote` listed it, the REST API served it with an `ETag`, and deleting it worked [measured; nothing left behind: `ls-remote 'refs/t3-team/*'` returns 0 lines]. Default fetches never download it, and no branch list shows it.

Cost of option B: you cannot browse the state on github.com (debug with `git fetch origin refs/t3-team/state` or `t3 team status`). It is still public on a public repo (Q1). Rulesets that target branches do not apply to it, which is good for us, though an org that wants to block it cannot. Other hosts need checking (Q3).

Decided: option B (decision 1). The ref name is one constant.

### 4.2 "Each person only writes their own files", keyed by person

As 3.2 says: the code names threads by server, and one person can have two servers. Key writer files by (login, server). VISION.md's own step 2 (two clones on one laptop, one GitHub account) would hit this on day one.

### 4.3 Tasks are shared, so "only your own files" does not hold for them

`team_task` updates a card, and M2's decision 7 lets a member "take an unowned task" [code: `TeamService.updateTask`; DESIGN.md 7.5]. That is one person changing another's record. Instead: every writer writes its own version of the task, and readers pick the newest (3.2). Two people moving the same card in the same seconds: the later one wins, and activity shows both. Fine for a 4-person team. Do not build anything heavier.

### 4.4 3.5 "the claim fades and others are told"

Nobody but the owner may write the owner's file, so nobody can "fade" someone else's claim. Instead: readers compute it. A claim whose writer has not synced for N days (`lastSyncAt` in the writer file) is shown as "probably free (Yassine has not been online since Monday)". Nothing is written. The question to the owner ("Still working on login?") is asked by the owner's own app when it next starts.

### 4.5 Claims are released on merge only by the claimer's own server

`TeamClaimAutoRelease` releases a thread's claims when its pull request merges, but it runs on the claimer's server and only while that server runs [code: `TeamClaimAutoRelease.ts`, module comment]. In the new model, if Yassine's laptop is closed when his PR merges, his claims stay until he opens the app. Instead: readers also treat a claim as released when its branch is merged into the default branch. That needs the branch on the claim, so add an optional `branch` field to claims in format 1 now: one field, and it saves a format change later. Building the reader-side check is for step 4, not step 1. VISION.md 3.3 ("read the teammate's unmerged changes, their pushed branch") needs the same field.

### 4.6 "Identity: the git/GitHub sign-in they already have"

Git itself has no login: `user.name` and `user.email` are free text, and HTTPS pushes use whatever credential helper is set. The login has to come from `gh` (or an in-app GitHub sign-in later). Also, anyone with push access can write any writer file, so the "own files" rule is a convention, not security. GitHub's "restrict file paths" push rule could enforce it [docs: available rules], but it is not per user. That is fine for a team that can already push code to each other's branches. Say it plainly in the docs; do not present it as protection.

### 4.7 "Install in 2 minutes, no terminal" vs needing `gh`

Upstream already needs `gh` for its pull request features [code: `GitHubSourceControlProvider.ts` `installHint`], and step 1 uses it too. For VISION.md step 6 (installer), plan an in-app GitHub sign-in, because a student should not have to install `gh` and run `gh auth login`. Not part of step 1. Noted so the installer plan includes it.

### 4.8 "Fetches the branch every 10 to 20 seconds"

A `git fetch` every 15 s is anonymous on a public repo (Q2) and pointless when nothing changed. Use the ETag check and fetch only on change. Same speed, nearly zero cost.

### 4.9 A commit after every change, forever

`TeamAutoNotes` saves a note after every turn [code], so the ref gets a commit per turn per person: thousands over a semester. Each one is tiny, and `--depth=1` fetches mean nobody downloads the history. But history can only be trimmed by force-pushing, which races with teammates. Instead: wait 2 seconds after a change and push everything changed in that time together, keep the per-file caps (3.2), and accept the history. If it ever matters, a new format can start a fresh ref. Not needed for v1.

## 5. Decisions (made 2026-10-07)

All five went with the recommendation.

1. **Ref name**: the hidden ref `refs/t3-team/state` (4.1), not a `team-state` branch.
2. **Public repos**: `t3 team init` refuses on a public repo unless run with `--public-ok` (Q1). Slice 6 builds it.
3. **Writer files** per (GitHub login, T3 server), not per login (3.2, 4.2). VISION.md's wording now says the same.
4. **Scopes**: `team:read` and `team:write` are reverted from `contracts/auth.ts` while host mode is parked (slice 0).
5. **Parking**: `git mv` to `team/parked/host-mode/` plus the tag `team-host-mode-m2.3` on fc0dc2691 (3.6, slice 0). The `ws.ts` security fix stays, with its own regression test.
