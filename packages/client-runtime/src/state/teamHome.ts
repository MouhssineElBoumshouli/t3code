/**
 * The Team home page and its solo "Today" (fork-only, team/UI_PLAN.md slice 4):
 * the "since you were last here" line, built from the team feed and the
 * project's chats, with no AI call. Web and mobile word it the same way.
 *
 * Times are ISO strings compared as instants. The caller keeps the last
 * visit; a first visit looks back one day.
 */
import type { TeamClaim, TeamFeedTeam, TeamMemberId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { claimPathInProject } from "./teamMarkers.ts";

/** One of the person's chats in the project, as the page needs it. */
export interface TeamHomeChat {
  /** `environmentId/threadId`, the key claims carry. */
  readonly key: string;
  readonly title: string;
  readonly working: boolean;
  /** A question, an approval or a team card waits on the person. */
  readonly awaitsYou: boolean;
  readonly completedAt: string | null;
}

export interface CatchUpInput {
  /** The project's team or solo state; null when the server has none open for it. */
  readonly team: TeamFeedTeam | null;
  readonly pathPrefix: string;
  readonly chats: ReadonlyArray<TeamHomeChat>;
  /** The previous visit to this page, or null for the first one. */
  readonly lastVisitAt: string | null;
  readonly now: string;
}

export interface CatchUp {
  /** Where the line starts counting from. */
  readonly since: string;
  /** True when there was no earlier visit and `since` is a day back. */
  readonly firstVisit: boolean;
  /** Short sentences, most useful first; empty when nothing happened. */
  readonly sentences: ReadonlyArray<string>;
}

const FIRST_VISIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_NAMED = 2;

const after = (at: string | null, since: number) => at !== null && Date.parse(at) > since;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "a, b", "a, b and 3 more". */
const listNames = (names: ReadonlyArray<string>) => {
  const shown = names.slice(0, MAX_NAMED);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
};

const quote = (title: string) => `"${title}"`;

const endSentence = (text: string) => (/[.!?…]$/u.test(text) ? text : `${text}.`);

/** A claim's paths as the project names them ("the whole project" for the root). */
export function claimPathsInProject(claim: TeamClaim, pathPrefix: string): ReadonlyArray<string> {
  return claim.paths.map((path) => {
    // Matched without case; shown as written.
    const inProject = claimPathInProject(path, pathPrefix);
    if (inProject === null) return path;
    if (inProject === "") return "the whole project";
    const trimmed = path.replace(/\/+$/u, "");
    return trimmed.slice(trimmed.length - inProject.length);
  });
}

const memberName = (team: TeamFeedTeam, memberId: TeamMemberId) =>
  team.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;

const chatKey = (claim: TeamClaim) => `${claim.thread.environmentId}/${claim.thread.threadId}`;

/** What changed since the last visit, in plain words. */
export function buildCatchUp(input: CatchUpInput): CatchUp {
  const nowMs = Date.parse(input.now);
  const lastVisitMs = input.lastVisitAt === null ? Number.NaN : Date.parse(input.lastVisitAt);
  const firstVisit = Number.isNaN(lastVisitMs);
  const sinceMs = firstVisit ? nowMs - FIRST_VISIT_LOOKBACK_MS : lastVisitMs;
  const sentences: Array<string> = [];
  const { team } = input;
  const solo = team === null || team.solo;
  const titles = new Map(input.chats.map((chat) => [chat.key, chat.title]));

  if (team !== null) {
    const newClaims = team.claims.filter((claim) => after(claim.claimedAt, sinceMs));
    if (!solo) {
      // Teammates' new work, one sentence per person.
      const byMember = new Map<TeamMemberId, Array<TeamClaim>>();
      for (const claim of newClaims) {
        if (claim.memberId === team.me) continue;
        byMember.set(claim.memberId, [...(byMember.get(claim.memberId) ?? []), claim]);
      }
      for (const [memberId, claims] of byMember) {
        const paths = claims.flatMap((claim) => claimPathsInProject(claim, input.pathPrefix));
        const ownBranch = claims.some((claim) => claim.branch !== undefined);
        sentences.push(
          `${memberName(team, memberId)} started on ${listNames(paths)}${ownBranch ? " (own branch, not merged yet)" : ""}.`,
        );
      }
      const handoffs = team.handoffs.filter(
        (handoff) => handoff.memberId !== team.me && after(handoff.createdAt, sinceMs),
      );
      for (const handoff of handoffs.slice(0, MAX_NAMED)) {
        sentences.push(
          endSentence(`${memberName(team, handoff.memberId)} wrote a handoff: ${handoff.headline}`),
        );
      }
      if (handoffs.length > MAX_NAMED) {
        sentences.push(`${plural(handoffs.length - MAX_NAMED, "more handoff")}.`);
      }
    } else {
      // Solo: which of the person's chats took on files.
      for (const claim of newClaims) {
        const title = titles.get(chatKey(claim));
        if (title === undefined) continue;
        sentences.push(
          `${quote(title)} started on ${listNames(claimPathsInProject(claim, input.pathPrefix))}.`,
        );
      }
    }

    const newTasks = team.tasks.filter((task) => after(task.createdAt, sinceMs));
    if (newTasks.length === 1) sentences.push(`New task: ${quote(newTasks[0]!.title)}.`);
    else if (newTasks.length > 1) sentences.push(`${plural(newTasks.length, "new task")}.`);
    const movedTasks = team.tasks.filter(
      (task) => !after(task.createdAt, sinceMs) && after(task.updatedAt, sinceMs),
    );
    if (movedTasks.length > 0) {
      sentences.push(`${plural(movedTasks.length, "task")} moved on.`);
    }
  }

  const finished = input.chats.filter(
    (chat) => !chat.working && !chat.awaitsYou && after(chat.completedAt, sinceMs),
  );
  if (finished.length > 0) {
    sentences.push(
      `${finished.length === 1 ? "Your chat" : `${finished.length} of your chats`} finished: ${listNames(finished.map((chat) => quote(chat.title)))}.`,
    );
  }
  const waiting = input.chats.filter((chat) => chat.awaitsYou);
  if (waiting.length > 0) {
    sentences.push(
      `${listNames(waiting.map((chat) => quote(chat.title)))} ${waiting.length === 1 ? "waits" : "wait"} for you.`,
    );
  }

  if (team !== null && (team.sync.status === "offline" || team.sync.status === "notFresh")) {
    sentences.push(
      team.sync.status === "offline"
        ? "The team's repo could not be reached, so this may miss the latest."
        : "The team state could not be read just now, so this may miss the latest.",
    );
  }

  return {
    since: firstVisit ? DateTime.formatIso(DateTime.makeUnsafe(sinceMs)) : input.lastVisitAt!,
    firstVisit,
    sentences,
  };
}
