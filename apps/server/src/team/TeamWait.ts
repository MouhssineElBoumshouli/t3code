/**
 * "Wait" on the warning card (fork-only, team/PREVENTION_PLAN.md section 2,
 * slice 3c). The click only records the wait (`TeamChoices.choose`); this
 * watcher ends it.
 *
 * Every {@link WAIT_CHECK_INTERVAL}, for each card that waits: when none of
 * the holders named on the card still holds any of its files, the wait is
 * over. A holder lets go when their chat's work merges, the chat is archived,
 * or it finds another way (`TeamClaimAutoRelease`, the team poller brings a
 * teammate's release here). Holders who claimed the files after the card was
 * shown are not waited for: the user chose to wait for these people.
 *
 * Team, in this chat's own worktree with no uncommitted changes: the copy is
 * moved on top of the fetched `origin/<base>` (a rebase, so committed work
 * stays). A conflict aborts the rebase and the card tells the user; no turn
 * starts. Uncommitted changes or the shared checkout are left as they are.
 * Then a turn continues the task. A chat busy with a turn is checked again
 * later.
 *
 * @module TeamWait
 */
import type { TeamPlanHolder, TeamChoiceActivityPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTeamResolver } from "../mcp/toolkits/team/resolve.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { holdersOf, sameThread } from "./heldElsewhere.ts";
import * as TeamChoices from "./TeamChoices.ts";
import * as TeamService from "./TeamService.ts";

export const WAIT_CHECK_INTERVAL = "15 seconds";

const GIT_TIMEOUT_MS = 60_000;

const sameHolder = (a: TeamPlanHolder, b: TeamPlanHolder) =>
  a.kind === "member"
    ? b.kind === "member" && a.memberId === b.memberId
    : b.kind === "chat" && sameThread(a.thread, b.thread);

export type CopyUpdate =
  | { readonly status: "updated"; readonly base: string }
  | { readonly status: "unknown" }
  | { readonly status: "conflict"; readonly base: string };

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const choices = yield* TeamChoices.TeamChoices;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: "TeamWait.updateCopy",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  /** Moves a clean worktree on top of the fetched base branch. */
  const updateCopy = (folder: string) =>
    Effect.gen(function* () {
      const status = yield* run(folder, ["status", "--porcelain"]);
      const unknown: CopyUpdate = { status: "unknown" };
      if (status.exitCode !== 0 || status.stdout.trim().length > 0) return unknown;
      if ((yield* run(folder, ["fetch", "--quiet", "origin"])).exitCode !== 0) return unknown;
      const head = yield* run(folder, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
      const base = head.exitCode === 0 ? head.stdout.trim() : "origin/main";
      if ((yield* run(folder, ["rev-parse", "--verify", "--quiet", base])).exitCode !== 0) {
        return unknown;
      }
      if ((yield* run(folder, ["rebase", "--quiet", base])).exitCode === 0) {
        return { status: "updated", base } satisfies CopyUpdate as CopyUpdate;
      }
      yield* run(folder, ["rebase", "--abort"]);
      return { status: "conflict", base } satisfies CopyUpdate as CopyUpdate;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team wait could not update the copy.", { folder, cause }).pipe(
          Effect.as<CopyUpdate>({ status: "unknown" }),
        ),
      ),
    );

  /** Ends the card's wait if its holders let go; true when it ended. */
  const checkCard = (card: TeamChoiceActivityPayload) =>
    Effect.gen(function* () {
      const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(card.threadId));
      if (shell === undefined || shell.archivedAt !== null) return false;
      if (shell.latestTurn?.state === "running") return false;
      const resolved = yield* resolve({ environmentId, threadId: card.threadId });
      if (resolved._tag === "NotInTeam") return false;
      const { context } = resolved;
      const teamId = context.teamFile.teamId;
      const [claims, members] = yield* Effect.all([
        teams.listActiveClaims(teamId),
        teams.listMembers(teamId),
      ]);
      const others = claims.filter((claim) => !sameThread(claim.thread, context.thread));
      const names = new Map(members.map((member) => [member.memberId, member.displayName]));
      const viewer = { memberId: context.member.memberId, solo: context.solo };
      const stillHeld = card.files.some((file) => {
        const now = holdersOf(file.path, others, viewer, names);
        return file.holders.some((was) => now.some((is) => sameHolder(was, is)));
      });
      if (stillHeld) return false;

      const copy: CopyUpdate =
        !context.solo && shell.worktreePath !== null
          ? yield* updateCopy(shell.worktreePath)
          : { status: "unknown" };
      return yield* choices.endWait({
        threadId: card.threadId,
        choiceId: card.choiceId,
        outcome: copy.status === "conflict" ? "conflict" : "done",
        text: TeamChoices.waitDoneInstruction(
          card.files,
          copy.status === "updated" ? copy : { status: "unknown" },
        ),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Team wait check skipped a card.", {
          choiceId: card.choiceId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  /** One round over every waiting card; returns the cards whose wait ended. */
  const checkWaits = Effect.gen(function* () {
    const cards = yield* choices.waitingCards;
    const ended: Array<string> = [];
    for (const card of cards) {
      if (yield* checkCard(card)) ended.push(card.choiceId);
    }
    if (ended.length > 0) yield* Effect.logInfo("Team waits ended.", { choiceIds: ended });
    return ended;
  });

  return { checkWaits, updateCopy };
});

export const TeamWaitLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { checkWaits } = yield* make;
    yield* forkParked(
      checkWaits.pipe(Effect.repeat(Schedule.spaced(WAIT_CHECK_INTERVAL)), Effect.asVoid),
    );
  }),
);
