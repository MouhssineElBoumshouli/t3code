import { assert, describe, it } from "@effect/vitest";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { setWorktreeDefault } from "./TeamProjectFiles.ts";

const edited = (raw: string | null) => {
  const result = setWorktreeDefault(raw);
  assert.equal(result._tag, "Edited");
  return result as Extract<typeof result, { readonly _tag: "Edited" }>;
};

describe("setWorktreeDefault", () => {
  it("writes a new t3.json that T3 reads as worktree mode", () => {
    const result = edited(null);
    assert.equal(parseT3ProjectFile(result.contents)?.defaultThreadEnvMode, "worktree");
    assert.include(result.contents, '"$schema": "https://t3.codes/schema/t3.json"');
    assert.isUndefined(result.previous);
  });

  it("adds the field and leaves every other line as it was", () => {
    const raw = `{
    "$schema": "https://t3.codes/schema/t3.json",
    "scripts": [{ "name": "Setup", "command": "pnpm i", "runOnWorktreeCreate": true }]
}
`;
    const result = edited(raw);
    assert.equal(
      result.contents,
      `{
    "defaultThreadEnvMode": "worktree",
    "$schema": "https://t3.codes/schema/t3.json",
    "scripts": [{ "name": "Setup", "command": "pnpm i", "runOnWorktreeCreate": true }]
}
`,
    );
    const parsed = parseT3ProjectFile(result.contents);
    assert.equal(parsed?.defaultThreadEnvMode, "worktree");
    assert.equal(parsed?.scripts?.[0]?.command, "pnpm i");
  });

  it("keeps comments and trailing commas in a JSONC file", () => {
    const raw = `// Shared with the team.
{
  // Worktree setup
  "scripts": [
    { "name": "Setup", "command": "pnpm i", },
  ],
}
`;
    const result = edited(raw);
    assert.include(result.contents, "// Shared with the team.");
    assert.include(result.contents, "// Worktree setup");
    assert.include(result.contents, `{ "name": "Setup", "command": "pnpm i", },`);
    assert.equal(parseT3ProjectFile(result.contents)?.defaultThreadEnvMode, "worktree");
  });

  it("switches an explicit local setting to worktree and reports what it was", () => {
    const raw = `{ "defaultThreadEnvMode": "local", "iconPath": "logo.svg" }\n`;
    const result = edited(raw);
    assert.equal(
      result.contents,
      `{ "defaultThreadEnvMode": "worktree", "iconPath": "logo.svg" }\n`,
    );
    assert.equal(result.previous, "local");
  });

  it("fills an empty object", () => {
    const result = edited("{}\n");
    assert.equal(parseT3ProjectFile(result.contents)?.defaultThreadEnvMode, "worktree");
  });

  it("changes nothing when worktree mode is already set", () => {
    assert.deepEqual(setWorktreeDefault(`{"defaultThreadEnvMode":"worktree"}`), {
      _tag: "Unchanged",
    });
  });

  it("refuses files it cannot edit safely", () => {
    assert.equal(setWorktreeDefault("not json")._tag, "Invalid");
    assert.equal(setWorktreeDefault("[1, 2]")._tag, "Invalid");
    assert.equal(setWorktreeDefault("")._tag, "Invalid");
    // The only match for the key is in a comment, so the edit would not change the real value.
    assert.equal(
      setWorktreeDefault(`{
  // "defaultThreadEnvMode": "local" was the old default
  "defaultThreadEnvMode": "local"
}`)._tag,
      "Invalid",
    );
  });
});
