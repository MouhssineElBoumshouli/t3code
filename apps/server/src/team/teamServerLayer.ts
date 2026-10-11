/**
 * The team layer on a running server (fork-only, team/V2_PORT_PLAN.md): one
 * `team-layer:` line in `server.ts` adds it.
 *
 * Gives the server the team state (`TeamService`), each chat's cards, the
 * warning card's hold (`TeamChoices`), the team feed and "Ask" for `ws.ts` and
 * the team tools, and starts the background work: the briefing resolver, the
 * guard, claim release, automatic notes, the stale-view line, waits, questions,
 * pushed branches, the warm-up and card cleanup.
 *
 * @module teamServerLayer
 */
import * as Layer from "effect/Layer";

import { TeamBriefingLive } from "../mcp/toolkits/team/briefing.ts";
import * as GitTeamService from "./state/GitTeamService.ts";
import { TeamAutoNotesLive } from "./TeamAutoNotes.ts";
import * as TeamCards from "./TeamCards.ts";
import * as TeamCardsCleanup from "./TeamCardsCleanup.ts";
import * as TeamChoices from "./TeamChoices.ts";
import { TeamClaimAutoReleaseLive } from "./TeamClaimAutoRelease.ts";
import * as TeamFeed from "./TeamFeed.ts";
import { TeamGuardLive } from "./TeamGuard.ts";
import { TeamPushedBranchesLive } from "./TeamPushedBranches.ts";
import * as TeamQuestions from "./TeamQuestions.ts";
import { TeamStaleViewLive } from "./TeamStaleView.ts";
import { TeamWaitLive } from "./TeamWait.ts";
import * as TeamWarmup from "./TeamWarmup.ts";

export const layer = Layer.mergeAll(
  TeamBriefingLive,
  TeamClaimAutoReleaseLive,
  TeamAutoNotesLive,
  TeamGuardLive,
  TeamStaleViewLive,
  TeamWaitLive,
  TeamPushedBranchesLive,
  TeamCardsCleanup.layer,
  TeamWarmup.layer,
  TeamFeed.layer,
).pipe(
  Layer.provideMerge(TeamQuestions.layer),
  Layer.provideMerge(TeamChoices.layer),
  Layer.provideMerge(TeamCards.layer),
  Layer.provideMerge(GitTeamService.layer),
);
