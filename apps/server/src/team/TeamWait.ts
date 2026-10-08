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
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTeamResolver } from "../mcp/toolkits/team/resolve.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { holdersOf, sameThread } from "./heldElsewhere.ts";
import * as TeamChoices from "./TeamChoices.ts";
import { type CopyMove, moveCopyOnto } from "./teamCopy.ts";
import * as TeamService from "./TeamService.ts";

export const WAIT_CHECK_INTERVAL = "15 seconds";

const sameHolder = (a: TeamPlanHolder, b: TeamPlanHolder) =>
  a.kind === "member"
    ? b.kind === "member" && a.memberId === b.memberId
    : b.kind === "chat" && sameThread(a.thread, b.thread);

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const choices = yield* TeamChoices.TeamChoices;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;

  /** Moves a clean worktree on top of the fetched base branch (`origin/HEAD`, else `origin/main`). */
  const updateCopy = (folder: string, paths: ReadonlyArray<string>) =>
    moveCopyOnto(git, {
      folder,
      fetch: ["origin"],
      onto: (run) =>
        run(["rev-parse", "--abbrev-ref", "origin/HEAD"]).pipe(
          Effect.map((head) => (head.exitCode === 0 ? head.stdout.trim() : "origin/main")),
        ),
      paths,
      operation: "TeamWait.updateCopy",
    });

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

      const folder = shell.worktreePath;
      const copy: CopyMove =
        !context.solo && folder !== null
          ? yield* updateCopy(
              folder,
              card.files.map((file) =>
                path.relative(folder, path.join(context.teamRoot, file.path)).replaceAll("\\", "/"),
              ),
            )
          : { status: "unavailable" };
      return yield* choices.endWait({
        threadId: card.threadId,
        choiceId: card.choiceId,
        outcome: copy.status === "conflict" ? "conflict" : "done",
        text: TeamChoices.waitDoneInstruction(
          card.files,
          copy.status === "updated"
            ? { status: "updated", base: copy.onto, touched: copy.touched }
            : { status: "unknown" },
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
