import { VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as TeamHost from "./TeamHost.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const repo = { host: "github.com", owner: "sara", name: "school-project" };

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
      assert.deepEqual(yield* host.login(repo), {
        status: "signedIn",
        login: "Sara-Dev",
        override: false,
      } as TeamHost.TeamHostLogin);
      assert.deepEqual(calls, [["auth", "status", "--json", "hosts", "--hostname", "github.com"]]);
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
      const result = yield* host.login(repo);
      assert.equal(result.status, "signedOut");
      assert.include(result.status === "signedOut" ? result.detail : "", "token expired");
    }),
  );

  it.effect("is signed out with no account, and unavailable without gh", () =>
    Effect.gen(function* () {
      const signedOut = yield* hostWith(() => ({ exitCode: 1, stdout: authStatus([]) }));
      assert.equal((yield* signedOut.host.login(repo)).status, "signedOut");

      const missing = yield* hostWith(() => "not-installed");
      assert.deepEqual(yield* missing.host.login(repo), {
        status: "unavailable",
        detail: "The GitHub CLI (gh) is not installed.",
      });

      const garbled = yield* hostWith(() => ({ exitCode: 1, stderr: "unknown flag: --json" }));
      const result = yield* garbled.host.login(repo);
      assert.equal(result.status, "unavailable");
    }),
  );

  it.effect("uses the dev override only in dev mode", () =>
    Effect.gen(function* () {
      const gh = () => ({ stdout: authStatus([account("sara", { active: true })]) });

      const dev = yield* hostWith(gh, { devMode: true, loginOverride: "yassine" });
      assert.deepEqual(yield* dev.host.login(repo), {
        status: "signedIn",
        login: "yassine",
        override: true,
      } as TeamHost.TeamHostLogin);
      assert.deepEqual(dev.calls, [], "the override does not ask gh");

      const notDev = yield* hostWith(gh, { devMode: false, loginOverride: "yassine" });
      assert.deepEqual(yield* notDev.host.login(repo), {
        status: "signedIn",
        login: "sara",
        override: false,
      } as TeamHost.TeamHostLogin);

      const invalid = yield* hostWith(gh, { devMode: true, loginOverride: "../sara" });
      assert.equal((yield* invalid.host.login(repo)).status, "unavailable");
    }),
  );
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

  it.effect("is unavailable on a rate limit, a garbled answer or no gh", () =>
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

      const missing = yield* hostWith(() => "not-installed");
      assert.equal((yield* missing.host.refChanged(repo, null)).status, "unavailable");
    }),
  );
});
