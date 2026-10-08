import { assert, describe, it } from "@effect/vitest";

import { TEAM_RULEBOOK_TEMPLATE } from "../../../team/TeamProjectFiles.ts";
import {
  isSharedPath,
  readDoNotTouchSection,
  readSharedFilesSection,
  TEAM_DO_NOT_TOUCH_LIMITS,
} from "./rulebook.ts";

const RULEBOOK_PATH = ".team/rulebook.md";

const rulebook = (section: string) =>
  [
    "# Project rulebook",
    "",
    "## Code rules",
    "",
    "- Keep auth code in `src/auth/`.",
    "",
    section,
    "",
    "## Decisions",
    "",
    "- Not part of the list.",
  ].join("\n");

describe("readDoNotTouchSection", () => {
  it("lists the section's items, and nothing from the sections around it", () => {
    const markdown = rulebook(
      [
        "## Do not touch",
        "",
        "- `data/`: the sample data. A human updates it.",
        "* `migrations/`",
        "1. `.github/workflows/`",
      ].join("\n"),
    );
    assert.deepEqual(readDoNotTouchSection(markdown, RULEBOOK_PATH), [
      "`data/`: the sample data. A human updates it.",
      "`migrations/`",
      "`.github/workflows/`",
    ]);
  });

  it("gives nothing without the section, with an empty one, or for the template", () => {
    assert.deepEqual(readDoNotTouchSection(rulebook(""), RULEBOOK_PATH), []);
    assert.deepEqual(readDoNotTouchSection(rulebook("## Do not touch\n"), RULEBOOK_PATH), []);
    assert.deepEqual(readDoNotTouchSection("", RULEBOOK_PATH), []);
    // `t3 team init` writes an example line there; it is not a rule.
    assert.deepEqual(readDoNotTouchSection(TEAM_RULEBOOK_TEMPLATE, RULEBOOK_PATH), []);
  });

  it("joins wrapped lines, keeps paragraphs, and reads subheadings' items", () => {
    const markdown = [
      "## Don't touch ##",
      "",
      "- `infra/`: owned by the platform team,",
      "  ask in #infra first.",
      "",
      "Never edit generated files",
      "by hand.",
      "",
      "### Secrets",
      "",
      "- `.env*`",
      "",
      "```",
      "- not/an/item",
      "```",
      "",
      "## Decisions",
      "",
      "- Not part of the list.",
    ].join("\n");
    assert.deepEqual(readDoNotTouchSection(markdown, RULEBOOK_PATH), [
      "`infra/`: owned by the platform team, ask in #infra first.",
      "Never edit generated files by hand.",
      "`.env*`",
    ]);
  });

  it("ends a deeper section at the next heading of its level or higher", () => {
    const markdown = "### Do not touch\n\n- `data/`\n\n## Next\n\n- `src/`";
    assert.deepEqual(readDoNotTouchSection(markdown, RULEBOOK_PATH), ["`data/`"]);
  });

  it("caps the list and each item, pointing to the rulebook for the rest", () => {
    const count = TEAM_DO_NOT_TOUCH_LIMITS.items + 3;
    const markdown = rulebook(
      [
        "## Do not touch",
        "",
        `- ${"long ".repeat(60).trim()}`,
        ...Array.from({ length: count - 1 }, (_, index) => `- \`folder-${index}/\``),
      ].join("\n"),
    );
    const list = readDoNotTouchSection(markdown, "../../.team/rulebook.md");
    assert.lengthOf(list, TEAM_DO_NOT_TOUCH_LIMITS.items);
    assert.lengthOf(list[0]!, TEAM_DO_NOT_TOUCH_LIMITS.itemCharacters);
    assert.isTrue(list[0]!.endsWith("…"));
    assert.equal(
      list.at(-1),
      `+${count - TEAM_DO_NOT_TOUCH_LIMITS.items + 1} more in ../../.team/rulebook.md`,
    );
  });
});

describe("readSharedFilesSection", () => {
  it("reads each item's path: its first code span, else its first word", () => {
    const markdown = rulebook(
      [
        "## Shared files",
        "",
        "- `src/api/routes.ts`: everyone adds routes here.",
        "- ./src/styles/, the global styles",
        "- `config\\app.json`",
      ].join("\n"),
    );
    const shared = readSharedFilesSection(markdown);
    assert.deepEqual(shared, ["src/api/routes.ts", "src/styles", "config/app.json"]);
    assert.isTrue(isSharedPath("src/api/routes.ts", shared));
    assert.isTrue(isSharedPath("src/styles/Theme.css", shared));
    assert.isTrue(isSharedPath("SRC/API/routes.ts", shared));
    // A folder holding a shared file is not shared itself, nor is a look-alike.
    assert.isFalse(isSharedPath("src/api", shared));
    assert.isFalse(isSharedPath("src/styles-old/a.css", shared));
  });

  it("gives nothing without the section, or for the template's example line", () => {
    assert.deepEqual(readSharedFilesSection(rulebook("")), []);
    assert.deepEqual(readSharedFilesSection(TEAM_RULEBOOK_TEMPLATE), []);
  });
});
