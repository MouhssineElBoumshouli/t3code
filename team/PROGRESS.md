# Progress log

Newest entries first. See team/WORKING_RULES.md for what each entry needs.

## 2026-09-30 — Design doc v2

**What changed**

- Rewrote team/DESIGN.md as v2 using the accepted "Instead" fixes from team/CODE_FINDINGS.md: team HTTP API with `team:read` / `team:write` and polling (D1), `.team/team.json` with `teamId` (D2), own migrator with `team_sql_migrations` and `team_*` tables (D3), a small ~150-token team block through `teamContext` (D4), five tools with a membership check at call time (D5), turn-diff claims as overlap detection, and team creation turning on worktrees (D6), cards keyed by thread with both PR link paths (D9), and a realistic list of upstream files (section 4). Every claim is marked [checked] or [verify] again. Section 6 now lists the remaining [verify] items.
- Removed the `team-layer:` ignore line from vite.config.ts, so the formatter formats DESIGN.md normally. vite.config.ts is back to the upstream version.
- Docs only, no feature code.

**Files touched**

- team/DESIGN.md
- team/PROGRESS.md
- vite.config.ts (line removed; file matches upstream again)

**How it was checked**

- Before writing, checked a few new details in the code: all six adapters have T3's thread id where they call `buildRuntimeInstructions()`, Codex has it in its session runtime options, HTTP groups are mounted in `makeRoutesLayer` in `apps/server/src/server.ts`, and pairing link lifetime is settable in the server-side auth service but not over HTTP.
- `git diff` of vite.config.ts against the commit before the ignore line was added: no difference.
- No typecheck or tests: only Markdown and one removed config line changed. The pre-commit formatter ran on the commit.

**What's left**

- The six [verify] items in DESIGN.md section 6. Then start M1.

**Unsure about / notes**

- D2 small choice not spelled out in the findings: the host address is **not** stored in `.team/team.json`. It comes from the invite and stays on each member's server, so public repos don't carry a private Tailscale address.
- D6 layer 4: team creation writes `.team/team.json` and the `t3.json` field in one commit that the creator reviews and pushes. Whether our code should make that commit itself or leave the files for the user to commit is open.

## 2026-09-30 — Design doc added and checked against the code

**What changed**

- Copied DESIGN.md from the Windows Downloads folder to team/DESIGN.md, unchanged.
- Wrote team/CODE_FINDINGS.md: answers to the 9 questions in DESIGN.md section 6, a re-check of every [checked] claim, and a list of design parts the code says won't work, with what to do instead. Research only; no feature code.

**Files touched**

- team/DESIGN.md (new, byte-identical copy)
- team/CODE_FINDINGS.md (new)
- team/PROGRESS.md
- vite.config.ts (one `team-layer:` line: formatter ignores team/DESIGN.md)

**How it was checked**

- `cmp` between the Downloads file and team/DESIGN.md: identical.
- The first commit (21a375e) went through the pre-commit formatter, which padded the two tables in DESIGN.md with spaces. The follow-up commit restores the exact bytes and adds team/DESIGN.md to the formatter's ignore list. `vp fmt --check` on DESIGN.md and vite.config.ts now checks only vite.config.ts, which passes, and `cmp` shows the committed file matches the original.
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
