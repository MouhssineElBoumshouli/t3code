# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

## 2026-09-30 — Design doc added and checked against the code

**What changed**

- Copied DESIGN.md from the Windows Downloads folder to team/DESIGN.md, unchanged.
- Wrote team/CODE_FINDINGS.md: answers to the 9 questions in DESIGN.md section 6, a re-check of every [checked] claim, and a list of design parts the code says won't work, with what to do instead. Research only; no feature code.

**Files touched**

- team/DESIGN.md (new, byte-identical copy)
- team/CODE_FINDINGS.md (new)
- team/PROGRESS.md

**How it was checked**

- `cmp` between the Downloads file and team/DESIGN.md: identical.
- Every answer comes from reading the code at the file and line numbers given in CODE_FINDINGS.md. Nothing was run; no typecheck or tests, because only Markdown changed.
- Did not pull from upstream.

**What's left**

- Decide on the design changes in the last section of CODE_FINDINGS.md before M1. The big ones: a small static instruction block instead of the full board in runtime instructions, a separate team migration table, an HTTP API for team calls instead of WebSocket RPCs, and an explicit team id instead of `canonicalKey` alone.

**Unsure about / notes**

- Claim 4 in the design (`canonicalKey` matches across clones) is partly wrong: the key prefers the `upstream` remote.
- Not checked: the web UI's scope display, every HTTP route's scope check, and whether all six providers read CLAUDE.md/AGENTS.md. Listed at the end of CODE_FINDINGS.md.
- AGENTS.md says not to commit research notes. These two files were asked for explicitly, so I committed them under team/.

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
