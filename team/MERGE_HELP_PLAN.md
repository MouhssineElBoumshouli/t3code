# Merging help: plan (VISION.md step 5)

Status: slice 1 (section 8, point 1) built 2026-10-13 (`TeamMergeCheck.ts`); slice 2 (point 2, "Fix it") and the turn-note line built 2026-10-13 (`TeamMergeFix.ts`); slice 3 (point 3, merge order and "Update my copy") built 2026-10-14 (`mergeOrder.ts`, `TeamMergeFix.ts`); slice 4 (point 4, the typecheck combine copy) built 2026-10-14 (`TeamCombineCheck.ts`, `combineCheck.ts`, `combineRunner.ts`). Covers VISION.md 3.4, and 3.6 points 1, 4, 6 and 7.

## 1. Background test-combine

**What gets combined.** For each pair below, Git builds the merged result in its object store. The working copy is never touched.

- Mine: each chat's latest checkpoint ref. It is a commit of the whole working tree, uncommitted edits included (`TeamStaleView.ts` already reads it). A chat in the shared checkout counts as one side.
- Teammates: their claims carry `branch` and `pushedCommit` (`TeamPushedBranches.ts`, every 15 s). We only see what they pushed. Unpushed work stays invisible (see open question 1).
- Main: `origin/<base>`.

**How.** `git fetch origin <branches>`, only the branches whose `pushedCommit` changed, into a hidden namespace (`refs/t3-team/peers/<login>/<branch>`), so the person's `git branch -r` stays clean. Then `git merge-tree --write-tree --name-only <mine> <theirs>`: exit 1 means conflict, and it lists the files. No checkout, no index. Measured on this repo (28,000 files): 0.05 s and 11 MB for a small merge; 1.25 s and 140 MB for 40 commits against upstream with 19 conflicting files. Needs Git 2.38 or newer (we have 2.53); with an older Git, the check is skipped and says so.

**How often.** On events, not on a timer: my chat's turn ends (new checkpoint), a teammate's `pushedCommit` changes (already in the team state poll), or `origin/<base>` moves (checked on the same poll, at most every 2 minutes). A 30 s debounce. Each result is cached by its pair of commits, so nothing is checked twice.

**Cost.** The merge-tree step is cheap enough to run on every event. The expensive part is section 2.

## 2. Checks after combining

**Git conflicts.** Exact, from merge-tree. The result tree holds the conflict markers, so counting them gives "2 places" and their line ranges. When merge-tree says two branches merge cleanly, the file-level overlap mark drops to a quiet mark (3.6 point 1c).

**Typecheck and tests on the combined result.** This catches a function renamed on one side and still called on the other (3.6 point 4).

- **Where.** One combine copy per project, kept between runs: a detached `git worktree` under the T3 home (`userdata/team/combine/<project>`). It is never in the repo, and never anyone's chat copy. A run does `git commit-tree` on the merged tree, then `git checkout --detach` in the combine copy. Git only rewrites the changed files, so `node_modules` and incremental build data (`tsbuildinfo`) stay. The first run installs dependencies with the project's worktree setup script (t3.json `runOnWorktreeCreate`). After that, when the lockfile changes, the automatic check skips and says "dependencies changed"; "Check now" installs.
- **When.** Only if merge-tree was clean, both sides changed code, and this pair of commits is new. Only when upstream's `BackgroundPolicy.shouldRunOpportunisticWork` allows it: not suspended, locked, too hot, or on battery (per the person's settings). Also no turn running in this project, and at least 1.5 GB of free memory. One check at a time on the server. At most once every 10 minutes per pair. "Check now" skips the idle rules but not the memory rule.
- **Laptop safety.** The child runs at the lowest priority (`os.setPriority`, which works on Windows too). It has a 10-minute timeout and is killed by the PID we started. We keep the last 200 lines of output.
- **Command source**, first found wins:
  1. A `## Check` section in `.team/rulebook.md` with one command. It is reviewed like code and shared by the team, and agents read it too, so they can run it before a handoff. It is parsed like "Shared files" (`rulebook.ts`).
  2. Detected: a `typecheck` script in package.json, else `tsc --noEmit` when there is a tsconfig.json. Also `cargo check` and `go vet ./...`.
  3. Nothing found: Git conflicts only.

  I would not add a key to t3.json: it is upstream's published schema, and every sync would fight over it.

- **Keep it short.** Typecheck by default. Tests only when the rulebook command asks for them, ideally only the tests related to the changed files (`{files}` in the command expands to the files both sides changed, e.g. `vitest related {files}`). Aim for under 2 minutes; the Check section says so.
- **No false alarms.** Report only errors that are new: present in the combined result, but not in mine alone and not in theirs alone. Each side's result is cached per commit and reused across pairs, so an error already on main never shows up as a clash.

**As built (slice 4).**

- Runs only on "Check now" (any clean pair) and once before "Update my copy" / "Update B on top of A". Never on its own, so `BackgroundPolicy` is not consulted.
- The copy gets each tree with `git read-tree -u --reset` (no commit is made). Dependencies: the lockfile's package manager (`npm ci`, `pnpm install --frozen-lockfile`, …) when `package.json` or the lockfile changed since the last install, not t3.json's setup script (it also does worktree chores, like linking `.env`). Each side alone runs on the dependencies installed for the combined result.
- The rulebook's `## Check` is read from the combined result. No `{files}` expansion.
- A check that cannot start (another check running, a turn in the project, under 1.5 GB free) or cannot run (no command, dependencies changed before an update, 10 minutes, a failure) says why on the line. Before an update, that or new errors stop it; the line offers "Update anyway", and "Fix it" for new errors (its prompt lists them).
- Errors are read from tsc's format, `path:line[:col]: message` and Rust's `-->`; output nothing reads counts as one new error only when both sides pass alone. Results live in memory, by the two commits.
- The priority: a small Node launcher lowers its own and starts the shell, so every child inherits it. The timeout kills the launcher's process group (Unix) or `taskkill /T` its PID (Windows).

## 3. How we warn

- **Who.** Only the people whose branches clash, each on their own server. Others see it on Team home, without a ping.
- **Team home** (Today when solo): a "Merging" section with one line per pair that has news:
  - "Your 'login' chat and Sara's search branch clash in 2 places in `src/api/routes.ts`."
  - "Combined with Sara's branch, `getUser` is renamed but still called in `src/api/me.ts` (yours)."
  - Clean pairs show as "merges cleanly, checked 3 min ago".
  - Buttons: Ask the agent to fix, Check now, and the merge order.
- **Presence popover:** a clash mark on the teammate's face and the same line.
- **File tree:** "clash" on the conflicting files; the quiet mark when clean.
- **The chat:** one line in the turn note, only when something changed (like the stale-view line), so the agent knows and tells the person. It never pauses the agent and is never a card.
- **Notification:** only for a new clash, once.
- **Against false alarms:**
  - Only changes of state are told.
  - Text says how fresh it is: "Sara's pushed work, 10:42; she pushed since, checking…".
  - Conflicts in lockfiles and generated files are worded "regenerate after merging", not "clash".
  - Shared files (rulebook) still get checked but are worded softly.

## 4. Merge order

When two branches clash or overlap, suggest the one that is ready first. We use the pull request data T3 already has (`ThreadPullRequestSnapshot`):

1. A pull request is open and not a draft.
2. Checks are green (`checksState`).
3. It is mergeable and approved.
4. Then the smaller diff (`additions + deletions`).
5. Then the older one.

The rule is a pure function of shared data, so both people see the same suggestion; a tie goes to the login that sorts first. After the first one merges, the other chat's server sees it (`TeamClaimAutoRelease`, or base moved) and offers "Update my copy". This reuses Wait's rebase (`teamCopy.ts`): it is never done while a turn runs or with uncommitted changes. It happens automatically only if the person had chosen Wait. A rebase conflict goes to section 5.

**As built (slice 3).**

- Each claim with a branch carries that branch's pull request as T3 last synced it (`TeamPushedBranches`, next to `pushedCommit`), so both servers rank the same data. "Older" is the earlier first claim of that chat; two chats use which finished its last turn first (a running chat goes last).
- The order shows on a teammate-branch or chat pair that clashes, has files to regenerate, or where both changed a file. Never on a base pair.
- The update is offered only on clean overlaps: a base pair ("Update my copy") and a two-chat pair (the second moves on top of the first, its checkpoint commit included). A teammate's branch is merged first; the base pair then offers the update. Own worktrees only.
- After an update, the chat's side is its new HEAD until its next turn (the same ref as an approved fix). A rebase that stops on a conflict changes nothing and offers "Fix it", which then merges even though the pair checked clean.
- Wait's own update (`TeamWait`) is unchanged and is the automatic path.

## 5. When a clash happens

- **Start.** Ask the agent to fix (Team home, popover, or the turn-note line), or a conflicting update.
- **Turn.** It is a normal turn in that person's own chat copy, any provider, so the checkpoint before it is the undo. The prompt holds:
  - the conflicting files and hunks;
  - both sides' handoff notes and automatic notes on those files (why each change was made);
  - both claims' notes and task titles;
  - decision files that name those files.

  The prompt is capped at about 600 tokens.

- **What the agent does.** It merges or rebases, resolves, runs the Check command, and stops before committing. The person sees the diff and chooses:
  - Approve: commit, and push if the branch is pushed.
  - Undo: abort, or go back to the checkpoint.
- **Limits.** The teammate's branch is never touched. The teammate gets a team note: "Mouhssine's agent merged your search changes into their branch; see `routes.ts`."
- **As built (slice 2).**
  - Only chats with their own worktree: in the shared checkout a merge would change every chat there, so the button is disabled with that reason.
  - Git refuses to merge over uncommitted edits to the same files, so the chat's uncommitted work is committed first ("Save the work of the chat …"); Undo takes that commit back and leaves the work uncommitted again.
  - The server starts `git merge --no-commit` itself; the turn only resolves. Approve refuses while a file that conflicted still has markers.
  - After Approve, the chat's side of the merge check is the merge commit (`refs/t3-team/fixed/<thread>`) until a newer checkpoint.
  - Solo chat-vs-chat merges the other chat's checkpoint commit, so "t3 checkpoint …" commits enter history.
  - The check command comes only from the rulebook's `## Check` section for now (no detection).

## 6. Solo

The same code, with my chats on both sides of each pair. It matters only for chats with their own worktree. Chats in the shared checkout edit the same files live, which the overlap warning and the stale-view line already cover. Today shows "Your chats 'A' and 'B' clash in `greet.ts`". The merge order is whichever chat finishes first, and "Update B on top of A" uses the same rebase. Mine against main also helps: after chat A's PR merges, B learns it is behind and will clash.

## 7. Testing

**Automatic:**

- merge-tree wrapper on real temp repos, like the `GitTeamService` bench: a clean merge, a conflict with its place count, and a rename that Git merges cleanly.
- Pair cache and triggers: debounce, unchanged pairs skipped, only changes of state reported.
- Check runner with a fake command: errors parsed (tsc format and plain `path:line`), timeout kill, one at a time.
- The "new errors only" filter.
- Gates: a `BackgroundPolicy` stub and the memory floor.
- The combine copy is reused: an unchanged file is not rewritten, and `node_modules` stays.
- Merge-order ranking from PR snapshots.
- Clash-prompt builder: both sides present, capped.
- Warning sentences in client-runtime, like `teamHome.ts`.

**Live:**

- Two servers on a seeded demo: Sara pushes a rename of `searchPins`, and my chat calls the old name. Team home says it breaks. Watch memory and CPU (`free`, `ps`) during the check on this laptop.
- A real conflict, fixed by the agent with Codex, then approved.
- Merge order and the update after Sara's PR merges on GitHub (needs `gh` and a real PR).
- Native Windows: Git for Windows merge-tree, low priority, paths.

## 8. What I'd build first

1. **merge-tree only:** mine against teammates' pushed branches and main, on events, shown on Team home / Today and in the popover, plus the quiet mark when clean. Cheap, no laptop risk, and it covers the most common case.
2. Ask the agent to fix, with notes, and approve.
3. Merge order and "Update my copy".
4. The typecheck combine copy, with its gates (the heavy one).

Solo comes with 1, since it is the same code.

## Decided (2026-10-13)

1. **Teammates' unpushed work:** not shared for now; checks use pushed work only. Revisit after slice 1 is in use.
2. **The check command** lives in a `## Check` section of `.team/rulebook.md`, not in t3.json.
3. **The typecheck** runs only on "Check now" and once before merging. Automatic can come later, after measuring.
