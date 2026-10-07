# 2026-10-07 slice 5: cold start test on the Git team store

- `main` commit: 5e7f7bb79 (feat(team): slice 5, the switch to the Git team store)
- Seed: `node apps/server/scripts/team-cold-start-seed.ts` (defaults). It rebuilt `~/code/team-demo5` with a local bare remote `~/code/team-demo5-remote.git` and wrote the team state to that remote's `refs/t3-team/state` as three servers: `mouhssine` (this dev home's server, owner), `Sara` and `Omar`. Run twice; the second run rebuilt both folders.
- Dev server: `T3CODE_TEAM_LOGIN_OVERRIDE=mouhssine vp run dev --home-dir ~/.t3-dev`, web port 5733, server port 13773. Stopped by the PID captured at start (vp), then its two children that still held the ports, after checking their working folders were this checkout.
- Browser: Playwright MCP, headless Chromium, fresh profile, 1440×1000. Paired with the startup link (not in any picture or file).
- In the app: setup dialog, "Do not import projects" (it offered the t3code repo itself), Add project → Local folder `~/code/team-demo5`. New chat: Claude Sonnet 5.5 (High), worktree mode on (from `t3.json`), from `origin/main` at aa8b830.
- The five questions from team/COLD_START_TEST.md, one at a time, exact wording, no hints. Tool calls expanded in each picture where the turn had any.

## Grades

| # | Question | Tools the agent called | Grade |
| - | -------- | ---------------------- | ----- |
| 1 | What is this project? | 2 shell commands (`git ls-files`, README, `package.json`, `t3.json`, `data/pins.json`, `routes.ts`). No team tools. Said "Since this is just exploration, I don't need to read the rulebook first." | **Pass.** Pinboard, save links ("pins") with tags and search them, TypeScript on Node, no framework, data in `data/pins.json`. Did not name the team "Demo team 5" or you (the plus). |
| 2 | Who is working on what right now? | `team_status` | **Pass, complete.** Sara: "Add tag filters to search", in progress, holds `search.ts` and `routes.ts`. Omar: no task, holds `session.ts`, "shorter session expiry". You (mouhssine): "Rate-limit the login endpoint", in progress, both items left, no claims. "Sara's and Omar's changes are in their own copies and aren't merged into yours yet." Also named `data/` as do-not-touch. Nothing mixed up or invented. |
| 3 | Why did we choose signed cookies for sessions? | Read `.team/decisions/0001-signed-cookie-sessions.md`, Read `src/auth/session.ts` | **Pass, complete.** From the decision (Sara, 2026-09-28): no storage needed (one small Node process, no database), survives restarts, easy to test, HMAC-SHA256 with `SESSION_SECRET`, trade-off (no early revoke; rotating the secret logs everyone out). Extra notes come from the code and are labelled as such (7-day cookie, `"dev-secret"` fallback), not presented as the team's reasons. |
| 4 | What is left on my task? | `git status --short; git log --oneline -3`, `team_status` | **Pass.** "Rate-limit the login endpoint": (1) call `allowLoginAttempt(ip)` in `handleLogin` (`login.ts`), 429 when it says no; (2) add tests. It found the task by its owner in `team_status` (this chat has no task card). Did not mention the earlier handoff's risk (in memory only, resets on restart): it never searched team memory. Not required to pass. |
| 5 | Which files should I avoid right now? | none (used the `team_status` result from question 4) | **Pass, full marks.** `search.ts` and `routes.ts` (Sara), `session.ts` (Omar), `data/` (rulebook "Do not touch"). Said its own task's files (`login.ts`, `rateLimit.ts`, new tests, `package.json`) are free. |

**Result: 5 of 5 pass**, question 5 with full marks (`data/` included, as `team_status`'s `doNotTouch` now gives it). Not graded: the agent never quoted Sara's outdated handoff (it never called `team_memory_search`), so the "maybe outdated" mark was not exercised in this run. It never read the rulebook file itself in this chat; `data/` came from `team_status`.

## Behind the scenes

- The server opened the team from the worktree's `origin` (the local bare remote): it made its state repo `~/.t3-dev/userdata/team/team-demo5-cold-start.git` and pushed nothing (the remote's tip stayed at the seed's last commit). No team warnings in the server log.
- The team briefing reached the agent: in question 1 it reasoned about whether to read the rulebook before exploring, which only the briefing tells it.
- Two sends needed a second try from my side: for question 1, Enter in the composer did not send (I clicked Send); for question 4, my first type-and-send left the composer empty with no message (I retyped and sent; only one question 4 message is in the chat, see `q4-…png`).
- Log noise unrelated to the team layer: upstream "PR lookup failed … No unknown source control provider" (a local remote has no PR host), a React key warning in the console.
- Not done: the "After the five questions (automatic notes)" part of COLD_START_TEST.md (not asked for this round).

## Pictures

- `q1-what-is-this-project.png`: question 1, "Ran 2 commands" expanded (the rulebook remark and both commands), and the answer.
- `q2-who-is-working-on-what.png`: question 2 with the `team_status` call expanded (team "Demo team 5", you "mouhssine", `doNotTouch`), and the top of the answer.
- `q2-who-is-working-on-what-end.png`: the rest of the question 2 answer (claims, "own copies", `data/`).
- `q3-why-signed-cookies.png`: question 3 with both reads expanded, and the answer.
- `q4-what-is-left-on-my-task.png`: question 4 with the command and `team_status` expanded, and the answer.
- `q5-which-files-to-avoid.png`: question 5 and its answer (no tool calls in this turn).

No pairing link, token or other secret is in any picture or in this file.
