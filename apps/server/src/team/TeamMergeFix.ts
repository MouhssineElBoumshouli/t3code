/**
 * "Fix it" for a merge clash (fork-only, team/MERGE_HELP_PLAN.md section 5).
 *
 * - Start: in the pair's chat (its own worktree; never the shared checkout),
 *   Git starts merging the other side's checked commit without committing
 *   (`mergeFixGit`), and a turn asks the agent to resolve the conflicts, with
 *   why each side changed those files and the rulebook's check command
 *   (`mergeFixPrompt`). The other side's branch is only read.
 * - Asking: the agent waits for the person: a question during its turn, or
 *   the turn ended with conflict markers still in a file. Open chat, or Undo.
 * - Ready: the turn ended. The person reads the diff in the chat, then:
 *   - Approve: commit the merge, push when the branch has an upstream, and
 *     tell a teammate whose branch was merged with a team note.
 *   - Undo: back to the state before the fix.
 *
 * Update (MERGE_HELP_PLAN.md sections 4 and 6): once the other side is first
 * (the base after a merge, or the chat that finished first), it is merged into
 * a chat's own worktree, as Wait does (`teamCopy`): never while its turn runs
 * or with uncommitted changes. A merge that stops on a conflict is aborted
 * and the person is sent to "Fix it".
 * Before it moves, the combined check runs once (`TeamCombineCheck`); new
 * errors, or a check that could not run, stop it until the person chooses
 * "Update anyway". "Check now" starts that check on its own.
 *
 * When a fix's turn ends and the chat's copy has no dependencies installed (a
 * `package.json` without `node_modules`), the agent could not run the check,
 * so it runs once on the fix's result in the combine copy
 * (`TeamCombineCheck.checkResult`) and shows on the fix's line. Approve does
 * not wait for it.
 *
 * Fixes waiting are kept in `<stateDir>/team/merge-fixes.json`, so a restart
 * still offers Approve and Undo. The team feed shows them (`forTeam`).
 *
 * @module TeamMergeFix
 */
import {
  CommandId,
  MessageId,
  type ProjectId,
  type TeamCombinedCheck,
  type TeamId,
  type TeamMemberId,
  type TeamMergeFix as TeamMergeFixView,
  TeamMergeFixError,
  type TeamMergeFixInput,
  type TeamMergeFixResult,
  TeamMergeMine,
  TeamMergeOther,
  type TeamMergePair,
  type TeamThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readDecisions } from "../mcp/toolkits/team/memory.ts";
import { makeTeamResolver } from "../mcp/toolkits/team/resolve.ts";
import { readCheckCommand } from "../mcp/toolkits/team/rulebook.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { sameThread } from "./heldElsewhere.ts";
import { approveMerge, startMerge, undoMerge, workingTree } from "./mergeFixGit.ts";
import { moveCopyOnto } from "./teamCopy.ts";
import { buildMergeFixPrompt, type MergeFixSide } from "./mergeFixPrompt.ts";
import { diffToTeamPaths } from "./TeamAutoNotes.ts";
import * as TeamCombineCheck from "./TeamCombineCheck.ts";
import * as TeamMergeCheck from "./TeamMergeCheck.ts";
import { findRepoRoot } from "./TeamProjectFiles.ts";
import * as TeamService from "./TeamService.ts";

/** Notes read per fix, newest first. */
const NOTES_READ = 100;
const FILES_IN_TEAM_NOTE = 3;
/** A conflict marker line, as Git writes it. */
const CONFLICT_MARKER = /^(<<<<<<<|>>>>>>>)( |$)/mu;

const StoredFix = Schema.Struct({
  teamId: Schema.String,
  projectId: Schema.String,
  threadId: ThreadId,
  /** The chat's worktree. */
  folder: Schema.String,
  /** The project's own checkout, where the other sides' refs live. */
  repoRoot: Schema.String,
  mine: TeamMergeMine,
  other: TeamMergeOther,
  /** Conflicting files: relative to the worktree, and to the team's root. */
  conflicts: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  headBefore: Schema.String,
  savedWork: Schema.NullOr(Schema.String),
  /** The chat's latest run when the fix started: a newer one that ended is the fix's turn. */
  runBefore: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
});
type StoredFix = typeof StoredFix.Type;

const FixesFile = Schema.Struct({ version: Schema.Literal(1), fixes: Schema.Array(StoredFix) });
const FixesFileJson = Schema.fromJsonString(FixesFile);
const encodeFixesFile = Schema.encodeEffect(FixesFileJson);
const decodeFixesFile = Schema.decodeUnknownEffect(FixesFileJson);

export class TeamMergeFix extends Context.Service<
  TeamMergeFix,
  {
    /** Start, approve or undo, as this server's person. */
    readonly act: (
      input: TeamMergeFixInput,
    ) => Effect.Effect<TeamMergeFixResult, TeamMergeFixError>;
    /** The team's fixes waiting for their turn or for the person. */
    readonly forTeam: (teamId: TeamId) => Effect.Effect<ReadonlyArray<TeamMergeFixView>>;
    /** A team's fixes changed. */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<TeamId>, never, Scope.Scope>;
  }
>()("t3/team/TeamMergeFix") {}

const fail = (detail: string) => Effect.fail(new TeamMergeFixError({ detail }));

/** How the other side is named: in the prompt, the commit message and the chat. */
export const otherSideWords = (other: TeamMergeOther, nameOf: (memberId: string) => string) => {
  switch (other._tag) {
    case "branch": {
      const name = nameOf(other.memberId);
      return {
        prompt: `${name}'s pushed branch \`${other.branch}\``,
        commit: `Merge ${name}'s ${other.branch} branch`,
        who: name,
      };
    }
    case "base":
      return {
        prompt: `\`${other.branch}\``,
        commit: `Merge ${other.branch}`,
        who: `\`${other.branch}\``,
      };
    case "chat":
      return {
        prompt: `the work of the chat "${other.title}"`,
        commit: `Merge the work of the chat "${other.title}"`,
        who: `The chat "${other.title}"`,
      };
  }
};

export const make = Effect.gen(function* () {
  const teams = yield* TeamService.TeamService;
  const mergeCheck = yield* TeamMergeCheck.TeamMergeCheck;
  const combineCheck = yield* TeamCombineCheck.TeamCombineCheck;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const { resolve } = yield* makeTeamResolver;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const changes = yield* PubSub.unbounded<TeamId>();
  const lock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const filePath = path.join(config.stateDir, "team", "merge-fixes.json");
  const fixes = new Map<ThreadId, StoredFix>();
  const stored = yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeFixesFile), Effect.option);
  if (Option.isSome(stored)) {
    for (const fix of stored.value.fixes) fixes.set(fix.threadId, fix);
  }

  const save = Effect.suspend(() =>
    encodeFixesFile({ version: 1, fixes: [...fixes.values()] }),
  ).pipe(
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
    Effect.provide(fileContext),
    Effect.catchCause((cause) =>
      Effect.logWarning("Team merge fixes could not be saved.", { cause }),
    ),
  );
  const changed = (teamId: string) =>
    save.pipe(Effect.andThen(PubSub.publish(changes, teamId as TeamId)), Effect.asVoid);

  const contextOf = (threadId: ThreadId) =>
    resolve({ environmentId, threadId }).pipe(
      Effect.mapError(
        () => new TeamMergeFixError({ detail: "This chat's team could not be read." }),
      ),
      Effect.flatMap((resolved) =>
        resolved._tag === "InTeam"
          ? Effect.succeed(resolved.context)
          : fail("This chat is not in a team or a solo project."),
      ),
    );

  const nameOfMember = (teamId: TeamId) =>
    teams.listMembers(teamId).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((members) => {
        const names = new Map(
          members.map((member) => [member.memberId as string, member.displayName]),
        );
        return (memberId: string) => names.get(memberId) ?? memberId;
      }),
    );

  /** Why each side changed the conflicting files: notes, claim notes, task titles. */
  const reasonsFor = (input: {
    readonly teamId: TeamId;
    readonly thread: { readonly environmentId: typeof environmentId; readonly threadId: ThreadId };
    readonly other: TeamMergeOther;
    readonly files: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const onFiles = (paths: ReadonlyArray<string>) =>
        paths.some((path) => input.files.includes(path));
      const notes = (yield* teams.listHandoffs(input.teamId, { limit: NOTES_READ })).filter(
        (note) => onFiles(note.files),
      );
      const claims = yield* teams.listActiveClaims(input.teamId);
      const tasks = (yield* teams.listTasks(input.teamId)).filter((task) => task.status !== "done");
      const theirs = (owner: {
        readonly memberId: TeamMemberId;
        readonly thread: TeamThreadRef;
      }) => {
        switch (input.other._tag) {
          case "branch":
            return owner.memberId === input.other.memberId;
          case "chat":
            return sameThread(owner.thread, input.other.thread);
          case "base":
            return false;
        }
      };
      const side = (belongs: (owner: Parameters<typeof theirs>[0]) => boolean) => [
        ...notes
          .filter((note) => belongs(note))
          .map((note) => (note.automatic ? `(automatic) ${note.changed}` : note.changed)),
        ...claims.flatMap((claim) =>
          belongs(claim) && claim.note !== null ? [`Claim: ${claim.note}`] : [],
        ),
        ...tasks.flatMap((task) =>
          task.thread !== null &&
          belongs({ memberId: task.ownerMemberId ?? ("" as TeamMemberId), thread: task.thread })
            ? [`Task: ${task.title}`]
            : [],
        ),
      ];
      return {
        mine: side((owner) => sameThread(owner.thread, input.thread)),
        theirs: side(theirs),
      };
    }).pipe(Effect.orElseSucceed(() => ({ mine: [], theirs: [] })));

  const start = (input: Extract<TeamMergeFixInput, { _tag: "start" }>) =>
    Effect.gen(function* () {
      if (fixes.has(input.threadId)) return yield* fail("A fix is already waiting in this chat.");
      const shell = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.archivedAt !== null)
        return yield* fail("This chat was not found.");
      if (shell.worktreePath === null) {
        return yield* fail(
          "This chat works in the shared checkout, where a merge would change every chat there. Fix it works in chats with their own worktree; merge this one by hand.",
        );
      }
      if (shell.activeRunId !== null) {
        return yield* fail("This chat's agent is working. Try again when its turn ends.");
      }
      const pair: TeamMergePair | undefined = yield* mergeCheck.findPair(
        input.projectId,
        input.threadId,
        input.other,
      );
      // A clean pair too: after an update stopped on a conflict, a merge goes through.
      if (pair === undefined) {
        return yield* fail("This clash is gone or was not checked yet. Look again in a moment.");
      }
      const context = yield* contextOf(input.threadId);
      const teamId = context.teamFile.teamId;
      const repoRoot = yield* findRepoRoot(context.teamRoot).pipe(
        Effect.provide(fileContext),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(repoRoot)) return yield* fail("The project's Git repo was not found.");
      const nameOf = yield* nameOfMember(teamId);
      const words = otherSideWords(pair.other, nameOf);
      const folder = shell.worktreePath;

      const started = yield* startMerge(git, {
        folder,
        otherCommit: pair.other.commit,
        savedWorkMessage: `Save the work of the chat "${shell.title}" before merging`,
      }).pipe(Effect.mapError((error) => new TeamMergeFixError({ detail: error.detail })));
      const files = diffToTeamPaths(path, started.conflicts, repoRoot.value, context.teamRoot);
      const fix: StoredFix = {
        teamId,
        projectId: input.projectId,
        threadId: input.threadId,
        folder,
        repoRoot: repoRoot.value,
        mine: pair.mine,
        other: pair.other,
        conflicts: started.conflicts,
        files,
        headBefore: started.headBefore,
        savedWork: started.savedWork,
        runBefore: shell.latestRunId,
        startedAt: DateTime.formatIso(yield* DateTime.now),
      };

      const reasons = yield* reasonsFor({
        teamId,
        thread: context.thread,
        other: pair.other,
        files,
      });
      const decisions = (yield* readDecisions(context.teamRoot).pipe(Effect.provide(fileContext)))
        .filter((entry) => entry.files.some((file) => files.includes(file)))
        .map((entry) => `\`${entry.source ?? entry.says}\`: ${entry.says}`);
      const check = yield* readCheckCommand({
        teamRoot: context.teamRoot,
        workingFolder: folder,
      }).pipe(Effect.provide(fileContext));
      const places = new Map(pair.files.map((file) => [file.path, file.places]));
      const combined = yield* mergeCheck.combinedOf(pair);
      const mine: MergeFixSide = { who: "This chat", reasons: reasons.mine };
      const theirs: MergeFixSide = { who: words.who, reasons: reasons.theirs };
      const text = buildMergeFixPrompt({
        other: words.prompt,
        conflicts: started.conflicts.map((file) => ({
          path: file,
          places:
            places.get(diffToTeamPaths(path, [file], repoRoot.value, context.teamRoot)[0] ?? "") ??
            0,
        })),
        mine,
        theirs,
        decisions,
        check: check ?? combined?.command,
        savedWork: started.savedWork !== null,
        combinedErrors:
          combined?.status === "broken"
            ? combined.errors.map((error) =>
                error.path === undefined
                  ? error.message
                  : `\`${error.path}${error.line === undefined ? "" : `:${error.line}`}\`: ${error.message}`,
              )
            : [],
      });

      // The fix's own message says it all; the clash line is not told again.
      yield* mergeCheck.takeClashLine(input.threadId);
      fixes.set(input.threadId, fix);
      const key = `team-merge-fix:${input.threadId}:${Date.parse(fix.startedAt)}`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:${key}:turn`),
          threadId: input.threadId,
          messageId: MessageId.make(`${key}:message`),
          text,
          attachments: [],
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: `Fix the merge clash with ${words.prompt}`,
            detail: text,
          },
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              fixes.delete(input.threadId);
              yield* undoMerge(git, fix).pipe(Effect.ignore);
              yield* Effect.logWarning("Team merge fix: the turn could not start.", { cause });
              return yield* fail("The agent could not be started; the merge was undone.");
            }),
          ),
        );
      yield* Effect.logInfo("Team merge fix started.", {
        threadId: input.threadId,
        conflicts: started.conflicts.length,
        savedWork: started.savedWork !== null,
      });
      yield* changed(teamId);
      return {};
    });

  /** Merges the other side (the base or another chat) into the chat's own worktree. */
  const update = (input: Extract<TeamMergeFixInput, { _tag: "update" }>) =>
    Effect.gen(function* () {
      const pair = yield* mergeCheck.findPair(input.projectId, input.threadId, input.other);
      if (pair === undefined) {
        return yield* fail("This pair is gone or was not checked yet. Look again in a moment.");
      }
      if (pair.other._tag === "branch") {
        return yield* fail(
          "A teammate's branch is merged first; then this chat updates on `main`.",
        );
      }
      if (pair.status !== "clean") {
        return yield* fail("These clash, so an update would stop on a conflict. Use Fix it.");
      }
      if (fixes.has(input.threadId)) return yield* fail("A fix is waiting in this chat.");
      const shell = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.archivedAt !== null)
        return yield* fail("This chat was not found.");
      if (shell.worktreePath === null) {
        return yield* fail(
          "This chat works in the shared checkout, where an update would move every chat there. Update it by hand.",
        );
      }
      if (shell.activeRunId !== null) {
        return yield* fail("This chat's agent is working. Try again when its turn ends.");
      }
      const context = yield* contextOf(input.threadId);
      const repoRoot = yield* findRepoRoot(context.teamRoot).pipe(
        Effect.provide(fileContext),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(repoRoot)) return yield* fail("The project's Git repo was not found.");

      const moved = yield* moveCopyOnto(git, {
        folder: shell.worktreePath,
        fetch: [],
        onto: pair.other.commit,
        paths: [],
        message: otherSideWords(pair.other, yield* nameOfMember(context.teamFile.teamId)).commit,
        operation: "TeamMergeFix.update",
      });
      switch (moved.status) {
        case "dirty":
          return yield* fail(
            "This chat has uncommitted changes. Commit them (or ask its agent to), then update.",
          );
        case "unavailable":
          return yield* fail("Git could not update this chat's copy.");
        case "conflict":
          yield* Effect.logInfo("Team merge update stopped on a conflict.", {
            threadId: input.threadId,
          });
          return {
            update: "conflict" as const,
            detail:
              "Git stopped on a conflict while merging, so nothing changed. Fix it lets the agent resolve it.",
          };
        case "updated": {
          const head = yield* git
            .execute({
              operation: "TeamMergeFix.update",
              cwd: shell.worktreePath,
              args: ["rev-parse", "HEAD"],
            })
            .pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.orElseSucceed(() => ""),
            );
          // Its last checkpoint is from before the move; the new HEAD stands for it until its next turn.
          if (head.length > 0) {
            yield* mergeCheck.useCommitUntilNextTurn({
              projectId: input.projectId,
              threadId: input.threadId,
              repoRoot: repoRoot.value,
              commit: head,
            });
          }
          yield* Effect.logInfo("Team merge update moved a chat's copy.", {
            threadId: input.threadId,
            onto: pair.other.commit,
          });
          return { update: "updated" as const };
        }
      }
    });

  /** The fix, once its turn has ended; Undo also while the agent waits for an answer. */
  const readyFix = (threadId: ThreadId, allowAsking: boolean) =>
    Effect.gen(function* () {
      const fix = fixes.get(threadId);
      if (fix === undefined) return yield* fail("No fix is waiting in this chat.");
      const status = yield* statusOf(fix);
      if (status === "working") return yield* fail("The agent is still working on the fix.");
      if (status === "asking" && !allowAsking) {
        return yield* fail("The agent is waiting for your answer. Reply in the chat first.");
      }
      return fix;
    });

  const approve = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const fix = yield* readyFix(threadId, false);
      const teamId = fix.teamId as TeamId;
      const nameOf = yield* nameOfMember(teamId);
      const outcome = yield* approveMerge(git, {
        folder: fix.folder,
        message: otherSideWords(fix.other, nameOf).commit,
        conflicts: fix.conflicts,
      }).pipe(Effect.mapError((error) => new TeamMergeFixError({ detail: error.detail })));
      fixes.delete(threadId);
      markersAfterRun.delete(threadId);
      resultChecks.delete(threadId);
      yield* changed(teamId);

      const head = yield* git
        .execute({
          operation: "TeamMergeFix.head",
          cwd: fix.folder,
          args: ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"],
        })
        .pipe(
          Effect.map((result) => result.stdout.trim().split("\n")),
          Effect.orElseSucceed(() => []),
        );
      if (head[0] !== undefined) {
        yield* mergeCheck.useCommitUntilNextTurn({
          projectId: fix.projectId as ProjectId,
          threadId,
          repoRoot: fix.repoRoot,
          commit: head[0],
        });
      }
      // A teammate whose branch was merged hears it from a note; their branch is untouched.
      if (fix.other._tag === "branch") {
        const me = yield* teams.currentMember(teamId);
        if (Option.isSome(me)) {
          // Notes are plain text.
          const files = fix.files.slice(0, FILES_IN_TEAM_NOTE);
          const more = fix.files.length - files.length;
          const branch = head[1] !== undefined && head[1] !== "HEAD" ? ` ${head[1]}` : "";
          yield* teams
            .writeNote({
              teamId,
              memberId: me.value.memberId,
              to: fix.other.memberId,
              text: `${me.value.displayName}'s agent merged your ${fix.other.branch} changes into their branch${branch}${
                files.length > 0
                  ? `; see ${files.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
                  : ""
              }.`,
              forAgents: false,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Team merge fix: the note to the teammate failed.", { cause }),
              ),
            );
        }
      }
      yield* Effect.logInfo("Team merge fix approved.", { threadId, push: outcome.push });
      return outcome.push === "failed"
        ? { push: "failed" as const, detail: outcome.detail }
        : { push: outcome.push };
    });

  const undo = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const fix = yield* readyFix(threadId, true);
      yield* undoMerge(git, fix).pipe(
        Effect.mapError((error) => new TeamMergeFixError({ detail: error.detail })),
      );
      fixes.delete(threadId);
      markersAfterRun.delete(threadId);
      resultChecks.delete(threadId);
      yield* changed(fix.teamId);
      yield* mergeCheck.request(fix.projectId as ProjectId);
      yield* Effect.logInfo("Team merge fix undone.", { threadId });
      return {};
    });

  /** Per fix, the run whose end was read and whether a conflicting file still had markers then. */
  const markersAfterRun = new Map<ThreadId, { runId: string; left: boolean }>();
  const markersLeft = (fix: StoredFix, runId: string) =>
    Effect.gen(function* () {
      const known = markersAfterRun.get(fix.threadId);
      if (known !== undefined && known.runId === runId) return known.left;
      let left = false;
      for (const file of fix.conflicts) {
        const text = yield* fs
          .readFileString(path.join(fix.folder, file))
          .pipe(Effect.orElseSucceed(() => ""));
        if (CONFLICT_MARKER.test(text)) {
          left = true;
          break;
        }
      }
      markersAfterRun.set(fix.threadId, { runId, left });
      return left;
    });

  /**
   * Working while its turn runs; asking when the agent waits for the person (a
   * question during the turn, or a turn that ended with markers left); else ready.
   */
  const statusOf = (fix: StoredFix) =>
    Effect.gen(function* () {
      const shell = yield* orchestrator.getThreadShell(fix.threadId);
      if (shell === null) return "working" as const;
      if (shell.pendingRuntimeRequest !== null) return "asking" as const;
      if (shell.activeRunId !== null || shell.latestRunId === null) return "working" as const;
      if (shell.latestRunId === fix.runBefore) return "working" as const;
      return (yield* markersLeft(fix, shell.latestRunId))
        ? ("asking" as const)
        : ("ready" as const);
    }).pipe(Effect.orElseSucceed(() => "working" as const));

  /** Per fix, the turn whose result was looked at, and its check (none when the agent could run it). */
  const resultChecks = new Map<
    ThreadId,
    { readonly runId: string; check: TeamCombinedCheck | undefined }
  >();

  /** Once per ended turn: the check on the fix's result, when the chat's copy has no dependencies. */
  const checkResultOnce = (fix: StoredFix, runId: string) =>
    Effect.gen(function* () {
      if (resultChecks.get(fix.threadId)?.runId === runId) return;
      const entry: { readonly runId: string; check: TeamCombinedCheck | undefined } = {
        runId,
        check: undefined,
      };
      resultChecks.set(fix.threadId, entry);
      const place = yield* mergeCheck.placeOf(fix.projectId as ProjectId);
      const checkFolder = Option.isSome(place)
        ? path.join(fix.folder, path.relative(place.value.repoRoot, place.value.teamRoot))
        : fix.folder;
      const exists = (name: string) =>
        fs.exists(path.join(checkFolder, name)).pipe(Effect.orElseSucceed(() => false));
      if (!(yield* exists("package.json")) || (yield* exists("node_modules"))) return;
      const sides = { mineCommit: fix.mine.commit, otherCommit: fix.other.commit };
      entry.check = {
        ...sides,
        status: "running",
        errors: [],
        errorCount: 0,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* Effect.gen(function* () {
        const tree = yield* workingTree(git, fix.folder).pipe(Effect.provide(fileContext));
        const done: TeamCombinedCheck =
          tree === undefined
            ? {
                ...sides,
                status: "skipped",
                skip: "failed",
                errors: [],
                errorCount: 0,
                checkedAt: DateTime.formatIso(yield* DateTime.now),
              }
            : yield* combineCheck.checkResult({
                projectId: fix.projectId as ProjectId,
                tree,
                ...sides,
              });
        if (resultChecks.get(fix.threadId) !== entry) return;
        entry.check = done;
        yield* PubSub.publish(changes, fix.teamId as TeamId);
      }).pipe(Effect.forkIn(scope));
    });

  const forTeam = (teamId: TeamId) =>
    Effect.forEach(
      [...fixes.values()].filter((fix) => fix.teamId === teamId),
      (fix) =>
        Effect.gen(function* () {
          const status = yield* statusOf(fix);
          const runId = (yield* orchestrator
            .getThreadShell(fix.threadId)
            .pipe(Effect.orElseSucceed(() => null)))?.latestRunId;
          if (status === "ready" && runId !== null && runId !== undefined) {
            yield* checkResultOnce(fix, runId);
          }
          const check =
            resultChecks.get(fix.threadId)?.runId === runId
              ? resultChecks.get(fix.threadId)?.check
              : undefined;
          return {
            projectId: fix.projectId as ProjectId,
            mine: fix.mine,
            other: fix.other,
            status,
            files: fix.files,
            savedWork: fix.savedWork !== null,
            ...(check === undefined ? {} : { check }),
            startedAt: fix.startedAt,
          } satisfies TeamMergeFixView;
        }),
    );

  // A fix's turn starting or ending, or its agent asking, changes what the feed shows.
  const eventSink = yield* EventSink.EventSinkV2;
  const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
  yield* forkParked(
    Stream.runForEach(
      Stream.merge(
        eventSink.stream({ afterSequence: fromSequence, eventType: "run.updated" }),
        eventSink.stream({ afterSequence: fromSequence, eventType: "runtime-request.updated" }),
      ),
      ({ event }) => {
        const fix = fixes.get(event.threadId);
        return fix === undefined ? Effect.void : PubSub.publish(changes, fix.teamId as TeamId);
      },
    ),
  );

  /** Words for a combined check that stopped an update. */
  const checkedWords = (check: { readonly status: string; readonly errorCount: number }) =>
    check.status === "broken"
      ? `Combined, the check finds ${check.errorCount === 1 ? "a new error" : `${check.errorCount} new errors`}. Fix it, or update anyway.`
      : "The combined check did not run; see why on the line. You can update anyway.";

  const act = (input: TeamMergeFixInput): Effect.Effect<TeamMergeFixResult, TeamMergeFixError> => {
    switch (input._tag) {
      case "check":
        return combineCheck
          .start({ ...input, install: true })
          .pipe(Effect.as({} satisfies TeamMergeFixResult));
      case "update":
        // The one combined check before merging runs outside the lock: it can take minutes.
        return Effect.gen(function* () {
          if (input.anyway !== true) {
            const check = yield* combineCheck.run({ ...input, install: false });
            if (check.status !== "clean") {
              return {
                update: "checked",
                detail: checkedWords(check),
              } satisfies TeamMergeFixResult;
            }
          }
          return yield* lock.withPermits(1)(update(input));
        });
      case "start":
        return lock.withPermits(1)(start(input));
      case "approve":
        return lock.withPermits(1)(approve(input.threadId));
      case "undo":
        return lock.withPermits(1)(undo(input.threadId));
    }
  };

  return TeamMergeFix.of({ act, forTeam, subscribeChanges: PubSub.subscribe(changes) });
});

export const layer = Layer.effect(TeamMergeFix, make);
