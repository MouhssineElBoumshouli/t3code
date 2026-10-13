import { describe, expect, it } from "vite-plus/test";

import { buildMergeFixPrompt, MERGE_FIX_PROMPT_CHARS } from "./mergeFixPrompt.ts";

const input = {
  other: "Sara's pushed branch `search`",
  conflicts: [{ path: "src/api/routes.ts", places: 2 }],
  mine: { who: "This chat", reasons: ["Trimmed the /search route's query before lookup."] },
  theirs: { who: "Sara", reasons: ["Added tag filtering to /search (task: Filter by tag)."] },
  decisions: ["`.team/decisions/routes.md`: Routes stay in one file."],
  check: "pnpm typecheck",
  savedWork: true,
};

describe("buildMergeFixPrompt", () => {
  it("names the files, both sides' reasons, decisions, the check and the rules", () => {
    const prompt = buildMergeFixPrompt(input);
    expect(prompt).toContain("A merge of Sara's pushed branch `search` into this copy");
    expect(prompt).toContain("this chat's uncommitted work was committed first");
    expect(prompt).toContain("- `src/api/routes.ts` (2 places)");
    expect(prompt).toContain("- This chat: Trimmed the /search route's query before lookup.");
    expect(prompt).toContain("- Sara: Added tag filtering to /search (task: Filter by tag).");
    expect(prompt).toContain("- `.team/decisions/routes.md`: Routes stay in one file.");
    expect(prompt).toContain("run `pnpm typecheck`");
    expect(prompt).toContain("Do not commit, push, abort the merge");
  });

  it("stays under the cap with both sides kept, dropping what does not fit", () => {
    const long = (side: string) =>
      Array.from({ length: 20 }, (_, index) => `${side} reason ${index} ${"x".repeat(300)}`);
    const prompt = buildMergeFixPrompt({
      ...input,
      conflicts: Array.from({ length: 14 }, (_, index) => ({
        path: `src/f${index}.ts`,
        places: 1,
      })),
      mine: { who: "This chat", reasons: long("mine") },
      theirs: { who: "Sara", reasons: long("theirs") },
    });
    expect(prompt.length).toBeLessThanOrEqual(MERGE_FIX_PROMPT_CHARS);
    expect(prompt).toContain("- This chat: mine reason 0");
    expect(prompt).toContain("- Sara: theirs reason 0");
    expect(prompt).not.toContain("reason 19");
    expect(prompt).toContain("- and 4 more");
    // The rules always fit.
    expect(prompt).toContain("Do not commit, push, abort the merge");
    expect(prompt.endsWith("</team_merge_fix>")).toBe(true);
  });

  it("without a check command or notes still says what to do", () => {
    const prompt = buildMergeFixPrompt({
      ...input,
      mine: { who: "This chat", reasons: [] },
      theirs: { who: "Sara", reasons: [] },
      decisions: [],
      check: undefined,
      savedWork: false,
    });
    expect(prompt).not.toContain("Why each side");
    expect(prompt).not.toContain("committed first");
    expect(prompt).toContain("usual typecheck or tests");
  });
});
