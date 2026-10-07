import {
  EnvironmentId,
  ProjectId,
  TeamClaimId,
  TeamId,
  TeamMemberId,
  type TeamFeedTeam,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  claimPathInProject,
  fileHolders,
  findProjectTeam,
  holderInitials,
  teammatesOf,
  threadHolders,
} from "./teamMarkers.ts";

const ENV = EnvironmentId.make("env-1");
const PROJECT = ProjectId.make("project-1");
const thread = (id: string) => ({ environmentId: ENV, threadId: ThreadId.make(id) });

const claim = (memberId: string, threadId: string, paths: ReadonlyArray<string>) => ({
  claimId: TeamClaimId.make(`${memberId}-${threadId}-${paths.join(",")}`),
  teamId: TeamId.make("team-1"),
  memberId: TeamMemberId.make(memberId),
  thread: thread(threadId),
  paths,
  note: null,
  claimedAt: "2026-10-07T10:00:00.000Z",
  releasedAt: null,
});

const team = (
  input: Partial<TeamFeedTeam> & { readonly claims: TeamFeedTeam["claims"] },
): TeamFeedTeam => ({
  teamId: TeamId.make("team-1"),
  name: "Core",
  solo: false,
  projects: [{ projectId: PROJECT, pathPrefix: "" }],
  me: TeamMemberId.make("mouhssine"),
  members: [
    {
      memberId: TeamMemberId.make("mouhssine"),
      teamId: TeamId.make("team-1"),
      displayName: "mouhssine",
      role: "owner",
      lastSeenAt: "2026-10-07T10:00:00.000Z",
    },
    {
      memberId: TeamMemberId.make("yassine-a"),
      teamId: TeamId.make("team-1"),
      displayName: "Yassine Amrani",
      role: "member",
      lastSeenAt: "2026-10-07T10:00:00.000Z",
    },
  ],
  tasks: [],
  handoffs: [],
  sync: { status: "synced", unshared: false, readAt: null },
  ...input,
});

const kinds = (holders: ReturnType<typeof fileHolders>) =>
  holders.map((holder) => (holder.kind === "member" ? holder.initials : holder.threadId));

describe("team markers", () => {
  it("marks a teammate's file and everything under a claimed folder, whatever the case", () => {
    const projectTeam = findProjectTeam(
      [team({ claims: [claim("yassine-a", "their-thread", ["src/Auth"])] })],
      PROJECT,
    )!;
    expect(kinds(fileHolders(projectTeam, "src/auth/login.ts", thread("mine")))).toEqual(["YA"]);
    expect(kinds(fileHolders(projectTeam, "src/auth", thread("mine")))).toEqual(["YA"]);
    // A parent folder is not marked for one claim inside it: no false alarms.
    expect(fileHolders(projectTeam, "src", thread("mine"))).toEqual([]);
    expect(fileHolders(projectTeam, "src/authz.ts", thread("mine"))).toEqual([]);
  });

  it("solo: marks a file only when two of the person's chats hold it", () => {
    const one = findProjectTeam(
      [team({ solo: true, me: TeamMemberId.make("me"), claims: [claim("me", "a", ["src/x.ts"])] })],
      PROJECT,
    )!;
    expect(fileHolders(one, "src/x.ts", thread("b"))).toEqual([]);
    expect(teammatesOf(one.team)).toEqual([]);

    const two = findProjectTeam(
      [
        team({
          solo: true,
          me: TeamMemberId.make("me"),
          claims: [claim("me", "a", ["src/x.ts"]), claim("me", "b", ["src/"])],
        }),
      ],
      PROJECT,
    )!;
    // Seen from chat a: chat b also holds it. From a third chat: both.
    expect(kinds(fileHolders(two, "src/x.ts", thread("a")))).toEqual(["b"]);
    expect(kinds(fileHolders(two, "src/x.ts", thread("c")))).toEqual(["a", "b"]);
    expect(kinds(threadHolders(two.team, thread("a")))).toEqual(["b"]);
    expect(threadHolders(two.team, thread("c"))).toEqual([]);
  });

  it("maps claim paths into a project that is a folder of the repo", () => {
    expect(claimPathInProject("packages/web/src/a.ts", "packages/web")).toBe("src/a.ts");
    expect(claimPathInProject("packages", "packages/web")).toBe("");
    expect(claimPathInProject("packages/api/x.ts", "packages/web")).toBeNull();
    const projectTeam = findProjectTeam(
      [
        team({
          projects: [{ projectId: PROJECT, pathPrefix: "packages/web" }],
          claims: [claim("yassine-a", "t", ["packages/web/src/a.ts", "packages/api/b.ts"])],
        }),
      ],
      PROJECT,
    )!;
    expect(kinds(fileHolders(projectTeam, "src/a.ts", null))).toEqual(["YA"]);
    expect(fileHolders(projectTeam, "b.ts", null)).toEqual([]);
  });

  it("marks a thread whose claims overlap a teammate's, and lists teammates with what they hold", () => {
    const feedTeam = team({
      claims: [
        claim("mouhssine", "mine", ["src/auth/login.ts"]),
        claim("yassine-a", "theirs", ["src/auth/"]),
        claim("yassine-a", "other", ["docs/"]),
      ],
    });
    expect(kinds(threadHolders(feedTeam, thread("mine")))).toEqual(["YA"]);
    const [yassine] = teammatesOf(feedTeam);
    expect(yassine?.initials).toBe("YA");
    expect(yassine?.claims.map((held) => held.paths)).toEqual([["src/auth/"], ["docs/"]]);
  });

  it("makes two-letter initials", () => {
    expect(holderInitials("Yassine Amrani")).toBe("YA");
    expect(holderInitials("sara")).toBe("SA");
    expect(holderInitials("jean-luc")).toBe("JL");
  });
});
