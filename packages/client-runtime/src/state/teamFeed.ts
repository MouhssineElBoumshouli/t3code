/**
 * The team feed on the client (fork-only, team/UI_PLAN.md slice 0): the
 * server pushes each team's view, and each chat's cards, when they change; this
 * folds the events into the current state. Web and mobile read it the same way.
 */
import { applyTeamFeedStateEvent, EMPTY_TEAM_FEED_STATE, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createTeamFeedAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    /** Every team and solo project on one environment, and each chat's cards, as last pushed. */
    feed: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:team:feed",
      tag: WS_METHODS.subscribeTeamFeed,
      // The scan's seed is not a state the server sent; the first value is the snapshot.
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => EMPTY_TEAM_FEED_STATE, applyTeamFeedStateEvent),
          Stream.drop(1),
        ),
    }),
    /** The user's choice on a warning card (team/PREVENTION_PLAN.md, slice 3a). */
    choose: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:choose",
      tag: WS_METHODS.teamChoose,
    }),
    /** An answer to a teammate's question (slice 3d). */
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:answer",
      tag: WS_METHODS.teamAnswer,
    }),
    /** Writing, replying to, marking and removing notes (slice 4). */
    note: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:note",
      tag: WS_METHODS.teamNote,
    }),
  };
}
