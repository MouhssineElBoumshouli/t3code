import { VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as TeamHost from "./TeamHost.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const repo = { host: "github.com", owner: "sara", name: "school-project" };
const repoUrl = "https://github.com/sara/school-project.git";

type Reply =
  | { readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string }
  | "not-installed";

/** A TeamHost whose `gh` answers from `reply`; returns it with the argument lists it got. */
const hostWith = (
  reply: (args: ReadonlyArray<string>) => Reply,
  options: Partial<TeamHost.TeamHostOptions> = {},
) =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const host = yield* TeamHost.make({ devMode: false, cwd: "/tmp", ...options }).pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          assert.equal(input.command, "gh");
          assert.isTrue(input.allowNonZeroExit, "gh's exit code alone decides nothing");
          calls.push(input.args);
          const answer = reply(input.args);
          if (answer === "not-installed") {
            return Effect.fail(
              new VcsProcessSpawnError({
                operation: input.operation,
                command: "gh",
                cwd: input.cwd,
                cause: new Error("spawn gh ENOENT"),
              }),
            );
          }
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(answer.exitCode ?? 0),
            stdout: answer.stdout ?? "",
            stderr: answer.stderr ?? "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      }),
    );
    return { host, calls };
  });

const account = (login: string, fields: { active: boolean; state?: string; error?: string }) => ({
  state: fields.state ?? "success",
  active: fields.active,
  host: "github.com",
  login,
  ...(fields.error === undefined ? {} : { error: fields.error }),
});

const authStatus = (accounts: ReadonlyArray<ReturnType<typeof account>>) =>
  toJson({ hosts: accounts.length === 0 ? {} : { "github.com": accounts } });

/** `gh api -i` output, as gh prints it. */
const httpOutput = (status: string, headers: Record<string, string>, body = "") =>
  [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)]
    .join("\r\n")
    .concat("\r\n\r\n", body);

describe("parseTeamRemoteUrl", () => {
  it("reads HTTPS, SSH and scp-style remotes", () => {
    for (const url of [
      "https://github.com/sara/school-project",
      "https://github.com/sara/school-project.git",
      "https://GitHub.com/sara/school-project/",
      "ssh://git@github.com/sara/school-project.git",
      "git@github.com:sara/school-project.git",
    ]) {
      assert.deepEqual(TeamHost.parseTeamRemoteUrl(url), repo, url);
    }
    assert.deepEqual(TeamHost.parseTeamRemoteUrl("https://ghe.school.edu/a/b.git"), {
      host: "ghe.school.edu",
      owner: "a",
      name: "b",
    });
  });

  it("refuses remotes that do not name one repo on a host", () => {
    for (const url of [
      "file:///tmp/origin.git",
      "/tmp/origin.git",
      "https://github.com/sara",
      "https://github.com/sara/a/b",
      "not a url",
    ]) {
      assert.isNull(TeamHost.parseTeamRemoteUrl(url), url);
    }
  });
});

describe("TeamHost.login", () => {
  it.effect("uses the active account when several are signed in", () =>
    Effect.gen(function* () {
      const { host, calls } = yield* hostWith(() => ({
        stdout: authStatus([
          account("yassine-old", { active: false }),
          account("Sara-Dev", { active: true }),
        ]),
      }));
      assert.deepEqual(yield* host.login(repoUrl, repo), {
        status: "signedIn",
        login: "Sara-Dev",
        override: false,
      } as TeamHost.TeamHostLogin);
      assert.deepEqual(calls, [["auth", "status", "--json", "hosts", "--hostname", "github.com"]]);
    }),
  );

  it.effect("asks gh once per host while signed in, and again after 10 minutes", () =>
    Effect.gen(function* () {
      let signedIn = true;
      const { host, calls } = yield* hostWith(() =>
        signedIn
          ? { stdout: authStatus([account("Sara-Dev", { active: true })]) }
          : { exitCode: 1, stdout: authStatus([]) },
      );
      assert.equal((yield* host.login(repoUrl, repo)).status, "signedIn");
      assert.equal((yield* host.login(repoUrl, repo)).status, "signedIn");
      assert.lengthOf(calls, 1);

      // Signed out since: the cached answer stands until it is 10 minutes old.
      signedIn = false;
      yield* TestClock.adjust("9 minutes");
      assert.equal((yield* host.login(repoUrl, repo)).status, "signedIn");
      assert.lengthOf(calls, 1);
      yield* TestClock.adjust("1 minute");
      assert.equal((yield* host.login(repoUrl, repo)).status, "signedOut");
      assert.lengthOf(calls, 2);

      // A signed-out answer is not kept: signing in works on the next call.
      signedIn = true;
      assert.equal((yield* host.login(repoUrl, repo)).status, "signedIn");
      assert.lengthOf(calls, 3);
    }),
  );

  it.effect("is signed out when the active account's sign-in fails, even if another works", () =>
    Effect.gen(function* () {
      const { host } = yield* hostWith(() => ({
        exitCode: 1,
        stdout: authStatus([
          account("sara", { active: true, state: "error", error: "token expired" }),
          account("yassine", { active: false }),
        ]),
      }));
      const result = yield* host.login(repoUrl, repo);
      assert.equal(result.status, "signedOut");
      assert.include(result.status === "signedOut" ? result.detail : "", "token expired");
    }),
  );

  it.effect("is signed out with no account, and unavailable without gh", () =>
    Effect.gen(function* () {
      const signedOut = yield* hostWith(() => ({ exitCode: 1, stdout: authStatus([]) }));
      assert.equal((yield* signedOut.host.login(repoUrl, repo)).status, "signedOut");

      const missing = yield* hostWith(() => "not-installed");
      assert.deepEqual(yield* missing.host.login(repoUrl, repo), {
        status: "unavailable",
        detail: "The GitHub CLI (gh) is not installed.",
      });

      const garbled = yield* hostWith(() => ({ exitCode: 1, stderr: "unknown flag: --json" }));
      const result = yield* garbled.host.login(repoUrl, repo);
      assert.equal(result.status, "unavailable");
    }),
  );

  it.effect("uses the dev override only in dev mode, and only for a remote on this computer", () =>
    Effect.gen(function* () {
      const gh = () => ({ stdout: authStatus([account("sara", { active: true })]) });
      const local = "file:///home/sara/school-project-remote.git";

      const dev = yield* hostWith(gh, { devMode: true, loginOverride: "yassine" });
      assert.deepEqual(yield* dev.host.login(local, null), {
        status: "signedIn",
        login: "yassine",
        override: true,
      } as TeamHost.TeamHostLogin);
      assert.equal(
        (yield* dev.host.login("/home/sara/school-project-remote.git", null)).status,
        "signedIn",
      );
      assert.deepEqual(dev.calls, [], "the override does not ask gh");

      // A GitHub team always gets the gh login: the override never writes there.
      assert.deepEqual(yield* dev.host.login(repoUrl, repo), {
        status: "signedIn",
        login: "sara",
        override: false,
      } as TeamHost.TeamHostLogin);
      assert.lengthOf(dev.calls, 1);
      // Not even a GitHub remote this app cannot locate.
      assert.equal(
        (yield* dev.host.login("git://github.com/sara/school-project.git", null)).status,
        "signedOut",
      );

      const notDev = yield* hostWith(gh, { devMode: false, loginOverride: "yassine" });
      assert.equal((yield* notDev.host.login(local, null)).status, "signedOut");
      assert.deepEqual(notDev.calls, [], "no gh call for a local remote");

      const invalid = yield* hostWith(gh, { devMode: true, loginOverride: "../sara" });
      assert.equal((yield* invalid.host.login(local, null)).status, "unavailable");
    }),
  );
});

describe("isLocalTeamRemote", () => {
  it("is true only for file URLs and folder paths", () => {
    for (const url of [
      "file:///home/sara/remote.git",
      "FILE:///C:/remote.git",
      "/home/sara/remote.git",
      "../remote.git",
      "remote.git",
      "C:\\Users\\sara\\remote.git",
      "D:/remote.git",
      "\\\\server\\share\\remote.git",
    ]) {
      assert.isTrue(TeamHost.isLocalTeamRemote(url), url);
    }
    for (const url of [
      "https://github.com/sara/school-project.git",
      "ssh://git@github.com/sara/school-project.git",
      "git@github.com:sara/school-project.git",
      "github.com:sara/school-project.git",
      "git://github.com/sara/school-project.git",
      "",
    ]) {
      assert.isFalse(TeamHost.isLocalTeamRemote(url), url);
    }
  });
});

describe("TeamHost.repoAccess", () => {
  it.effect("reads push access and visibility", () =>
    Effect.gen(function* () {
      const answers: Record<string, string> = {
        "repos/sara/private-push": toJson({
          private: true,
          visibility: "private",
          permissions: { admin: false, push: true, pull: true },
        }),
        "repos/sara/public-read": toJson({
          private: false,
          visibility: "public",
          permissions: { push: false, pull: true },
        }),
        "repos/sara/no-permissions": toJson({ private: false }),
      };
      const { host, calls } = yield* hostWith((args) => ({ stdout: answers[args.at(-1)!] ?? "" }));
      const access = (name: string) => host.repoAccess({ ...repo, name });

      assert.deepEqual(yield* access("private-push"), {
        status: "found",
        canPush: true,
        isPublic: false,
      });
      assert.deepEqual(yield* access("public-read"), {
        status: "found",
        canPush: false,
        isPublic: true,
      });
      assert.deepEqual(yield* access("no-permissions"), {
        status: "found",
        canPush: false,
        isPublic: true,
      });
      assert.deepEqual(calls[0], ["api", "repos/sara/private-push"]);
    }),
  );

  it.effect("tells a missing repo from a failure, and passes --hostname off github.com", () =>
    Effect.gen(function* () {
      const { host, calls } = yield* hostWith((args) =>
        args.includes("repos/sara/gone")
          ? { exitCode: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)" }
          : { exitCode: 1, stderr: "error connecting to api.github.com" },
      );
      assert.deepEqual(yield* host.repoAccess({ ...repo, name: "gone" }), { status: "notFound" });
      assert.deepEqual(yield* host.repoAccess({ ...repo, host: "ghe.school.edu" }), {
        status: "unavailable",
        detail: "error connecting to api.github.com",
      });
      assert.deepEqual(calls[1], [
        "api",
        "--hostname",
        "ghe.school.edu",
        "repos/sara/school-project",
      ]);
    }),
  );
});

describe("TeamHost.refChanged", () => {
  it.effect("sends the ETag, and reads 200, 304 and 404 from the status line", () =>
    Effect.gen(function* () {
      const etag = 'W/"abc123"';
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const { host, calls } = yield* hostWith((args) => {
        if (args.includes("repos/sara/new-team/git/ref/t3-team/state")) {
          return {
            exitCode: 1,
            stdout: httpOutput("404 Not Found", {}, '{"message":"Not Found"}'),
            stderr: "gh: Not Found (HTTP 404)",
          };
        }
        // gh exits 1 on a 304, like on any other non-2xx answer.
        return args.includes(`If-None-Match: ${etag}`)
          ? { exitCode: 1, stdout: httpOutput("304 Not Modified", { Etag: etag }) }
          : {
              stdout: httpOutput(
                "200 OK",
                { "Content-Type": "application/json", Etag: etag, "X-Ratelimit-Used": "6" },
                toJson({ ref: "refs/t3-team/state", object: { sha, type: "commit" } }),
              ),
            };
      });

      assert.deepEqual(yield* host.refChanged(repo, null), { status: "current", sha, etag });
      assert.deepEqual(yield* host.refChanged(repo, etag), { status: "unchanged" });
      assert.deepEqual(yield* host.refChanged({ ...repo, name: "new-team" }, null), {
        status: "missing",
      });
      assert.deepEqual(calls[0], ["api", "-i", "repos/sara/school-project/git/ref/t3-team/state"]);
      assert.deepEqual(calls[1], [
        "api",
        "-i",
        "-H",
        `If-None-Match: ${etag}`,
        "repos/sara/school-project/git/ref/t3-team/state",
      ]);
    }),
  );

  it.effect("is unavailable on a rate limit, a garbled answer or offline", () =>
    Effect.gen(function* () {
      const limited = yield* hostWith(() => ({
        exitCode: 1,
        stdout: httpOutput("403 Forbidden", { "X-Ratelimit-Remaining": "0" }, "{}"),
      }));
      assert.deepEqual(yield* limited.host.refChanged(repo, null), {
        status: "unavailable",
        detail: "GitHub answered HTTP 403.",
      });

      const garbled = yield* hostWith(() => ({ stdout: httpOutput("200 OK", {}, "<html>") }));
      assert.equal((yield* garbled.host.refChanged(repo, null)).status, "unavailable");

      const offline = yield* hostWith(() => ({ exitCode: 1, stderr: "dial tcp: no such host" }));
      assert.deepEqual(yield* offline.host.refChanged(repo, null), {
        status: "unavailable",
        detail: "dial tcp: no such host",
      });
    }),
  );

  it.effect("says to check with Git instead without gh or a working sign-in", () =>
    Effect.gen(function* () {
      const missing = yield* hostWith(() => "not-installed");
      assert.equal((yield* missing.host.refChanged(repo, null)).status, "noApi");

      const signedOut = yield* hostWith(() => ({
        exitCode: 4,
        stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
      }));
      assert.equal((yield* signedOut.host.refChanged(repo, null)).status, "noApi");

      const refused = yield* hostWith(() => ({
        exitCode: 1,
        stdout: httpOutput("401 Unauthorized", {}, "{}"),
      }));
      assert.equal((yield* refused.host.refChanged(repo, null)).status, "noApi");
    }),
  );
});
