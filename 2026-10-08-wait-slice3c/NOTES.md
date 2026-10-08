# 2026-10-08: small fixes, the stale-view line, "Wait" (slice 3c), live self-test

`main` at 857a5aba0 (small fixes), fba8b3dfd (stale-view line), fe62fccf1 ("Wait"). Dev server `vp run dev --home-dir ~/.t3-dev` with `T3CODE_TEAM_LOGIN_OVERRIDE=mouhssine`, headless Chromium 1440x900. Claude Sonnet 5.5, Codex GPT-6-Astra.

Projects: `~/code/team-demo10` and `~/code/team-demo11` (fresh seeds: Sara holds `src/pins/search.ts` and `src/api/routes.ts`, Omar `src/auth/session.ts`; worktrees), `~/code/solo-demo5` and `~/code/solo-demo6` (plain repos, local checkout).

| Picture | What it shows |
| --- | --- |
| r1-01 | team-demo10, Claude: the card held `team_plan` from 17:22:06 to the click at 17:28:19 (6 min 12 s, past Claude Code's old 60 s drop); "You chose: Go anyway · sent to the agent" (the held call); "Worked for 6m 40s"; the edit landed. |
| r1-02 | team-demo10, Claude told to Edit Sara's `search.ts` with no team tools: the hook refused; the group reads "Used 1 tool and could not change 1 file" (was "Changed 1 file"). |
| r2-01 | solo-demo5, Claude chat A after Codex chat B changed `format.ts`: asked to describe the file first, Claude said "That draft rule is from another chat" (its turn carried the stale-view line; server log). Then it planned and got the card (B holds the file). |
| r2-02 | solo-demo5, Codex chat B after chat A added trimming: "preserving trimming and quotes" (its turn carried the line). The stored user message shows no line. |
| r3-01 | solo-demo6, Claude, the file chat B (Codex) holds: the card with "Find another way", "Go anyway", "Wait for that chat" (solo: no coming-soon row). Sidebar "Input". |
| r3-02 | After "Wait for that chat": "Waiting for that chat to let go of it · this chat goes on by itself then", "Stop waiting"; Claude ended its turn without editing; sidebar no longer "Input". |
| r3-03 | After "Stop waiting": the card is open again with all three choices; sidebar "Input" again. |
| r3-04 | Waited again, then chat B archived (its claim released): 15 s later "Done waiting: the other chat let go of `notes.ts`. Re-read it, then continue the task." as a new message; Claude planned (nobody holds it) and added `removeNote` on top of B's `pinned` change. |
| r3-05 | The card after: "Waited for that chat · the chat went on as a new message". The holder reads `your chat "another chat"` because B is archived; fixed after this picture (now "another of your chats"; not re-shot). |
| r3-06 | team-demo11, Codex, Sara's `search.ts`: the team card with "Wait for Sara"; "Build on top of Sara's work" and "Ask Sara" still coming soon. |
| r3-07 | After "Wait for Sara": waiting row with "Stop waiting"; Codex got the answer on its held call and ended its turn, no files changed. |
| r3-08 | Sara's commit pushed to the remote's main and her claim released (scratch script as Sara's server): 11 s later the wait ended, the chat's worktree was rebased onto `origin/main` (now at Sara's commit), and "Done waiting: Sara let go of `search.ts`. Your copy is now on top of `origin/main`, with their work..." started a turn; Codex added `.slice(0, 20)` to Sara's new tag-filter version. Card: "Waited for Sara". |
