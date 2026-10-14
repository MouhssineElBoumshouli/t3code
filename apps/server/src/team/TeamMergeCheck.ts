/**
 * Merging help, slice 1 (fork-only, team/MERGE_HELP_PLAN.md sections 1, 3
 * and 6): on events, this server combines each of its chats' latest
 * checkpoint with teammates' pushed branches, with the remote's base branch,
 * and (own worktrees only) with its other chats, using `git merge-tree`. The
 * team feed shows the result.
 *
 * - Mine: a chat's newest ready run checkpoint, a commit of its whole working
 *   tree. Chats in the shared checkout are one side (the newest one); solo,
 *   only chats with their own worktree count, since the shared checkout's
 *   overlaps are already told live.
 * - Teammates: claims with a `branch` and `pushedCommit`. A commit not here
 *   yet is fetched into `refs/t3-team/peers/<login>/<branch>`, so the
 *   person's own remote branches stay as they were. A pushed commit the base
 *   already holds (merged, also squashed) is left out.
 * - Base: `origin/HEAD`'s branch, else `main`, fetched into
 *   `refs/t3-team/base/<branch>` at most every two minutes.
 * - When: a chat's turn ends (new checkpoint), the team state changes (a
 *   teammate pushed), every two minutes for the base, and once at start.
 *   Requests within 30 s are one batch; batches never overlap, and pairs run
 *   one at a time. Results are cached by their two commits.
 * - Git older than 2.38 has no `merge-tree --write-tree`: nothing is checked
 *   and the feed says why.
 *
 * A clashing or overlapping pair with a teammate's branch or another chat
 * gets a merge order (`mergeOrder`): the teammate's side from their claims
 * (pull request, when they started), this server's chats from their own
 * pull request and claims; two chats by which finished first.
 *
 * The chat's turn note gets one line when a new clash appears for it (each
 * clash once), so the agent tells the person. After an approved fix, the
 * chat's side is its merge commit until a newer checkpoint (a ref, so it
 * survives a restart).
 *
 * The combined typecheck (`TeamCombineCheck`) stores its result here, by the
 * two commits, and the view shows it on the pair while both stay.
 *
 * Results live in memory; a restart checks again. Never touches a working copy.
 *
 * @module TeamMergeCheck
 */
import {
  type OrchestrationProjectShell,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type TeamClaim,
  type TeamCombinedCheck,
  type TeamId,
  type TeamMemberId,
  type TeamMergeMine,
  type TeamMergeOrder,
  type TeamMergeOther,
  type TeamMergePair,
  TeamMerging,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  alreadyHolds,
  fetchIntoHiddenRef,
  MERGE_TREE_MIN_GIT,
  type MergeTreeResult,
  mergeTree,
  parseGitVersion,
  supportsMergeTree,
} from "./mergeTree.ts";
import { soloTeamIdOf } from "./state/SoloTeam.ts";
import { diffToTeamPaths } from "./TeamAutoNotes.ts";
import { claimPullRequestOf, mergeOrder, type MergeOrderSide } from "./mergeOrder.ts";
import {
  BoundedCache,
  type CheckedPair,
  clashLine,
  combinedKey,
  newClashes,
  commitPairKey,
  isChangeOfState,
  mergingView,
  nextPair,
  orientCombined,
  pairKey,
  type PairSides,
  swapChatPair,
  wantsOrder,
} from "./TeamMergeModel.ts";
import { findRepoRoot, findTeamFile } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";
import { installTeamTurnNote } from "./teamTurnNote.ts";

export const MERGE_CHECK_DEBOUNCE = Duration.seconds(30);
export const BASE_CHECK_INTERVAL = Duration.minutes(2);
/** Chats whose last turn ended longer ago than this are left out. */
const RECENT_CHAT_DAYS = 14;
/** The newest chats checked per project. */
const MAX_CHATS = 12;
const GIT_TIMEOUT_MS = 60_000;
const RESULT_CACHE_SIZE = 500;
const PEER_REFS = "refs/t3-team/peers";
const FIXED_REFS = "refs/t3-team/fixed";
const BASE_REFS = "refs/t3-team/base";

export class TeamMergeCheck extends Context.Service<
  TeamMergeCheck,
  {
    /** The team's merging view; undefined when there is nothing to show. */
    readonly forTeam: (teamId: TeamId) => Effect.Effect<TeamMerging | undefined>;
    /** A team's view changed. */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<TeamId>, never, Scope.Scope>;
    /** Checks the project in the next batch. */
    readonly request: (projectId: ProjectId) => Effect.Effect<void>;
    /** The pair of this chat and that other side, as last checked; two chats from either one. */
    readonly findPair: (
      projectId: ProjectId,
      threadId: ThreadId,
      other: TeamMergeOther,
    ) => Effect.Effect<TeamMergePair | undefined>;
    /** After an approved fix: the chat's side is `commit` until a newer checkpoint. Checks again. */
    readonly useCommitUntilNextTurn: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly repoRoot: string;
      readonly commit: string;
    }) => Effect.Effect<void>;
    /** The turn-note line for clashes this chat was not told about yet; marks them told. */
    readonly takeClashLine: (threadId: ThreadId) => Effect.Effect<string | undefined>;
    /** The project's team, its root, and the Git repo root. */
    readonly placeOf: (projectId: ProjectId) => Effect.Effect<Option.Option<ProjectPlace>>;
    /** A combined check's result (or that it runs), shown on its pair while both commits stay. */
    readonly setCombined: (projectId: ProjectId, check: TeamCombinedCheck) => Effect.Effect<void>;
    /** The combined check last stored for this pair, as seen from it. */
    readonly combinedOf: (pair: TeamMergePair) => Effect.Effect<TeamCombinedCheck | undefined>;
  }
>()("t3/team/TeamMergeCheck") {}

/**
 * Collects keys and runs them as one batch `delay` after the first request;
 * requests while it waits join it. Batches run one at a time.
 */
export const makeBatcher = <K>(
  delay: Duration.Input,
  run: (keys: ReadonlyArray<K>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const pending = new Set<K>();
    let waiting = false;
    const flush = Effect.suspend(() => {
      waiting = false;
      const keys = [...pending];
      pending.clear();
      return keys.length === 0 ? Effect.void : run(keys);
    });
    const request = (key: K) =>
      Effect.suspend(() => {
        pending.add(key);
        if (waiting) return Effect.void;
        waiting = true;
        return Effect.sleep(delay).pipe(
          Effect.andThen(lock.withPermits(1)(flush)),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });
    return { request };
  });

const encodeMerging = Schema.encodeSync(Schema.fromJsonString(TeamMerging));

interface ProjectState {
  readonly teamId: TeamId;
  readonly pairs: ReadonlyMap<string, CheckedPair>;
  /** It had chats to check last time, so the base is polled for it. */
  readonly active: boolean;
}

export interface ProjectPlace {
  readonly teamId: TeamId;
  readonly teamRoot: string;
  readonly repoRoot: string;
}

interface RefInfo {
  readonly commit: string;
  readonly tree: string;
  readonly committedAt: string;
}

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const changes = yield* PubSub.unbounded<TeamId>();

  const byProject = new Map<ProjectId, ProjectState>();
  const results = new BoundedCache<MergeTreeResult | null>(RESULT_CACHE_SIZE);
  /** Per thread: the run whose checkpoint ref was read, and that ref (null: none ready). */
  const checkpoints = new Map<ThreadId, { runId: string; ref: string | null }>();
  /** `<folder>|<login>/<branch>` → the commit its peer ref holds, or `missing:<commit>`. */
  const peers = new Map<string, string>();
  const baseFetchedAt = new Map<string, number>();
  /** Per chat, the clashes its turn note told (`<pair>|<since>`). */
  const told = new Map<ThreadId, Set<string>>();
  let gitProblem: string | undefined | null = null;

  const run = (cwd: string, args: ReadonlyArray<string>, operation: string) =>
    git.execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: GIT_TIMEOUT_MS });

  /** Undefined when Git can merge-tree; otherwise why not. Read once. */
  const gitUnavailable = (cwd: string) =>
    Effect.gen(function* () {
      if (gitProblem !== null) return gitProblem;
      const result = yield* run(cwd, ["--version"], "TeamMerging.version");
      const version = parseGitVersion(result.stdout);
      gitProblem =
        version === undefined || supportsMergeTree(version)
          ? undefined
          : `Merge checks need Git ${MERGE_TREE_MIN_GIT.major}.${MERGE_TREE_MIN_GIT.minor} or newer; this computer has ${version.major}.${version.minor}.`;
      if (gitProblem !== undefined) yield* Effect.logWarning(gitProblem);
      return gitProblem;
    });

  /** Combined checks by their two commits (`combinedKey`). */
  const combined = new BoundedCache<TeamCombinedCheck>(RESULT_CACHE_SIZE);
  const withCombined = (checked: CheckedPair): CheckedPair => {
    const { pair } = checked;
    const check = orientCombined(
      combined.get(combinedKey(pair.mine.commit, pair.other.commit)),
      pair,
    );
    if (check === undefined) return checked;
    return { ...checked, pair: { ...pair, combined: check } };
  };

  const teamView = (teamId: TeamId) =>
    mergingView(
      [...byProject.values()]
        .filter((state) => state.teamId === teamId)
        .flatMap((state) => [...state.pairs.values()].map(withCombined)),
      gitProblem ?? undefined,
    );
  const encodedView = (teamId: TeamId) => {
    const view = teamView(teamId);
    return view === undefined ? "" : encodeMerging(view);
  };

  /** The team a project is in, its root, and the Git repo root. */
  const placeOf = (project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      const found = yield* findTeamFile(project.workspaceRoot);
      const repoRoot = yield* findRepoRoot(project.workspaceRoot);
      if (Option.isNone(repoRoot)) return Option.none();
      return Option.some(
        Option.isSome(found)
          ? {
              teamId: found.value.teamFile.teamId,
              teamRoot: found.value.teamRoot,
              repoRoot: repoRoot.value,
            }
          : {
              teamId: yield* soloTeamIdOf(project.workspaceRoot),
              teamRoot: project.workspaceRoot,
              repoRoot: repoRoot.value,
            },
      );
    }).pipe(
      Effect.provide(fileContext),
      Effect.orElseSucceed(() => Option.none()),
    );

  /** The thread's newest ready run checkpoint ref, read once per run. */
  const checkpointRefOf = (thread: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const runId = thread.latestRunId;
      if (runId === null) return null;
      const known = checkpoints.get(thread.id);
      if (known !== undefined && known.runId === runId) return known.ref;
      const records = yield* orchestrator.getThreadRecords(thread.id, [
        "checkpoints",
        "checkpointScopes",
      ]);
      const subagentScopes = new Set(
        records.checkpointScopes.flatMap((scope) => (scope.kind === "subagent" ? [scope.id] : [])),
      );
      const newest = records.checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.runId !== null &&
            checkpoint.appRunOrdinal !== null &&
            checkpoint.status === "ready" &&
            !subagentScopes.has(checkpoint.scopeId),
        )
        .toSorted((a, b) => (b.appRunOrdinal ?? 0) - (a.appRunOrdinal ?? 0))[0];
      const ref = newest?.ref ?? null;
      checkpoints.set(thread.id, { runId, ref });
      return ref;
    }).pipe(Effect.orElseSucceed(() => null));

  /** Commit, tree and commit time of each ref that exists, in one call. */
  const readRefs = (repoRoot: string, refs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const found = new Map<string, RefInfo>();
      if (refs.length === 0) return found;
      const result = yield* run(
        repoRoot,
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(tree)%00%(committerdate:iso-strict)",
          ...refs,
        ],
        "TeamMerging.refs",
      );
      if (result.exitCode !== 0) return found;
      for (const line of result.stdout.split("\n")) {
        const [name, commit, tree, committedAt] = line.split("\0");
        if (name && commit && tree && committedAt) {
          found.set(name, { commit, tree, committedAt });
        }
      }
      return found;
    });

  /** Puts a teammate's pushed commit on its peer ref, fetching it if it is not here. */
  const ensurePeer = (repoRoot: string, memberId: string, branch: string, commit: string) =>
    Effect.gen(function* () {
      const ref = `${PEER_REFS}/${memberId}/${branch}`;
      const key = `${repoRoot}|${memberId}/${branch}`;
      const known = peers.get(key);
      if (known === commit) return ref;
      if (known === `missing:${commit}`) return undefined;
      const present = (yield* run(
        repoRoot,
        ["cat-file", "-e", `${commit}^{commit}`],
        "TeamMerging.peer",
      )).exitCode;
      if (present !== 0) {
        yield* fetchIntoHiddenRef(git, repoRoot, branch, ref);
      }
      const set = yield* run(repoRoot, ["update-ref", ref, commit], "TeamMerging.peer");
      if (set.exitCode !== 0) {
        peers.set(key, `missing:${commit}`);
        yield* Effect.logInfo("Team merge check: a teammate's pushed commit is not reachable.", {
          memberId,
          branch,
          commit,
        });
        return undefined;
      }
      peers.set(key, commit);
      return ref;
    });

  /** The base branch's hidden ref, fetched at most every two minutes; undefined without a remote. */
  const baseRef = (repoRoot: string) =>
    Effect.gen(function* () {
      if ((yield* run(repoRoot, ["remote", "get-url", "origin"], "TeamMerging.base")).exitCode) {
        return undefined;
      }
      const head = yield* run(
        repoRoot,
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        "TeamMerging.base",
      );
      const branch =
        head.exitCode === 0 && head.stdout.trim().startsWith("origin/")
          ? head.stdout.trim().slice("origin/".length)
          : "main";
      const ref = `${BASE_REFS}/${branch}`;
      const now = yield* Clock.currentTimeMillis;
      const last = baseFetchedAt.get(repoRoot);
      if (last === undefined || now - last >= Duration.toMillis(BASE_CHECK_INTERVAL)) {
        baseFetchedAt.set(repoRoot, now);
        yield* fetchIntoHiddenRef(git, repoRoot, branch, ref);
      }
      return { ref, branch };
    });

  const checkProject = (
    project: OrchestrationProjectShell,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) =>
    Effect.gen(function* () {
      const place = yield* placeOf(project);
      if (Option.isNone(place)) return;
      const { teamId, teamRoot, repoRoot } = place.value;
      const before = byProject.get(project.id);
      const publishIfChanged = (next: ProjectState | undefined) =>
        Effect.gen(function* () {
          const affected = [...new Set([teamId, ...(before === undefined ? [] : [before.teamId])])];
          const old = affected.map((id) => encodedView(id));
          if (next === undefined) byProject.delete(project.id);
          else byProject.set(project.id, next);
          for (const [index, id] of affected.entries()) {
            if (encodedView(id) !== old[index]) yield* PubSub.publish(changes, id);
          }
        });

      if ((yield* gitUnavailable(repoRoot)) !== undefined) {
        return yield* publishIfChanged({ teamId, pairs: new Map(), active: false });
      }
      if (Option.isNone(yield* teams.getTeam(teamId))) return yield* publishIfChanged(undefined);
      const solo = yield* teams.isSolo(teamId);
      const me = yield* teams.currentMember(teamId);

      // Mine: the newest chats with a turn that ended lately.
      const recentSince = (yield* Clock.currentTimeMillis) - RECENT_CHAT_DAYS * 24 * 60 * 60 * 1000;
      const candidates = threads
        .filter(
          (thread) =>
            thread.projectId === project.id &&
            thread.archivedAt === null &&
            thread.latestRunCompletedAt != null &&
            DateTime.toEpochMillis(thread.latestRunCompletedAt) >= recentSince &&
            (!solo || thread.worktreePath !== null),
        )
        .toSorted(
          (a, b) =>
            DateTime.toEpochMillis(b.latestRunCompletedAt!) -
            DateTime.toEpochMillis(a.latestRunCompletedAt!),
        );
      const mineRefs: Array<{ thread: OrchestrationV2ThreadShell; ref: string }> = [];
      let checkoutTaken = false;
      for (const thread of candidates) {
        if (mineRefs.length >= MAX_CHATS) break;
        if (thread.worktreePath === null && checkoutTaken) continue;
        const ref = yield* checkpointRefOf(thread);
        if (ref === null) continue;
        if (thread.worktreePath === null) checkoutTaken = true;
        mineRefs.push({ thread, ref });
      }
      if (mineRefs.length === 0) {
        return yield* publishIfChanged({ teamId, pairs: new Map(), active: false });
      }

      // Theirs: teammates' pushed branches, and the base.
      const peerRefs: Array<{ memberId: TeamMemberId; branch: string; ref: string }> = [];
      const teamClaims: ReadonlyArray<TeamClaim> =
        !solo && Option.isSome(me) ? yield* teams.listActiveClaims(teamId) : [];
      if (!solo && Option.isSome(me)) {
        const seen = new Set<string>();
        const claims = teamClaims.toReversed();
        for (const claim of claims) {
          if (claim.memberId === me.value.memberId) continue;
          if (claim.branch === undefined || claim.pushedCommit === undefined) continue;
          const key = `${claim.memberId}/${claim.branch}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const ref = yield* ensurePeer(repoRoot, claim.memberId, claim.branch, claim.pushedCommit);
          if (ref !== undefined)
            peerRefs.push({ memberId: claim.memberId, branch: claim.branch, ref });
        }
      }
      const base = yield* baseRef(repoRoot);

      const fixedRefOf = (threadId: ThreadId) => `${FIXED_REFS}/${threadId}`;
      const refs = yield* readRefs(repoRoot, [
        ...mineRefs.flatMap((entry) => [entry.ref, fixedRefOf(entry.thread.id)]),
        ...peerRefs.map((entry) => entry.ref),
        ...(base ? [base.ref] : []),
      ]);

      const mineSides: Array<{ side: TeamMergeMine; info: RefInfo }> = [];
      for (const { thread, ref } of mineRefs) {
        const checkpoint = refs.get(ref);
        if (checkpoint === undefined) continue;
        // An approved fix's merge commit stands for the chat until its next turn's checkpoint.
        const fixed = refs.get(fixedRefOf(thread.id));
        const info =
          fixed !== undefined && Date.parse(fixed.committedAt) >= Date.parse(checkpoint.committedAt)
            ? fixed
            : checkpoint;
        mineSides.push({
          side: {
            thread: { environmentId, threadId: thread.id },
            title: thread.title,
            worktree: thread.worktreePath !== null,
            commit: info.commit,
          },
          info,
        });
      }
      /** Cached merge-tree of two commits, null when Git cannot merge them. */
      const merged = (ours: string, theirs: string) =>
        Effect.gen(function* () {
          const cacheKey = commitPairKey(ours, theirs);
          let result = results.get(cacheKey);
          if (result === undefined) {
            result = (yield* mergeTree(git, repoRoot, ours, theirs)) ?? null;
            results.set(cacheKey, result);
          }
          return result;
        });
      const baseInfo = base ? refs.get(base.ref) : undefined;
      const others: Array<{ side: TeamMergeOther; info: RefInfo }> = [];
      for (const peer of peerRefs) {
        const info = refs.get(peer.ref);
        if (info === undefined) continue;
        // A teammate's work already in the base: only the base line is left to tell.
        if (baseInfo && alreadyHolds(baseInfo.tree, yield* merged(baseInfo.commit, info.commit))) {
          continue;
        }
        others.push({
          side: {
            _tag: "branch",
            memberId: peer.memberId,
            branch: peer.branch,
            commit: info.commit,
          },
          info,
        });
      }
      if (base && baseInfo) {
        others.push({
          side: { _tag: "base", branch: base.branch, commit: baseInfo.commit },
          info: baseInfo,
        });
      }

      const pairsToCheck: Array<PairSides> = [];
      const sidesOf = (
        mine: { side: TeamMergeMine; info: RefInfo },
        other: { side: TeamMergeOther; info: RefInfo },
      ): PairSides => ({
        projectId: project.id,
        mine: mine.side,
        other: other.side,
        mineTree: mine.info.tree,
        otherTree: other.info.tree,
        newerCommitAt:
          Date.parse(mine.info.committedAt) >= Date.parse(other.info.committedAt)
            ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(mine.info.committedAt)))
            : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(other.info.committedAt))),
      });
      for (const mine of mineSides) {
        for (const other of others) pairsToCheck.push(sidesOf(mine, other));
      }
      // Own worktrees against each other (solo's main case; the same in a team).
      const worktrees = mineSides.filter((mine) => mine.side.worktree);
      for (let index = 0; index < worktrees.length; index++) {
        for (const later of worktrees.slice(index + 1)) {
          const mine = worktrees[index]!;
          pairsToCheck.push(
            sidesOf(mine, {
              side: {
                _tag: "chat",
                thread: later.side.thread,
                title: later.side.title,
                commit: later.side.commit,
              },
              info: later.info,
            }),
          );
        }
      }

      // Merge order: both people read the same claims, so both servers suggest the same side.
      const shells = new Map(mineRefs.map(({ thread }) => [thread.id as string, thread]));
      const earliest = (claims: ReadonlyArray<TeamClaim>) =>
        claims.map((claim) => claim.claimedAt).toSorted()[0];
      const mineOrderSide = (thread: OrchestrationV2ThreadShell): MergeOrderSide => ({
        key: Option.isSome(me) ? me.value.memberId : thread.title,
        pullRequest: claimPullRequestOf(thread.pullRequests),
        at:
          earliest(
            teamClaims.filter(
              (claim) =>
                claim.thread.environmentId === environmentId && claim.thread.threadId === thread.id,
            ),
          ) ?? DateTime.formatIso(thread.createdAt),
      });
      const chatOrderSide = (thread: OrchestrationV2ThreadShell): MergeOrderSide => ({
        key: thread.title,
        pullRequest: claimPullRequestOf(thread.pullRequests),
        at:
          thread.activeRunId === null && thread.latestRunCompletedAt != null
            ? DateTime.formatIso(thread.latestRunCompletedAt)
            : null,
      });
      const orderOf = (pair: TeamMergePair): TeamMergeOrder | undefined => {
        if (!wantsOrder(pair)) return undefined;
        const mineShell = shells.get(pair.mine.thread.threadId);
        if (mineShell === undefined) return undefined;
        const other = pair.other;
        let sides: readonly [MergeOrderSide, MergeOrderSide];
        if (other._tag === "chat") {
          const otherShell = shells.get(other.thread.threadId);
          if (otherShell === undefined) return undefined;
          sides = [chatOrderSide(mineShell), chatOrderSide(otherShell)];
        } else if (other._tag === "branch") {
          const theirs = teamClaims
            .filter((claim) => claim.memberId === other.memberId && claim.branch === other.branch)
            .toSorted((a, b) => a.claimedAt.localeCompare(b.claimedAt));
          sides = [
            mineOrderSide(mineShell),
            {
              key: other.memberId,
              pullRequest: theirs.findLast((claim) => claim.pullRequest)?.pullRequest ?? null,
              at: theirs[0]?.claimedAt ?? null,
            },
          ];
        } else {
          return undefined;
        }
        const decided = mergeOrder(sides[0], sides[1]);
        return { first: decided.first === "a" ? "mine" : "other", reason: decided.reason };
      };

      const now = DateTime.formatIso(yield* DateTime.now);
      const toTeamPath = (repoPath: string) =>
        diffToTeamPaths(path, [repoPath], repoRoot, teamRoot)[0];
      const next = new Map<string, CheckedPair>();
      for (const sides of pairsToCheck) {
        if (sides.mine.commit === sides.other.commit) continue;
        const key = pairKey(sides.projectId, sides.mine, sides.other);
        const previous = before?.pairs.get(key);
        const result = yield* merged(sides.mine.commit, sides.other.commit);
        if (result === null) continue;
        const fresh = nextPair({ previous, sides, result, toTeamPath, now });
        const { order: _order, ...unordered } = fresh.pair;
        const order = orderOf(unordered);
        const checked: CheckedPair = {
          ...fresh,
          pair: order === undefined ? unordered : { ...unordered, order },
        };
        if (previous !== undefined && isChangeOfState(previous, checked.pair.status)) {
          yield* Effect.logInfo("Team merge check: a pair changed.", {
            pair: key,
            from: previous.pair.status,
            to: checked.pair.status,
            files: checked.pair.fileCount,
          });
        }
        next.set(key, checked);
      }
      yield* publishIfChanged({ teamId, pairs: next, active: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team merge check failed.", { projectId: project.id, cause }),
      ),
    );

  const checkProjects = (projectIds: ReadonlyArray<ProjectId>) =>
    Effect.gen(function* () {
      const shells = yield* projects.listShells();
      const threads = (yield* orchestrator.getShellSnapshot()).threads;
      const wanted = new Set(projectIds);
      for (const project of shells) {
        if (wanted.has(project.id)) yield* checkProject(project, threads);
      }
      // Projects that are gone leave the view.
      for (const projectId of projectIds) {
        const state = byProject.get(projectId);
        if (state !== undefined && !shells.some((project) => project.id === projectId)) {
          byProject.delete(projectId);
          yield* PubSub.publish(changes, state.teamId);
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Team merge checks failed.", { cause })),
    );

  const batcher = yield* makeBatcher(MERGE_CHECK_DEBOUNCE, checkProjects);

  // Triggers: a turn ends, the team state changes, the base poll, and once at start.
  const eventSink = yield* EventSink.EventSinkV2;
  const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
  const checkpointsCaptured = eventSink.stream({
    afterSequence: fromSequence,
    eventType: "checkpoint.captured",
  });
  const onCheckpoint = ({ event }: OrchestrationV2StoredEvent) =>
    event.type === "checkpoint.captured" &&
    event.payload.runId !== null &&
    event.payload.status === "ready"
      ? orchestrator.getThreadShell(event.threadId).pipe(
          Effect.flatMap((shell) =>
            shell === null ? Effect.void : batcher.request(shell.projectId),
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.void;
  const requestAll = projects.listShells().pipe(
    Effect.flatMap((shells) => Effect.forEach(shells, (project) => batcher.request(project.id))),
    Effect.orElseSucceed(() => undefined),
  );
  /** Projects last seen in the team; a project never checked is covered by the start-up round. */
  const requestTeam = (teamId: TeamId) =>
    Effect.forEach(
      [...byProject].flatMap(([projectId, state]) => (state.teamId === teamId ? [projectId] : [])),
      batcher.request,
    );
  const requestActive = Effect.suspend(() =>
    Effect.forEach(
      [...byProject].flatMap(([projectId, state]) => (state.active ? [projectId] : [])),
      batcher.request,
    ),
  );
  const teamChanges = yield* teams.subscribeChanges;

  yield* forkParked(requestAll);
  yield* forkParked(Stream.runForEach(checkpointsCaptured, onCheckpoint));
  // A teammate's push reaches this server as a team state change. Unchanged pairs are not checked again.
  yield* forkParked(Stream.runForEach(Stream.fromSubscription(teamChanges), requestTeam));
  // The base moves without any team event. The delay sits outside the repeat, or each round waits twice.
  yield* forkParked(
    requestActive.pipe(
      Effect.repeat(Schedule.spaced(BASE_CHECK_INTERVAL)),
      Effect.delay(BASE_CHECK_INTERVAL),
    ),
  );

  const findPair = (projectId: ProjectId, threadId: ThreadId, other: TeamMergeOther) =>
    Effect.sync(() => {
      const pairs = byProject.get(projectId)?.pairs;
      if (pairs === undefined) return undefined;
      for (const checked of pairs.values()) {
        for (const pair of [checked.pair, swapChatPair(checked.pair)]) {
          if (pair === undefined || pair.mine.thread.threadId !== threadId) continue;
          if (pairKey(projectId, pair.mine, other) === pairKey(projectId, pair.mine, pair.other)) {
            return pair;
          }
        }
      }
      return undefined;
    });

  const useCommitUntilNextTurn = (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly repoRoot: string;
    readonly commit: string;
  }) =>
    // Kept in Git, so a restart still knows: `refs/t3-team/fixed/<thread>`, used while newer than the checkpoint.
    run(
      input.repoRoot,
      ["update-ref", `${FIXED_REFS}/${input.threadId}`, input.commit],
      "TeamMerging.fixed",
    ).pipe(
      Effect.andThen(batcher.request(input.projectId)),
      Effect.orElseSucceed(() => undefined),
    );

  const takeClashLine = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell === null) return undefined;
      const state = byProject.get(shell.projectId);
      if (state === undefined) return undefined;
      const seen = told.get(threadId) ?? new Set<string>();
      told.set(threadId, seen);
      const fresh = newClashes({
        pairs: state.pairs,
        threadId,
        sharedCheckout: shell.worktreePath === null,
        told: seen,
      });
      if (fresh.length === 0) return undefined;
      const members = yield* teams.listMembers(state.teamId).pipe(Effect.orElseSucceed(() => []));
      const names = new Map(
        members.map((member) => [member.memberId as string, member.displayName]),
      );
      return clashLine({
        pairs: fresh,
        threadId,
        nameOf: (memberId) => names.get(memberId) ?? memberId,
        solo: yield* teams.isSolo(state.teamId),
      });
    }).pipe(Effect.orElseSucceed(() => undefined));

  const placeOfProject = (projectId: ProjectId) =>
    projects.listShells().pipe(
      Effect.flatMap((shells) => {
        const project = shells.find((shell) => shell.id === projectId);
        return project === undefined
          ? Effect.succeed(Option.none<ProjectPlace>())
          : placeOf(project);
      }),
      Effect.orElseSucceed(() => Option.none<ProjectPlace>()),
    );

  const setCombined = (projectId: ProjectId, check: TeamCombinedCheck) =>
    Effect.gen(function* () {
      const teamId = byProject.get(projectId)?.teamId;
      const old = teamId === undefined ? "" : encodedView(teamId);
      combined.set(combinedKey(check.mineCommit, check.otherCommit), check);
      if (teamId !== undefined && encodedView(teamId) !== old) {
        yield* PubSub.publish(changes, teamId);
      }
    });

  const uninstall = installTeamTurnNote(takeClashLine);
  yield* Effect.addFinalizer(() => Effect.sync(uninstall));

  return TeamMergeCheck.of({
    forTeam: (teamId) => Effect.sync(() => teamView(teamId)),
    subscribeChanges: PubSub.subscribe(changes),
    request: batcher.request,
    findPair,
    useCommitUntilNextTurn,
    takeClashLine,
    placeOf: placeOfProject,
    setCombined,
    combinedOf: (pair) =>
      Effect.sync(() =>
        orientCombined(combined.get(combinedKey(pair.mine.commit, pair.other.commit)), pair),
      ),
  });
});

export const layer = Layer.effect(TeamMergeCheck, make);
