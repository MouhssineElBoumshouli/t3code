/**
 * Comparing folders the way the OS does (team/WINDOWS_AND_SOLO.md W8): two
 * spellings of one folder (`C:\Code\x` and `c:/code/x/`, or a link and its
 * target) are the same checkout. Used to tell whether two threads share a
 * checkout, and to key a project's solo state.
 *
 * @module folders
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A folder as one string to compare: without a trailing separator, and on
 * Windows in lower case with `\`. Resolve links first ({@link realFolder})
 * when the folder exists.
 */
export const folderKey = (folder: string, platform: NodeJS.Platform) => {
  const windows = platform === "win32";
  let key = windows ? folder.replaceAll("/", "\\") : folder;
  while (key.length > 1 && /[\\/]$/u.test(key) && !/^[A-Za-z]:\\$/u.test(key)) {
    key = key.slice(0, -1);
  }
  return windows ? key.toLowerCase() : key;
};

/** The folder with links resolved; as given (resolved) when it cannot be read. */
export const realFolder = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(folder);
    return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  });
