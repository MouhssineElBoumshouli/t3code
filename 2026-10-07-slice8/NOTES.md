# 2026-10-07, slice 8: two people for real

`main` at the time of the test: 3f85420c2 (the poller retries unpushed writes).

## Setup

- Private scratch repo `t3-team-scratch` (team state ref `refs/t3-team/state` kept from the slice 6/7 test). I added four small files to its `main` first (d744af6: `src/search/query.ts`, `src/profile/avatar.ts`, `src/api/client.ts`, `src/shared/format.ts`) so there was something to claim and edit.
- Two clones: `~/code/t3-team-scratch` (host) and `~/code/t3-team-scratch-member` (new, cloned for this test).
- Two dev servers from the t3code checkout:
  - **host**: `vp run dev --home-dir ~/.t3-dev`, ports 13773/5733, real gh login `MouhssineElBoumshouli`.
  - **member**: `T3CODE_TEAM_LOGIN_OVERRIDE=Yassine-T3Test vp run dev --home-dir ~/.t3-dev-member` (fresh home), ports 13774/5734.
- One Playwright browser, one tab per server, each paired with its own one-time link. One chat per server, both Claude Sonnet 5.5 (High), both ran in a new worktree.
- Timing came from Git, not from the UI: a script read both servers' state repos every 0.5 s (this server's own files in `mine/`, and the tip of the local state ref) and logged every change. "Write" is when the server's own file changed on disk, "pushed" is when its own state ref held that version, "seen" is when the other server's state ref held that version or a newer one of the same file.
- The old fake teammate `Sara-T3Test` (claim on `src/auth`, from the slice 6/7 test) is still in the state; both agents list her.

## Timings (seconds after the write)

| What | Direction | Pushed | Seen by the other |
| --- | --- | --- | --- |
| Member joins (writer file) | member → host | 5.8 | 9.0 |
| Claim `src/search/query.ts` | host → member | 2.7 | 10.6 |
| Task "Search: support quoted phrases" | host → member | 5.1 | 7.9 |
| Claim `src/profile/avatar.ts` | member → host | 2.7 | 5.3 |
| Task "Profile: avatar sizes" | member → host | 5.3 | 19.1 |
| Handoff (search) | host → member | 4.8 | 5.9 |
| Handoff (avatar) | member → host | 4.3 | 15.8 |
| Race 1 claim `src/shared/format.ts` | member → host | 3.2 | 5.8 |
| Race 1 claim `src/shared/format.ts` | host → member | 5.3 | 9.5 |
| Race 2 claim `src/api/client.ts` | member → host | 3.2 | 7.9 |
| Race 2 claim `src/api/client.ts` | host → member | 3.2 | 19.5 |
| Host claims `avatar.ts` (edit test) | host → member | 3.2 | 12.2 |

All 12 under 20 s; 5.3 to 19.5 s, median 9.3 s. A claim pushes at once (about 3 s); other writes wait 2 s and push together (about 5 s). What is left is the wait for the other side's next 15 s check, unless the other side syncs for its own claim first (race rows, 5.8 s).

## Steps and pictures

### 0. Adding the project (the "Local checkout" question)

- `m00-project-added-draft.png`: member, Add project → Local folder → `~/code/t3-team-scratch-member`. The draft it opens says **Current checkout**, though the clone's `t3.json` says `"defaultThreadEnvMode": "worktree"`.
- `m01-second-new-thread-draft.png`: same project, the next new thread (after reloading `/`): **New worktree, From origin/main**.
- `h00-host-draft.png`: host, project already known: **New worktree**.

### 1. Claims and tasks, host → member

- `h01-claim-and-task.png`: host asks to claim `src/search/query.ts` and create the task. Agent: claimed, no overlaps (lists Sara's old `src/auth`), task created, no code edited. Server log: "Team briefing added." for that first turn.
- `m02-member-sees-host-claim-task.png`: member, "what is the rest of the team working on right now?" (no tool named). Lists Mouhssine's claim on `query.ts`, the task, Sara's claim.

### 2. Claims and tasks, member → host

- `m03-member-claim-and-task.png`: member claims `src/profile/avatar.ts`, creates "Profile: avatar sizes".
- `h02-host-sees-member-claim-task.png`: host asks who holds what. Shows Yassine's claim. It does **not** show his task: the agent's `team_status` ran at about 19:45:19, the host fetched the task at 19:45:20.2 (pushed 19:45:06.4).
- `h03-host-sees-member-task.png`: asked again 20 s later: both tasks, Yassine's "new since my last check".

### 3. Handoffs, both ways

- `h04-host-handoff-written.png`, `m04-member-handoff-written.png`: both write a handoff at the same moment.
- `h05-host-reads-member-handoff.png`: host, "did any teammate leave a handoff note?": gives Yassine's note (done, left, risks). `h05b-host-handoff-tool-calls.png`: it searched team memory for "handoff" (nothing), then for "avatar" (found).
- `m05-member-reads-host-handoff.png`: member, same question: "I can't give you their note". `m05b`/`m05c`: it searched for "handoff" only, and `team_status` lists only "MouhssineElBoumshouli wrote a handoff note." The note was in the member's state (checked with `git show` on its state repo: changed, left, risks, file, commit).
- `m05d-member-finds-host-handoff.png`: "look for what Mouhssine left about the search query parser": gives the note correctly. So the note crossed; finding it is the gap (see below).

### 4. The same-second claim race

- Both chats got the same message in the same second ("Claim src/shared/format.ts … as your first action"), sent 19:50:38.38 and 19:50:38.41.
- The agents' claim calls landed 2.1 s apart (member 19:50:40.6, host 19:50:42.7). So the host's claim fetched first and saw the member's: `h06-race-claim.png`, "it overlaps with Yassine … sort it out with them before anyone edits it". The member's claim (first) said "No overlaps": `m06-race-claim.png`.
- `m07-race-after-sync.png`: member, "check with the team once more": "MouhssineElBoumshouli also claimed format.ts after you did". The raw `team_status` result (from the agent's own Claude Code transcript) had `"lateOverlaps":["Since you claimed, MouhssineElBoumshouli also claimed src/shared/format.ts. Tell the user before editing those."]`.
- `h07-race-after-sync.png`: host, same question: "Yassine is still on format.ts … check with Yassine".
- Race 2 (`src/api/client.ts`), to try for a tighter race: claims landed 8 s apart (member 19:53:33.3, host 19:53:41.4); same pattern, the host warned in its claim result (`h08-race2-claim.png`), the member's said "No overlaps" (transcript; my member screenshot of that moment showed an old part of the chat, so I did not keep it). The member mentions the client.ts overlap in step 5.
- **Not reached:** both claims pushed before either fetched (the true same-second case). Agents take 3 to 17 s to make their first call, so I could not get them within the ~3 s window. That case is covered by the unit test ("keeps a claim made offline … tells both sides … once") and by the 6 GitHub races in STORAGE_PLAN.md Q4.

### 5. Editing a file the other side holds (no tools named)

- Host: "Change avatarUrl in src/profile/avatar.ts so the default size is 128 instead of 64." `h09-edit-teammate-file.png`: "I haven't made the edit yet. avatar.ts is already claimed by Yassine for 'Profile: avatar sizes', and their handoff says they plan to support 32/64/128 sizes … Do you want me to go ahead anyway, or check with Yassine first?" It did claim the file for its own thread before asking (so it now overlaps).
- Member: "In src/search/query.ts, raise the default limit in parseQuery from 20 to 50." `m09-edit-teammate-file.png`: "I haven't made the change, because query.ts is claimed by MouhssineElBoumshouli … Should I go ahead and edit query.ts anyway?" It also raised the format.ts and client.ts overlaps.
- `git status` in both clones and both worktrees afterwards: clean.

## Findings

1. **Handoffs are hard to find** (not a sync problem). `team_status` says "X wrote a handoff note" but gives no way to read it; `team_memory_search` for "handoff" returns nothing because it searches the note text. Both agents tried "handoff" first; one gave up. A small fix: `team_status` could include teammates' latest handoffs (who, file, left, risks), or memory search could match "handoff".
2. **The first draft after "Add project → Local folder" ignores t3.json** (upstream). See the PROGRESS.md entry.
3. Agents note claims in other people's copies as "not merged into yours yet", as designed.

## Clean-up

Browser closed. Both vp processes stopped by the PIDs captured at start (317413, 318381), then their four children on ports 13773, 13774, 5733, 5734 (working folders `apps/server` and `apps/web` of the t3code checkout). Timing monitor stopped by its PID. Ports free.

Left in place: the two worktrees and their branches in the scratch clones (`t3code/search-quoted-phrases`, `t3code/summarize-team-work`), the member clone `~/code/t3-team-scratch-member`, the dev home `~/.t3-dev-member`, and on GitHub the state ref with this round's claims and tasks (as asked).
