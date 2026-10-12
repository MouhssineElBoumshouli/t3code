// @effect-diagnostics nodeBuiltinImport:off - a temp folder per test, made and removed synchronously.
/**
 * team-layer: the team hooks in the v2 providers (team/V2_PORT_PLAN.md D3):
 * the briefing and turn note on the turn text, Claude's system prompt and
 * edit hook, Codex's own context entry and tool timeout, and the refusal of
 * Antigravity's writes to held files.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAntigravityAcpAdapterFlavor } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { installTeamBriefingResolver } from "./TeamBriefing.ts";
import { claudeTeamEditHooks, installTeamEditCheck } from "./teamEditCheck.ts";
import { installTeamTurnNote } from "./teamTurnNote.ts";
import { withTeamTurnText } from "./teamTurnText.ts";

const BRIEFING = "<team_context>Team Core.</team_context>";
const NOTE = "<team_changes>Changed: `src/a.ts`.</team_changes>";

let uninstall: Array<() => void> = [];
let root = "";
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-team-hooks-"));
});
afterEach(() => {
  for (const undo of uninstall) undo();
  uninstall = [];
  NodeFS.rmSync(root, { recursive: true, force: true });
});

/** The briefing each thread gets, changed by setting `briefing`. */
let briefing: string | undefined = BRIEFING;
const installBriefing = () => {
  briefing = BRIEFING;
  uninstall.push(installTeamBriefingResolver(() => Effect.succeed(briefing)));
  uninstall.push(installTeamTurnNote(() => Effect.succeed(NOTE)));
};

describe("withTeamTurnText", () => {
  const turn = (threadId: string, driver: string, providerTurnOrdinal: number, text = "Go") =>
    withTeamTurnText({
      threadId: ThreadId.make(threadId),
      driver: ProviderDriverKind.make(driver),
      providerTurnOrdinal,
      text,
    });

  it.effect(
    "puts the briefing first on the first turn and when it changes; the note every turn",
    () =>
      Effect.gen(function* () {
        installBriefing();
        assert.equal(yield* turn("cursor-1", "cursor", 1), `${BRIEFING}\n\nGo\n\n${NOTE}`);
        assert.equal(yield* turn("cursor-1", "cursor", 2), `Go\n\n${NOTE}`);
        briefing = "<team_context>Team Core, renamed.</team_context>";
        assert.equal(yield* turn("cursor-1", "cursor", 3), `${briefing}\n\nGo\n\n${NOTE}`);
        assert.equal(yield* turn("cursor-1", "cursor", 4), `Go\n\n${NOTE}`);
        // A new provider thread starts over, whatever this server sent before.
        assert.equal(yield* turn("cursor-1", "cursor", 1), `${briefing}\n\nGo\n\n${NOTE}`);
      }),
  );

  it.effect(
    "leaves the briefing to Claude's and Codex's own instructions, and slash commands alone",
    () =>
      Effect.gen(function* () {
        installBriefing();
        assert.equal(yield* turn("claude-1", "claudeAgent", 1), `Go\n\n${NOTE}`);
        assert.equal(yield* turn("codex-1", "codex", 1), `Go\n\n${NOTE}`);
        assert.equal(yield* turn("grok-1", "grok", 1, "/compact"), "/compact");
      }),
  );

  it.effect("adds nothing outside a team", () =>
    Effect.gen(function* () {
      assert.equal(yield* turn("plain-1", "opencode", 1), "Go");
    }),
  );
});

describe("Claude", () => {
  const options = (input: { teamContext?: string; hooks?: boolean }) =>
    ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "team-thread",
      resume: false,
      cwd: "/workspace",
      ...(input.teamContext === undefined ? {} : { teamContext: input.teamContext }),
      ...(input.hooks === true
        ? { hooks: claudeTeamEditHooks(ThreadId.make("claude-1"), Effect.runPromise) }
        : {}),
    });

  it("appends the briefing to the system prompt and passes the edit hook", () => {
    const team = options({ teamContext: BRIEFING, hooks: true });
    const prompt = team.systemPrompt as { readonly append: string };
    assert.include(
      prompt.append,
      `${buildRuntimeInstructions({ harness: "Claude Code" })}\n\n${BRIEFING}`,
    );
    assert.lengthOf(team.hooks?.PreToolUse ?? [], 1);
    const plain = options({});
    assert.notInclude((plain.systemPrompt as { readonly append: string }).append, "team_context");
    assert.isUndefined(plain.hooks);
  });
});

describe("Codex", () => {
  const params = (teamContext: string | undefined) =>
    CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "native-team",
      codexInput: [{ type: "text", text: "Go" }],
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      hasT3Mcp: true,
      teamContext,
    });

  // Its own entry: Codex resends an entry only when its value changes (team/VISION.md 6.5).
  it.effect("sends the briefing as its own application entry, none outside a team", () =>
    Effect.gen(function* () {
      const team = (yield* params(BRIEFING)).additionalContext;
      assert.deepEqual(team?.t3_code_team, { kind: "application", value: BRIEFING });
      const plain = (yield* params(undefined)).additionalContext;
      assert.isUndefined(plain?.t3_code_team);
      assert.deepEqual(plain?.t3_code_runtime, team?.t3_code_runtime);
    }),
  );

  it("lets T3's MCP calls wait an hour, for the warning card", () => {
    const runtime = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: {
        environmentId: "environment-1" as never,
        threadId: ThreadId.make("codex-1"),
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
      },
    });
    const servers = runtime.config.mcp_servers as Record<string, Record<string, unknown>>;
    assert.equal(servers["t3-code"]?.tool_timeout_sec, 3600);
  });
});

describe("Antigravity", () => {
  it.effect("refuses a write to a held file with the guard's reason; other writes land", () =>
    Effect.gen(function* () {
      uninstall.push(
        installTeamEditCheck((_threadId, paths) =>
          Effect.succeed(
            paths.some((file) => file.endsWith("held.ts"))
              ? "`held.ts` is held by Omar."
              : undefined,
          ),
        ),
      );
      const flavor = makeAntigravityAcpAdapterFlavor({
        instanceId: ProviderInstanceId.make("antigravity-test"),
        crypto: undefined as never,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        host: { paths: { attachmentsDir: NodePath.join(root, "attachments") } } as never,
        selfInvocation: undefined as never,
        makeRuntime: () => Effect.die("not spawned in this test"),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      });
      const write = (file: string) =>
        flavor.clientFileSystem!.writeTextFile(
          {
            sessionId: "session-1",
            path: NodePath.join(root, file),
            content: "x",
          } as EffectAcpSchema.WriteTextFileRequest,
          root,
          ThreadId.make("antigravity-1"),
        );
      const refused = yield* Effect.exit(write("held.ts"));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), "held by Omar");
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "held.ts")));
      yield* write("free.ts");
      assert.equal(NodeFS.readFileSync(NodePath.join(root, "free.ts"), "utf8"), "x");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
