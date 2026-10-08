# Fork working rules

This repo is a fork of T3 Code. We are adding a team layer: a shared Brain, shared project memory, file claims, conflict warnings, and team features. Upstream rules in AGENTS.md still apply, except where this file says otherwise.

## Keep our code separate

- Put new code in new files and folders whenever possible.
- When you must edit an upstream file, keep the edit small and mark it with a comment starting with "team-layer:".
- This keeps it easy to pull in updates from upstream T3 Code.

## After every step

1. Run typecheck and tests only for what you changed.
2. Commit with a clear conventional commit message.
3. Push to origin main. Not pushed = not done.
4. Add an entry to team/PROGRESS.md with: date, what changed, files touched, how you checked it, what's left, anything you're unsure about.

## Manual tests

- Start the dev server with `--home-dir ~/.t3-dev`: `vp run dev --home-dir ~/.t3-dev`. Never use a home folder inside this repo (such as `~/code/t3code/.t3`): chat worktrees live under the home folder, and agents in demo projects walk up the folders, find this repo's CLAUDE.md and these rules, and follow them.
- Never use `~/.t3/userdata` (the real T3 install) for tests.
- Dev runs must never add `apps/server` as a project called "server" (a chat there would edit this repo). `vp run dev` turns that off by itself since M2.3 (`scripts/dev-runner.ts`); a repo-root `.env.local` with `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0` (gitignored, never committed) also works. Never set it to 1 here.
- Two dev servers from this checkout (host and member) each get their own Vite cache, `apps/web/node_modules/.vite-dev-<web port>`. If a page ever fails with "error loading dynamically imported module", stop that server and delete its cache folder.
- `T3CODE_TEAM_LOGIN_OVERRIDE` works only on a dev server and only for a team whose origin is on this computer (a folder or `file://` URL). A team on GitHub always uses the gh login, so the override can never write to a real team; testing two people on GitHub needs a second gh account.
- Each round uses a fresh project (`~/code/team-demo4`, then `team-demo5`...). Control tests use a separate plain folder, never this repo.

## Self-testing

The agent runs the manual tests itself in a headless browser, so a slice reaches you already tried. This overrides AGENTS.md's "ask before spinning up browsers" for the Playwright setup below. Every other rule here still applies.

- **Tool.** The Playwright MCP server, set up for this project in `.mcp.json` (`@playwright/mcp`, pinned version, headless Chromium, a fresh browser profile each session). It saves its files in `.playwright-mcp/` (gitignored). A new Claude Code session loads it; one already running does not see it until restarted.
- **Browser.** Playwright's own Chromium in `~/.cache/ms-playwright` (no sudo). WSL also needs three system libraries, installed once with sudo: `sudo apt-get install -y libnss3 libnspr4 libasound2t64`.
- **Dev server.** Same as manual tests: `vp run dev --home-dir ~/.t3-dev`, in the background. Note the PID at start and stop it by that PID (AGENTS.md rule 1). Read the web port from the `[dev-runner]` line.
- **Pairing.** Open the `pairingUrl:` the dev server prints, in the Playwright browser only. It is one-time and used up by that visit. Never write it into a file, a commit, PROGRESS.md or a chat summary, and never paste it anywhere else.
- **Screenshots.** Take them only after pairing has finished and the app has loaded. Never photograph a page that shows a pairing link, token, invite code or secret (pairing pages, Settings → Connections with a link open, terminal output with a URL). Look at every picture before keeping it.
- **Where pictures go.** The orphan branch `test-screenshots`, which shares no history with `main`. It is checked out as a separate worktree at `../t3code-screenshots`. One folder per test round, `YYYY-MM-DD-<round>/`, holding the PNGs and a `NOTES.md` (what was tested, the `main` commit, what each picture shows). Commit and push that branch after each test. Never commit screenshots to `main`.
- **Memory.** This laptop runs out of memory. Never run two dev servers and a full typecheck at the same time. Stop the browser (`browser_close`) when done.
- **Honesty.** A self-test is a real check, so report it like one: what you clicked, what you saw, which screenshot shows it. It does not replace your own manual test when a slice asks for one.

## Honesty

- Never say something works unless you ran it and saw it work.
- If you skipped a check or something failed, say so plainly.

## Progress log

- team/PROGRESS.md is allowed in this fork. It overrides the upstream rule against committing progress notes.

## Safety

- Never commit secrets, tokens, .env files, or pairing URLs.
- Don't pull from upstream unless asked.
- Ask before any big design decision that isn't in the plan.
