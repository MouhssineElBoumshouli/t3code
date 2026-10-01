# Cold start test (D8)

Can an agent in a brand-new chat, with no hints, find out what the project is, who is doing what, why a decision was made, what is left on your task, and which files to avoid? Everything it needs is in the repo's `.team/` folder and the team tools.

The answers below are only in this file and in the seed script, both in the t3code repo. Never copy them into the demo project.

## Setup

1. Stop the dev server if it is running.
2. Seed the demo, from the t3code repo:

   ```bash
   node apps/server/scripts/team-cold-start-seed.ts
   ```

   Defaults: `--home-dir ~/.t3-dev`, `--project ~/code/team-demo5`. It prints your member name ("You are ..."). Safe to run again: it rebuilds `~/code/team-demo5` (only if this script made it) and resets the team's rows. After a re-run, archive the project's old chats in T3: their worktrees belonged to the old repo.

3. Start the dev server: `vp run dev --home-dir ~/.t3-dev`. Add `~/code/team-demo5` as a project (once; the path stays the same on re-runs).
4. Open a new chat in that project. Worktree mode should be on (from the project's `t3.json`).
5. Ask the five questions below, one at a time, in this exact wording. No hints, no follow-ups that steer.
6. Repeat in a new chat for each provider you test (D8 asks for Claude Code and Codex in M1).

## What the seed holds

- Repo (`main`, three commits): Pinboard app; "Set up team Demo team 5" (`.team/team.json`, rulebook, one decision, `t3.json`); "Search ignores case" (changes `src/pins/search.ts`).
- Team "Demo team 5": you (this server), Sara and Omar (on their own servers).
- Tasks: "Rate-limit the login endpoint" (yours, in progress, not linked to any chat); "Add tag filters to search" (Sara's, in progress).
- Claims: Sara's chat holds `src/pins/search.ts` and `src/api/routes.ts`; Omar's chat holds `src/auth/session.ts` (no task card).
- Handoffs: Sara's on search (now **maybe outdated**: the later commit changed `search.ts`), and yours from an earlier chat on rate limiting (fresh).

## Questions and expected answers

### 1. What is this project?

Pinboard: a small web app to save links ("pins") with tags and search them. TypeScript on Node, no framework, no database; pins live in `data/pins.json`. It is in team "Demo team 5", and you are the name the script printed.

Pass: Pinboard, saving links with tags, search. The team name is a plus.

### 2. Who is working on what right now?

- Sara: "Add tag filters to search", in progress. Holds `src/pins/search.ts` and `src/api/routes.ts`, in her own copy (not merged into yours yet).
- Omar: no task card. Holds `src/auth/session.ts`, note "shorter session expiry", in his own copy.
- You: "Rate-limit the login endpoint", in progress, no claims yet.

Pass: both teammates with their files, and Sara's task. Fail: claims mixed up between people, or invented work.

### 3. Why did we choose signed cookies for sessions?

From `.team/decisions/0001-signed-cookie-sessions.md` (Sara, 2026-09-28): the session is a signed cookie (HMAC-SHA256 with `SESSION_SECRET`) instead of a server-side session store, because Pinboard is one small Node process with no database. A cookie needs no storage, survives restarts, and is easy to test. Trade-off: one session cannot be revoked early; rotating `SESSION_SECRET` logs everyone out.

Pass: no storage needed / one process without a database, plus at least one of: survives restarts, easy to test, the trade-off. Fail: generic reasons not in the file (scaling, statelessness for load balancers, security folklore) presented as the team's.

### 4. What is left on my task?

Your task is "Rate-limit the login endpoint" (in progress). Done: `src/auth/rateLimit.ts`, `allowLoginAttempt(ip)`, 5 tries a minute per IP, in memory. Left:

1. Call `allowLoginAttempt` in `handleLogin` (`src/auth/login.ts`) and answer 429 when it says no.
2. Add tests.

The earlier handoff also warns: in memory only, limits reset on restart.

Pass: this task (not Sara's) and both items left. Fail: "you have no task". Note: this new chat has no task card of its own, so `team_task` says "no task yet"; the agent must notice the task in `team_status` whose owner is you.

### 5. Which files should I avoid right now?

- `src/pins/search.ts` and `src/api/routes.ts`: claimed by Sara.
- `src/auth/session.ts`: claimed by Omar.
- `data/`: the rulebook's "Do not touch" (a human updates it).

Their claimed work is in their own copies, so you may not see their changes yet. Your own task's files (`src/auth/rateLimit.ts`, `src/auth/login.ts`) are free.

Pass: the three claimed files. Full marks with `data/` too. Fail: missing a claimed file, or telling you to avoid your own task's files.

## Grading

Pass = all five correct from a cold start. For each answer, write down which tools the agent called (`team_status`, `team_task`, `team_memory_search`, file reads) and whether it read the rulebook first.

Also note, not graded: if the agent quotes Sara's handoff ("matching is case-sensitive"), it should flag it as maybe outdated. The mark reads "maybe outdated: content of src/pins/search.ts changed since this note was written (+2 -2 lines)", and the code now ignores case.

## After the five questions (automatic notes)

Ask the chat to make a small change, for example "Add a comment at the top of src/auth/rateLimit.ts" (it should claim the file first). When the turn ends, open a second new chat and ask it to search team memory for `src/auth/rateLimit.ts`. Expected: your old handoff ranked first, then an "automatic note" for the first chat ("this chat changed 1 file"), marked "not merged yet" with its reason, since that change is only in the first chat's worktree.
