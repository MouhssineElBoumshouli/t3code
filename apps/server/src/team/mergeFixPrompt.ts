/**
 * The message of a "Fix it" turn (fork-only, team/MERGE_HELP_PLAN.md section
 * 5): which files Git could not combine, why each side changed them (handoff
 * and automatic notes, claim notes, task titles), decisions on those files,
 * the errors the combined check found, the check command, and what not to do. Capped at about 600 tokens: the
 * files and the rules always fit; notes are added newest first until the cap.
 *
 * @module mergeFixPrompt
 */

/** About 600 tokens. */
export const MERGE_FIX_PROMPT_CHARS = 2_400;
const ITEM_CHARS = 220;
const LISTED_FILES = 10;

export interface MergeFixSide {
  /** "This chat", "Sara", "Your chat "B"". */
  readonly who: string;
  /** Why this side changed the files: notes, claim notes, task titles; most useful first. */
  readonly reasons: ReadonlyArray<string>;
}

export interface MergeFixPromptInput {
  /** "Sara's pushed branch `search`", "`main`", "your chat "B"". */
  readonly other: string;
  /** Files Git could not combine, relative to the chat's copy, with conflict places when known. */
  readonly conflicts: ReadonlyArray<{ readonly path: string; readonly places: number }>;
  readonly mine: MergeFixSide;
  readonly theirs: MergeFixSide;
  /** Decision files that name these files: "`.team/decisions/x.md`: says…". */
  readonly decisions: ReadonlyArray<string>;
  /** The rulebook's check command, if any. */
  readonly check: string | undefined;
  /** The chat's uncommitted work was committed first. */
  readonly savedWork: boolean;
  /** Errors the combined check found and neither side has alone: "`src/me.ts:3`: Cannot find name 'getUser'.". */
  readonly combinedErrors?: ReadonlyArray<string>;
}

const oneLine = (text: string) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= ITEM_CHARS ? line : `${line.slice(0, ITEM_CHARS - 1).trimEnd()}…`;
};

export function buildMergeFixPrompt(input: MergeFixPromptInput): string {
  const files = input.conflicts
    .slice(0, LISTED_FILES)
    .map((file) => `- \`${file.path}\`${file.places > 1 ? ` (${file.places} places)` : ""}`);
  if (input.conflicts.length > LISTED_FILES) {
    files.push(`- and ${input.conflicts.length - LISTED_FILES} more (\`git status\`)`);
  }
  const head = [
    `The user chose "Fix it" for a merge clash. A merge of ${input.other} into this copy is in progress (\`git merge --no-commit\`)${input.savedWork ? "; this chat's uncommitted work was committed first" : ""}.`,
    files.length > 0
      ? `Git could not combine:\n${files.join("\n")}`
      : "Git combined every file; check that both changes still work together.",
    ...((input.combinedErrors ?? []).length === 0
      ? []
      : [
          `Combined, the check finds errors neither side has alone:\n${(input.combinedErrors ?? [])
            .slice(0, LISTED_FILES)
            .map((error) => `- ${oneLine(error)}`)
            .join("\n")}`,
        ]),
    files.length > 0
      ? "Resolve every conflict so both sides' changes keep working."
      : "Make both sides' changes work together.",
  ];
  const tail = [
    input.check === undefined
      ? "Then run the project's usual typecheck or tests for these files if there are any."
      : `Then run \`${oneLine(input.check)}\` and fix what the merge broke.`,
    "Stage the files with `git add`. Do not commit, push, abort the merge or switch branches: the user reviews the diff and approves or undoes it in T3 Code. End with a short summary of how you combined the two sides.",
  ];
  const open = "<team_merge_fix>";
  const close = "</team_merge_fix>";
  const fixed = [open, ...head, ...tail, close].join("\n").length;

  // Reasons alternate between the sides, so neither crowds out the other; decisions after.
  const optional: Array<{ readonly section: "why" | "decisions"; readonly line: string }> = [];
  const longest = Math.max(input.mine.reasons.length, input.theirs.reasons.length);
  for (let index = 0; index < longest; index++) {
    for (const side of [input.mine, input.theirs]) {
      const reason = side.reasons[index];
      if (reason !== undefined) {
        optional.push({ section: "why", line: `- ${side.who}: ${oneLine(reason)}` });
      }
    }
  }
  for (const decision of input.decisions) {
    optional.push({ section: "decisions", line: `- ${oneLine(decision)}` });
  }
  const why: Array<string> = [];
  const decisions: Array<string> = [];
  const headings = { why: "Why each side changed them:", decisions: "Decisions on these files:" };
  let used = fixed;
  for (const item of optional) {
    const list = item.section === "why" ? why : decisions;
    const cost = item.line.length + 1 + (list.length === 0 ? headings[item.section].length + 1 : 0);
    if (used + cost > MERGE_FIX_PROMPT_CHARS) continue;
    used += cost;
    list.push(item.line);
  }
  return [
    open,
    ...head,
    ...(why.length === 0 ? [] : [`${headings.why}\n${why.join("\n")}`]),
    ...(decisions.length === 0 ? [] : [`${headings.decisions}\n${decisions.join("\n")}`]),
    ...tail,
    close,
  ].join("\n");
}
