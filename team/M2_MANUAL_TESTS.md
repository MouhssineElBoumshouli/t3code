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

## M2.3 `t3 team invite` and the join endpoint (host), plus the Vite cache fix

Three Ubuntu windows. **Window 1** runs the host server, **window 2** the member server, **window 3** is for commands. Start every window with `cd ~/code/t3code`. Both servers stopped before you begin.

`t3 team join` (the member side) is M2.4, so here window 3 does by hand what the member's server will do: exchange the invite URL for a session, then call `/join`. The joiner is a made-up member called "Probe", so that M2.4 can still invite Sara.

The invite prints times in Ubuntu's clock, which is UTC on this machine (`date` in window 3 shows it), not Windows' clock.

### Part A: two dev servers, two Vite caches

1. **Window 3.** Remove the old shared cache, which no dev server uses any more:

   ```bash
   rm -rf apps/web/node_modules/.vite
   ```

   Prints nothing.

2. **Window 1.** Start the host:

   ```bash
   vp run dev --home-dir ~/.t3-dev
   ```

   You see `[dev-runner] mode=dev source=… serverPort=13773 webPort=5733 baseDir=/home/mouhssine/.t3-dev`.

3. **Browser.** Open http://localhost:5733 and wait until the host UI has loaded.

4. **Window 2.** Start the member:

   ```bash
   T3CODE_PORT_OFFSET=20 vp run dev --home-dir ~/.t3-dev-member
   ```

   You see `[dev-runner] mode=dev source=T3CODE_PORT_OFFSET=20 serverPort=13793 webPort=5753 …`.

5. **Browser.** Open http://localhost:5753 (member UI). Then go back to the host tab and reload it three times, opening a chat and Settings in between.

   You see: the host page keeps working. No "error loading dynamically imported module" (the bug from the M2.2 test).

6. **Window 3.**

   ```bash
   ls -d apps/web/node_modules/.vite*
   ```

   You see `apps/web/node_modules/.vite-dev-5733`, `apps/web/node_modules/.vite-dev-5753` and `apps/web/node_modules/.vite-temp`, and no plain `.vite`: one cache per web port.

7. **Both UIs:** no project called "server". (Since this commit `vp run dev` turns that off by itself; `.env.local` can stay.)

### Part B: invite, exchange, join (host side)

8. **Window 3.** Make an invite for Demo team 6:

   ```bash
   node apps/server/src/bin.ts team invite ~/code/team-demo6-host --name Probe --base-dir ~/.t3-dev
   ```

   You see:

   ```
   Invite for Probe to team "Demo team 6" (invite <id>).

     http://localhost:5733/team-invite#invite=<long code>

   Expires at HH:MM (<date>T<time>Z, 30m from now). It works once.
   It gives team access only (team:read, team:write): no projects, chats, files or terminals on this server.
   The URL points at localhost, so it only works from this machine.
   ...
   Do not open it in a browser. Probe's server joins with `t3 team join` (M2.4, not built yet).
   ```

   Do not click the URL. Copy it.

9. **Window 3.** It is listed as pending:

   ```bash
   node apps/server/src/bin.ts team invites --base-dir ~/.t3-dev
   ```

   You see `Demo team 6 (teamId 3c5c6962-…)` and under it `pending  Probe  invite <id>  made …, expires …`.

10. **Window 3.** Exchange the URL the way the member's server will. Paste your URL between the quotes:

    ```bash
    INVITE='<paste the URL from step 8>'
    CRED="${INVITE#*#invite=}"
    exchange() { curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:5733/oauth/token --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange --data-urlencode "subject_token=$1" --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token; }
    OUT=$(exchange "$CRED"); TOKEN=$(echo "$OUT" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    echo "$OUT" | tail -1; echo "token length ${#TOKEN}"; echo "$OUT" | grep -o '"scope":"[^"]*"'
    ```

    You see `HTTP 200`, `token length` with a number above 20, and `"scope":"team:read team:write"`.

11. **Window 3.** The same URL again:

    ```bash
    exchange "$CRED" | tail -1
    ```

    You see `HTTP 401`: an invite works once.

12. **Window 3.** Before joining, the session is no member:

    ```bash
    curl -s -w '\n' -H "authorization: Bearer $TOKEN" http://localhost:5733/api/team/v1/me
    ```

    You see `{"_tag":"TeamMembershipRequiredError",…,"reason":"not_a_member"}`.

13. **Window 3.** Join. The body also tries to make itself owner under another name; the host ignores that:

    ```bash
    curl -s -w '\n' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"environmentId":"env-manual-probe","role":"owner","displayName":"Boss"}' \
      http://localhost:5733/api/team/v1/join
    ```

    You see JSON with `"name":"Demo team 6"` and a member with `"displayName":"Probe"`, `"role":"member"`, `"environmentId":"env-manual-probe"`. Note its `memberId`.

14. **Window 3.** Join again and ask who you are:

    ```bash
    curl -s -w '\n' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"environmentId":"env-manual-probe"}' http://localhost:5733/api/team/v1/join
    curl -s -w '\n' -H "authorization: Bearer $TOKEN" http://localhost:5733/api/team/v1/me
    ```

    Both show the same `memberId` as step 13: no second member.

15. **Window 3.** The host sees one new member and a used invite:

    ```bash
    node apps/server/src/bin.ts team status --base-dir ~/.t3-dev
    node apps/server/src/bin.ts team invites --base-dir ~/.t3-dev
    ```

    Under Demo team 6: `members: <your name> (owner), Probe (member)`, and `used  Probe  invite <id>  made …, joined …`.

16. **Window 3.** The team session reaches nothing else on the host:

    ```bash
    curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" http://localhost:5733/api/orchestration/snapshot
    curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"scopes":["orchestration:read"]}' http://localhost:5733/api/auth/pairing-token
    curl -s -w '\n' -H "authorization: Bearer $TOKEN" http://localhost:5733/api/team/v1/teams/some-other-team/board
    ```

    You see `403`, `403`, and `{"_tag":"TeamMembershipRequiredError",…,"reason":"other_team"}`.

17. **Browser, host UI.** Settings → Connections. A client labelled "Team Demo team 6: Probe" is listed with 2 scopes; opening them shows `team:read` and `team:write`. (Checks the plan's open question in DESIGN.md 7.4.)

### Part C: refused invites

18. **Window 3.** Revoke an unused invite:

    ```bash
    node apps/server/src/bin.ts team invite ~/code/team-demo6-host --name Lina --base-dir ~/.t3-dev
    ```

    Copy its invite id (in the first line) and its URL, then:

    ```bash
    node apps/server/src/bin.ts team invites --revoke <Lina's invite id> --base-dir ~/.t3-dev
    INVITE='<paste Lina's URL>'; exchange "${INVITE#*#invite=}" | tail -1
    ```

    You see `Revoked invite <id> for Lina. Its URL no longer works, and the host refuses to join with it.`, then `HTTP 401`.

19. **Window 3.** Expiry: a 2 minute invite.

    ```bash
    node apps/server/src/bin.ts team invite ~/code/team-demo6-host --name Omar --ttl 2m --base-dir ~/.t3-dev
    ```

    You see `Expires at HH:MM (…, 2m from now)`. Wait until `date` is past that time, then:

    ```bash
    node apps/server/src/bin.ts team invites --base-dir ~/.t3-dev
    ```

    You see `expired  Omar …` and `revoked  Lina …` next to `used  Probe …`.

20. **Window 3.** The host's checks on names and lifetime:

    ```bash
    node apps/server/src/bin.ts team invite ~/code/team-demo6-host --name probe --base-dir ~/.t3-dev
    node apps/server/src/bin.ts team invite ~/code/team-demo6-host --name Nadia --ttl 25h --base-dir ~/.t3-dev
    node apps/server/src/bin.ts team invite ~/code/team-demo6-member --name Nadia --base-dir ~/.t3-dev-member
    ```

    Each fails, with (first line of the error): `Team "Demo team 6" already has a member named Probe. Pick another name.`; `An invite lasts more than 0 and at most 24 hours (--ttl). Got 1d 1h.`; `This T3 home does not host team 3c5c6962-…, so it cannot invite anyone to it.` (the member's server cannot invite).

21. **Window 3.** Nothing leaked:

    ```bash
    grep -rlF "$TOKEN" ~/.t3-dev/userdata/logs ~/code/team-demo6-host; grep -rlF "$CRED" ~/.t3-dev/userdata/logs ~/code/team-demo6-host; echo checked
    git -C ~/code/team-demo6-host status --short
    unset TOKEN CRED INVITE OUT
    ```

    You see only `checked`, and `git status` prints nothing.

**Pass:** Part A: the host page survives the member server starting, and there is one `.vite-dev-<port>` per server. Part B: the invite works once, joins once as a `member` named by the host whatever the body says, and the session reaches only its own team. Part C: revoked, expired and used invites are refused, the name and lifetime rules hold, and neither credential nor token is in a log or the repo.

Leave both servers running if you go on; stop them (Ctrl+C in windows 1 and 2) before a typecheck. Probe stays a member of Demo team 6 until members can be removed (M2.9); M2.4's test starts from a fresh demo (`--demo ~/code/team-demo7`).
