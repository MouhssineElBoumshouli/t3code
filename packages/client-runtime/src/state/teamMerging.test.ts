import {
  EnvironmentId,
  ProjectId,
  TeamClaimId,
  TeamId,
  TeamMemberId,
  type TeamCombinedCheck,
  type TeamFeedTeam,
  type TeamMergeFile,
  type TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCatchUp } from "./teamHome.ts";
import { fileHolders } from "./teamMarkers.ts";
import {
  combinedCheckOffered,
  combinedSentence,
  fileMergeMark,
  fixCheckSentence,
  fixIsForPair,
  foldedMergeLine,
  foldMergePairs,
  mergeFixBlocked,
  mergeFixSentence,
  mergeOrderSentence,
  mergePairPending,
  mergePairSentence,
  mergeUpdateOffer,
  mergeUpdateStoppedSentence,
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

  it("words a fix and matches it to its pair; the shared checkout cannot be fixed here", () => {
    const fix = {
      projectId: PROJECT,
      mine: pair().mine,
      other: pair().other,
      status: "working" as const,
      files: ["app/src/api/routes.ts"],
      savedWork: true,
      startedAt: "2026-10-13T10:01:00.000Z",
    };
    expect(fixIsForPair(fix, pair())).toBe(true);
    expect(fixIsForPair(fix, pair({ other: { _tag: "base", branch: "main", commit: "m1" } }))).toBe(
      false,
    );
    expect(mergeFixSentence(team([]), fix, "app")).toBe(
      'Your "login" chat and Sara\'s `search` branch: the agent is resolving the clash in `src/api/routes.ts`.',
    );
    expect(mergeFixSentence(team([]), { ...fix, status: "ready" }, "app")).toBe(
      "Your \"login\" chat and Sara's `search` branch: the agent's fix in `src/api/routes.ts` is ready. Read the diff in the chat, then approve or undo.",
    );
    expect(mergeFixSentence(team([]), { ...fix, status: "asking" }, "app")).toBe(
      'Your "login" chat and Sara\'s `search` branch: the agent is waiting for your answer about the clash in `src/api/routes.ts`. Reply in the chat.',
    );
    expect(mergeFixBlocked(pair())).toBeNull();
    expect(mergeFixBlocked(pair({ mine: { ...pair().mine, worktree: false } }))).toContain(
      "shared checkout",
    );
  });

  it("words the merge order from the pair's side", () => {
    expect(mergeOrderSentence(team([]), pair())).toBeNull();
    expect(
      mergeOrderSentence(team([]), pair({ order: { first: "other", reason: "checksGreen" } })),
    ).toBe("Merge Sara's `search` branch first; its checks are green.");
    expect(
      mergeOrderSentence(team([]), pair({ order: { first: "mine", reason: "earlier" } })),
    ).toBe('Merge your "login" chat first; it started earlier.');
    const chats = pair({
      other: { _tag: "chat", thread: SEARCH, title: "search", commit: "c1" },
      order: { first: "other", reason: "earlier" },
    });
    expect(mergeOrderSentence(team([]), chats)).toBe('Merge "search" first; it finished first.');
    expect(
      mergeOrderSentence(team([]), { ...chats, order: { first: "mine", reason: "tie" } }),
    ).toBe('Merge "login" first.');
  });

  it("offers an update on top of the base or the chat that goes first, never over a clash", () => {
    const onMain = pair({
      other: { _tag: "base", branch: "main", commit: "m1" },
      status: "clean",
      files: [],
      fileCount: 0,
      bothChanged: ["app/src/api/routes.ts"],
    });
    expect(mergeUpdateOffer(onMain)).toEqual({
      threadId: LOGIN.threadId,
      other: onMain.other,
      label: "Update my copy",
      blocked: null,
      anyway: false,
    });
    expect(mergeUpdateOffer({ ...onMain, bothChanged: [] })).toBeNull();
    expect(mergeUpdateOffer({ ...onMain, status: "clash" })).toBeNull();
    expect(
      mergeUpdateOffer({ ...onMain, mine: { ...onMain.mine, worktree: false } })?.blocked,
    ).toContain("shared checkout");
    // A teammate's branch merges first; the update comes on the base pair after.
    expect(mergeUpdateOffer({ ...onMain, other: pair().other })).toBeNull();

    const chats = pair({
      other: { _tag: "chat", thread: SEARCH, title: "search", commit: "c1" },
      status: "clean",
      files: [],
      fileCount: 0,
      bothChanged: ["app/src/greet.ts"],
      order: { first: "mine", reason: "earlier" },
    });
    // "login" finished first: "search" moves on top of it.
    expect(mergeUpdateOffer(chats)).toEqual({
      threadId: SEARCH.threadId,
      other: { _tag: "chat", thread: LOGIN, title: "login", commit: "a1" },
      label: 'Update "search" on top of "login"',
      blocked: null,
      anyway: false,
    });
    expect(
      mergeUpdateOffer({ ...chats, order: { first: "other", reason: "earlier" } })?.label,
    ).toBe('Update "login" on top of "search"');
    // A fix started from the other chat still belongs to the pair.
    const fix = {
      projectId: PROJECT,
      mine: { thread: SEARCH, title: "search", worktree: true, commit: "c1" },
      other: { _tag: "chat" as const, thread: LOGIN, title: "login", commit: "a1" },
      status: "working" as const,
      files: [],
      savedWork: false,
      startedAt: "2026-10-13T10:01:00.000Z",
    };
    expect(fixIsForPair(fix, chats)).toBe(true);
  });

  it("words the combined check, keeps its news unfolded, and offers Fix it and Update anyway", () => {
    const at = "2026-10-14T10:00:00.000Z";
    const clean = pair({
      status: "clean",
      files: [],
      fileCount: 0,
      bothChanged: [],
    });
    const withCheck = (combined: TeamCombinedCheck) => ({ ...clean, combined });
    const base = { mineCommit: "a1", otherCommit: "b1", errors: [], errorCount: 0, checkedAt: at };
    const renamed = withCheck({
      ...base,
      status: "broken",
      command: "npm run typecheck",
      errors: [
        {
          path: "app/src/api/me.ts",
          line: 3,
          message: "Cannot find name 'getUser'. Did you mean 'fetchUser'?",
          name: "getUser",
          suggestion: "fetchUser",
          side: "mine",
        },
      ],
      errorCount: 3,
    });
    const current = team([renamed]);
    expect(combinedSentence(current, renamed, "app")).toBe(
      "Combined with Sara's `search` branch, `getUser` is renamed (to `fetchUser`?) but still used in `src/api/me.ts` (yours). And 2 more new errors.",
    );
    expect(
      combinedSentence(
        current,
        withCheck({
          ...base,
          status: "broken",
          errors: [
            { path: "app/src/x.ts", message: "Type 'string' is not assignable.", side: "other" },
          ],
          errorCount: 1,
        }),
        "app",
      ),
    ).toBe(
      "Combined with Sara's `search` branch, a new error in `src/x.ts` (Sara's): Type 'string' is not assignable.",
    );
    expect(
      combinedSentence(current, withCheck({ ...base, status: "skipped", skip: "memory" }), "app"),
    ).toBe(
      "Combined with Sara's `search` branch: not checked, less than 1.5 GB of memory is free.",
    );
    expect(
      combinedSentence(
        current,
        withCheck({ ...base, status: "clean", command: "cargo check" }),
        "app",
      ),
    ).toBe("Combined with Sara's `search` branch, `cargo check` finds nothing new.");
    expect(combinedSentence(current, withCheck({ ...base, status: "running" }), "app")).toBe(
      "Combined with Sara's `search` branch: checking…",
    );
    expect(combinedSentence(current, clean, "app")).toBeNull();

    // A clean pair with news gets its own line; Fix it is open for new errors.
    expect(foldMergePairs([clean, renamed]).shown).toEqual([renamed]);
    expect(mergeFixBlocked(renamed)).toBeNull();
    expect(mergeFixBlocked(clean)).toBe("It merges cleanly.");
    expect(combinedCheckOffered(clean)).toBe(true);
    expect(combinedCheckOffered(withCheck({ ...base, status: "running" }))).toBe(false);
    expect(combinedCheckOffered(pair())).toBe(false);

    const onMain = {
      ...renamed,
      other: { _tag: "base" as const, branch: "main", commit: "b1" },
      bothChanged: ["app/src/api/routes.ts"],
    };
    expect(mergeUpdateOffer(onMain)).toMatchObject({ label: "Update anyway", anyway: true });
    expect(
      mergeUpdateOffer({ ...onMain, combined: { ...onMain.combined, status: "clean" } }),
    ).toMatchObject({ label: "Update my copy", anyway: false });
  });

  it("says an update stopped on a conflict, and words the check on a fix's result", () => {
    const onMain = pair({
      other: { _tag: "base", branch: "main", commit: "m1" },
      status: "clean",
      files: [],
      fileCount: 0,
      bothChanged: ["app/src/api/routes.ts"],
    });
    expect(mergeUpdateStoppedSentence(team([onMain]), onMain)).toBe(
      'Your "login" chat and `main`: the update stopped on a conflict, so nothing changed. Fix it lets the agent resolve it.',
    );

    const fix = {
      projectId: PROJECT,
      mine: onMain.mine,
      other: onMain.other,
      status: "ready" as const,
      files: [],
      savedWork: false,
      startedAt: "2026-10-14T10:01:00.000Z",
    };
    const check = {
      mineCommit: "a1",
      otherCommit: "m1",
      errors: [],
      errorCount: 0,
      checkedAt: "2026-10-14T10:02:00.000Z",
    };
    expect(fixCheckSentence(team([]), fix, "app")).toBeNull();
    expect(
      fixCheckSentence(team([]), { ...fix, check: { ...check, status: "running" } }, "app"),
    ).toBe("On the fix: checking…");
    expect(
      fixCheckSentence(
        team([]),
        { ...fix, check: { ...check, status: "clean", command: "npm run typecheck" } },
        "app",
      ),
    ).toBe("On the fix, `npm run typecheck` finds nothing new.");
    expect(
      fixCheckSentence(
        team([]),
        {
          ...fix,
          check: {
            ...check,
            status: "broken",
            errors: [
              {
                path: "app/src/api/count.ts",
                message: "Cannot find name 'searchPins'.",
                name: "searchPins",
                side: "mine",
              },
            ],
            errorCount: 1,
          },
        },
        "app",
      ),
    ).toBe("On the fix, `searchPins` is gone but still used in `src/api/count.ts` (yours).");
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
