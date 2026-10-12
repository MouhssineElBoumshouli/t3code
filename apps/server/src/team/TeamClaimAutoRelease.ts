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
  OrchestrationV2AppThread,
  OrchestrationV2StoredEvent,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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
  thread: Pick<OrchestrationV2AppThread, "pullRequests" | "branchPullRequest">,
  isMergedPullRequest: PullRequestMatch,
): boolean {
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  const touched =
    links.some(isMergedPullRequest) ||
    (thread.branchPullRequest != null && isMergedPullRequest(thread.branchPullRequest));
  return touched && !links.some((link) => !isMergedPullRequest(link) && isOpen(link));
}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  // From the sequence read now, so no event before activation is missed. A
  // failed read starts from the beginning: releasing twice changes nothing.
  const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
  // One stream, in order: a merge and a later archive release in the order they happened.
  const events = eventSink.stream({ afterSequence: fromSequence });
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
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell === null || shell.archivedAt !== null ? Option.none() : Option.some(shell),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Team claim release could not read the thread.", {
          threadId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );

  /** The event carries the thread after the sync, so its links show the merge. */
  const onPullRequestsSynced = (thread: OrchestrationV2AppThread, occurredAt: DateTime.Utc) =>
    Effect.gen(function* () {
      // Archived threads are released by their own event.
      if (thread.archivedAt !== null) return;
      const isMerged = (pullRequest: ThreadLinkedPullRequest | ThreadPullRequestLink) =>
        "snapshot" in pullRequest && pullRequest.snapshot?.state === "merged";
      if (!isThreadWorkMerged(thread, isMerged)) return;
      const mergedAt =
        visibleThreadPullRequests(thread.pullRequests ?? [])
          .flatMap((link) =>
            isMerged(link) && link.snapshot?.mergedAt ? [link.snapshot.mergedAt] : [],
          )
          .toSorted()
          .at(-1) ?? DateTime.formatIso(occurredAt);
      yield* release(thread.id, RELEASE_REASONS.merged, mergedAt);
    });

  const onEvent = ({ event }: OrchestrationV2StoredEvent) => {
    switch (event.type) {
      case "thread.archived":
        return release(event.threadId, RELEASE_REASONS.archived);
      case "thread.deleted":
        return release(event.threadId, RELEASE_REASONS.deleted);
      case "thread.pull-request-synced":
        return onPullRequestsSynced(event.payload, event.occurredAt);
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
      const thread = yield* activeThread(threadId);
      if (Option.isNone(thread)) yield* release(threadId, RELEASE_REASONS.inactive);
    }
  });

  yield* forkParked(releaseInactive.pipe(Effect.andThen(Stream.runForEach(events, onEvent))));
  yield* forkParked(Stream.runForEach(merges, onMerge));
});

export const TeamClaimAutoReleaseLive = Layer.effectDiscard(make);
