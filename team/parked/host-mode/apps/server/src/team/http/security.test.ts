// @effect-diagnostics nodeBuiltinImport:off - spawns a real server and talks HTTP and WebSocket to it.
// @effect-diagnostics unsafeEffectTypeAssertion:off anyUnknownInErrorContext:off - S2 calls each RPC by name, so its types are only known at run time.
/**
 * Security tests for the team API (team/DESIGN.md 7.2), run against a real
 * server: the `SecurityHost` layer starts `src/bin.ts` on a temp home, so the
 * routes, the session middleware, the scope checks and the handlers are the
 * ones a host runs. Nothing about auth is mocked.
 *
 * The team-only session is made the way a member gets one: a one-time pairing
 * link with exactly `[team:read, team:write]` (what `t3 team invite` makes),
 * exchanged at `/oauth/token` without asking for scopes (what `t3 team join`
 * will do, M2.4). The invite tests (M2.3) run the real `t3 team invite` and
 * `t3 team invites` commands against the same home while the server runs.
 *
 * S1 and S2 walk every endpoint of `EnvironmentHttpApi` and every RPC of
 * `WsRpcGroup` as listed at test time, with a valid payload generated from
 * each schema, so a new upstream endpoint or RPC is covered without editing
 * this file, and a refusal is the scope check rather than a decode error.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthTeamReadScope,
  AuthTeamWriteScope,
  EnvironmentHttpApi,
  TeamFile,
  TeamHttpApi,
  TeamId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type * as HttpMethod from "effect/unstable/http/HttpMethod";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../../auth/RpcAuthorization.ts";
import { resolveCliAuthConfig } from "../../cli/config.ts";
import { teamInviteLayer } from "../../cli/team.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as TeamInvites from "../TeamInvites.ts";
import * as TeamService from "../TeamService.ts";

const SERVER_DIR = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const BIN_PATH = NodePath.join(SERVER_DIR, "src", "bin.ts");
const TEAM_HTTP_DIR = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const TEAM_SCOPES = [AuthTeamReadScope, AuthTeamWriteScope] as const;
const STARTUP_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// HTTP

interface HttpResult {
  readonly status: number;
  /** `_tag` of a JSON error body, when there is one. */
  readonly tag: string | undefined;
  readonly text: string;
}

const decodeTagged = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.optional(Schema.String) })),
);

interface CallOptions {
  readonly method?: HttpMethod.HttpMethod;
  readonly headers?: Record<string, string>;
  readonly body?: HttpBody.HttpBody;
}

const httpCall = (url: string, options: CallOptions = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.make(options.method ?? "GET")(url, {
        headers: options.headers ?? {},
        ...(options.body ? { body: options.body } : {}),
      }),
    );
    const text = yield* response.text;
    return {
      status: response.status,
      tag: Option.getOrUndefined(decodeTagged(text))?._tag,
      text,
    } satisfies HttpResult;
  }).pipe(Effect.timeout("15 seconds"), Effect.orDie);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const decodeAccessToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ access_token: Schema.optional(Schema.String) })),
);

const exchangeCredential = (baseUrl: string, credential: string, scope?: string) =>
  httpCall(`${baseUrl}/oauth/token`, {
    method: "POST",
    body: HttpBody.urlParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      ...(scope === undefined ? {} : { scope }),
    }),
  }).pipe(
    Effect.map((result) => ({
      status: result.status,
      accessToken: Option.getOrUndefined(decodeAccessToken(result.text))?.access_token,
    })),
  );

// ---------------------------------------------------------------------------
// The host: a real server process on a temp home, and three sessions on it

interface Host {
  readonly baseUrl: string;
  readonly baseDir: string;
  readonly output: ReadonlyArray<string>;
  /** Exactly team:read and team:write, from a real token exchange. */
  readonly teamToken: string;
  readonly teamCredential: string;
  /** `AuthStandardClientScopes`: no team scope. */
  readonly standardToken: string;
  /** `AuthAdministrativeScopes`: every scope, team ones included. */
  readonly adminToken: string;
}

class SecurityHost extends Context.Service<SecurityHost, Host>()(
  "t3/team/http/security.test/SecurityHost",
) {}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** The child gets no T3CODE_* settings from whoever runs the tests, only these. */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("T3CODE_") || key.startsWith("VITEST") || key === "NODE_ENV") continue;
    env[key] = value;
  }
  return {
    ...env,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    T3CODE_TELEMETRY_ENABLED: "0",
    T3CODE_NO_BROWSER: "1",
  };
};

const waitForServer = (
  baseUrl: string,
  child: NodeChildProcess.ChildProcess,
  output: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    while (true) {
      if (child.exitCode !== null) {
        return yield* Effect.die(
          new Error(`server exited with ${child.exitCode}\n${output.join("").slice(-4_000)}`),
        );
      }
      const ready = yield* client.get(`${baseUrl}/.well-known/t3/environment`).pipe(
        Effect.map((response) => response.status === 200),
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => false),
      );
      if (ready) return;
      yield* Effect.sleep("500 millis");
    }
  }).pipe(
    Effect.timeout(STARTUP_TIMEOUT_MS),
    Effect.catch(() =>
      Effect.die(new Error(`server did not start in time\n${output.join("").slice(-4_000)}`)),
    ),
  );

const stopChild = (child: NodeChildProcess.ChildProcess) =>
  Effect.gen(function* () {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    yield* Effect.promise(() => exited).pipe(Effect.timeout("10 seconds"), Effect.ignore);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

/** `EnvironmentAuth` on the temp home, in this process, the way `t3 pair` and `t3 auth` use it. */
const withHostAuth = <A, E>(
  baseDir: string,
  run: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(
      { baseDir: Option.some(baseDir) },
      Option.some("Error"),
    );
    return yield* Effect.gen(function* () {
      return yield* run(yield* EnvironmentAuth.EnvironmentAuth);
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    );
  });

const mintTeamCredential = (baseDir: string) =>
  withHostAuth(baseDir, (auth) =>
    auth.createPairingLink({
      scopes: TEAM_SCOPES,
      subject: "team-invite:security-test",
      label: "Team security test",
    }),
  ).pipe(Effect.map((link) => link.credential));

const startHost = Effect.gen(function* () {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-security-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
  );
  const workDir = NodePath.join(baseDir, "cwd");
  NodeFS.mkdirSync(workDir);
  const port = yield* Effect.promise(freePort);
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: Array<string> = [];
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      BIN_PATH,
      "--mode",
      "web",
      "--base-dir",
      baseDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    { cwd: workDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  yield* Effect.addFinalizer(() => stopChild(child));
  child.stdout?.on("data", (data: Buffer) => output.push(data.toString()));
  child.stderr?.on("data", (data: Buffer) => output.push(data.toString()));
  yield* waitForServer(baseUrl, child, output);

  const teamCredential = yield* mintTeamCredential(baseDir);
  const exchanged = yield* exchangeCredential(baseUrl, teamCredential);
  if (exchanged.status !== 200 || exchanged.accessToken === undefined) {
    return yield* Effect.die(new Error(`team credential exchange failed: ${exchanged.status}`));
  }
  const [standard, admin] = yield* withHostAuth(baseDir, (auth) =>
    Effect.all([
      auth.issueSession({ scopes: AuthStandardClientScopes, label: "security test standard" }),
      auth.issueSession({ scopes: AuthAdministrativeScopes, label: "security test admin" }),
    ]),
  );
  return SecurityHost.of({
    baseUrl,
    baseDir,
    output,
    teamToken: exchanged.accessToken,
    teamCredential,
    standardToken: standard.token,
    adminToken: admin.token,
  });
});

const SecurityHostLive = Layer.effect(SecurityHost, startHost).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer)),
);

// ---------------------------------------------------------------------------
// Requests built from the API definitions

/**
 * A value for a schema that encodes, so a refusal is never a decode error.
 * Generated values can miss a check that sits on an encoding (an empty string
 * for a non-empty field), so a few are drawn and the first that encodes wins.
 */
const sample = (schema: Schema.Top, seed: number) => {
  const codec = schema as Schema.Codec<unknown, unknown>;
  return Arbitrary.sampleEffect(Arbitrary.schema(codec), { count: 50, seed }).pipe(
    Effect.flatMap((values) =>
      Effect.firstSuccessOf(
        values.map((value) =>
          Schema.encodeUnknownEffect(codec)(value).pipe(
            Effect.flatMap((encoded) =>
              Schema.decodeUnknownEffect(codec)(encoded).pipe(Effect.as({ value, encoded })),
            ),
          ),
        ),
      ),
    ),
    Effect.orDie,
  );
};

const toSearchParams = (value: unknown) => {
  const params = new URLSearchParams();
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      for (const item of Array.isArray(entry) ? entry : [entry]) params.append(key, String(item));
    }
  }
  return params;
};

interface ListedEndpoint {
  /** `group.endpoint`, as the allow-list names them. */
  readonly name: string;
  readonly method: HttpMethod.HttpMethod;
  readonly path: string;
  readonly params: Schema.Top | undefined;
  readonly query: Schema.Top | undefined;
  readonly payload:
    | { readonly encoding: string; readonly contentType: string; readonly schema: Schema.Top }
    | undefined;
}

const listEndpoints = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyArray<ListedEndpoint> => {
  const endpoints: Array<ListedEndpoint> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      const first = [...endpoint.payload.values()][0];
      endpoints.push({
        name: `${group.identifier}.${endpoint.identifier}`,
        method: endpoint.method,
        path: endpoint.path,
        params: endpoint.params,
        query: endpoint.query,
        payload:
          first === undefined
            ? undefined
            : {
                encoding: first.encoding._tag,
                contentType: first.encoding.contentType,
                schema: first.schemas[0],
              },
      });
    },
  });
  return endpoints;
};

const callEndpoint = (
  host: Host,
  endpoint: ListedEndpoint,
  headers: Record<string, string>,
  seed: number,
) =>
  Effect.gen(function* () {
    let path = endpoint.path;
    if (endpoint.params) {
      const { encoded } = yield* sample(endpoint.params, seed);
      for (const [key, value] of Object.entries(encoded as Record<string, string>)) {
        path = path.replace(`:${key}`, encodeURIComponent(value));
      }
    }
    const url = new URL(path, host.baseUrl);
    if (endpoint.query) {
      const { encoded } = yield* sample(endpoint.query, seed);
      for (const [key, value] of toSearchParams(encoded)) url.searchParams.append(key, value);
    }
    let body: HttpBody.HttpBody | undefined;
    if (endpoint.payload) {
      const { encoded } = yield* sample(endpoint.payload.schema, seed);
      if (endpoint.method === "GET" || endpoint.method === "HEAD") {
        for (const [key, value] of toSearchParams(encoded)) url.searchParams.append(key, value);
      } else if (endpoint.payload.encoding === "FormUrlEncoded") {
        body = HttpBody.urlParams(toSearchParams(encoded), endpoint.payload.contentType);
      } else if (endpoint.payload.encoding === "Json") {
        body = HttpBody.jsonUnsafe(encoded, endpoint.payload.contentType);
      } else {
        return yield* Effect.die(
          new Error(`${endpoint.name}: payload encoding ${endpoint.payload.encoding} not handled`),
        );
      }
    }
    return yield* httpCall(url.toString(), {
      method: endpoint.method,
      headers,
      ...(body ? { body } : {}),
    });
  });

const wsUrl = (host: Host, ticket: string) =>
  `${host.baseUrl.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(ticket)}`;

const decodeTicket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
);

const issueTeamTicket = (host: Host) =>
  Effect.gen(function* () {
    const result = yield* httpCall(`${host.baseUrl}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: bearer(host.teamToken),
    });
    assert.strictEqual(result.status, 200);
    return (yield* decodeTicket(result.text).pipe(Effect.orDie)).ticket;
  });

/** Every message the socket sends in its first seconds after opening, before any request. */
const messagesBeforeFirstRequest = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<string> = [];
      const socket = new NodeSocket.NodeWS.WebSocket(url);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
          }),
      );
      socket.on("message", (data) => received.push(data.toString()));
      yield* Effect.sleep("2 seconds");
      return received;
    }),
  );

const rpcProtocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(url).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (socketUrl, protocols) =>
              new NodeSocket.NodeWS.WebSocket(
                socketUrl,
                protocols as string | Array<string> | undefined,
              ) as unknown as globalThis.WebSocket,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

// ---------------------------------------------------------------------------
const decodeSessionState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      authenticated: Schema.Boolean,
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);

// ---------------------------------------------------------------------------
// Invites (M2.3): the real CLI, and the host's team state in this process

/** Every credential and token the invite tests make; S12 searches the logs for all of them. */
const inviteSecrets: Array<string> = [];

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `t3 team …` as a separate process on the host's home, as the host owner runs it. */
const runTeamCli = (args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<CliResult>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [BIN_PATH, "team", ...args], {
          cwd: SERVER_DIR,
          env: childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
        child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, stdout, stderr }));
      }),
  ).pipe(Effect.timeout("60 seconds"), Effect.orDie);

/** The host's team state and auth store, in this process, as `t3 team invite` opens them. */
const withHostTeams = <A, E, R>(baseDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(
      { baseDir: Option.some(baseDir) },
      Option.some("Error"),
    );
    return yield* effect.pipe(Effect.provide(teamInviteLayer(config)));
  });

let teamCounter = 0;

/**
 * Two teams hosted by the test server, owned by its own environment, and a
 * repo folder whose `.team/team.json` names the first, for `t3 team invite`.
 */
const setUpTeams = (host: Host) =>
  Effect.gen(function* () {
    teamCounter += 1;
    const teamX = TeamFile.make({
      teamId: TeamId.make(`team-x-${teamCounter}`),
      name: `X ${teamCounter}`,
    });
    const teamY = TeamFile.make({
      teamId: TeamId.make(`team-y-${teamCounter}`),
      name: `Y ${teamCounter}`,
    });
    const hostEnvironmentId = yield* withHostTeams(
      host.baseDir,
      Effect.gen(function* () {
        const teams = yield* TeamService.TeamService;
        const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
          .getEnvironmentId;
        for (const teamFile of [teamX, teamY]) {
          yield* teams.ensureTeam({
            teamFile,
            canonicalKey: null,
            owner: { environmentId, displayName: "Host owner" },
          });
        }
        return environmentId;
      }),
    );
    const repo = NodePath.join(host.baseDir, `repo-${teamCounter}`);
    NodeFS.mkdirSync(NodePath.join(repo, ".git"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(repo, ".team"));
    NodeFS.writeFileSync(
      NodePath.join(repo, ".team", "team.json"),
      `{ "teamId": "${teamX.teamId}", "name": "${teamX.name}" }\n`,
    );
    return { teamX, teamY, repo, hostEnvironmentId };
  });

/** An invite made in this process, for the paths the CLI cannot reach (a 1 ms lifetime). */
const issueInvite = (host: Host, teamId: TeamId, memberName: string, ttl?: Duration.Duration) =>
  withHostTeams(
    host.baseDir,
    Effect.gen(function* () {
      const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
      return yield* TeamInvites.issueTeamInvite({
        teamId,
        memberName,
        ttl,
        hostEnvironmentId: yield* identity.getEnvironmentId,
      });
    }),
  ).pipe(Effect.tap((issued) => Effect.sync(() => inviteSecrets.push(issued.credential))));

/** Exchange as `t3 team join` will (no scopes asked), and remember the token for S12. */
const exchangeInvite = (host: Host, credential: string) =>
  exchangeCredential(host.baseUrl, credential).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.accessToken !== undefined) inviteSecrets.push(result.accessToken);
      }),
    ),
  );

const joinCall = (host: Host, token: string, body: unknown) =>
  httpCall(`${host.baseUrl}/api/team/v1/join`, {
    method: "POST",
    headers: bearer(token),
    body: HttpBody.jsonUnsafe(body),
  });

const decodeMe = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      team: Schema.Struct({ teamId: Schema.String, name: Schema.String }),
      member: Schema.Struct({
        memberId: Schema.String,
        displayName: Schema.String,
        role: Schema.String,
        environmentId: Schema.String,
      }),
    }),
  ),
);

const decodeJoinRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String, reason: Schema.String })),
);

const joinRefusal = (result: HttpResult) => {
  const body = Option.getOrUndefined(decodeJoinRefusal(result.text));
  return `${result.status} ${body?._tag ?? "?"} ${body?.reason ?? "?"}`;
};

// Checks that need no server

describe("scopes and the API definitions", () => {
  it("S2: no RPC accepts a team scope", () => {
    for (const scope of Object.values(RPC_REQUIRED_SCOPES)) {
      assert.isFalse(scope.startsWith("team:"), scope);
    }
  });

  it("S5: team scopes are in the administrative preset only", () => {
    assert.isFalse(AuthStandardClientScopes.some((scope) => scope.startsWith("team:")));
    assert.include(AuthAdministrativeScopes, AuthTeamReadScope);
    assert.include(AuthAdministrativeScopes, AuthTeamWriteScope);
  });

  it("S7: the team API has no route for roles, members or invites", () => {
    const endpoints = listEndpoints(TeamHttpApi);
    assert.deepStrictEqual(endpoints.map((endpoint) => endpoint.name).toSorted(), [
      "team.board",
      "team.join",
      "team.me",
    ]);
    for (const endpoint of endpoints) {
      assert.match(endpoint.path, /^\/api\/team\/v1\//);
      assert.notMatch(endpoint.path, /role|members|invite/i);
    }
  });

  it("S3: no file in team/http imports file, Git, VCS, thread, terminal or provider modules", () => {
    const forbidden = [
      /^effect\/FileSystem$/,
      /^node:fs/,
      /(^|\/)git/i,
      /vcs/i,
      /ProjectionSnapshotQuery/,
      /orchestration/i,
      /terminal/i,
      /provider/i,
      /workspace/i,
      /checkpoint/i,
    ];
    const sources = NodeFS.readdirSync(TEAM_HTTP_DIR).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    assert.isAbove(sources.length, 0);
    const hits: Array<string> = [];
    for (const file of sources) {
      const text = NodeFS.readFileSync(NodePath.join(TEAM_HTTP_DIR, file), "utf8");
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (forbidden.some((pattern) => pattern.test(specifier)))
          hits.push(`${file}: ${specifier}`);
      }
    }
    assert.deepStrictEqual(hits, []);
  });
});

// ---------------------------------------------------------------------------
// Checks against the running host

it.layer(SecurityHostLive, {
  timeout: STARTUP_TIMEOUT_MS + 30_000,
  excludeTestServices: true,
})("team security against a running host", (it) => {
  it.effect("the team session holds exactly team:read and team:write", () =>
    Effect.gen(function* () {
      const host = yield* SecurityHost;
      const result = yield* httpCall(`${host.baseUrl}/api/auth/session`, {
        headers: bearer(host.teamToken),
      });
      const body = yield* decodeSessionState(result.text).pipe(Effect.orDie);
      assert.isTrue(body.authenticated);
      assert.deepStrictEqual([...(body.scopes ?? [])].toSorted(), [...TEAM_SCOPES].toSorted());
    }),
  );

  describe("S1: a team token on every non-team HTTP route", () => {
    /** Endpoints a team token may reach, checked by name. Every other one must give 401 or 403. */
    const allowedWithSession: Record<string, number> = {
      "metadata.descriptor": 200,
      // Says what the token can do; the test above checks it.
      "auth.session": 200,
      // Any session may get a ticket (decision 8); S2 proves the socket gives nothing.
      "auth.webSocketTicket": 200,
    };
    /** Endpoints that take no session: a made-up body must still get nothing (4xx or 5xx). */
    const noSessionEndpoints = [
      // Exchange a credential from the body.
      "auth.token",
      "auth.browserSession",
      // Verify cloud-signed payloads instead of a session.
      "connect.health",
      "connect.mintCredential",
      "connect.t3MintCredential",
    ];

    it.effect("every allow-listed name is a real endpoint", () =>
      Effect.sync(() => {
        const names = new Set(listEndpoints(EnvironmentHttpApi).map((endpoint) => endpoint.name));
        for (const name of [...Object.keys(allowedWithSession), ...noSessionEndpoints]) {
          assert.isTrue(names.has(name), name);
        }
      }),
    );

    it.effect("refuses every EnvironmentHttpApi endpoint, listed at test time", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const endpoints = listEndpoints(EnvironmentHttpApi);
        assert.isAbove(endpoints.length, 20);
        const failures: Array<string> = [];
        let seed = 1;
        for (const endpoint of endpoints) {
          const result = yield* callEndpoint(host, endpoint, bearer(host.teamToken), seed++);
          const allowedStatus = allowedWithSession[endpoint.name];
          const ok =
            allowedStatus !== undefined
              ? result.status === allowedStatus
              : noSessionEndpoints.includes(endpoint.name)
                ? result.status >= 400
                : result.status === 401 || result.status === 403;
          // A refusal names an upstream scope, never a team one.
          const namesTeamScope = /"requiredScope":"team:/.test(result.text);
          if (!ok || namesTeamScope) {
            failures.push(
              `${endpoint.name} ${endpoint.method} ${endpoint.path} -> ${result.status} ${result.tag ?? ""}`,
            );
          }
        }
        assert.deepStrictEqual(failures, []);
      }),
    );

    it.effect("control: an admin token gets what the team token is refused", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const snapshot = `${host.baseUrl}/api/orchestration/snapshot`;
        const clients = `${host.baseUrl}/api/auth/clients`;
        assert.strictEqual(
          (yield* httpCall(snapshot, { headers: bearer(host.adminToken) })).status,
          200,
        );
        assert.strictEqual(
          (yield* httpCall(clients, { headers: bearer(host.adminToken) })).status,
          200,
        );
        const refused = yield* httpCall(snapshot, { headers: bearer(host.teamToken) });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.tag, "EnvironmentScopeRequiredError");
      }),
    );

    it.effect("refuses the raw routes: OTLP, device hub, assets, attachment upload", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const otlp = yield* httpCall(`${host.baseUrl}/api/observability/v1/traces`, {
          method: "POST",
          headers: bearer(host.teamToken),
          body: HttpBody.text("{}", "application/json"),
        });
        assert.include([401, 403], otlp.status);
        // A path on the hub's allow-list, so the request reaches the scope check.
        const deviceHub = yield* httpCall(`${host.baseUrl}/api/device-hub/api/devices`, {
          headers: bearer(host.teamToken),
        });
        assert.include([401, 403], deviceHub.status);
        // Asset and upload URLs carry their own signed, expiring token: a forged one is 404 (S3).
        const asset = yield* httpCall(`${host.baseUrl}/api/assets/forged-id/forged-signature`, {
          headers: bearer(host.teamToken),
        });
        assert.strictEqual(asset.status, 404);
        const upload = yield* httpCall(`${host.baseUrl}/api/attachments/upload/forged-token`, {
          method: "POST",
          headers: bearer(host.teamToken),
          body: HttpBody.text("x"),
        });
        assert.strictEqual(upload.status, 404);
      }),
    );
  });

  describe("S2: a team token on WebSocket RPCs", () => {
    it.effect("the socket sends nothing before the first RPC", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const ticket = yield* issueTeamTicket(host);
        const messages = yield* messagesBeforeFirstRequest(wsUrl(host, ticket));
        assert.deepStrictEqual(messages, []);
      }),
    );

    it.effect(
      "refuses every WsRpcGroup RPC, listed at test time, with a scope error",
      () =>
        Effect.gen(function* () {
          const host = yield* SecurityHost;
          const ticket = yield* issueTeamTicket(host);
          const rpcs = [...WsRpcGroup.requests.entries()];
          assert.isAbove(rpcs.length, 50);
          const payloads = new Map<string, unknown>();
          let seed = 1;
          for (const [tag, rpc] of rpcs) {
            payloads.set(tag, (yield* sample(rpc.payloadSchema, seed++)).value);
          }
          const failures = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<
                string,
                (payload: unknown) => unknown
              >;
              const found: Array<string> = [];
              for (const [tag] of rpcs) {
                const result = client[tag]!(payloads.get(tag));
                // Called by name, so the result and error types are only known at run time.
                const run = Stream.isStream(result)
                  ? Stream.runHead(result as Stream.Stream<unknown, unknown>)
                  : (result as Effect.Effect<unknown, unknown>);
                const exit = yield* Effect.exit(run.pipe(Effect.timeout("10 seconds")));
                const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
                const tagOf = (value: unknown) =>
                  typeof value === "object" && value !== null
                    ? (value as { _tag?: string; requiredScope?: string })
                    : undefined;
                const refused =
                  tagOf(error)?._tag === "EnvironmentAuthorizationError" &&
                  !String(tagOf(error)?.requiredScope).startsWith("team:");
                if (!refused) {
                  found.push(
                    `${tag}: ${Exit.isSuccess(exit) ? "succeeded" : (tagOf(error)?._tag ?? String(error))}`,
                  );
                }
              }
              return found;
            }).pipe(Effect.provide(rpcProtocolLayer(wsUrl(host, ticket)))),
          );
          assert.deepStrictEqual(failures, []);
        }),
      300_000,
    );
  });

  it.effect("S4: a team token as Bearer to /mcp gets 401", () =>
    Effect.gen(function* () {
      const host = yield* SecurityHost;
      const result = yield* httpCall(`${host.baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearer(host.teamToken), accept: "application/json, text/event-stream" },
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.strictEqual(result.status, 401);
    }),
  );

  describe("S5: a team token cannot get any upstream scope", () => {
    it.effect("a team token cannot make a pairing link, for any scopes", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        for (const scopes of [[...TEAM_SCOPES], [AuthTeamReadScope], ["orchestration:read"]]) {
          const result = yield* httpCall(`${host.baseUrl}/api/auth/pairing-token`, {
            method: "POST",
            headers: bearer(host.teamToken),
            body: HttpBody.jsonUnsafe({ scopes }),
          });
          assert.strictEqual(result.status, 403, scopes.join(" "));
        }
      }),
    );

    it.effect("exchanging a team invite while asking for orchestration:read fails", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const credential = yield* mintTeamCredential(host.baseDir);
        const result = yield* exchangeCredential(host.baseUrl, credential, "orchestration:read");
        assert.isAtLeast(result.status, 400);
        assert.isUndefined(result.accessToken);
      }),
    );

    it.effect("the token endpoint does not accept team scope names (join asks for none)", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const credential = yield* mintTeamCredential(host.baseDir);
        const result = yield* exchangeCredential(host.baseUrl, credential, AuthTeamReadScope);
        assert.strictEqual(result.status, 400);
      }),
    );

    it.effect("a team credential is one-time", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const result = yield* exchangeCredential(host.baseUrl, host.teamCredential);
        assert.strictEqual(result.status, 401);
      }),
    );
  });

  describe("team API guard", () => {
    const teamEndpoints = listEndpoints(TeamHttpApi);

    it.effect("no token: 401 on every team endpoint", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        let seed = 1;
        for (const endpoint of teamEndpoints) {
          const result = yield* callEndpoint(host, endpoint, {}, seed++);
          assert.strictEqual(result.status, 401, endpoint.name);
        }
      }),
    );

    it.effect("a session without team scopes: 403 insufficient scope on every team endpoint", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        let seed = 1;
        for (const endpoint of teamEndpoints) {
          const result = yield* callEndpoint(host, endpoint, bearer(host.standardToken), seed++);
          assert.strictEqual(result.status, 403, endpoint.name);
          assert.strictEqual(result.tag, "EnvironmentScopeRequiredError", endpoint.name);
        }
      }),
    );

    it.effect(
      "a team session with no member row: 403 not_a_member on every endpoint but /join",
      () =>
        Effect.gen(function* () {
          const host = yield* SecurityHost;
          for (const token of [host.teamToken, host.adminToken]) {
            let seed = 1;
            for (const endpoint of teamEndpoints.filter(
              (candidate) => candidate.name !== "team.join",
            )) {
              const result = yield* callEndpoint(host, endpoint, bearer(token), seed++);
              assert.strictEqual(result.status, 403, endpoint.name);
              assert.strictEqual(result.tag, "TeamMembershipRequiredError", endpoint.name);
              assert.include(result.text, "not_a_member", endpoint.name);
            }
          }
        }),
    );
  });

  describe("M2.3: t3 team invite and /join (S5, S6, S7, S8, S12)", () => {
    it.effect("/join refuses sessions that did not come from a real invite", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const body = { environmentId: "env-anyone" };
        // The admin's own session: team scopes, but not an invite.
        assert.equal(
          joinRefusal(yield* joinCall(host, host.adminToken, body)),
          "403 TeamJoinRefusedError not_an_invite",
        );
        // A team link whose subject names no invite row.
        assert.equal(
          joinRefusal(yield* joinCall(host, host.teamToken, body)),
          "403 TeamJoinRefusedError invite_not_found",
        );
        // No team scope.
        const standard = yield* joinCall(host, host.standardToken, body);
        assert.equal(standard.status, 403);
        assert.equal(standard.tag, "EnvironmentScopeRequiredError");
      }),
    );

    it.effect(
      "invite with the CLI, exchange once, join once as a member named by the host, see only that team",
      () =>
        Effect.gen(function* () {
          const host = yield* SecurityHost;
          const { teamX, teamY, repo } = yield* setUpTeams(host);
          const teamFileBefore = NodeFS.readFileSync(
            NodePath.join(repo, ".team", "team.json"),
            "utf8",
          );
          const repoBefore = NodeFS.readdirSync(repo, { recursive: true }).toSorted();

          const cli = yield* runTeamCli([
            "invite",
            repo,
            "--name",
            "Sara",
            "--base-dir",
            host.baseDir,
          ]);
          assert.equal(cli.code, 0, cli.stderr);
          assert.include(cli.stdout, `Invite for Sara to team "${teamX.name}"`);
          assert.match(cli.stdout, /Expires at \d\d:\d\d \(/);
          const urlText = /^\s+(http\S+)$/m.exec(cli.stdout)?.[1];
          assert.isDefined(urlText);
          const url = new URL(urlText!);
          assert.equal(url.origin, host.baseUrl);
          assert.equal(url.pathname, "/team-invite");
          // Not `token`: the web app would exchange that on any page it opens.
          assert.isNull(new URLSearchParams(url.hash.slice(1)).get("token"));
          assert.equal(url.search, "");
          const credential = new URLSearchParams(url.hash.slice(1)).get("invite") ?? "";
          assert.isAbove(credential.length, 10);
          inviteSecrets.push(credential);
          // S12: printed once, on stdout only.
          assert.equal(cli.stdout.split(credential).length - 1, 1);
          assert.notInclude(cli.stderr, credential);

          // S5: the pairing link behind it holds exactly the two team scopes.
          const inviteId = /invite ([0-9a-f-]{36})\)/.exec(cli.stdout)?.[1] ?? "";
          const link = (yield* withHostAuth(host.baseDir, (auth) => auth.listPairingLinks())).find(
            (candidate) => candidate.subject === `team-invite:${inviteId}`,
          );
          assert.isDefined(link);
          assert.deepStrictEqual([...link!.scopes].toSorted(), [...TEAM_SCOPES].toSorted());

          const exchanged = yield* exchangeInvite(host, credential);
          assert.equal(exchanged.status, 200);
          const token = exchanged.accessToken!;
          // S6: one time only.
          assert.equal((yield* exchangeInvite(host, credential)).status, 401);

          const before = yield* httpCall(`${host.baseUrl}/api/team/v1/me`, {
            headers: bearer(token),
          });
          assert.equal(before.status, 403);
          assert.include(before.text, "not_a_member");

          // S7, S8: the body cannot pick a role, a name or a member id.
          const joined = yield* joinCall(host, token, {
            environmentId: "env-sara",
            role: "owner",
            displayName: "Boss",
            memberId: "member-owner",
          });
          assert.equal(joined.status, 200, joined.text);
          const me = yield* decodeMe(joined.text).pipe(Effect.orDie);
          assert.equal(me.team.teamId, teamX.teamId);
          assert.equal(me.member.displayName, "Sara");
          assert.equal(me.member.role, "member");
          assert.equal(me.member.environmentId, "env-sara");
          assert.notEqual(me.member.memberId, "member-owner");

          // The same session again: the same member, no second row.
          const again = yield* decodeMe(
            (yield* joinCall(host, token, { environmentId: "env-sara" })).text,
          ).pipe(Effect.orDie);
          assert.equal(again.member.memberId, me.member.memberId);
          const members = yield* withHostTeams(
            host.baseDir,
            Effect.gen(function* () {
              return yield* (yield* TeamService.TeamService).listMembers(teamX.teamId);
            }),
          );
          assert.deepStrictEqual(
            members.map((member) => `${member.displayName}:${member.role}`),
            ["Host owner:owner", "Sara:member"],
          );

          const meNow = yield* httpCall(`${host.baseUrl}/api/team/v1/me`, {
            headers: bearer(token),
          });
          assert.equal(meNow.status, 200);
          assert.equal(
            (yield* decodeMe(meNow.text).pipe(Effect.orDie)).member.memberId,
            me.member.memberId,
          );

          // Wrong team: only its own team's paths.
          const own = yield* httpCall(`${host.baseUrl}/api/team/v1/teams/${teamX.teamId}/board`, {
            headers: bearer(token),
          });
          assert.equal(own.status, 200);
          const other = yield* httpCall(`${host.baseUrl}/api/team/v1/teams/${teamY.teamId}/board`, {
            headers: bearer(token),
          });
          assert.equal(other.status, 403);
          assert.include(other.text, "other_team");
          // Still nothing upstream.
          const snapshot = yield* httpCall(`${host.baseUrl}/api/orchestration/snapshot`, {
            headers: bearer(token),
          });
          assert.oneOf(snapshot.status, [401, 403]);

          const listed = yield* runTeamCli(["invites", "--base-dir", host.baseDir]);
          assert.equal(listed.code, 0, listed.stderr);
          assert.match(listed.stdout, new RegExp(`used +Sara +invite ${inviteId}`));
          assert.notInclude(listed.stdout, credential);

          // S12: the repo is untouched; the URL never went into it.
          assert.equal(
            NodeFS.readFileSync(NodePath.join(repo, ".team", "team.json"), "utf8"),
            teamFileBefore,
          );
          assert.deepStrictEqual(
            NodeFS.readdirSync(repo, { recursive: true }).toSorted(),
            repoBefore,
          );
        }),
    );

    it.effect("S6: revoked, expired and already used invites are refused", () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const { teamX, hostEnvironmentId } = yield* setUpTeams(host);

        // Revoked before use: the link is dead.
        const omar = yield* issueInvite(host, teamX.teamId, "Omar");
        const revoke = yield* runTeamCli([
          "invites",
          "--revoke",
          omar.invite.inviteId,
          "--base-dir",
          host.baseDir,
        ]);
        assert.equal(revoke.code, 0, revoke.stderr);
        assert.include(revoke.stdout, `Revoked invite ${omar.invite.inviteId} for Omar`);
        const deadLink = yield* exchangeInvite(host, omar.credential);
        assert.isAtLeast(deadLink.status, 400);
        assert.isUndefined(deadLink.accessToken);

        // Exchanged, then revoked before joining: /join refuses.
        const lina = yield* issueInvite(host, teamX.teamId, "Lina");
        const linaToken = (yield* exchangeInvite(host, lina.credential)).accessToken!;
        yield* runTeamCli([
          "invites",
          "--revoke",
          lina.invite.inviteId,
          "--base-dir",
          host.baseDir,
        ]);
        assert.equal(
          joinRefusal(yield* joinCall(host, linaToken, { environmentId: "env-lina" })),
          "403 TeamJoinRefusedError invite_revoked",
        );

        // Expired: a 1 ms invite is dead by the time it is used.
        const nora = yield* issueInvite(host, teamX.teamId, "Nora", Duration.millis(1));
        const expired = yield* exchangeInvite(host, nora.credential);
        assert.isAtLeast(expired.status, 400);
        assert.isUndefined(expired.accessToken);

        // Used: a second session naming the same invite cannot join again.
        const kai = yield* issueInvite(host, teamX.teamId, "Kai");
        const kaiToken = (yield* exchangeInvite(host, kai.credential)).accessToken!;
        assert.equal((yield* joinCall(host, kaiToken, { environmentId: "env-kai" })).status, 200);
        const forged = yield* withHostAuth(host.baseDir, (auth) =>
          auth.issueSession({ subject: `team-invite:${kai.invite.inviteId}`, scopes: TEAM_SCOPES }),
        );
        inviteSecrets.push(forged.token);
        assert.equal(
          joinRefusal(yield* joinCall(host, forged.token, { environmentId: "env-kai-2" })),
          "403 TeamJoinRefusedError invite_used",
        );

        // S8: a joiner cannot take the host owner's environment id.
        const zed = yield* issueInvite(host, teamX.teamId, "Zed");
        const zedToken = (yield* exchangeInvite(host, zed.credential)).accessToken!;
        assert.equal(
          joinRefusal(yield* joinCall(host, zedToken, { environmentId: hostEnvironmentId })),
          "403 TeamJoinRefusedError already_member",
        );

        const members = yield* withHostTeams(
          host.baseDir,
          Effect.gen(function* () {
            return yield* (yield* TeamService.TeamService).listMembers(teamX.teamId);
          }),
        );
        assert.deepStrictEqual(
          members.map((member) => member.displayName),
          ["Host owner", "Kai"],
        );
        const listed = yield* runTeamCli(["invites", "--base-dir", host.baseDir]);
        assert.match(listed.stdout, /revoked +Omar/);
        assert.match(listed.stdout, /revoked +Lina/);
        assert.match(listed.stdout, /expired +Nora/);
        assert.match(listed.stdout, /used +Kai/);
        assert.match(listed.stdout, /pending +Zed/);
      }),
    );
  });

  it.effect(
    "S12 groundwork: the server output and log files hold neither credential nor token",
    () =>
      Effect.gen(function* () {
        const host = yield* SecurityHost;
        const logs = [host.output.join("")];
        const walk = (dir: string) => {
          if (!NodeFS.existsSync(dir)) return;
          for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
            const full = NodePath.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else logs.push(NodeFS.readFileSync(full, "utf8"));
          }
        };
        walk(NodePath.join(host.baseDir, "userdata", "logs"));
        // The invite tests ran first, so their links, tokens and CLI runs are covered too.
        assert.isAbove(inviteSecrets.length, 5);
        for (const text of logs) {
          for (const secret of [host.teamToken, host.teamCredential, ...inviteSecrets]) {
            assert.isFalse(text.includes(secret));
          }
        }
      }),
  );
});
