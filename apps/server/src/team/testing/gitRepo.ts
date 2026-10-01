// @effect-diagnostics nodeBuiltinImport:off - synchronous Git and file setup for tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Runs Git in `cwd` for test setup and returns its trimmed output. */
export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** Writes `contents` to `file` under `root`, making folders as needed. */
export const writeFile = (root: string, file: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, file), contents);
};

/** A repo on `main` with `files` in one commit; returns that commit. */
export const initRepo = (root: string, files: Readonly<Record<string, string>>) => {
  git(root, "init", "--quiet", "-b", "main");
  for (const [file, contents] of Object.entries(files)) writeFile(root, file, contents);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  return git(root, "rev-parse", "HEAD");
};

/** Commits everything in `root` and returns the new commit. */
export const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
};
