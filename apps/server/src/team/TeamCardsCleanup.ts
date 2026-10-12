/**
 * Removes a chat's team cards when the chat goes (fork-only,
 * team/V2_PORT_PLAN.md D1): on `thread.deleted`, and at start for chats
 * deleted while the server was off. An archived chat keeps its cards, so
 * unarchiving it brings them back.
 *
 * @module TeamCardsCleanup
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as TeamCards from "./TeamCards.ts";

const make = Effect.gen(function* () {
  const cards = yield* TeamCards.TeamCards;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  // From here on, not from whenever the fiber below subscribes: a chat deleted
  // in between would otherwise keep its file until the next start.
  // A failed read starts from the beginning: removing a file that is gone does nothing.
  const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));

  const remove = (threadId: ThreadId) =>
    cards.removeThread(threadId).pipe(
      Effect.catchTags({
        TeamCardsWriteError: (error) =>
          Effect.logWarning("team cards of a deleted chat could not be removed", { error }),
      }),
    );

  yield* forkParked(
    Stream.runForEach(
      eventSink.stream({ afterSequence: fromSequence, eventType: "thread.deleted" }),
      (stored) =>
        stored.event.type === "thread.deleted" ? remove(stored.event.threadId) : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("team cards cleanup event stream failed", { cause }),
      ),
    ),
  );

  // Only the files there at start: a chat created later is missing from the
  // list read below but not deleted.
  const candidates = yield* cards.threadIds;
  yield* forkParked(
    Effect.gen(function* () {
      if (candidates.length === 0) return;
      const shells = yield* orchestrator.getShellSnapshot();
      const archived = yield* orchestrator.getShellSnapshot({ location: "archive" });
      const known = new Set<ThreadId>(
        [
          ...shells.threads,
          ...shells.archivedThreads,
          ...archived.threads,
          ...archived.archivedThreads,
        ].map((thread) => thread.id),
      );
      for (const threadId of candidates) {
        if (!known.has(threadId)) yield* remove(threadId);
      }
    }).pipe(
      // A failed read deletes nothing.
      Effect.catchCause((cause) => Effect.logWarning("team cards startup sweep failed", { cause })),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
