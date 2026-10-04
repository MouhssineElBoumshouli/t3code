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
- Each round uses a fresh project (`~/code/team-demo4`, then `team-demo5`...). Control tests use a separate plain folder, never this repo.

## Honesty

- Never say something works unless you ran it and saw it work.
- If you skipped a check or something failed, say so plainly.

## Progress log

- team/PROGRESS.md is allowed in this fork. It overrides the upstream rule against committing progress notes.

## Safety

- Never commit secrets, tokens, .env files, or pairing URLs.
- Don't pull from upstream unless asked.
- Ask before any big design decision that isn't in the plan.
