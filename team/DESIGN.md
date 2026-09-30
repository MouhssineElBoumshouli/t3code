# Team layer design (v1)

Status: draft, 2026-09-30. Owner: Mouhssine. Written by Claude (chat) after reading the T3 Code source at commit a8e385e6.

Every claim about T3 Code below is marked **[checked]** (read in the code or docs) or **[verify]** (still needs checking in the code before we build on it).

## 1. What we are building

T3 Code lets one person run real agents (Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity) from one app. We add a team layer so many people can work on the same Git repo at once:

- every agent knows the project rules, who is doing what, and its own task
- agents warn before two people touch the same files
- work can be handed from one person to another with its context
- nothing about normal single-person use gets worse

Non-goals for v1: our own editor, our own agent, replacing Git or pull requests, live co-typing in one file.

## 2. Facts from T3 Code that shape the design

- **One environment owns the work.** Each person runs their own T3 server (an "environment"). It owns their files, agents, Git and database. Environments do not share databases. [checked: docs/internals/overview.md, remote.md, environment-auth.md]
- **Pairing grants scopes.** A pairing link gives a limited set of permissions ("scopes"), and every server call declares the scope it needs. [checked: docs/internals/environment-auth.md, apps/server/src/auth/RpcAuthorization.ts]
- **Remote reach already exists.** Direct network, Tailscale, SSH and T3 Connect all reach a server the same way. [checked: docs/internals/remote.md]
- **Repos have a shared identity.** A repo gets a `canonicalKey` from its Git remote, so two people's clones of the same GitHub repo match. [checked: packages/contracts/src/environment.ts, RepositoryIdentity]
- **Every agent already gets a T3 tool server.** T3 attaches an MCP tool server named `t3-code` to its agents, with tool sets for preview, device and pull requests. [checked: apps/server/src/mcp/toolkits/, CodexDeveloperInstructions.ts]
- **Every agent already gets extra instructions.** `buildRuntimeInstructions()` builds a shared instruction block used by the provider adapters. [checked: apps/server/src/provider/RuntimeInstructions.ts] Whether every provider receives it on every turn or only at session start: [verify]
- **T3 knows what each turn changed.** A `thread.turn-diff-completed` event fires after each turn, backed by hidden Git checkpoints. [checked: apps/server/src/orchestration/decider.ts, docs/internals/overview.md]
- **Approvals exist per provider** (Claude `canUseTool`, Codex `fileChange/requestApproval`), but only fire in permission modes that ask. [checked: ClaudeAdapter.ts, CodexSessionRuntime.ts] So they cannot be our main way to stop conflicts.
- **Upstream moves fast** (many commits a day) and does not require Windows tests. We develop in WSL.

## 3. Decisions

### D1. The Brain is a T3 server in "team host" mode

One T3 environment on the team acts as the host. It stores team state and serves team calls. Other members' T3 servers connect to it server-to-server.

- **v1 host:** a teammate's computer (Option A). Reached over Tailscale, which T3 already supports.
- **Later:** the same thing on a small online server with `npx t3 serve`. No code change, only where it runs.
- **Members join with an invite** that is a pairing grant limited to new `team:*` scopes. A member can read and write team state, and nothing else. They cannot see the host's files, threads or agents.
- **Rejected:** a separate Brain service. It would need its own auth, install and hosting. Reusing T3's server, pairing and scopes is less new code and matches how T3 already works.

**When the host is offline:** everyone keeps working normally. Team features show "offline". Writes (claims, handoffs) wait in a local queue and send when the host is back. Rules and decisions still work, because they live in the repo (D3).

### D2. A team is one Git repo

A team is keyed by the repo's `canonicalKey`. When a member opens a project whose key matches a team they joined, the team layer turns on for that project. Other projects are untouched.

### D3. Memory lives in three places

| What                  | Where                                                     | Why                                                                                                 |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Rulebook              | `.team/rulebook.md` in the project repo                   | Changes go through Git and pull requests like code. Hard cap: 1,500 words.                          |
| Decisions             | `.team/decisions/NNNN-short-title.md` in the project repo | One short file per decision. Front matter lists files it is about and the commit it was written at. |
| Live state            | Host database (SQLite, like the rest of T3)               | Members, active agents, claims, tasks, handoff notes, activity feed. Changes too often for Git.     |
| Personal chat history | Each provider's own history, unchanged                    | Private. Only summaries get shared.                                                                 |

The `.team/` folder is in the user's project, not in our app's repo.

### D4. How memory reaches agents

Add a `<team_context>` section to `buildRuntimeInstructions()` so every provider gets it the same way.

Budget: about 1,200 tokens total, in this order:

1. One line on the rules: "Project rules are in `.team/rulebook.md`. Read it before your first change."
2. Team board snapshot: each teammate, their task, their claimed paths. Short.
3. This thread's task card: goal, paths, done-when, the last handoff note.
4. A pointer to the team tools for anything else.

Anything bigger goes through tools (D5), never pasted in. If the snapshot is over budget, cut the oldest items first.

[verify] If instructions only arrive at session start for some providers, the board snapshot goes stale during long sessions. Fallback: `team_status` tool, plus an instruction to call it before editing new files.

### D5. Team tools

A new tool set at `apps/server/src/mcp/toolkits/team/`, built like `pullRequests/`:

| Tool                                 | What it does                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `team_status`                        | Returns the team board: who, what task, which paths.                                                    |
| `team_claim` / `team_release`        | Claim or release paths (files or folders) with a short note. Returns any overlap with others.           |
| `team_task_get` / `team_task_update` | Read this thread's task card, update its status and note.                                               |
| `team_handoff_write`                 | Save a handoff: what changed, what's left, risks. Max 150 words.                                        |
| `team_memory_search`                 | Search decisions and handoffs. Returns the top 3 to 5, short, each marked fresh or maybe-outdated (D7). |
| `team_decision_propose`              | Write a new `.team/decisions/` file in the working copy, so it gets committed with the work.            |

Tools only show up when the project belongs to a team, same as how preview and device tools only show up when available.

### D6. Conflicts

Five layers, cheapest first:

1. **Split the work.** Tasks come with paths. (Planner UI comes after v1.)
2. **Claims.** Agents are told to claim paths before editing, via `team_claim`.
3. **Automatic claims.** On `thread.turn-diff-completed`, the member's server claims every file the turn changed and checks it against others' claims. Overlap sends a warning to both people. This works for every provider and every permission mode, because it does not rely on the agent obeying.
4. **Separate copies.** Each thread works on its own branch or worktree, as T3 already supports. [verify how T3 names and creates them]
5. **Pull requests.** Git stays the final judge.

Later, not v1: hard blocking through the approval layer for teams that want it, and a dry-run merge check between teammates' pushed branches.

### D7. Keeping memory fresh

- Every decision and handoff stores the files it is about and the commit it was written at.
- When `team_memory_search` returns it, the server checks whether those files changed since that commit. If yes, it is marked "maybe outdated: files changed since".
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

A Kanban board (columns: To do, In progress, In review, Done) built on the same task cards agents already read in D4 and D5. One source of truth for people and agents.

Cards move from real activity, not by hand:

- A thread starts on a card → **In progress**
- A pull request is linked to the card's thread → **In review** (T3 already tracks PRs per thread)
- The PR merges → **Done**
- The agent waits on an approval or keeps failing for a set time → card turns red, owner gets told

Each card shows its paths. Two cards touching the same paths are flagged on the board before anyone starts.

Smart features on top of the board, after v1:

- **Plan to cards.** Describe a feature, the planner splits it into cards with paths and flags overlaps between cards.
- **Waiting on.** Card B can wait for card A. When A merges, B's owner is told, and B's agent gets a catch-up note.
- **Auto standup.** A short daily summary per person, written from real activity.
- **Decisions from merges.** When a PR merges, the cleaner suggests decision notes for a human to approve.
- **GitHub Issues sync.** Cards can link to GitHub Issues both ways, so teams keep the tracker they already use.

## 4. How we keep upstream merges easy

- New code goes in new folders: `mcp/toolkits/team/`, `apps/server/src/team/`, `packages/contracts/src/team.ts`, and a `team/` area in the web UI.
- Team state on the host lives in its own tables and service, outside the orchestration decider. We only read orchestration events (like turn diffs); we do not add team events to the orchestration log.
- Edits to upstream files stay small and are marked `team-layer:`. Expected spots: `RuntimeInstructions.ts`, where toolkits are registered, RPC contract/authorization for `team:*` scopes, and the UI entry points.
- Pull from upstream weekly, on its own branch, then merge.

## 5. Milestones

- **M1, solo:** team tools, host mode on your own machine, `<team_context>` injection, handoff notes, `.team/` files. Pass the cold start test with Claude Code and Codex.
- **M2, two people:** server-to-server connection, `team:*` scopes, invite links, offline queue. Test with one friend over Tailscale.
- **M3, conflicts:** automatic claims from turn diffs, overlap warnings, team board in the UI.
- **M4, team features:** the self-moving task board (D9), catch me up, handoff UI, then guide mode.
- **Later:** plan to cards, waiting on, auto standup, decisions from merges, GitHub Issues sync, phone approvals, shared skills, usage per person, online host, own name, open source launch.

## 6. Questions to answer in the code before M1

1. Does each provider adapter send `buildRuntimeInstructions()` every turn, or only at session start? List per provider.
2. Where are MCP toolkits registered and turned on per thread? What decides if preview/device tools are available?
3. How does a toolkit handler know which thread, project and repo it is called from? (`McpInvocationContext`)
4. How are thread worktrees and branches created and named?
5. Can a server-side service subscribe to `thread.turn-diff-completed` and read the list of changed files?
6. How are RPC scopes defined and checked? What would adding `team:read` and `team:write` touch?
7. Is there an existing way for one T3 server to call another as a client (for example via `packages/client-runtime`), or is that new?
8. Where does the server keep its SQLite migrations, and how would we add team tables without touching upstream ones?
9. Which events tell us a thread started a turn, linked a PR, had its PR merged, or is waiting on an approval? (Needed for the self-moving board in D9.)
