# 2026-10-07 slices 6 and 7: t3 team init on GitHub, first-turn briefing, the poller

- `main` commit: df397ce55 (the dev server and the CLI ran on this). Work in this round: caea4e50a (warm-up), f258aa82b (slice 6), 01175a77c (test fix), d3a50e77c (slice 7), 0c0bfe32d (briefing log line), df397ce55 (init: a timed-out ls-remote counts as unreachable).
- Repo: the private scratch repo `MouhssineElBoumshouli/t3-team-scratch`, cloned at `~/code/t3-team-scratch`. Its state ref did not exist before this round.
- Dev home: `~/.t3-dev`. Dev server: `vp run dev --home-dir ~/.t3-dev` (no login override for you: the real gh login `MouhssineElBoumshouli`), web port 5733, server port 13773.
- Browser: Playwright MCP, headless Chromium, fresh profile, 1440×1000, paired with the startup link (not in any picture or file).

## 1. `t3 team init` for real (GitHub)

First run, from a non-terminal (`< /dev/null`), `node apps/server/src/bin.ts team init ~/code/t3-team-scratch --base-dir ~/.t3-dev`. My very first try timed out on `git ls-remote` after 20 s and stopped with a raw Git error (a one-off: by hand it took 1.2 s, and the next run took 4.6 s in all). df397ce55 makes a timeout end like any unreachable remote. Output of the run that went through:

```
Team "t3-team-scratch" (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b) in /home/mouhssine/code/t3-team-scratch

  created   .team/team.json  New team "t3-team-scratch" (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b).
  created   .team/rulebook.md  Template with section headings. Keep it under 1,500 words.
  created   t3.json  Set "defaultThreadEnvMode": "worktree" so each thread gets its own worktree.

t3 team init does not commit. Review these files, then commit and push them so the whole team gets them.

On https://github.com/MouhssineElBoumshouli/t3-team-scratch, this creates the hidden ref refs/t3-team/state with:
  team.json                                                                team "t3-team-scratch" (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b), created by MouhssineElBoumshouli
  writers/MouhssineElBoumshouli/bb20aaa0-0302-4f13-9166-6cf9e4163494.json  this T3 server's part: your claims, tasks, notes and activity
Your branches are not touched, and a normal git fetch or pull does not download it.
Everyone who can read the repo can read it; everyone who can push can add to it.
TeamCliError: Not a terminal, so the team state was not created. Rerun with --yes to confirm from a script.
```

Nothing was created on the remote by that run. Second run, in a pseudo-terminal (`script`), answering `y` to the prompt:

```
Team "t3-team-scratch" (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b) in /home/mouhssine/code/t3-team-scratch
  unchanged .team/team.json  Team "t3-team-scratch" already exists (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b).
  unchanged .team/rulebook.md  Already exists.
  unchanged t3.json  Already sets "defaultThreadEnvMode": "worktree".
Nothing changed here. t3 team init does not commit; commit and push the files if you have not yet.
On https://github.com/MouhssineElBoumshouli/t3-team-scratch, this creates the hidden ref refs/t3-team/state with:
  team.json                                                                team "t3-team-scratch" (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b), created by MouhssineElBoumshouli
  writers/MouhssineElBoumshouli/bb20aaa0-0302-4f13-9166-6cf9e4163494.json  this T3 server's part: your claims, tasks, notes and activity
Your branches are not touched, and a normal git fetch or pull does not download it.
Everyone who can read the repo can read it; everyone who can push can add to it.
? Create it? › (y/N)✔ Create it? … yes
Created refs/t3-team/state on https://github.com/MouhssineElBoumshouli/t3-team-scratch. Teammates with push access join by pulling .team/ and opening the project in T3 Code (or running t3 team init in their clone).
```

On GitHub afterwards (`git ls-remote`, and a depth-1 fetch into a throwaway bare repo): `refs/t3-team/state` at 256e2e4, one commit "team state: MouhssineElBoumshouli created the team" by `MouhssineElBoumshouli`, files `team.json` (`createdBy: MouhssineElBoumshouli`) and `writers/MouhssineElBoumshouli/bb20aaa0-….json`.

`t3 team status --base-dir ~/.t3-dev`:

```
  t3-team-scratch (teamId 30858e4c-7114-4ff0-be53-7fd38baaee4b), created 2026-10-07T16:25:20.478Z
    Fetched from the remote just now.
    members: MouhssineElBoumshouli (owner, last seen 2026-10-07T16:25:20.489Z)
    claims: none
```

(It also listed this home's older Demo team 5, from slice 5.)

Then I committed `.team/` and `t3.json` in the scratch repo and pushed them to its `main` (2c074c0), as init says to. My first commit used an email I typed by hand; GitHub refused that push (email privacy), so nothing with it reached GitHub, and I redid the commit with the repo's configured noreply address.

## 2. The public repo refusal: with a fake

Testing it on GitHub needs a public repo you can push to: either a new one (I do not create repos on your account) or your public fork (you asked me not to touch your other repos). So it ran with a fake host: a throwaway local repo and bare origin in /tmp, init's lookup of `origin` reporting `https://github.com/acme/app.git`, and a host saying "public, can push". The real `runTeamInit` code, through a script in my scratchpad (not committed):

```

$ t3 team init /tmp/t3-public-refusal-QcrZNL/acme-app --yes   (fake host: public repo)
refused: TeamProjectRegisterError: This repo is public, so its team state would be public too: anyone could read your GitHub logins, task titles and notes, the files you work on, handoff notes and when you work. Nothing was written. Make the repo private (GitHub Free allows unlimited private repos with collaborators), or run t3 team init --public-ok to accept that.
files in the repo: []
refs on origin: ""

$ t3 team init /tmp/t3-public-refusal-QcrZNL/acme-app --yes --public-ok   (fake host: public repo)
Team "acme-app" (teamId 1b55c6c5-6ad5-4247-9015-89bc7cfff621) in /tmp/t3-public-refusal-QcrZNL/acme-app

  created   .team/team.json  New team "acme-app" (teamId 1b55c6c5-6ad5-4247-9015-89bc7cfff621).
  created   .team/rulebook.md  Template with section headings. Keep it under 1,500 words.
  created   t3.json  Set "defaultThreadEnvMode": "worktree" so each thread gets its own worktree.

t3 team init does not commit. Review these files, then commit and push them so the whole team gets them.

On https://github.com/acme/app.git, this creates the hidden ref refs/t3-team/state with:
  team.json                                           team "acme-app" (teamId 1b55c6c5-6ad5-4247-9015-89bc7cfff621), created by MouhssineElBoumshouli
  writers/MouhssineElBoumshouli/selftest-server.json  this T3 server's part: your claims, tasks, notes and activity
Your branches are not touched, and a normal git fetch or pull does not download it.
The repo is public, so anyone can read it (you passed --public-ok).
Created refs/t3-team/state on https://github.com/acme/app.git. Teammates with push access join by pulling .team/ and opening the project in T3 Code (or running t3 team init in their clone).
init finished (see below)
files in the repo: [".team","t3.json"]
refs on origin: "refs/t3-team/state"
```

In the fake, the "Created … on https://github.com/acme/app.git" line names the faked URL; the ref went to the local throwaway origin. The same refusal is in the unit tests (`cli/team.test.ts`, "refuses on a public repo unless --public-ok, and writes nothing").

## 3. First turn after adding the project: the briefing

- 16:27:59 added `~/code/t3-team-scratch` as a project (Add project → Local folder). 16:28:01: the dev server's state repo for the team (`~/.t3-dev/userdata/team/30858e4c-….git`) has a new `FETCH_HEAD`: the warm-up opened the team when the project was added.
- New chat, Claude Sonnet 5.5 (High), current checkout (the composer showed "Current checkout", not a new worktree). Sent "Call team_status and show me the raw result." at about 16:28:32.
- Server log: `16:28:32.383 INFO Team briefing added.` (the line added in 0c0bfe32d). No "Team briefing skipped" warning anywhere in the log. So **the first turn got its briefing**.
- The agent called `team_status` once (MCP tool call) and showed the raw result: team `t3-team-scratch`, you `MouhssineElBoumshouli`, no tasks, no claims, recent "MouhssineElBoumshouli created team t3-team-scratch." It also added a paragraph about claude.ai MCP connectors needing sign-in; that comes from the Claude Code setup on this laptop, not from T3.

## 4. A teammate's claim reaches the running server: the poller

With the dev server still running, a second state repo (my scratchpad, `sara-state`, environment `sara-laptop`) as a fake teammate: `TeamHost` with the dev login override `Sara-T3Test` (dev mode), `GitTeamService.openTeam` on the scratch checkout, then `claimPaths(["src/auth"], note "login form (fake teammate)")`. The pushes went to GitHub with your gh credentials; the writer file and commit author are `Sara-T3Test`.

```
Sara opens the team: member
Sara's claim: confirmed=true, overlaps=0, pushed 2026-10-07T16:29:25.569Z, tip c2f57687354c5ae046033ec104428bfbcf8ea279
The dev server fetched it 3.8 s after the push (checked every 0.25 s), at 2026-10-07T16:29:29.401Z.
```

The script read the dev server's state repo tip every 0.25 s (read only) until it matched Sara's commit: **3.8 s** after her push was confirmed. That was luck of timing: the poller checks every 15 s, so the wait for the check alone can be up to 15 s, plus about 1 s to fetch (STORAGE_PLAN.md Q4 measured 0.99 to 1.21 s).

Then in the same chat, "Call team_status again." at about 16:29:38: the raw result has `claims: [{"who":"Sara-T3Test","task":"no task","where":"their own copy; not merged into yours yet","paths":["src/auth"],"note":"login form (fake teammate)"}]` and recent "Sara-T3Test claimed src/auth.", "Sara-T3Test joined the team."

## Stopping

Playwright browser closed. Dev server stopped by the vp PID captured at start; vp left its two children on ports 13773 and 5733 (as in slice 5), whose working folders were `apps/server` and `apps/web` of this checkout, so I stopped those two PIDs. Ports free afterwards.

Left in place on purpose: the scratch repo's `refs/t3-team/state` (your writer file and Sara-T3Test's, with her claim on `src/auth`), and its `main` commit 2c074c0 with `.team/` and `t3.json`.

## Pictures

- `q1-team-status-first-turn.png`: the first turn, "Worked for 7.5s" expanded (one MCP tool call), the raw `team_status` result with no claims.
- `q2-team-status-teammate-claim.png`: the second turn, "Worked for 4.7s" expanded (one MCP tool call), the raw result with Sara-T3Test's claim on `src/auth`; the first result above it for comparison.

No pairing link, token or other secret is in any picture or in this file.
