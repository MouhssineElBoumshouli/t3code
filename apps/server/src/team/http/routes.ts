/**
 * The team HTTP API on the host (team/DESIGN.md 7.1 M2.2): its own
 * `HttpApiBuilder.layer`, behind the same session middleware as the
 * environment API, mounted in `makeRoutesLayer` with one `team-layer:` line.
 *
 * Nothing here reads the host's disk, Git, threads, terminals or providers;
 * `security.test.ts` fails if a file in this folder imports them (S3).
 */
import { AuthTeamReadScope, TeamHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, environmentAuthenticatedAuthLayer } from "../../auth/http.ts";
import { requireTeamMember } from "./guard.ts";
import * as TeamSessionMembers from "./TeamSessionMembers.ts";

export const teamHttpApiLayer = HttpApiBuilder.group(
  TeamHttpApi,
  "team",
  Effect.fnUntraced(function* (handlers) {
    const members = yield* TeamSessionMembers.TeamSessionMembers;
    return handlers
      .handle(
        "me",
        Effect.fn("team.http.me")(function* () {
          yield* annotateEnvironmentRequest("team.me");
          const { team, member } = yield* requireTeamMember(members, AuthTeamReadScope);
          return { team, member };
        }),
      )
      .handle(
        "board",
        Effect.fn("team.http.board")(function* (args) {
          yield* annotateEnvironmentRequest("team.board");
          const { team } = yield* requireTeamMember(members, AuthTeamReadScope, args.params.teamId);
          return {
            teamId: team.teamId,
            placeholder: true as const,
            note: "The team board over HTTP arrives in M2.5.",
          };
        }),
      );
  }),
);

export const teamHttpRoutesLayer = HttpApiBuilder.layer(TeamHttpApi).pipe(
  Layer.provide(teamHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provide(TeamSessionMembers.layer),
);
