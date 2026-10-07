/**
 * The team feed on the client (fork-only, team/UI_PLAN.md slice 0): the
 * server pushes each team's view when it changes, and this folds the events
 * into the current list of teams. Web and mobile read it the same way.
 */
import { applyTeamFeedEvent, type TeamFeedTeam, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const NO_TEAMS: ReadonlyArray<TeamFeedTeam> = [];

export function createTeamFeedAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    /** Every team and solo project on one environment, as last pushed. */
    teams: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:team:feed",
      tag: WS_METHODS.subscribeTeamFeed,
      // The scan's seed is not a state the server sent; the first value is the snapshot.
      transform: (stream) => stream.pipe(Stream.scan(NO_TEAMS, applyTeamFeedEvent), Stream.drop(1)),
    }),
  };
}
