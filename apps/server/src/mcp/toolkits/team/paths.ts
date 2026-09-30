import * as Effect from "effect/Effect";

import { TeamToolError } from "./tools.ts";

/** The part of a platform path module the conversion needs; `node:path` and effect's `Path` both fit. */
export interface TeamPathApi {
  readonly isAbsolute: (path: string) => boolean;
  readonly resolve: (...paths: ReadonlyArray<string>) => string;
  readonly relative: (from: string, to: string) => string;
}

export interface TeamPathRoots {
  /** The folder holding `.team/`; claims and handoff files are relative to it. */
  readonly teamRoot: string;
  /** The thread's checkout. Relative paths from the agent are relative to it. */
  readonly workingFolder: string;
}

const leavesRoot = (relative: string, path: TeamPathApi) =>
  relative === ".." || /^\.\.[\\/]/u.test(relative) || path.isAbsolute(relative);

/**
 * Turns the paths an agent sends (often full paths) into project-relative `/`
 * paths. A full path outside the project, or a relative one that climbs out
 * of it, is rejected with a message the agent can act on.
 */
export const toProjectPaths = (
  raws: ReadonlyArray<string>,
  roots: TeamPathRoots,
  path: TeamPathApi,
): Effect.Effect<ReadonlyArray<string>, TeamToolError> =>
  Effect.forEach(raws, (raw) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Effect.fail(
        new TeamToolError({ detail: "A path is empty. Remove it or name a file." }),
      );
    }
    const absolute = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(roots.workingFolder, trimmed);
    const relative = path.relative(roots.teamRoot, absolute);
    if (leavesRoot(relative, path)) {
      return Effect.fail(
        new TeamToolError({
          detail: `"${trimmed}" is outside this project (${roots.teamRoot}). Use paths inside it.`,
        }),
      );
    }
    return Effect.succeed(relative.replaceAll("\\", "/"));
  });
