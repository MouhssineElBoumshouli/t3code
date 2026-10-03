# M2 manual tests

One section per slice of the M2 plan (team/DESIGN.md section 7). Run commands from the t3code repo. `t3` means `node apps/server/src/bin.ts`. The first CLI command against a new home also prints migration log lines; they are expected.

Setup for every slice is in DESIGN.md 7.3: host home `~/.t3-dev` (ports 13773/5733), member home `~/.t3-dev-member` (`T3CODE_PORT_OFFSET=20`, ports 13793/5753), demo folders `~/code/team-demo6-*`.

## M2.0 Test bench

1. Build the demo (the host dev server may be running):

   ```bash
   node apps/server/scripts/team-two-person-setup.ts
   ```

   Expect "Registered in the T3 home at /home/…/.t3-dev, which now hosts this team, with <your name> as owner." and "Ready. Team "Demo team 6" is hosted by ~/.t3-dev." If you ran it before, it first says "Removed the old demo team <id> …": that is the reset.

2. Check the folders:
   - `git -C ~/code/team-demo6-member log --oneline` shows "Set up team Demo team 6" and "Pinboard: first version".
   - `ls ~/code/team-demo6-member/.team` shows `rulebook.md team.json`.
   - `git -C ~/code/team-demo6-host status --short` and the same for `-member` print nothing.

3. Refusals write nothing. Each prints a reason and exits 1:
   - `node apps/server/scripts/team-two-person-setup.ts --host-home ~/.t3` ("Refusing the real T3 home").
   - `node apps/server/scripts/team-two-person-setup.ts --demo ~/code/t3code/demo` ("Refusing … agents there would read the rules").
   - `mkdir ~/code/team-demo-foreign-host && node apps/server/scripts/team-two-person-setup.ts --demo ~/code/team-demo-foreign` ("exists and was not made by this script"), then `rmdir ~/code/team-demo-foreign-host`.

4. Two servers side by side, one terminal each:

   ```bash
   vp run dev --home-dir ~/.t3-dev
   T3CODE_PORT_OFFSET=20 vp run dev --home-dir ~/.t3-dev-member
   ```

   The second prints `[dev-runner] mode=dev source=T3CODE_PORT_OFFSET=20 serverPort=13793 webPort=5753`.

5. In one browser: the host UI at http://localhost:5733 (already paired). For the member, open the pairing URL the member server prints at startup (its home is new). Add `~/code/team-demo6-host` as a project on the host and `~/code/team-demo6-member` on the member.

6. Use one tab, then reload the other, a few times each way.

**Pass:** both UIs work in the same browser without logging each other out, each shows only its own project, and nothing was written outside the three `team-demo6` folders and the two homes.

## M2.1 Only the host registers a team

Both servers running, M2.0 done.

1. **Member, no registration from a chat.** On the member UI, in `team-demo6-member`, start a new chat: "Call team_status, then team_claim src/pins/search.ts, and tell me exactly what each returned." Both return: "This project is in team Demo team 6, which is hosted on another T3 server. This server has not joined it, so team tools do nothing here. To join, ask the team's host for an invite."

2. **Member home hosts nothing**, even after that chat:

   ```bash
   node apps/server/src/bin.ts team status --base-dir ~/.t3-dev-member
   ```

   Prints "The T3 home at /home/…/.t3-dev-member hosts no teams."

3. **init refuses a clone:**

   ```bash
   node apps/server/src/bin.ts team init ~/code/team-demo6-member --base-dir ~/.t3-dev-member
   ```

   Fails with "This repo is already team "Demo team 6", and the T3 home at … does not host it. Its host is another T3 server: ask the host for an invite. Nothing was written or registered." Then `git -C ~/code/team-demo6-member status --short` prints nothing, and step 2 still prints "hosts no teams".

4. **init needs `--base-dir`:** `node apps/server/src/bin.ts team init ~/code/team-demo6-member` fails with "t3 team init needs --base-dir … Without it, it would use your real T3 install." and writes nothing.

5. **Host has the team before any chat:**

   ```bash
   node apps/server/src/bin.ts team status --base-dir ~/.t3-dev
   ```

   Lists "Demo team 6 (teamId …)" with "members: <your name> (owner)", next to your older demo teams.

6. **Host chat:** on the host UI, in `team-demo6-host`, new chat: "Call team_status." It answers for team "Demo team 6" with you as the member.

7. **Re-running init on the host changes nothing:** `node apps/server/src/bin.ts team init ~/code/team-demo6-host --base-dir ~/.t3-dev` prints "Already hosted by the T3 home at /home/…/.t3-dev." and "Nothing changed". Step 5 still shows one Demo team 6 with one owner.

8. **Old teams still work:** a new chat in `team-demo5` (the cold start demo): "Call team_status." It still answers for Demo team 5.

**Pass:** steps 1 to 4 show the member's server never registers or owns the team; steps 5 to 8 show the host registers it once through `t3 team init`, and teams from M1 keep working.

## M2.2 Scopes and the team API skeleton

The security tests (`apps/server/src/team/http/security.test.ts`) already prove the refusals against a real server. This checks only what they cannot: the dev proxy, your browser, and the "server" project.

1. **No "server" project.** Check `cat .env.local` shows `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0`. Stop and restart both dev servers (the setting is read when `vp run dev` starts). Then, for each home:

   ```bash
   node apps/server/src/bin.ts project remove ~/code/t3code/apps/server --base-dir ~/.t3-dev
   ```

   It refuses because the project has a chat ("New thread", made with it). If you never used that chat, run it again with `--force`: it removes the project and that chat from T3 only and touches no files. Repeat with `--base-dir ~/.t3-dev-member`. Restart both servers once more: neither UI shows "server".

2. **Through the dev proxy, no token:**

   ```bash
   curl -i http://127.0.0.1:5733/api/team/v1/me
   curl -i http://127.0.0.1:5753/api/team/v1/me
   ```

   Both print `401` and `"reason":"missing_credential"`.

3. **Host UI still works.** In the host UI: open a chat in `team-demo6-host` and send "Call team_status." (it answers for Demo team 6); open Settings → Connections (your sessions are listed). Then the same quick look in the member UI.

**Pass:** no "server" project after a restart, 401 from both proxies, and both UIs work as before.
