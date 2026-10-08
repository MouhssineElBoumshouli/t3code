import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_CHOICE_MADE_ACTIVITY_KIND,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { countOpenTeamChoices } from "./openTeamChoices.ts";

const card = (choiceId: string, turnId: string | null) => ({
  kind: TEAM_CHOICE_ACTIVITY_KIND,
  turnId,
  payload: {
    choiceId,
    threadId: "thread-1",
    solo: true,
    files: [{ path: "src/a.ts", holders: [] }],
  },
});
const made = (choiceId: string) => ({
  kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
  turnId: null,
  payload: { choiceId, choice: "goAnyway", delivery: "held" },
});

describe("countOpenTeamChoices", () => {
  it("counts a card until its choice is made or a newer turn starts", () => {
    assert.equal(countOpenTeamChoices([card("c1", "t1")], "t1"), 1);
    assert.equal(countOpenTeamChoices([card("c1", "t1"), made("c1")], "t1"), 0);
    // The user moved on with a message: the card still takes a click, but no longer waits.
    assert.equal(countOpenTeamChoices([card("c1", "t1")], "t2"), 0);
    assert.equal(countOpenTeamChoices([card("c1", null)], "t2"), 1);
    // Planning again before the choice reuses the card: one wait, not two.
    assert.equal(countOpenTeamChoices([card("c1", "t1"), card("c1", "t1")], "t1"), 1);
    assert.equal(countOpenTeamChoices([{ ...card("c1", "t1"), payload: { bad: 1 } }], "t1"), 0);
  });

  it("does not count a card that asked a teammate, and counts it again after a no", () => {
    const ask = (status: string) => ({
      kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
      turnId: null,
      payload: { choiceId: "c1", choice: "ask", delivery: "held", ask: status, questionId: "q1" },
    });
    assert.equal(countOpenTeamChoices([card("c1", "t1"), ask("asked")], "t1"), 0);
    assert.equal(countOpenTeamChoices([card("c1", "t1"), ask("asked"), ask("declined")], "t1"), 1);
  });

  it("does not count a card that waits for its holder, and counts it again when the wait stops", () => {
    const wait = (status: string) => ({
      kind: TEAM_CHOICE_MADE_ACTIVITY_KIND,
      turnId: null,
      payload: { choiceId: "c1", choice: "wait", delivery: "held", wait: status },
    });
    assert.equal(countOpenTeamChoices([card("c1", "t1"), wait("waiting")], "t1"), 0);
    assert.equal(
      countOpenTeamChoices([card("c1", "t1"), wait("waiting"), wait("cancelled")], "t1"),
      1,
    );
    // The newest record wins: waiting again after the cancel.
    assert.equal(
      countOpenTeamChoices(
        [card("c1", "t1"), wait("waiting"), wait("cancelled"), wait("waiting")],
        "t1",
      ),
      0,
    );
  });
});

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-open-team-choices-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("the thread shell counts an open warning card as pending input", (it) => {
  it.effect("pending while the card waits; clear after the choice or a newer turn", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-team-choice");
      const at = "2026-10-08T10:00:00.000Z";
      let seq = 0;
      const base = () => {
        seq += 1;
        return {
          eventId: EventId.make(`evt-team-choice-${seq}`),
          occurredAt: at,
          commandId: CommandId.make(`cmd-team-choice-${seq}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-team-choice-${seq}`),
          metadata: {},
        };
      };
      const project = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
      const runningTurn = (turnId: string) =>
        project({
          ...base(),
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "claudeAgent",
              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
              runtimeMode: "full-access",
              activeTurnId: TurnId.make(turnId),
              lastError: null,
              updatedAt: at,
            },
          },
        });
      const activity = (input: ReturnType<typeof card> | ReturnType<typeof made>, id: string) =>
        project({
          ...base(),
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            activity: {
              id: EventId.make(id),
              tone: "info",
              kind: input.kind,
              summary: "card",
              payload: { ...input.payload, threadId },
              turnId: input.turnId === null ? null : TurnId.make(input.turnId),
              createdAt: at,
            },
          },
        });
      const pending = sql<{ readonly count: number }>`
        SELECT pending_user_input_count AS "count"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `.pipe(Effect.map((rows) => rows[0]?.count));

      yield* project({
        ...base(),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-team-choice"),
        payload: {
          projectId: ProjectId.make("project-team-choice"),
          title: "Team choice",
          workspaceRoot: "/tmp/project-team-choice",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      });
      yield* project({
        ...base(),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          projectId: ProjectId.make("project-team-choice"),
          title: "Team choice",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at,
          updatedAt: at,
        },
      });
      yield* runningTurn("turn-1");
      assert.equal(yield* pending, 0);

      yield* activity(card("c1", "turn-1"), "c1");
      assert.equal(yield* pending, 1);
      yield* activity(made("c1"), "c1:made");
      assert.equal(yield* pending, 0);

      // Not answered, and the user sends a message instead: the next turn clears it.
      yield* activity(card("c2", "turn-1"), "c2");
      assert.equal(yield* pending, 1);
      yield* runningTurn("turn-2");
      assert.equal(yield* pending, 0);
    }),
  );
});
