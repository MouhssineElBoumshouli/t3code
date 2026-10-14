import type { TeamClaimPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { claimPullRequestOf, mergeOrder, type MergeOrderSide } from "./mergeOrder.ts";

const pullRequest = (overrides: Partial<TeamClaimPullRequest> = {}): TeamClaimPullRequest => ({
  number: 1,
  state: "open",
  draft: false,
  checks: null,
  mergeable: false,
  approved: false,
  size: null,
  ...overrides,
});

const side = (key: string, overrides: Partial<MergeOrderSide> = {}): MergeOrderSide => ({
  key,
  pullRequest: null,
  at: "2026-10-14T09:00:00.000Z",
  ...overrides,
});

describe("mergeOrder", () => {
  it("goes down the rules until one tells the sides apart", () => {
    // 1. An open pull request beats none, and a draft counts as none.
    assert.deepEqual(mergeOrder(side("mouhssine"), side("sara", { pullRequest: pullRequest() })), {
      first: "b",
      reason: "pullRequestOpen",
    });
    assert.deepEqual(
      mergeOrder(
        side("mouhssine", { pullRequest: pullRequest({ draft: true }) }),
        side("sara", { at: "2026-10-14T10:00:00.000Z" }),
      ),
      { first: "a", reason: "earlier" },
    );
    // 2. Green checks.
    assert.deepEqual(
      mergeOrder(
        side("mouhssine", { pullRequest: pullRequest({ checks: "pending" }) }),
        side("sara", { pullRequest: pullRequest({ checks: "passing" }) }),
      ),
      { first: "b", reason: "checksGreen" },
    );
    // 3. Mergeable and approved, both needed.
    assert.deepEqual(
      mergeOrder(
        side("mouhssine", { pullRequest: pullRequest({ mergeable: true, approved: true }) }),
        side("sara", { pullRequest: pullRequest({ mergeable: true }) }),
      ),
      { first: "a", reason: "approved" },
    );
    // 4. The smaller diff, only when both sizes are known.
    assert.deepEqual(
      mergeOrder(
        side("mouhssine", { pullRequest: pullRequest({ size: 400 }) }),
        side("sara", { pullRequest: pullRequest({ size: 40 }) }),
      ),
      { first: "b", reason: "smaller" },
    );
    assert.equal(
      mergeOrder(
        side("mouhssine", { pullRequest: pullRequest({ size: 400 }) }),
        side("sara", { pullRequest: pullRequest(), at: "2026-10-14T08:00:00.000Z" }),
      ).reason,
      "earlier",
    );
  });

  it("is the same suggestion from either side", () => {
    const mine = side("mouhssine", { pullRequest: pullRequest({ size: 10 }) });
    const sara = side("sara", { pullRequest: pullRequest({ size: 30 }) });
    assert.deepEqual(mergeOrder(mine, sara), { first: "a", reason: "smaller" });
    assert.deepEqual(mergeOrder(sara, mine), { first: "b", reason: "smaller" });
  });

  it("puts a chat that still runs after one that finished, and ties by key", () => {
    assert.deepEqual(mergeOrder(side("A", { at: null }), side("B")), {
      first: "b",
      reason: "earlier",
    });
    assert.deepEqual(mergeOrder(side("sara"), side("mouhssine")), { first: "b", reason: "tie" });
    assert.deepEqual(mergeOrder(side("mouhssine"), side("sara")), { first: "a", reason: "tie" });
  });
});

describe("claimPullRequestOf", () => {
  const link = (snapshot: ThreadPullRequestLink["snapshot"]): ThreadPullRequestLink => ({
    host: "github.com",
    repository: "acme/notes",
    number: 12,
    url: "https://github.com/acme/notes/pull/12",
    source: "created",
    linkedAt: "2026-10-14T09:00:00.000Z",
    snapshot,
    stack: null,
  });

  it("reads the current pull request's synced state; nothing before the first sync", () => {
    assert.isNull(claimPullRequestOf(undefined));
    assert.isNull(claimPullRequestOf([link(null)]));
    assert.deepEqual(
      claimPullRequestOf([
        link({
          state: "open",
          title: "Search by tag",
          headBranch: "t3/search",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-14T09:05:00.000Z",
          additions: 30,
          deletions: 4,
          reviewDecision: "approved",
          checksState: "passing",
          mergeability: "mergeable",
        }),
      ]),
      {
        number: 12,
        state: "open",
        draft: false,
        checks: "passing",
        mergeable: true,
        approved: true,
        size: 34,
      },
    );
  });
});
