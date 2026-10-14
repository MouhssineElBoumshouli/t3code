import { assert, describe, it } from "@effect/vitest";

import {
  CheckOutput,
  COMBINE_MIN_FREE_BYTES,
  detectCheckCommand,
  installCommand,
  missingName,
  newErrors,
  runGate,
  startGate,
} from "./combineCheck.ts";

const read = (text: string, folder = "/copy") => {
  const output = new CheckOutput(folder);
  // In two chunks, split mid-line, as a pipe delivers it.
  const middle = Math.floor(text.length / 2);
  output.write(text.slice(0, middle));
  output.write(text.slice(middle));
  output.end();
  return output;
};

describe("combineCheck", () => {
  it("reads tsc, path:line and Rust errors, with paths relative to the copy", () => {
    const output = read(
      [
        "> demo@1.0.0 typecheck",
        "src/api/me.ts(3,10): error TS2724: '\"../user\"' has no exported member named 'getUser'. Did you mean 'fetchUser'?",
        "/copy/src/b.ts:12:5: error: something broke",
        "./cmd/main.go:7:2: undefined: Thing",
        "error[E0425]: cannot find value `total` in this scope",
        "  --> src/main.rs:4:13",
        "error: could not compile `demo` (bin) due to 1 previous error",
        "Found 1 error.",
      ].join("\n"),
    );
    assert.deepEqual(
      output.errors.map((error) => [error.path, error.line, error.code]),
      [
        ["src/api/me.ts", 3, "TS2724"],
        ["src/b.ts", 12, undefined],
        ["cmd/main.go", 7, undefined],
        ["src/main.rs", 4, "E0425"],
      ],
    );
    assert.equal(output.errors[1]!.message, "something broke");
    assert.equal(output.tail.length, 8);
  });

  it("reads Windows paths with spaces", () => {
    const output = read(
      "C:\\Users\\Sara Lee\\combine\\p1\\src\\me.ts(3,10): error TS2304: Cannot find name 'getUser'.\r\n",
      "C:\\Users\\Sara Lee\\combine\\p1",
    );
    assert.equal(output.errors[0]!.path, "src/me.ts");
  });

  it("reports only errors that neither side has alone", () => {
    const error = (path: string, message: string) => ({
      path,
      line: 1,
      code: "TS2304",
      message,
    });
    const onMain = error("src/old.ts", "Cannot find name 'legacy'.");
    const mineOnly = error("src/mine.ts", "Type 'string' is not assignable to type 'number'.");
    const renamed = error("src/api/me.ts", "Cannot find name 'getUser'.");
    const combined = [
      onMain,
      mineOnly,
      { ...renamed, line: 3 },
      // The same error once more than either side has it: the extra one is new.
      { ...renamed, line: 9 },
    ];
    const fresh = newErrors(combined, [onMain, mineOnly, renamed], [onMain]);
    assert.deepEqual(
      fresh.map((found) => [found.path, found.line]),
      [["src/api/me.ts", 9]],
    );
    // Lines move in a merge; an old error on another line is still old.
    assert.deepEqual(newErrors([{ ...onMain, line: 40 }], [], [onMain]), []);
    assert.deepEqual(newErrors([renamed], [], []), [renamed]);
  });

  it("names a missing name and the suggestion", () => {
    assert.deepEqual(missingName("Cannot find name 'getUser'. Did you mean 'fetchUser'?"), {
      name: "getUser",
      suggestion: "fetchUser",
    });
    assert.deepEqual(missingName("Module '\"../user\"' has no exported member 'getUser'."), {
      name: "getUser",
    });
    assert.deepEqual(missingName("cannot find value `total` in this scope"), { name: "total" });
    assert.equal(missingName("Type 'string' is not assignable to type 'number'."), undefined);
  });

  it("finds the command: typecheck script, tsc, cargo, go; else none", () => {
    const has = (files: ReadonlyArray<string>) => (file: string) => files.includes(file);
    const scripts = JSON.stringify({ scripts: { typecheck: "tsc -b" } });
    assert.equal(
      detectCheckCommand({ packageJson: scripts, has: has(["pnpm-lock.yaml"]) }),
      "pnpm run typecheck",
    );
    assert.equal(detectCheckCommand({ packageJson: scripts, has: has([]) }), "npm run typecheck");
    assert.equal(
      detectCheckCommand({ packageJson: "{}", has: has(["tsconfig.json"]) }),
      "npx --no -- tsc --noEmit",
    );
    assert.equal(
      detectCheckCommand({ packageJson: undefined, has: has(["Cargo.toml"]) }),
      "cargo check",
    );
    assert.equal(
      detectCheckCommand({ packageJson: undefined, has: has(["go.mod"]) }),
      "go vet ./...",
    );
    assert.equal(detectCheckCommand({ packageJson: "not json", has: has([]) }), undefined);
    assert.equal(installCommand({ packageJson: "{}", has: has(["package-lock.json"]) }), "npm ci");
    assert.equal(installCommand({ packageJson: "{}", has: has([]) }), undefined);
    assert.equal(installCommand({ packageJson: undefined, has: has(["yarn.lock"]) }), undefined);
  });

  it("gates: one at a time, no turn running, enough memory; then a command and installed dependencies", () => {
    const free = COMBINE_MIN_FREE_BYTES;
    assert.equal(startGate({ busy: false, turnRunning: false, freeBytes: free }), undefined);
    assert.equal(startGate({ busy: true, turnRunning: true, freeBytes: 0 }), "busy");
    assert.equal(startGate({ busy: false, turnRunning: true, freeBytes: free }), "turnRunning");
    assert.equal(startGate({ busy: false, turnRunning: false, freeBytes: free - 1 }), "memory");

    const command = "npm run typecheck";
    assert.equal(
      runGate({ command: undefined, dependenciesChanged: false, install: true }),
      "noCommand",
    );
    // Before an update, changed dependencies are not installed; "Check now" installs them.
    assert.equal(runGate({ command, dependenciesChanged: true, install: false }), "dependencies");
    assert.equal(runGate({ command, dependenciesChanged: true, install: true }), undefined);
    assert.equal(runGate({ command, dependenciesChanged: false, install: false }), undefined);
  });
});
