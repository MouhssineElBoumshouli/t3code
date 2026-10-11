/**
 * Team cards kept per chat (fork-only, team/V2_PORT_PLAN.md D1): the plan
 * card, the warning card and its choice, a teammate's question and its answer.
 *
 * Upstream's thread history is a fixed set of item types, so the team layer
 * keeps its cards here instead: one JSON file per chat under
 * `<stateDir>/team/cards/`, all held in memory after the first read. The team
 * feed sends them to clients (`subscribeChanges`); `TeamCardsCleanup`
 * removes a chat's file when the chat is deleted.
 *
 * @module TeamCards
 */
import {
  type TeamCardEntry,
  TeamCardEntry as TeamCardEntrySchema,
  type TeamCardKind,
  ThreadId,
  type TeamThreadCards,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export class TeamCardsWriteError extends Schema.TaggedError<TeamCardsWriteError>()(
  "TeamCardsWriteError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to save the chat's team cards.";
  }
}

/** One card record and the chat it belongs to. */
export interface TeamCardOfThread {
  readonly threadId: ThreadId;
  readonly entry: TeamCardEntry;
}

export class TeamCards extends Context.Service<
  TeamCards,
  {
    /** Adds a record to the chat's cards; a record whose id is already there is ignored. */
    readonly append: (input: TeamCardOfThread) => Effect.Effect<void, TeamCardsWriteError>;
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<TeamCardEntry>>;
    /** Every chat's records of one kind, oldest first within each chat. */
    readonly listByKind: (kind: TeamCardKind) => Effect.Effect<ReadonlyArray<TeamCardOfThread>>;
    /** Every chat that has cards. */
    readonly all: Effect.Effect<ReadonlyArray<TeamThreadCards>>;
    /** The chats that have a card file. */
    readonly threadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Deletes the chat's cards; nothing happens when it has none. */
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, TeamCardsWriteError>;
    /**
     * A chat's cards after each change, empty entries after its removal.
     * Subscribed when this runs, so a read right after misses nothing.
     */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<TeamThreadCards>,
      never,
      Scope.Scope
    >;
  }
>()("t3/team/TeamCards") {}

const CardsFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(TeamCardEntrySchema),
});
const CardsFileJson = Schema.fromJsonString(CardsFile);
const decodeCardsFile = Schema.decodeUnknownEffect(CardsFileJson);
const encodeCardsFile = Schema.encodeEffect(CardsFileJson);

const FILE_SUFFIX = ".json";
// Thread ids are free text in the contract; the file name must not be.
const fileNameOf = (threadId: ThreadId) => `${encodeURIComponent(threadId)}${FILE_SUFFIX}`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const directory = path.join(config.stateDir, "team", "cards");
  const filePathOf = (threadId: ThreadId) => path.join(directory, fileNameOf(threadId));

  const cards = new Map<ThreadId, ReadonlyArray<TeamCardEntry>>();
  // A file that cannot be read is skipped, not fatal: the chat shows no cards.
  if (yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false))) {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const threadId = ThreadId.make(decodeURIComponent(name.slice(0, -FILE_SUFFIX.length)));
      const read = yield* fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.flatMap(decodeCardsFile), Effect.option);
      if (read._tag === "Some") cards.set(threadId, read.value.entries);
      else yield* Effect.logWarning("team cards file could not be read; skipped.", { name });
    }
  }

  const writes = yield* Semaphore.make(1);
  const pubsub = yield* PubSub.unbounded<TeamThreadCards>();

  const save = (threadId: ThreadId, entries: ReadonlyArray<TeamCardEntry>) =>
    encodeCardsFile({ version: 1, entries }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: filePathOf(threadId), contents }),
      ),
      Effect.mapError((cause) => new TeamCardsWriteError({ threadId, cause })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const append = (input: TeamCardOfThread) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = cards.get(input.threadId) ?? [];
        if (current.some((entry) => entry.id === input.entry.id)) return;
        const entries = [...current, input.entry];
        yield* save(input.threadId, entries);
        cards.set(input.threadId, entries);
        yield* PubSub.publish(pubsub, { threadId: input.threadId, entries });
      }),
    );

  const removeThread = (threadId: ThreadId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        if (!cards.has(threadId)) return;
        yield* fs
          .remove(filePathOf(threadId), { force: true })
          .pipe(Effect.mapError((cause) => new TeamCardsWriteError({ threadId, cause })));
        cards.delete(threadId);
        yield* PubSub.publish(pubsub, { threadId, entries: [] });
      }),
    );

  return TeamCards.of({
    append,
    forThread: (threadId) => Effect.sync(() => cards.get(threadId) ?? []),
    listByKind: (kind) =>
      Effect.sync(() =>
        [...cards].flatMap(([threadId, entries]) =>
          entries.flatMap((entry) => (entry.kind === kind ? [{ threadId, entry }] : [])),
        ),
      ),
    all: Effect.sync(() => [...cards].map(([threadId, entries]) => ({ threadId, entries }))),
    threadIds: Effect.sync(() => [...cards.keys()]),
    removeThread,
    subscribeChanges: PubSub.subscribe(pubsub),
  });
});

export const layer = Layer.effect(TeamCards, make);
