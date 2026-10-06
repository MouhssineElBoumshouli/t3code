// @effect-diagnostics nodeBuiltinImport:off - spawns a real server and talks HTTP and WebSocket to it.
// @effect-diagnostics unsafeEffectTypeAssertion:off anyUnknownInErrorContext:off - the RPCs are called by name, so their types are only known at run time.
/**
 * team-layer: regression test for the scope check on three ChatGPT RPCs in
 * `ws.ts` (`chatGptReconnectProfile`, `chatGptImportProfile`,
 * `chatGptHandoffSubscribe`). They skipped the check `RPC_REQUIRED_SCOPES`
 * declares (`orchestration:operate`), so any session could call them. Found by
 * the team security tests, now parked with host mode (team/STORAGE_PLAN.md 3.6).
 *
 * Runs against a real server (`src/bin.ts` on a temp home), with a session
 * made the way a client gets one: a one-time pairing link with only
 * `orchestration:read`, exchanged at `/oauth/token`.
 */
import { AuthOrchestrationReadScope, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { resolveCliAuthConfig } from "../cli/config.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const BIN_PATH = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const STARTUP_TIMEOUT_MS = 120_000;

const CHATGPT_RPCS = [
  WS_METHODS.chatGptReconnectProfile,
  WS_METHODS.chatGptImportProfile,
  WS_METHODS.chatGptHandoffSubscribe,
] as const;

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

const post = (url: string, headers: Record<string, string>, body?: HttpBody.HttpBody) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(url, { headers, ...(body ? { body } : {}) }),
    );
    return { status: response.status, text: yield* response.text };
  }).pipe(Effect.timeout("15 seconds"), Effect.orDie);

const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })),
);
const decodeTicket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
);

/** A real server on a temp home, and a WebSocket URL for an `orchestration:read` session. */
class ReadOnlySocket extends Context.Service<ReadOnlySocket, { readonly wsUrl: string }>()(
  "t3/auth/ChatGptRpcScopes.test/ReadOnlySocket",
) {}

const start = Effect.gen(function* () {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-scopes-"));
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
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      yield* Effect.promise(() => exited).pipe(Effect.timeout("10 seconds"), Effect.ignore);
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  );
  child.stdout?.on("data", (data: Buffer) => output.push(data.toString()));
  child.stderr?.on("data", (data: Buffer) => output.push(data.toString()));

  const client = yield* HttpClient.HttpClient;
  yield* Effect.gen(function* () {
    while (true) {
      if (child.exitCode !== null) {
        return yield* Effect.die(new Error(`server exited with ${child.exitCode}`));
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
      Effect.die(new Error(`server did not start\n${output.join("").slice(-4_000)}`)),
    ),
  );

  // The pairing link is made in this process on the same home, the way `t3 pair` does it.
  const config = yield* resolveCliAuthConfig(
    { baseDir: Option.some(baseDir) },
    Option.some("Error"),
  );
  const link = yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.createPairingLink({
      scopes: [AuthOrchestrationReadScope],
      label: "ChatGPT RPC scope test",
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
  const exchanged = yield* post(
    `${baseUrl}/oauth/token`,
    {},
    HttpBody.urlParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: link.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  );
  assert.strictEqual(exchanged.status, 200, exchanged.text);
  const token = (yield* decodeAccessToken(exchanged.text).pipe(Effect.orDie)).access_token;
  const ticketResult = yield* post(`${baseUrl}/api/auth/websocket-ticket`, {
    authorization: `Bearer ${token}`,
  });
  assert.strictEqual(ticketResult.status, 200, ticketResult.text);
  const ticket = (yield* decodeTicket(ticketResult.text).pipe(Effect.orDie)).ticket;
  return ReadOnlySocket.of({
    wsUrl: `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}`,
  });
});

const ReadOnlySocketLive = Layer.effect(ReadOnlySocket, start).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer)),
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

/** A payload that passes the RPC's schema, so a refusal is the scope check, not a decode error. */
const samplePayload = (tag: string) => {
  const codec = WsRpcGroup.requests.get(tag)!.payloadSchema as Schema.Codec<unknown, unknown>;
  return Arbitrary.sampleEffect(Arbitrary.schema(codec), { count: 50, seed: 1 }).pipe(
    Effect.flatMap((values) =>
      Effect.firstSuccessOf(
        values.map((value) =>
          Schema.encodeUnknownEffect(codec)(value).pipe(
            Effect.flatMap((encoded) => Schema.decodeUnknownEffect(codec)(encoded)),
            Effect.as(value),
          ),
        ),
      ),
    ),
    Effect.orDie,
  );
};

/** Calls an RPC by name over the read-only socket and returns its exit. */
const callByName = (wsUrl: string, tag: string, payload: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<
        string,
        (payload: unknown) => unknown
      >;
      const result = client[tag]!(payload);
      const run = Stream.isStream(result)
        ? Stream.runHead(result as Stream.Stream<unknown, unknown>)
        : (result as Effect.Effect<unknown, unknown>);
      return yield* Effect.exit(run.pipe(Effect.timeout("10 seconds")));
    }).pipe(Effect.provide(rpcProtocolLayer(wsUrl))),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  return typeof error === "object" && error !== null
    ? (error as { readonly _tag?: string; readonly requiredScope?: string })
    : undefined;
};

it.layer(ReadOnlySocketLive, { timeout: STARTUP_TIMEOUT_MS + 30_000, excludeTestServices: true })(
  "ChatGPT RPCs need orchestration:operate",
  (it) => {
    it.effect("control: the orchestration:read session can call serverGetConfig", () =>
      Effect.gen(function* () {
        const { wsUrl } = yield* ReadOnlySocket;
        const exit = yield* callByName(wsUrl, WS_METHODS.serverGetConfig, {});
        assert.isTrue(Exit.isSuccess(exit), String(failureOf(exit)?._tag));
      }),
    );

    for (const tag of CHATGPT_RPCS) {
      it.effect(`${tag} refuses an orchestration:read session`, () =>
        Effect.gen(function* () {
          const { wsUrl } = yield* ReadOnlySocket;
          const exit = yield* callByName(wsUrl, tag, yield* samplePayload(tag));
          const failure = failureOf(exit);
          assert.strictEqual(failure?._tag, "EnvironmentAuthorizationError");
          assert.strictEqual(failure?.requiredScope, "orchestration:operate");
        }),
      );
    }
  },
);
