import { assert, describe, it } from "@effect/vitest";

import { folderKey } from "./folders.ts";

describe("folderKey", () => {
  it("makes Windows spellings of one folder equal", () => {
    const keys = ["C:\\Code\\App", "c:/code/app", "c:\\code\\app\\", "C:/Code/App/"].map((folder) =>
      folderKey(folder, "win32"),
    );
    assert.deepEqual(new Set(keys).size, 1);
    assert.equal(folderKey("C:\\", "win32"), "c:\\");
    assert.notEqual(folderKey("C:\\code\\app", "win32"), folderKey("C:\\code\\app2", "win32"));
  });

  it("keeps case elsewhere, and drops only a trailing slash", () => {
    assert.equal(folderKey("/home/me/App/", "linux"), "/home/me/App");
    assert.notEqual(folderKey("/home/me/App", "linux"), folderKey("/home/me/app", "linux"));
    assert.equal(folderKey("/", "linux"), "/");
  });
});
