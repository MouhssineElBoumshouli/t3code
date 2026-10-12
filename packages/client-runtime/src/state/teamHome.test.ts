import {
  EnvironmentId,
  TeamClaimId,
  TeamHandoffId,
  TeamId,
  TeamMemberId,
  TeamTaskId,
  type TeamFeedTeam,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCatchUp, claimPathsInProject, type TeamHomeChat } from "./teamHome.ts";

const ENV = EnvironmentId.make("env-1");
const LAST_VISIT = "2026-10-12T08:00:00.000Z";
const NOW = "2026-10-12T12:00:00.000Z";
const BEFORE = "2026-10-12T07:00:00.000Z";
const SINCE = "2026-10-12T09:00:00.000Z";

const member = (memberId: string, displayName: string) => ({
  memberId: TeamMemberId.make(memberId),
  teamId: TeamId.make("team-1"),
  displayName,
  role: "member" as const,
  lastSeenAt: SINCE,
});

const claim = (
  memberId: string,
  threadId: string,
  paths: ReadonlyArray<string>,
  claimedAt: string,
  extra: { readonly branch?: string } = {},
) => ({
  claimId: TeamClaimId.make(`${memberId}-${threadId}`),
  teamId: TeamId.make("team-1"),
  memberId: TeamMemberId.make(memberId),
  thread: { environmentId: ENV, threadId: ThreadId.make(threadId) },
  paths,
  note: null,
  claimedAt,
  releasedAt: null,
  ...(extra.branch === undefined ? {} : { branch: extra.branch }),
});

const handoff = (id: string, memberId: string, headline: string, createdAt: string) => ({
  handoffId: TeamHandoffId.make(id),
  memberId: TeamMemberId.make(memberId),
  thread: { environmentId: ENV, threadId: ThreadId.make(`${memberId}-thread`) },
  headline,
  files: [],
  createdAt,
});

const task = (id: string, title: string, createdAt: string, updatedAt = createdAt) => ({
  taskId: TeamTaskId.make(id),
  teamId: TeamId.make("team-1"),
  title,
  status: "todo" as const,
  note: null,
  paths: [],
  ownerMemberId: null,
  thread: null,
  createdAt,
  updatedAt,
});

const team = (input: Partial<TeamFeedTeam> = {}): TeamFeedTeam => ({
  teamId: TeamId.make("team-1"),
  name: "Core",
  solo: false,
  projects: [],
  me: TeamMemberId.make("me"),
  members: [member("me", "Mouhssine"), member("sara", "Sara"), member("yassine", "Yassine")],
  claims: [],
  tasks: [],
  handoffs: [],
  sync: { status: "synced", unshared: false, readAt: null },
  ...input,
});

const chat = (id: string, title: string, overrides: Partial<TeamHomeChat> = {}): TeamHomeChat => ({
  key: `${ENV}/${id}`,
  title,
  working: false,
  awaitsYou: false,
  completedAt: null,
  ...overrides,
});

const catchUp = (input: {
  readonly team?: TeamFeedTeam | null;
  readonly chats?: ReadonlyArray<TeamHomeChat>;
  readonly lastVisitAt?: string | null;
}) =>
  buildCatchUp({
    team: input.team === undefined ? team() : input.team,
    pathPrefix: "",
    chats: input.chats ?? [],
    lastVisitAt: input.lastVisitAt === undefined ? LAST_VISIT : input.lastVisitAt,
    now: NOW,
  });

describe("buildCatchUp", () => {
  it("tells what teammates started and wrote since the last visit, not before, not mine", () => {
    const result = catchUp({
      team: team({
        claims: [
          claim("yassine", "login", ["src/auth", "src/api/session.ts"], SINCE, { branch: "login" }),
          claim("sara", "old", ["src/old.ts"], BEFORE),
          claim("me", "mine", ["src/search"], SINCE),
        ],
        handoffs: [
          handoff("h1", "sara", "Avatar upload works, resizing is left", SINCE),
          handoff("h0", "sara", "Old note", BEFORE),
          handoff("h2", "me", "My own note", SINCE),
        ],
      }),
    });
    expect(result.firstVisit).toBe(false);
    expect(result.since).toBe(LAST_VISIT);
    expect(result.sentences).toEqual([
      "Yassine started on src/auth and src/api/session.ts (own branch, not merged yet).",
      "Sara wrote a handoff: Avatar upload works, resizing is left.",
    ]);
  });

  it("counts new and moved tasks, and caps long lists", () => {
    expect(catchUp({ team: team({ tasks: [task("t1", "Dark mode", SINCE)] }) }).sentences).toEqual([
      'New task: "Dark mode".',
    ]);
    const result = catchUp({
      team: team({
        tasks: [
          task("t1", "A", SINCE),
          task("t2", "B", SINCE),
          task("t3", "C", BEFORE, SINCE),
          task("t4", "D", BEFORE),
        ],
        claims: [claim("sara", "s", ["a.ts", "b.ts", "c.ts", "d.ts"], SINCE)],
        handoffs: [
          handoff("h1", "sara", "One.", SINCE),
          handoff("h2", "sara", "Two", SINCE),
          handoff("h3", "yassine", "Three", SINCE),
          handoff("h4", "yassine", "Four", SINCE),
        ],
      }),
    });
    expect(result.sentences).toEqual([
      "Sara started on a.ts, b.ts and 2 more.",
      "Sara wrote a handoff: One.",
      "Sara wrote a handoff: Two.",
      "2 more handoffs.",
      "2 new tasks.",
      "1 task moved on.",
    ]);
  });

  it("names the person's chats that finished or wait for them", () => {
    const result = catchUp({
      chats: [
        chat("a", "Search page", { completedAt: SINCE }),
        chat("b", "Fix paging", { completedAt: SINCE, awaitsYou: true }),
        chat("c", "Old", { completedAt: BEFORE }),
        chat("d", "Running", { working: true, completedAt: SINCE }),
      ],
    });
    expect(result.sentences).toEqual([
      'Your chat finished: "Search page".',
      '"Fix paging" waits for you.',
    ]);
  });

  it("solo: names chats that took on files, never teammates", () => {
    const solo = team({
      solo: true,
      me: null,
      members: [],
      claims: [
        claim("local", "a", ["src/search"], SINCE),
        claim("local", "gone", ["src/x.ts"], SINCE),
      ],
      sync: { status: "solo", unshared: false, readAt: null },
    });
    const result = catchUp({ team: solo, chats: [chat("a", "Search page")] });
    expect(result.sentences).toEqual(['"Search page" started on src/search.']);
  });

  it("looks back a day on a first visit, and says when the team state is not fresh", () => {
    const result = catchUp({
      lastVisitAt: null,
      team: team({
        handoffs: [handoff("h1", "sara", "Yesterday evening", "2026-10-11T18:00:00.000Z")],
        sync: { status: "offline", unshared: false, readAt: BEFORE },
      }),
    });
    expect(result.firstVisit).toBe(true);
    expect(result.since).toBe("2026-10-11T12:00:00.000Z");
    expect(result.sentences).toEqual([
      "Sara wrote a handoff: Yesterday evening.",
      "The team's repo could not be reached, so this may miss the latest.",
    ]);
  });

  it("is empty when nothing happened, with or without a team state", () => {
    expect(catchUp({}).sentences).toEqual([]);
    expect(
      catchUp({ team: null, chats: [chat("a", "Old", { completedAt: BEFORE })] }).sentences,
    ).toEqual([]);
  });
});

describe("claimPathsInProject", () => {
  it("shows paths as written, relative to the project folder", () => {
    const held = claim("sara", "s", ["README.md", "app/Src/Login.ts/", "other/x.ts", "app"], SINCE);
    expect(claimPathsInProject(held, "")).toEqual([
      "README.md",
      "app/Src/Login.ts",
      "other/x.ts",
      "app",
    ]);
    expect(claimPathsInProject(held, "app")).toEqual([
      "README.md",
      "Src/Login.ts",
      "other/x.ts",
      "the whole project",
    ]);
  });
});
