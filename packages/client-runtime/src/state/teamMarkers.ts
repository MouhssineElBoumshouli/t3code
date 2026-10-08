/**
 * Who else holds a file or a thread's files (fork-only, team/UI_PLAN.md
 * slice 1), from the team feed. Web and mobile draw the same markers from it.
 *
 * - A teammate's claim always marks what it covers.
 * - The person's own chats mark a file only when two or more of them hold it
 *   (an overlap), so solo shows nothing until two chats collide.
 * - A thread is marked when its claims overlap a teammate's or another of
 *   the person's chats.
 *
 * Claim paths are relative to the team's root; a project's files are
 * relative to the project, which may sit in a folder of the repo
 * (`pathPrefix`). Case is ignored, as the server does.
 */
import {
  type EnvironmentId,
  type ProjectId,
  type TeamClaim,
  type TeamFeedTeam,
  type TeamMemberId,
  teamPathsOverlap,
  type TeamPlanHolder,
  type ThreadId,
} from "@t3tools/contracts";

export type TeamHolder =
  | {
      readonly kind: "member";
      readonly memberId: TeamMemberId;
      readonly name: string;
      readonly initials: string;
      readonly hue: number;
    }
  | {
      readonly kind: "chat";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly hue: number;
    };

export interface ProjectTeam {
  readonly team: TeamFeedTeam;
  readonly pathPrefix: string;
}

/** The team (or solo state) a project is in, if the server has it open. */
export function findProjectTeam(
  teams: ReadonlyArray<TeamFeedTeam>,
  projectId: ProjectId | null,
): ProjectTeam | null {
  if (projectId === null) return null;
  for (const team of teams) {
    const project = team.projects.find((candidate) => candidate.projectId === projectId);
    if (project !== undefined) return { team, pathPrefix: project.pathPrefix };
  }
  return null;
}

/** A stable hue for a person or a chat, so the same chip has the same color everywhere. */
export function holderHue(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Two letters for a chip: "Yassine Amrani" → "YA", "yassine" → "YA". */
export function holderInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s_-]+/u)
    .filter((word) => word.length > 0);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A claim path as the project names it: "" for the whole project, null when outside it. */
export function claimPathInProject(claimPath: string, pathPrefix: string): string | null {
  const path = claimPath.replace(/\/+$/u, "").toLowerCase();
  const prefix = pathPrefix.replace(/\/+$/u, "").toLowerCase();
  if (prefix === "") return path;
  if (path === prefix || prefix.startsWith(`${path}/`)) return "";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

/** Whether a claimed path (project-relative, lower case) covers a file or folder of the project. */
const covers = (claimed: string, path: string) =>
  claimed === "" || path === claimed || path.startsWith(`${claimed}/`);

const memberHolder = (team: TeamFeedTeam, memberId: TeamMemberId): TeamHolder => {
  const name = team.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
  return {
    kind: "member",
    memberId,
    name,
    initials: holderInitials(name),
    hue: holderHue(`member:${memberId}`),
  };
};

const chatHolder = (claim: TeamClaim): TeamHolder => ({
  kind: "chat",
  environmentId: claim.thread.environmentId,
  threadId: claim.thread.threadId,
  hue: holderHue(`chat:${claim.thread.environmentId}/${claim.thread.threadId}`),
});

const threadKey = (claim: TeamClaim) => `${claim.thread.environmentId}/${claim.thread.threadId}`;

const isMine = (team: TeamFeedTeam, claim: TeamClaim) => team.solo || claim.memberId === team.me;

/** Teammates first, then chats; one entry each. */
const uniqueHolders = (holders: ReadonlyArray<TeamHolder>) => {
  const seen = new Set<string>();
  const unique: Array<TeamHolder> = [];
  for (const holder of holders) {
    const key =
      holder.kind === "member"
        ? `member:${holder.memberId}`
        : `chat:${holder.environmentId}/${holder.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(holder);
  }
  // Not toSorted: mobile's Hermes does not have it. `sort` is stable.
  return unique.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "member" ? -1 : 1));
};

/**
 * Who else holds a file or folder of the project, seen from one thread
 * (null when no thread is open). Empty when nothing should be marked.
 */
export function fileHolders(
  projectTeam: ProjectTeam,
  path: string,
  viewing: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): ReadonlyArray<TeamHolder> {
  const { team, pathPrefix } = projectTeam;
  const target = path.replace(/\/+$/u, "").toLowerCase();
  const holding = team.claims.filter((claim) =>
    claim.paths.some((claimPath) => {
      const claimed = claimPathInProject(claimPath, pathPrefix);
      return claimed !== null && covers(claimed, target);
    }),
  );
  const teammates = holding.filter((claim) => !isMine(team, claim));
  const myChats = new Map(
    holding.filter((claim) => isMine(team, claim)).map((claim) => [threadKey(claim), claim]),
  );
  const viewingKey = viewing === null ? null : `${viewing.environmentId}/${viewing.threadId}`;
  const otherChats = myChats.size >= 2 ? [...myChats].filter(([key]) => key !== viewingKey) : [];
  return uniqueHolders([
    ...teammates.map((claim) => memberHolder(team, claim.memberId)),
    ...otherChats.map(([, claim]) => chatHolder(claim)),
  ]);
}

/** Who holds paths that overlap a thread's claims: teammates, and the person's other chats. */
export function threadHolders(
  team: TeamFeedTeam,
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ReadonlyArray<TeamHolder> {
  const key = `${thread.environmentId}/${thread.threadId}`;
  const mine = team.claims.filter((claim) => threadKey(claim) === key);
  if (mine.length === 0) return [];
  const paths = mine.flatMap((claim) => claim.paths);
  const overlapping = team.claims.filter(
    (claim) =>
      threadKey(claim) !== key &&
      claim.paths.some((other) => paths.some((path) => teamPathsOverlap(path, other))),
  );
  return uniqueHolders(
    overlapping.map((claim) =>
      isMine(team, claim) ? chatHolder(claim) : memberHolder(team, claim.memberId),
    ),
  );
}

/**
 * A plan card's holders (slice 2) as chips: the same color and initials as
 * the markers. The name is the one the server saw when it checked the plan.
 */
export function planHolders(holders: ReadonlyArray<TeamPlanHolder>): ReadonlyArray<TeamHolder> {
  return holders.map((holder) =>
    holder.kind === "member"
      ? {
          kind: "member",
          memberId: holder.memberId,
          name: holder.name,
          initials: holderInitials(holder.name),
          hue: holderHue(`member:${holder.memberId}`),
        }
      : {
          kind: "chat",
          environmentId: holder.thread.environmentId,
          threadId: holder.thread.threadId,
          hue: holderHue(`chat:${holder.thread.environmentId}/${holder.thread.threadId}`),
        },
  );
}

/** Teammates other than this server's person, for the presence chip. Empty when solo. */
export function teammatesOf(team: TeamFeedTeam) {
  if (team.solo) return [];
  return team.members
    .filter((member) => member.memberId !== team.me)
    .map((member) => ({
      member,
      initials: holderInitials(member.displayName),
      hue: holderHue(`member:${member.memberId}`),
      claims: team.claims.filter((claim) => claim.memberId === member.memberId),
      tasks: team.tasks.filter(
        (task) => task.ownerMemberId === member.memberId && task.status !== "todo",
      ),
    }));
}
