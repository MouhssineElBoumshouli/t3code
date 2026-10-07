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

## 7. Order of work

1. **Storage swap.** Done 2026-10-07 (slices 0 to 7 of [STORAGE_PLAN.md](STORAGE_PLAN.md)). Replace the local team database with the GitHub state ref (`refs/t3-team/state`) behind the same team service, so M1's tools, briefing, memory search and freshness keep working. Park the host-mode code (M2.2, M2.3) instead of deleting it; keep the upstream security fix.
2. **Two people, for real.** Done 2026-10-07 (slice 8, self-tested on GitHub with two dev servers). Two clones of one GitHub repo on one laptop, then two laptops. Claims, tasks, handoffs sync through `refs/t3-team/state`.
3. **Visible.** Team screen, file markers, the warning card from 3.1. Picked 2026-10-07: Option C (a Team home page, "Today" when solo, and the warning card inside the agent's message) with Option B's presence chip in the tab bar ([DESIGN_DIRECTION.md](DESIGN_DIRECTION.md) section 5). Build order: [UI_PLAN.md](UI_PLAN.md).
4. **Prevention.** Plan-first claim check (3.1) and pause-in-the-middle (3.2).
5. **Merging help.** Background clash check and note-aware conflict fixing (3.4).
6. **Installer.** Our own name, Windows installer, sign-in, "Make this a team project," joining.
7. **Classmates test** on a real group project. Fix what they hate.
8. **Launch.** 30-second demo video, one-page site, Reddit, X, Hacker News, Product Hunt.
