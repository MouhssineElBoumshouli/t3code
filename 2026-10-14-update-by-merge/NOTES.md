# Update by merging; check on a fix's result (2026-10-14)

`main` commit tested: c4946c1166 ("feat(team): updates merge instead of rebasing; check a fix's result").
One dev server (`~/.t3-dev`), fresh seeded `team-demo21` with a `typecheck` script (`tsc --noEmit`) on `main`. Provider: Codex, GPT-6-Astra.

Steps:
1. A worktree chat added `src/api/count.ts` (`countPins` calls `searchPins`) and a `/pins/count` route in `src/api/routes.ts`, and committed (after "Go anyway" on Sara's seeded claim of `routes.ts`).
2. `main` renamed `searchPins` to `findPins` (pushed from a scratch clone; `routes.ts` imports `findPins as searchPins`, so Git merges cleanly).
3. Team home: "`main` both changed `src/api/routes.ts` and merge cleanly." Check now: "Combined with `main`, `searchPins` is gone but still used in `src/api/count.ts` (yours)." Fix it.
4. The chat's worktree has no `node_modules`. When the fix turn ended, the server checked the fix's result in the combine copy.
5. Approve: merge commit "Merge main" holds the fix (`count.ts` imports `findPins as searchPins`); the chat's own commit still calls `searchPins`.
6. `main` moved again ("Say Not found on 404", same file, other line). "Update my copy": combined check clean, then a merge: "Merge main" on top of the approved fix. `count.ts` keeps the fix; `tsc --noEmit` on the new HEAD: 0 errors. After the recheck: "Nothing to report".

Pictures:
- `01-fix-result-checked.png`: the fix line before Approve, "On the fix, `npm run typecheck` finds nothing new."
- `02-copy-updated.png`: "Copy updated" after "Update my copy", with the pre-update combined check ("finds nothing new").
