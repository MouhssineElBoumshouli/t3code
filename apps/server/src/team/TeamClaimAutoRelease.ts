/**
 * Claim lifetime (fork-only, see team/DESIGN.md D5): a claim lasts until the
 * thread's work is merged or dropped, not until a turn ends. Agents are told
 * to keep their claims; this layer releases them when:
 *
 * - the thread is archived or deleted (`thread.archived`, `thread.deleted`;
 *   deleting a project deletes its threads first),
 * - a pull request linked to the thread merges (`thread.pull-request-synced`
 *   with state `merged`), and none of the thread's other linked pull requests
 *   is still open,
 * - a pull request is merged from T3 (`PullRequestService.subscribeMerges`)
 *   and it is the thread's linked or branch pull request.
 *
 * A merge releases only claims made before it, so a thread that carries on
 * after its pull request merged keeps its new claims.
 *
 * Not detected: a pull request T3 only found from the thread's branch, merged
 * outside T3. T3 stores no state for those, so there is no event to react to.
 *
 * At startup, claims of threads that are no longer active (archived or
 * deleted while this layer was not listening) are released too.
 *
 * @module TeamClaimAutoRelease
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadShell,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as TeamService from "./TeamService.ts";

export const RELEASE_REASONS = {
  merged: "its pull request merged",
  archived: "its thread was archived",
  deleted: "its thread was deleted",
  inactive: "its thread was archived or deleted",
} as const;

const isOpen = (link: ThreadPullRequestLink) =>
  link.snapshot === null || link.snapshot.state === "open";

type PullRequestMatch = (pullRequest: ThreadLinkedPullRequest | ThreadPullRequestLink) => boolean;

/**
 * The thread's work is merged when one of its pull requests is the merged one
 * and no other linked one is still open (a stack, or a follow-up pull request).
 */
export function isThreadWorkMerged(
  thread: OrchestrationThreadShell,
  isMergedPullRequest: PullRequestMatch,
): boolean {
  const links = visibleThreadPullRequests(thread.pullRequests);
  const touched =
    links.some(isMergedPullRequest) ||
    (thread.branchPullRequest != null && isMergedPullRequest(thread.branchPullRequest));
  return touched && !links.some((link) => !isMergedPullRequest(link) && isOpen(link));
}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  // Subscribe now, so no event published before activation is missed.
  const events = yield* engine.subscribeDomainEvents;
  const merges = yield* pullRequests.subscribeMerges;

  const release = (threadId: ThreadId, reason: string, claimedBefore?: string) =>
    teams.releaseThreadClaims({ thread: { environmentId, threadId }, reason, claimedBefore }).pipe(
      Effect.flatMap((released) =>
        released.length === 0
          ? Effect.void
          : Effect.logInfo("Released team claims.", { threadId, reason, claims: released.length }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Team claim release failed.", { threadId, reason, cause }),
      ),
    );

  /** The active thread, or none when it is archived, deleted or unreadable. */
  const activeThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Team claim release could not read the thread.", {
          threadId,
          cause,
        }).pipe(Effect.as(Option.none<OrchestrationThreadShell>())),
      ),
    );

  const onLinkSynced = (threadId: ThreadId, key: ThreadPullRequestKey, mergedAt: string) =>
    Effect.gen(function* () {
      // Archived or deleted threads are released by their own events.
      const thread = yield* activeThread(threadId);
      if (Option.isNone(thread)) return;
      // Matched by key: the event's link may not be projected as merged yet.
      const merged = isThreadWorkMerged(
        thread.value,
        (pullRequest) => "host" in pullRequest && threadPullRequestKeysEqual(pullRequest, key),
      );
      if (merged) yield* release(threadId, RELEASE_REASONS.merged, mergedAt);
    });

  const onEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.archived":
        return release(event.payload.threadId, RELEASE_REASONS.archived);
      case "thread.deleted":
        return release(event.payload.threadId, RELEASE_REASONS.deleted);
      case "thread.pull-request-synced":
        return event.payload.snapshot.state === "merged"
          ? onLinkSynced(
              event.payload.threadId,
              event.payload,
              event.payload.snapshot.mergedAt ?? event.occurredAt,
            )
          : Effect.void;
    }
    return Effect.void;
  };

  /** A merge made from T3, which may be a pull request found only from a branch. */
  const onMerge = (event: PullRequestService.PullRequestMergeEvent) =>
    Effect.gen(function* () {
      const matches = (pullRequest: { readonly repository: string; readonly number: number }) =>
        pullRequest.number === event.number &&
        pullRequest.repository.toLowerCase() === event.repository.toLowerCase();
      for (const threadId of yield* teams.listClaimedThreads(environmentId)) {
        const thread = yield* activeThread(threadId);
        if (Option.isNone(thread) || thread.value.projectId !== event.projectId) continue;
        if (isThreadWorkMerged(thread.value, matches)) {
          yield* release(threadId, RELEASE_REASONS.merged, event.mergedAt);
        }
      }
    });

  /** Claims of threads archived or deleted while nothing was listening. */
  const releaseInactive = Effect.gen(function* () {
    for (const threadId of yield* teams.listClaimedThreads(environmentId)) {
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread)) yield* release(threadId, RELEASE_REASONS.inactive);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Team claim startup release failed.", { cause })),
  );

  yield* forkParked(releaseInactive.pipe(Effect.andThen(Stream.runForEach(events, onEvent))));
  yield* forkParked(Stream.runForEach(merges, onMerge));
});

export const TeamClaimAutoReleaseLive = Layer.effectDiscard(make);
