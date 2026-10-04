// @effect-diagnostics nodeBuiltinImport:off - reads apps/web/vite.config.ts as text.
/**
 * Fork-only checks on the dev runner's `team-layer:` defaults (team/DESIGN.md 7.3):
 * two dev servers from one checkout get separate Vite deps caches, and dev runs
 * never add this repo as a project unless asked to.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createDevRunnerEnv } from "./dev-runner.ts";

const baseInput = {
  mode: "dev",
  baseEnv: {},
  t3Home: undefined,
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: undefined,
  devUrl: undefined,
} as const;

it.layer(NodeServices.layer)("team-layer dev runner defaults", (it) => {
  it.effect("the host and member dev servers (offsets 0 and 20) use different Vite caches", () =>
    Effect.gen(function* () {
      const host = yield* createDevRunnerEnv({ ...baseInput, serverOffset: 0, webOffset: 0 });
      const member = yield* createDevRunnerEnv({ ...baseInput, serverOffset: 20, webOffset: 20 });

      assert.equal(host.PORT, "5733");
      assert.equal(member.PORT, "5753");
      assert.equal(host.T3CODE_VITE_CACHE_DIR, "node_modules/.vite-dev-5733");
      assert.equal(member.T3CODE_VITE_CACHE_DIR, "node_modules/.vite-dev-5753");
    }),
  );

  it.effect("an inherited cache folder is replaced, so two runs cannot share one by accident", () =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        ...baseInput,
        baseEnv: { T3CODE_VITE_CACHE_DIR: "node_modules/.vite" },
        serverOffset: 0,
        webOffset: 3,
      });
      assert.equal(env.T3CODE_VITE_CACHE_DIR, "node_modules/.vite-dev-5736");
    }),
  );

  it.effect("desktop and web-only runs get a per-port cache too", () =>
    Effect.gen(function* () {
      for (const mode of ["dev:web", "dev:desktop"] as const) {
        const env = yield* createDevRunnerEnv({
          ...baseInput,
          mode,
          serverOffset: 7,
          webOffset: 7,
        });
        assert.equal(env.T3CODE_VITE_CACHE_DIR, "node_modules/.vite-dev-5740", mode);
      }
    }),
  );

  it.effect("auto-bootstrap of the working folder is off unless asked for", () =>
    Effect.gen(function* () {
      const unset = yield* createDevRunnerEnv({ ...baseInput, serverOffset: 0, webOffset: 0 });
      assert.equal(unset.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");

      // `.env.local` or the flag still win: they arrive as an explicit value.
      const on = yield* createDevRunnerEnv({
        ...baseInput,
        autoBootstrapProjectFromCwd: true,
        serverOffset: 0,
        webOffset: 0,
      });
      assert.equal(on.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "1");
      const off = yield* createDevRunnerEnv({
        ...baseInput,
        autoBootstrapProjectFromCwd: false,
        serverOffset: 0,
        webOffset: 0,
      });
      assert.equal(off.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
    }),
  );

  it("apps/web/vite.config.ts still reads the cache folder (an upstream merge can drop the line)", () => {
    const configPath = NodeURL.fileURLToPath(
      new URL("../apps/web/vite.config.ts", import.meta.url),
    );
    const text = NodeFS.readFileSync(configPath, "utf8");
    assert.include(
      text,
      "...(process.env.T3CODE_VITE_CACHE_DIR ? { cacheDir: process.env.T3CODE_VITE_CACHE_DIR } : {}),",
    );
  });
});
