import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  TEAM_CHOICE_ACTIVITY_KIND,
  TEAM_PLAN_ACTIVITY_KIND,
  type TeamCardEntry,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as TeamCards from "./TeamCards.ts";
import * as TeamCardsCleanup from "./TeamCardsCleanup.ts";
import * as TeamOrchestrator from "./teamOrchestrator.testkit.ts";

const threadId = ThreadId.make("thread:team-cards");
const projectId = ProjectId.make("project:team-cards");

const entry = (
  id: string,
  kind: TeamCardEntry["kind"] = TEAM_PLAN_ACTIVITY_KIND,
): TeamCardEntry => ({
  id,
  kind,
  summary: "Plan",
  payload: { files: [] },
  runId: null,
  createdAt: "2026-10-11T10:00:00.000Z",
});

const cardsDirectory = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "team", "cards");
});

/** A fresh store on the same T3 home, as after a restart. */
const withStore = <A, E, R>(effect: Effect.Effect<A, E, R | TeamCards.TeamCards>) =>
  effect.pipe(Effect.provide(TeamCards.layer));

it.layer(TeamOrchestrator.layer)("TeamCards", (it) => {
  it.effect("keeps a chat's cards across a restart, each id once", () =>
    Effect.gen(function* () {
      yield* withStore(
        Effect.gen(function* () {
          const cards = yield* TeamCards.TeamCards;
          yield* cards.append({ threadId, entry: entry("card-1") });
          yield* cards.append({ threadId, entry: entry("card-1") });
          yield* cards.append({ threadId, entry: entry("card-2", TEAM_CHOICE_ACTIVITY_KIND) });
        }),
      );
      const after = yield* withStore(
        Effect.gen(function* () {
          const cards = yield* TeamCards.TeamCards;
          return {
            entries: yield* cards.forThread(threadId),
            choices: yield* cards.listByKind(TEAM_CHOICE_ACTIVITY_KIND),
          };
        }),
      );
      assert.deepEqual(
        after.entries.map((card) => card.id),
        ["card-1", "card-2"],
      );
      assert.deepEqual(
        after.choices.map((card) => [card.threadId, card.entry.id]),
        [[threadId, "card-2"]],
      );
    }),
  );

  it.effect("skips a file it cannot read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* cardsDirectory;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "thread%3Abroken.json"), "{not json");
      const all = yield* withStore(
        Effect.gen(function* () {
          return yield* (yield* TeamCards.TeamCards).all;
        }),
      );
      assert.isFalse(all.some((cards) => cards.threadId === "thread:broken"));
    }),
  );

  it.effect("removes a deleted chat's file and tells subscribers", () =>
    Effect.gen(function* () {
      const deletedThreadId = ThreadId.make("thread:team-cards-deleted");
      const keptThreadId = ThreadId.make("thread:team-cards-kept");
      yield* TeamOrchestrator.seedThread({
        projectId,
        threadId: deletedThreadId,
        workspaceRoot: "/workspace/team-cards",
      });
      yield* TeamOrchestrator.seedThread({
        projectId,
        threadId: keptThreadId,
        workspaceRoot: "/workspace/team-cards",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cards = yield* TeamCards.TeamCards;
          // Built before the cards exist, so its start-up sweep has nothing to do.
          yield* Layer.build(TeamCardsCleanup.layer);
          yield* cards.append({ threadId: deletedThreadId, entry: entry("deleted-card") });
          yield* cards.append({ threadId: keptThreadId, entry: entry("kept-card") });
          const removed = yield* Deferred.make<void>();
          yield* Stream.fromSubscription(yield* cards.subscribeChanges).pipe(
            Stream.filter(
              (change) => change.threadId === deletedThreadId && change.entries.length === 0,
            ),
            Stream.runHead,
            Effect.andThen(Deferred.succeed(removed, undefined)),
            Effect.forkScoped,
          );
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("command:team-cards-delete"),
            threadId: deletedThreadId,
          });
          yield* Deferred.await(removed);
          assert.deepEqual(yield* cards.forThread(deletedThreadId), []);
          assert.deepEqual(
            (yield* cards.forThread(keptThreadId)).map((card) => card.id),
            ["kept-card"],
          );
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* cardsDirectory;
          assert.isFalse(
            yield* fs.exists(path.join(directory, `${encodeURIComponent(deletedThreadId)}.json`)),
          );
        }),
      ).pipe(Effect.provide(TeamCards.layer));
    }),
  );

  it.effect("at start, removes the files of chats that no longer exist", () =>
    Effect.gen(function* () {
      const goneThreadId = ThreadId.make("thread:team-cards-gone");
      const liveThreadId = ThreadId.make("thread:team-cards-live");
      yield* TeamOrchestrator.seedThread({
        projectId,
        threadId: liveThreadId,
        workspaceRoot: "/workspace/team-cards",
      });
      yield* withStore(
        Effect.gen(function* () {
          const cards = yield* TeamCards.TeamCards;
          yield* cards.append({ threadId: goneThreadId, entry: entry("gone-card") });
          yield* cards.append({ threadId: liveThreadId, entry: entry("live-card") });
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cards = yield* TeamCards.TeamCards;
          const removed = yield* Deferred.make<void>();
          yield* Stream.fromSubscription(yield* cards.subscribeChanges).pipe(
            Stream.filter((change) => change.threadId === goneThreadId),
            Stream.runHead,
            Effect.andThen(Deferred.succeed(removed, undefined)),
            Effect.forkScoped,
          );
          yield* Layer.build(TeamCardsCleanup.layer);
          yield* Deferred.await(removed);
          assert.deepEqual(yield* cards.forThread(goneThreadId), []);
          assert.deepEqual(
            (yield* cards.forThread(liveThreadId)).map((card) => card.id),
            ["live-card"],
          );
        }),
      ).pipe(Effect.provide(TeamCards.layer));
    }),
  );
});
