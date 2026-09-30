# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

## 2026-09-30 — Dev environment setup and fork working rules

**What changed**

- Set up the dev environment in WSL (Ubuntu 26.04) under the Linux home folder: Node v24.21.0 via nvm 0.40.3, npm 11.19.0, vp v1.0.0 (repo pins vite-plus 0.3.3), gh 2.101.0, git 2.53.0.
- Cloned the fork into ~/code/t3code and added `upstream` → https://github.com/pingdotgg/t3code. Did not pull from upstream (fork main was 2 commits behind upstream/main at clone time).
- Added team/WORKING_RULES.md and this log.
- CLAUDE.md now also imports @team/WORKING_RULES.md. AGENTS.md has a one-line fork note at the top pointing to the working rules.

**Files touched**

- team/WORKING_RULES.md (new)
- team/PROGRESS.md (new)
- CLAUDE.md
- AGENTS.md

**How it was checked**

- `vp i` finished with exit 0 (one warning: peer dependency issues; `pnpm peers check` lists them). Working tree was clean afterwards.
- `vp run dev --home-dir ~/code/t3code/.t3` started. Server listened on 127.0.0.1:13773, web on 127.0.0.1:5733. State went to the repo's gitignored `.t3`, not ~/.t3/userdata. Web root returned HTTP 200 with title "T3 Code (Alpha)". Pairing from the Windows browser worked (confirmed by the developer).
- Dev server stopped by signalling the process group it was started in, after confirming both port owners belonged to that group and had cwd inside the repo. Both ports were free afterwards.
- No typecheck or tests run: this step changed only Markdown.

**What's left**

- No team-layer features yet. Next step is planning the first feature.

**Unsure about / notes**

- Vite logged "Failed to resolve dependency: @clerk/clerk-js, present in client 'optimizeDeps.include'" at startup. It comes from upstream's apps/web/vite.config.ts; the app still loaded. Not investigated.
- The fork note sits above the `# T3 Code` heading in AGENTS.md, as asked. A future upstream pull could conflict on that first line; it is easy to resolve.
