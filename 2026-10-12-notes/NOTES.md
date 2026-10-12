# Notes on Team home / Today (UI slice 4, part 2)

Tested on `main` at a0ba7105f (n1 to n6). The face fix a14d2afb4 came after: in n2 and n3 the faces already show "MO" (picked up by hot reload); the label still reads "You".

Setup: `vp run dev --home-dir ~/.t3-dev` as `mouhssine` (login override, local remote), Codex GPT-6-Astra, headless Chromium 1440×900. Team: fresh `~/code/team-demo15` (seed script), given its own team id `team-demo15-notes` because older demo projects in the dev home share the seed's id. Sara is a scratch script that edits her writer file on the local remote, the way her server would. Solo: fresh `~/code/solo-demo9` (plain Git repo, `src/db/`).

- **n1-agent-followed-note.png** (team, light). Chat "Add Pin Saving Function". Turn 1: Codex called `team_plan` on `src/pins/store.ts`; its answer carried Sara's note for agents ("Pins keep their id…", seen in Codex's session log as `teamNotes`). Turn 2, after I wrote a note for agents on the same file: the turn note carried only my note (`<team_notes>…savePin must refuse a pin with an empty url…`), not Sara's again, and Codex says "Also added empty-URL rejection per the team note". Turn 3 had no note.
- **n2-team-notes-light.png** (team, light). Notes section: the not-private line; the form; "For you · 1 note" (Sara's note to me, with my reply); "For everyone" (Sara's note on `src/pins/store.ts`, "Agents know this"); "From you" (my note, "Seen by Sara", seen read from Sara's file); "Hide done" open.
- **n3-team-notes-done-dark.png** (team, dark). Same, scrolled: the done note I wrote to Sara, with her reply "Thanks! Merging tonight.", "Seen by Sara", "Done by Sara".
- **n4-file-tree-note-mark-dark.png** (team, dark). File tree filtered to "store": `src/pins/store.ts` shows "✎2" (two open notes on it).
- **n5-solo-today-notes-light.png** (solo, light). Today for `solo-demo9`: "Notes to future you. Kept on this computer…", one note on `src/db` for agents, one note marked done and folded ("Done (1)").
- **n6-solo-agent-followed-note-dark.png** (solo, dark). Asked to add a "tags" step to `src/db/migrate.ts`; `team_plan`'s answer carried the note (no name, solo) and Codex says "All steps now use create-if-missing, as required by the project rule."
