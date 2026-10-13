import {
  EnvironmentId,
  ProjectId,
  TeamClaimId,
  TeamId,
  TeamMemberId,
  type TeamFeedTeam,
  type TeamMergeFile,
  type TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCatchUp } from "./teamHome.ts";
import { fileHolders } from "./teamMarkers.ts";
import {
  fileMergeMark,
  foldedMergeLine,
  foldMergePairs,
  mergePairPending,
  mergePairSentence,
  projectMergePairs,
  viewerMergePairs,
} from "./teamMerging.ts";

const ENV = EnvironmentId.make("env-1");
const PROJECT = ProjectId.make("project-1");
const LOGIN = { environmentId: ENV, threadId: ThreadId.make("login") };
const SEARCH = { environmentId: ENV, threadId: ThreadId.make("search") };

const file = (path: string, places = 1, regenerate = false): TeamMergeFile => ({
  path,
  places,
  regenerate,
});

const pair = (overrides: Partial<TeamMergePair> = {}): TeamMergePair => ({
  projectId: PROJECT,
  mine: { thread: LOGIN, title: "login", worktree: true, commit: "a1" },
  other: { _tag: "branch", memberId: TeamMemberId.make("sara"), branch: "search", commit: "b1" },
  status: "clash",
  files: [file("app/src/api/routes.ts", 2)],
  fileCount: 1,
  bothChanged: [],
  previous: null,
  since: "2026-10-13T10:00:00.000Z",
  checkedAt: "2026-10-13T10:00:30.000Z",
  ...overrides,
});

const team = (pairs: ReadonlyArray<TeamMergePair>, solo = false): TeamFeedTeam => ({
  teamId: TeamId.make("team-1"),
  name: "Notes",
  solo,
  projects: [{ projectId: PROJECT, pathPrefix: "app" }],
  me: TeamMemberId.make("me"),
  members: [
    {
      memberId: TeamMemberId.make("sara"),
      teamId: TeamId.make("team-1"),
      displayName: "Sara",
      role: "member",
      lastSeenAt: "2026-10-13T10:00:00.000Z",
    },
  ],
  claims: [
    {
      claimId: TeamClaimId.make("c1"),
      teamId: TeamId.make("team-1"),
      memberId: TeamMemberId.make("sara"),
      thread: { environmentId: EnvironmentId.make("env-2"), threadId: ThreadId.make("s1") },
      paths: ["app/src/api/me.ts"],
      note: null,
      branch: "search",
      pushedCommit: "b1",
      claimedAt: "2026-10-13T09:00:00.000Z",
      releasedAt: null,
    },
  ],
  tasks: [],
  handoffs: [],
  merging: { pairs },
  sync: { status: "synced", unshared: false, readAt: null },
});

describe("teamMerging", () => {
  it("words a clash with its places, in the project's paths", () => {
    expect(mergePairSentence(team([]), pair(), "app")).toBe(
      'Your "login" chat and Sara\'s `search` branch clash in 2 places in `src/api/routes.ts`.',
    );
    expect(
      mergePairSentence(
        team([]),
        pair({
          files: [
            file("app/a.ts"),
            file("app/b.ts"),
            file("app/c.ts"),
            file("app/pnpm-lock.yaml", 1, true),
          ],
          fileCount: 5,
        }),
        "app",
      ),
    ).toBe(
      'Your "login" chat and Sara\'s `search` branch clash in 4 files: `a.ts`, `b.ts` and 2 more. Regenerate `pnpm-lock.yaml` after merging.',
    );
  });

  it("says regenerate for lockfiles only, never clash", () => {
    expect(
      mergePairSentence(
        team([]),
        pair({
          status: "regenerate",
          other: { _tag: "base", branch: "main", commit: "m1" },
          files: [file("app/pnpm-lock.yaml", 1, true)],
        }),
        "app",
      ),
    ).toBe(
      'Your "login" chat and `main` both changed `pnpm-lock.yaml`: regenerate it after merging.',
    );
  });

  it("words solo pairs and clean ones", () => {
    const solo = pair({
      other: { _tag: "chat", thread: SEARCH, title: "search", commit: "c1" },
      files: [file("app/greet.ts")],
    });
    expect(mergePairSentence(team([], true), solo, "app")).toBe(
      'Your chats "login" and "search" clash in `greet.ts`.',
    );
    expect(
      mergePairSentence(team([]), pair({ status: "clean", files: [], fileCount: 0 }), ""),
    ).toBe('Your "login" chat and Sara\'s `search` branch merge cleanly.');
    expect(
      mergePairSentence(
        team([]),
        pair({ status: "clean", files: [], fileCount: 0, previous: "clash" }),
        "",
      ),
    ).toBe('Your "login" chat and Sara\'s `search` branch merge cleanly now.');
  });

  it("gives a clean pair a line only when both sides changed the same file", () => {
    const shared = pair({
      status: "clean",
      files: [],
      fileCount: 0,
      bothChanged: ["app/greet.ts"],
    });
    const quiet = pair({
      status: "clean",
      files: [],
      fileCount: 0,
      mine: { ...pair().mine, title: "quiet" },
    });
    const clash = pair();
    const { shown, folded } = foldMergePairs([clash, shared, quiet]);
    expect(shown).toEqual([clash, shared]);
    expect(folded).toEqual([quiet]);
    expect(mergePairSentence(team([]), shared, "app")).toBe(
      'Your "login" chat and Sara\'s `search` branch both changed `greet.ts` and merge cleanly.',
    );
    expect(foldedMergeLine(4, false)).toBe("4 other pairs merge cleanly");
    expect(foldedMergeLine(1, true)).toBe("1 pair merges cleanly");
  });

  it("says when a teammate pushed again since the check", () => {
    const current = team([pair()]);
    expect(mergePairPending(current, pair())).toBeNull();
    expect(
      mergePairPending(
        current,
        pair({
          other: {
            _tag: "branch",
            memberId: TeamMemberId.make("sara"),
            branch: "search",
            commit: "b0",
          },
        }),
      ),
    ).toBe("Sara pushed since; checking…");
  });

  it("marks the clashing file, and lets a holder's mark go quiet when their branch merges cleanly", () => {
    const clash = pair();
    const clean = pair({
      mine: { thread: SEARCH, title: "search", worktree: false, commit: "x" },
      status: "clean",
      files: [],
      fileCount: 0,
    });
    const projectTeam = { team: team([clash, clean]), pathPrefix: "app" };
    const pairs = projectMergePairs(projectTeam.team, PROJECT);
    // Viewing the login chat: only its pairs.
    const login = viewerMergePairs(pairs, { ...LOGIN, sharedCheckout: false });
    expect(login).toEqual([clash]);
    expect(
      fileMergeMark({ pairs: login, pathPrefix: "app", path: "src/api/routes.ts", holders: [] })
        ?.clashes.length,
    ).toBe(1);
    // A chat in the shared checkout sees the checkout's pairs.
    const shared = viewerMergePairs(pairs, { ...SEARCH, sharedCheckout: true });
    const holders = fileHolders(projectTeam, "src/api/me.ts", SEARCH);
    expect(
      fileMergeMark({ pairs: shared, pathPrefix: "app", path: "src/api/me.ts", holders })?.clean,
    ).toEqual([clean]);
    expect(
      fileMergeMark({ pairs: shared, pathPrefix: "app", path: "src/x.ts", holders: [] }),
    ).toBeNull();
  });

  it("tells new clashes and ended ones since the last visit, not old or plain clean pairs", () => {
    const pairs = [
      pair(),
      pair({ since: "2026-10-12T10:00:00.000Z", mine: { ...pair().mine, title: "old" } }),
      pair({ status: "clean", files: [], fileCount: 0, mine: { ...pair().mine, title: "fine" } }),
      pair({
        status: "clean",
        files: [],
        fileCount: 0,
        previous: "clash",
        mine: { ...pair().mine, title: "fixed" },
      }),
    ];
    const catchUp = buildCatchUp({
      team: team(pairs),
      projectId: PROJECT,
      pathPrefix: "app",
      chats: [],
      lastVisitAt: "2026-10-13T09:00:00.000Z",
      now: "2026-10-13T11:00:00.000Z",
    });
    expect(catchUp.sentences).toEqual([
      'Your "login" chat and Sara\'s `search` branch clash in 2 places in `src/api/routes.ts`.',
      'Your "fixed" chat and Sara\'s `search` branch merge cleanly now.',
    ]);
  });
});
