/**
 * The team HTTP API on the host (team/DESIGN.md 7.1 M2.2): its own
 * `HttpApiBuilder.layer`, behind the same session middleware as the
 * environment API, mounted in `makeRoutesLayer` with one `team-layer:` line.
 *
 * Nothing here reads the host's disk, Git, threads, terminals or providers;
 * `security.test.ts` fails if a file in this folder imports them (S3).
 */
import {
  AuthTeamReadScope,
  AuthTeamWriteScope,
  TeamHttpApi,
  TeamHttpInternalError,
  TeamJoinRefusedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  environmentAuthenticatedAuthLayer,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import * as TeamInvites from "../TeamInvites.ts";
import { requireTeamMember } from "./guard.ts";
import * as TeamSessionMembers from "./TeamSessionMembers.ts";

export const teamHttpApiLayer = HttpApiBuilder.group(
  TeamHttpApi,
  "team",
  Effect.fnUntraced(function* (handlers) {
    const members = yield* TeamSessionMembers.TeamSessionMembers;
    const invites = yield* TeamInvites.TeamInvites;
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
        "join",
        // The one handler without `requireTeamMember`: this is how a session
        // made from an invite gets its member. Name and role come from the
        // invite, the invite from the session's subject; the body only says
        // which environment is joining (S7, S8).
        Effect.fn("team.http.join")(function* (args) {
          yield* annotateEnvironmentRequest("team.join");
          const session = yield* requireEnvironmentScope(AuthTeamWriteScope);
          const inviteId = TeamInvites.inviteIdFromSubject(session.subject);
          if (Option.isNone(inviteId)) {
            return yield* new TeamJoinRefusedError({
              code: "team_join_refused",
              reason: "not_an_invite",
            });
          }
          return yield* invites
            .join({
              inviteId: inviteId.value,
              sessionId: session.sessionId,
              environmentId: args.payload.environmentId,
            })
            .pipe(
              Effect.catchTag("TeamJoinRefused", (refused) =>
                Effect.fail(
                  new TeamJoinRefusedError({ code: "team_join_refused", reason: refused.reason }),
                ),
              ),
              Effect.catchIf(
                (error) => error._tag !== "TeamJoinRefusedError",
                (cause) =>
                  Effect.logError("team api join failed", { cause }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new TeamHttpInternalError({
                          code: "internal_error",
                          reason: "team_join_failed",
                        }),
                      ),
                    ),
                  ),
              ),
            );
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
  Layer.provide(Layer.provideMerge(TeamSessionMembers.layer, TeamInvites.layer)),
);
