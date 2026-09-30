// @effect-diagnostics nodeBuiltinImport:off - the test needs both posix and win32 path rules.
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { toProjectPaths } from "./paths.ts";

const posixRoots = { teamRoot: "/work/app", workingFolder: "/work/app" };

describe("toProjectPaths", () => {
  it.effect("turns full paths inside the project into project-relative paths", () =>
    Effect.gen(function* () {
      const paths = yield* toProjectPaths(
        ["/work/app/src/auth/login.ts", "/work/app/docs/", "src/ui/button.tsx", "./README.md"],
        posixRoots,
        NodePath.posix,
      );
      assert.deepEqual(paths, ["src/auth/login.ts", "docs", "src/ui/button.tsx", "README.md"]);
    }),
  );

  it.effect("rejects full paths outside the project, and relative paths that climb out", () =>
    Effect.gen(function* () {
      for (const raw of ["/work/other/src/a.ts", "/work/app-old/a.ts", "../other/a.ts", ".."]) {
        const error = yield* toProjectPaths([raw], posixRoots, NodePath.posix).pipe(Effect.flip);
        assert.equal(error._tag, "TeamToolError");
        assert.include(error.message, "is outside this project (/work/app)");
      }
      const empty = yield* toProjectPaths(["  "], posixRoots, NodePath.posix).pipe(Effect.flip);
      assert.include(empty.message, "empty");
    }),
  );

  it.effect("resolves relative paths from the working folder when the team root is above it", () =>
    Effect.gen(function* () {
      const paths = yield* toProjectPaths(
        ["src/a.ts", "/repo/packages/web/b.ts", "../api/c.ts"],
        { teamRoot: "/repo", workingFolder: "/repo/packages/web" },
        NodePath.posix,
      );
      assert.deepEqual(paths, ["packages/web/src/a.ts", "packages/web/b.ts", "packages/api/c.ts"]);
    }),
  );

  it.effect("handles Windows paths, drive letters and mixed separators", () =>
    Effect.gen(function* () {
      const roots = { teamRoot: "C:\\work\\app", workingFolder: "C:\\work\\app" };
      const paths = yield* toProjectPaths(
        ["C:\\work\\app\\src\\a.ts", "c:/work/app/src/b.ts", "src\\c.ts"],
        roots,
        NodePath.win32,
      );
      assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
      const otherDrive = yield* toProjectPaths(["D:\\work\\app\\a.ts"], roots, NodePath.win32).pipe(
        Effect.flip,
      );
      assert.include(otherDrive.message, "is outside this project");
    }),
  );
});
