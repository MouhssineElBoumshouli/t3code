/**
 * team-layer: the team briefing on Codex's path (team/DESIGN.md D4). Codex
 * gets it through `turn/start.additionalContext`, built in the session runtime
 * from T3's thread id. The mock peer does not record `turn/start`, so the
 * runtime test reads the context back from the compaction restore, which
 * resends exactly what the last turn sent.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { TEST_TEAM_BRIEFING, withTeamBriefing } from "../../team/testing/teamBriefing.ts";
import { buildCodexAdditionalContext } from "../CodexDeveloperInstructions.ts";
import { buildTurnStartParams, makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const THREAD_ID = ThreadId.make("thread-codex-team-briefing");
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

const turnParams = (teamContext: string | undefined) =>
  buildTurnStartParams({
    threadId: "provider-thread-1",
    runtimeMode: "full-access",
    prompt: "Go",
    model: "gpt-5.3-codex",
    interactionMode: "default",
    teamContext,
  });

describe("Codex team briefing", () => {
  it.effect("adds nothing to the turn context outside a team", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* turnParams(undefined)).additionalContext,
        buildCodexAdditionalContext({ model: "gpt-5.3-codex", reasoningEffort: "medium" }),
      );
    }),
  );

  // Its own entry: Codex resends an entry when its value changes, and the
  // runtime entry changes with the model and effort (team/VISION.md 6.5).
  it.effect("adds the briefing as its own entry of the turn context", () =>
    Effect.gen(function* () {
      const params = yield* turnParams(TEST_TEAM_BRIEFING);
      assert.strictEqual(params.additionalContext?.t3_code_team?.value, TEST_TEAM_BRIEFING);
      assert.deepStrictEqual(
        params.additionalContext?.t3_code_runtime,
        (yield* turnParams(undefined)).additionalContext?.t3_code_runtime,
      );
    }),
  );

  it.effect("sends the thread's briefing from the session runtime", () =>
    Effect.gen(function* () {
      const scriptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-team-"));
      const scriptPath = NodePath.join(scriptDir, "script.json");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptDir, { recursive: true, force: true })),
      );
      const compacted = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: `${ROOT}-turn`,
          completedAtMs: 0,
          item: { type: "contextCompaction", id: "compaction-root" },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const script = JSON.stringify({
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [compacted],
      });
      NodeFS.writeFileSync(scriptPath, script, "utf8");

      const runtime = yield* makeCodexSessionRuntime({
        threadId: THREAD_ID,
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const completedFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* withTeamBriefing(
        (threadId) => (threadId === THREAD_ID ? TEST_TEAM_BRIEFING : undefined),
        runtime.sendTurn({ input: "keep going", interactionMode: "default" }),
      );
      yield* Fiber.join(completedFiber);

      const requests = NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      const inject = requests.find((request) => request.method === "thread/inject_items");
      assert.isDefined(inject);
      const texts = (inject.params.items as ReadonlyArray<{ content: [{ text: string }] }>).map(
        (item) => item.content[0].text,
      );
      assert.lengthOf(texts, 2);
      assert.include(texts, `<t3_code_team>${TEST_TEAM_BRIEFING}</t3_code_team>`);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
