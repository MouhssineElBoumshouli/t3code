// @effect-diagnostics nodeBuiltinImport:off - synchronous Git and file setup for tests.
/**
 * The team service on its real store for tests: a local bare `origin` over
 * `file://` (real Git, no network), checkouts whose `origin` it is, and a
 * host that answers from fixed values.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EnvironmentId, TeamLogin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as GitTeamService from "../state/GitTeamService.ts";
import * as TeamHost from "../state/TeamHost.ts";
import * as TeamService from "../TeamService.ts";
import { git } from "./gitRepo.ts";

/** Who the test server signs in as; also the member's display name. */
export const TEST_TEAM_LOGIN = "Mouhssine";

export const TestTeamGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-state-git-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** A host where `login` is signed in with push access to a private repo. */
export const fakeTeamHost = (
  login: string | null,
  access: TeamHost.TeamHostRepoAccess = { status: "found", canPush: true, isPublic: false },
) =>
  TeamHost.TeamHost.of({
    login: () =>
      Effect.succeed(
        login === null
          ? { status: "signedOut", detail: "Not signed in." }
          : { status: "signedIn", login: login as TeamLogin, override: false },
      ),
    repoAccess: () => Effect.succeed(access),
    refChanged: () => Effect.die("not used in these tests"),
  });

/** A bare repo `origin.git` in `root`; returns its `file://` URL. */
export const makeTeamOrigin = (root: string) => {
  const origin = NodePath.join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", origin);
  // Not `file://${origin}`: a Windows path would give `file://C:\...`, which Git does not read.
  return NodeURL.pathToFileURL(origin).href;
};

/** Makes `folder` a Git repo, unless it is one, with `originUrl` as its `origin`. */
export const useTeamOrigin = (folder: string, originUrl: string) => {
  if (!NodeFS.existsSync(NodePath.join(folder, ".git"))) {
    git(folder, "init", "--quiet", "-b", "main");
  }
  const remotes = git(folder, "remote").split("\n");
  if (remotes.includes("origin")) git(folder, "remote", "set-url", "origin", originUrl);
  else git(folder, "remote", "add", "origin", originUrl);
};

/** The team service of one T3 server, on Git, with its state repos in `stateDirectory`. */
export const testTeamServiceLayer = (options: {
  readonly environmentId: EnvironmentId;
  readonly stateDirectory: string;
  readonly host?: TeamHost.TeamHost["Service"] | undefined;
}) =>
  Layer.effect(
    TeamService.TeamService,
    GitTeamService.make({
      environmentId: options.environmentId,
      stateDirectory: options.stateDirectory,
    }).pipe(
      Effect.provideService(TeamHost.TeamHost, options.host ?? fakeTeamHost(TEST_TEAM_LOGIN)),
    ),
  ).pipe(Layer.provide(TestTeamGitLayer));
