/**
 * TeamStateModel - pure functions over the team state on Git (format 1, see
 * team/STORAGE_PLAN.md 3.2). Reading turns the state tree's files into one
 * team view; each write turns this server's writer file into its next
 * version. No I/O: callers pass ids and the time in.
 *
 * @module TeamStateModel
 */
import {
  type TeamActivity,
  type TeamAnswer,
  type TeamClaim,
  type TeamClaimOverlap,
  type TeamHandoff,
  TeamMemberId,
  type TeamQuestion,
  type TeamMemberRole,
  teamPathsOverlap,
  type TeamStateActivity,
  TeamStateActivity as TeamStateActivitySchema,
  TeamStateAnswer as TeamStateAnswerSchema,
  type TeamStateClaim,
  TeamStateClaim as TeamStateClaimSchema,
  type TeamStateNote,
  TeamStateNote as TeamStateNoteSchema,
  type TeamStateQuestion,
  TeamStateQuestion as TeamStateQuestionSchema,
  type TeamStateTask,
  TeamStateTask as TeamStateTaskSchema,
  type TeamStateTeamFile,
  TeamStateTeamFile as TeamStateTeamFileSchema,
  type TeamTask,
  type TeamThreadRef,
  TEAM_AUTOMATIC_NOTE_MAX_FILES,
  TEAM_STATE_FORMAT,
  TEAM_STATE_LIMITS,
  TEAM_STATE_TEAM_FILE,
  TEAM_STATE_WRITERS_DIRECTORY,
  type TeamLogin,
  TeamWriterFile,
  type EnvironmentId,
  type TeamActivityId,
  type TeamClaimId,
  type TeamHandoffId,
  type TeamTaskId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One server's writer file, with the key readers break ties by. */
export interface TeamWriter {
  /** `<login>/<environmentId>`. */
  readonly key: string;
  readonly file: TeamWriterFile;
}

export interface ParsedTeamState {
  /** Null when `team.json` is missing or does not parse. */
  readonly team: TeamStateTeamFile | null;
  readonly writers: ReadonlyArray<TeamWriter>;
  /** One line per file or entry that was skipped. */
  readonly warnings: ReadonlyArray<string>;
}

export interface TeamStateMember {
  readonly login: TeamLogin;
  /** From the writer file that synced last. */
  readonly displayName: string;
  readonly role: TeamMemberRole;
  /** Every T3 server this person writes from. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly lastSyncAt: string;
}

/** The whole team as every reader sees it. Member ids are logins. */
export interface TeamStateView {
  readonly team: TeamStateTeamFile;
  /** By login. */
  readonly members: ReadonlyArray<TeamStateMember>;
  /** Oldest first. */
  readonly activeClaims: ReadonlyArray<TeamClaim>;
  /** One version per task, the newest; oldest task first. */
  readonly tasks: ReadonlyArray<TeamTask>;
  /** Newest first; automatic notes included. */
  readonly notes: ReadonlyArray<TeamHandoff>;
  /** Newest first. */
  readonly activity: ReadonlyArray<TeamActivity>;
  /** Open questions ("Ask", slice 3d), oldest first. */
  readonly questions: ReadonlyArray<TeamQuestion>;
  /** Answers to them, oldest first. */
  readonly answers: ReadonlyArray<TeamAnswer>;
}

/** Another writer's active claim that overlaps one of this server's, found after both were made. */
export interface TeamLateOverlap {
  /** From {@link overlapKey}. */
  readonly key: string;
  readonly mine: TeamClaim;
  readonly theirs: TeamClaim;
  /** The overlapping paths as `theirs` names them. */
  readonly paths: ReadonlyArray<string>;
}

export const writerKey = (login: string, environmentId: string) => `${login}/${environmentId}`;

export const writerFilePath = (login: string, environmentId: string) =>
  `${TEAM_STATE_WRITERS_DIRECTORY}/${writerKey(login, environmentId)}.json`;

/** The same key for a pair of claims whichever side computes it. */
export const overlapKey = (left: TeamClaimId, right: TeamClaimId) =>
  left < right ? `${left}|${right}` : `${right}|${left}`;

const encodeTeamFile = Schema.encodeSync(TeamStateTeamFileSchema);
const encodeWriter = Schema.encodeSync(TeamWriterFile);

/** `team.json` as written to the tree. */
export const encodeTeamStateTeamFile = (team: TeamStateTeamFile) =>
  `${JSON.stringify(encodeTeamFile(team), null, 2)}\n`;

/** A writer file as written to the tree, indented so it can be read by eye. */
export const encodeWriterFile = (file: TeamWriterFile) =>
  `${JSON.stringify(encodeWriter(file), null, 2)}\n`;

// The entries are decoded one by one: an entry this app does not understand
// (a task status added later, say) is skipped instead of hiding the whole file.
const WriterEnvelope = Schema.Struct({
  ...TeamWriterFile.fields,
  claims: Schema.Array(Schema.Unknown),
  tasks: Schema.Array(Schema.Unknown),
  notes: Schema.Array(Schema.Unknown),
  activity: Schema.Array(Schema.Unknown),
  questions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  answers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const decodeEnvelope = Schema.decodeUnknownExit(WriterEnvelope);
const decodeTeamFile = Schema.decodeUnknownExit(TeamStateTeamFileSchema);

const parseJson = (contents: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(contents));
  } catch {
    return Option.none();
  }
};

const decodeEntries = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  raw: ReadonlyArray<unknown>,
) => {
  const decode = Schema.decodeUnknownOption(schema);
  const kept: Array<S["Type"]> = [];
  let skipped = 0;
  for (const entry of raw) {
    const decoded = decode(entry);
    if (Option.isSome(decoded)) kept.push(decoded.value);
    else skipped += 1;
  }
  return { kept, skipped };
};

const WRITER_PATH = new RegExp(`^${TEAM_STATE_WRITERS_DIRECTORY}/([^/]+)/([^/]+)\\.json$`, "u");

/**
 * Reads the state tree (path → contents). A file that does not parse, or a
 * writer file whose path and contents disagree, is skipped with a warning and
 * never breaks the others. Other files are ignored.
 */
export const parseTeamState = (files: ReadonlyMap<string, string>): ParsedTeamState => {
  const warnings: Array<string> = [];
  let team: TeamStateTeamFile | null = null;
  const rawTeam = files.get(TEAM_STATE_TEAM_FILE);
  if (rawTeam === undefined) {
    warnings.push(`${TEAM_STATE_TEAM_FILE} is missing.`);
  } else {
    const decoded = Option.map(parseJson(rawTeam), decodeTeamFile);
    if (Option.isSome(decoded) && Exit.isSuccess(decoded.value)) team = decoded.value.value;
    else warnings.push(`${TEAM_STATE_TEAM_FILE} does not match the team file format; skipped.`);
  }

  const writers: Array<TeamWriter> = [];
  for (const [path, contents] of [...files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const match = WRITER_PATH.exec(path);
    if (!match) continue;
    const json = parseJson(contents);
    if (Option.isNone(json)) {
      warnings.push(`${path} is not valid JSON; skipped.`);
      continue;
    }
    const envelope = decodeEnvelope(json.value);
    if (Exit.isFailure(envelope)) {
      warnings.push(`${path} does not match the writer file format; skipped.`);
      continue;
    }
    const raw = envelope.value;
    if (raw.login !== match[1] || raw.environmentId !== match[2]) {
      warnings.push(
        `${path} names another writer inside (${writerKey(raw.login, raw.environmentId)}); skipped.`,
      );
      continue;
    }
    const claims = decodeEntries(TeamStateClaimSchema, raw.claims);
    const tasks = decodeEntries(TeamStateTaskSchema, raw.tasks);
    const notes = decodeEntries(TeamStateNoteSchema, raw.notes);
    const activity = decodeEntries(TeamStateActivitySchema, raw.activity);
    const questions = decodeEntries(TeamStateQuestionSchema, raw.questions ?? []);
    const answers = decodeEntries(TeamStateAnswerSchema, raw.answers ?? []);
    const skipped =
      claims.skipped +
      tasks.skipped +
      notes.skipped +
      activity.skipped +
      questions.skipped +
      answers.skipped;
    if (skipped > 0) {
      warnings.push(
        `${path}: ${skipped} ${skipped === 1 ? "entry" : "entries"} not understood; skipped.`,
      );
    }
    writers.push({
      key: writerKey(raw.login, raw.environmentId),
      file: {
        format: raw.format,
        login: raw.login,
        displayName: raw.displayName,
        environmentId: raw.environmentId,
        lastSyncAt: raw.lastSyncAt,
        claims: claims.kept,
        tasks: tasks.kept,
        notes: notes.kept,
        activity: activity.kept,
        ...(raw.questions === undefined ? {} : { questions: questions.kept }),
        ...(raw.answers === undefined ? {} : { answers: answers.kept }),
      },
    });
  }
  return { team, writers, warnings };
};

/** Milliseconds, or -Infinity for a time that does not parse, so it sorts oldest. */
const timeOf = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const sameThread = (left: TeamThreadRef, right: TeamThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

const memberIdOf = (login: TeamLogin) => TeamMemberId.make(login);

/** Builds the team view from every writer file. Readers given the same files in any order agree. */
export const buildTeamView = (
  team: TeamStateTeamFile,
  writers: ReadonlyArray<TeamWriter>,
): TeamStateView => {
  const ordered = writers.toSorted((a, b) => compareText(a.key, b.key));

  const byLogin = new Map<TeamLogin, Array<TeamWriter>>();
  for (const writer of ordered) {
    const list = byLogin.get(writer.file.login) ?? [];
    list.push(writer);
    byLogin.set(writer.file.login, list);
  }
  const members = [...byLogin.entries()]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([login, own]): TeamStateMember => {
      const latest = own.reduce((best, writer) =>
        timeOf(writer.file.lastSyncAt) >= timeOf(best.file.lastSyncAt) ? writer : best,
      );
      return {
        login,
        displayName: latest.file.displayName,
        role: login === team.createdBy ? "owner" : "member",
        environmentIds: own.map((writer) => writer.file.environmentId),
        lastSyncAt: latest.file.lastSyncAt,
      };
    });

  const activeClaims = ordered
    .flatMap((writer) =>
      writer.file.claims
        .filter((claim) => claim.releasedAt === null)
        .map((claim, index) => ({ writer, claim, index })),
    )
    .toSorted(
      (a, b) =>
        timeOf(a.claim.claimedAt) - timeOf(b.claim.claimedAt) ||
        compareText(a.writer.key, b.writer.key) ||
        a.index - b.index,
    )
    .map(({ writer, claim }) => toClaim(team, writer.file.login, claim));

  const newestTask = new Map<
    TeamTaskId,
    { readonly writer: TeamWriter; readonly task: TeamStateTask }
  >();
  for (const writer of ordered) {
    for (const task of writer.file.tasks) {
      const current = newestTask.get(task.taskId);
      // Ties go to the larger writer key; `ordered` is ascending, so a later writer wins them.
      if (current === undefined || timeOf(task.updatedAt) >= timeOf(current.task.updatedAt)) {
        newestTask.set(task.taskId, { writer, task });
      }
    }
  }
  const tasks = [...newestTask.values()]
    .map(({ task }) => toTask(team, task))
    .toSorted(
      (a, b) => timeOf(a.createdAt) - timeOf(b.createdAt) || compareText(a.taskId, b.taskId),
    );

  const notes = ordered
    .flatMap((writer) => writer.file.notes.map((note) => toHandoff(team, writer.file.login, note)))
    .toSorted(
      (a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || compareText(b.handoffId, a.handoffId),
    );

  const activity = ordered
    .flatMap((writer) => writer.file.activity.map((line, index) => ({ writer, line, index })))
    .toSorted(
      (a, b) =>
        timeOf(b.line.createdAt) - timeOf(a.line.createdAt) ||
        compareText(b.writer.key, a.writer.key) ||
        b.index - a.index,
    )
    .map(({ writer, line }) => toActivity(team, writer.file.login, line));

  const byTime =
    <A>(timeOfEntry: (entry: A) => string) =>
    (a: A, b: A) =>
      timeOf(timeOfEntry(a)) - timeOf(timeOfEntry(b));
  const questions = ordered
    .flatMap((writer) =>
      (writer.file.questions ?? []).map((question): TeamQuestion => ({
        ...question,
        from: memberIdOf(writer.file.login),
        to: question.to.map(memberIdOf),
      })),
    )
    .toSorted(byTime((question) => question.askedAt));
  const answers = ordered
    .flatMap((writer) =>
      (writer.file.answers ?? []).map((answer): TeamAnswer => ({
        ...answer,
        by: memberIdOf(writer.file.login),
      })),
    )
    .toSorted(byTime((answer) => answer.answeredAt));

  return { team, members, activeClaims, tasks, notes, activity, questions, answers };
};

const toClaim = (team: TeamStateTeamFile, login: TeamLogin, claim: TeamStateClaim): TeamClaim => ({
  claimId: claim.claimId,
  teamId: team.teamId,
  memberId: memberIdOf(login),
  thread: claim.thread,
  paths: claim.paths,
  note: claim.note,
  ...(claim.branch === undefined ? {} : { branch: claim.branch }),
  ...(claim.pushedCommit === undefined ? {} : { pushedCommit: claim.pushedCommit }),
  claimedAt: claim.claimedAt,
  releasedAt: claim.releasedAt,
});

const toTask = (team: TeamStateTeamFile, task: TeamStateTask): TeamTask => ({
  taskId: task.taskId,
  teamId: team.teamId,
  title: task.title,
  status: task.status,
  note: task.note,
  paths: task.paths,
  ownerMemberId: task.owner === null ? null : memberIdOf(task.owner),
  thread: task.thread,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

const toHandoff = (
  team: TeamStateTeamFile,
  login: TeamLogin,
  note: TeamStateNote,
): TeamHandoff => ({
  ...note,
  teamId: team.teamId,
  memberId: memberIdOf(login),
});

const toActivity = (
  team: TeamStateTeamFile,
  login: TeamLogin,
  line: TeamStateActivity,
): TeamActivity => ({
  activityId: line.activityId,
  teamId: team.teamId,
  memberId: memberIdOf(login),
  kind: line.kind,
  summary: line.summary,
  thread: line.thread,
  createdAt: line.createdAt,
});

/** Active claims of other threads that overlap `claim`, with the paths as they name them. */
export const claimOverlaps = (
  active: ReadonlyArray<TeamClaim>,
  claim: Pick<TeamClaim, "claimId" | "thread" | "paths">,
): ReadonlyArray<TeamClaimOverlap> =>
  active.flatMap((other): Array<TeamClaimOverlap> => {
    if (other.claimId === claim.claimId || sameThread(other.thread, claim.thread)) return [];
    const overlapping = other.paths.filter((otherPath) =>
      claim.paths.some((path) => teamPathsOverlap(path, otherPath)),
    );
    return overlapping.length > 0 ? [{ claim: other, paths: overlapping }] : [];
  });

/**
 * Overlaps between this server's active claims and other writers' that were
 * not reported yet (STORAGE_PLAN.md Q4). Every server runs this after a sync,
 * so both sides hear of a pair once. `reported` comes back holding only the
 * pairs that still overlap, so it does not grow forever; add the overlaps a
 * claim reported itself with {@link overlapKey}.
 */
export const findLateOverlaps = (
  view: TeamStateView,
  me: { readonly login: TeamLogin; readonly environmentId: EnvironmentId },
  reported: ReadonlySet<string>,
): {
  readonly overlaps: ReadonlyArray<TeamLateOverlap>;
  readonly reported: ReadonlySet<string>;
} => {
  const isMine = (claim: TeamClaim) =>
    claim.memberId === me.login && claim.thread.environmentId === me.environmentId;
  const mine = view.activeClaims.filter(isMine);
  const theirs = view.activeClaims.filter((claim) => !isMine(claim));
  const overlaps: Array<TeamLateOverlap> = [];
  const stillReported = new Set<string>();
  for (const claim of mine) {
    for (const overlap of claimOverlaps(theirs, claim)) {
      const key = overlapKey(claim.claimId, overlap.claim.claimId);
      if (reported.has(key)) {
        stillReported.add(key);
      } else if (!stillReported.has(key)) {
        stillReported.add(key);
        overlaps.push({ key, mine: claim, theirs: overlap.claim, paths: overlap.paths });
      }
    }
  }
  return { overlaps, reported: stillReported };
};

// ---------------------------------------------------------------------------
// Writes. Each one returns this server's next writer file, with the caps applied.

export const emptyWriterFile = (input: {
  readonly login: TeamLogin;
  readonly displayName: string;
  readonly environmentId: EnvironmentId;
  readonly now: string;
}): TeamWriterFile => ({
  format: TEAM_STATE_FORMAT,
  login: input.login,
  displayName: input.displayName,
  environmentId: input.environmentId,
  lastSyncAt: input.now,
  claims: [],
  tasks: [],
  notes: [],
  activity: [],
});

/** Keeps the newest `limit` entries by `timeOfEntry`, in their file order. */
const keepNewest = <A>(
  entries: ReadonlyArray<A>,
  limit: number,
  timeOfEntry: (entry: A) => number,
) => {
  if (entries.length <= limit) return entries;
  const kept = new Set(
    entries
      .map((entry, index) => ({ entry, index }))
      .toSorted((a, b) => timeOfEntry(b.entry) - timeOfEntry(a.entry) || b.index - a.index)
      .slice(0, limit)
      .map(({ entry }) => entry),
  );
  return entries.filter((entry) => kept.has(entry));
};

/**
 * Applies the caps of STORAGE_PLAN.md 3.2: active claims plus claims released
 * in the last 7 days (at most 200, active first), the newest 200 notes and
 * the newest 100 activity lines. Every write calls it; call it before a sync
 * too, so old released claims drop out without a write.
 */
export const compactWriterFile = (file: TeamWriterFile, now: string): TeamWriterFile => {
  const cutoff = timeOf(now) - TEAM_STATE_LIMITS.releasedClaimDays * 24 * 60 * 60 * 1000;
  const active = file.claims.filter((claim) => claim.releasedAt === null);
  const recent = file.claims.filter(
    (claim) => claim.releasedAt !== null && timeOf(claim.releasedAt) >= cutoff,
  );
  const keptActive = keepNewest(active, TEAM_STATE_LIMITS.claims, (claim) =>
    timeOf(claim.claimedAt),
  );
  const keptRecent = keepNewest(recent, TEAM_STATE_LIMITS.claims - keptActive.length, (claim) =>
    timeOf(claim.releasedAt ?? ""),
  );
  const keptClaims = new Set([...keptActive, ...keptRecent]);
  return {
    ...file,
    claims: file.claims.filter((claim) => keptClaims.has(claim)),
    notes: keepNewest(file.notes, TEAM_STATE_LIMITS.notes, (note) => timeOf(note.createdAt)),
    activity: keepNewest(file.activity, TEAM_STATE_LIMITS.activity, (line) =>
      timeOf(line.createdAt),
    ),
    ...(file.questions === undefined
      ? {}
      : {
          questions: keepNewest(file.questions, TEAM_STATE_LIMITS.questions, (question) =>
            timeOf(question.askedAt),
          ),
        }),
    ...(file.answers === undefined
      ? {}
      : {
          answers: keepNewest(file.answers, TEAM_STATE_LIMITS.answers, (answer) =>
            timeOf(answer.answeredAt),
          ),
        }),
  };
};

/** "a, b, c and 2 more". */
export const describePaths = (paths: ReadonlyArray<string>) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

const withActivity = (file: TeamWriterFile, line: TeamStateActivity, now: string): TeamWriterFile =>
  compactWriterFile({ ...file, activity: [...file.activity, line] }, now);

/** Adds an activity line on its own. */
export const addActivity = (file: TeamWriterFile, line: TeamStateActivity): TeamWriterFile =>
  withActivity(file, line, line.createdAt);

/** Adds a claim. `paths` must already be normalized. */
export const addClaim = (
  file: TeamWriterFile,
  input: {
    readonly claimId: TeamClaimId;
    readonly activityId: TeamActivityId;
    readonly thread: TeamThreadRef;
    readonly paths: ReadonlyArray<string>;
    readonly note: string | null;
    readonly branch?: string | undefined;
    readonly pushedCommit?: string | undefined;
    readonly now: string;
  },
): { readonly file: TeamWriterFile; readonly claim: TeamStateClaim } => {
  const claim: TeamStateClaim = {
    claimId: input.claimId,
    thread: input.thread,
    paths: input.paths,
    note: input.note,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.branch === undefined || input.pushedCommit === undefined
      ? {}
      : { pushedCommit: input.pushedCommit }),
    claimedAt: input.now,
    releasedAt: null,
  };
  const next = withActivity(
    { ...file, claims: [...file.claims, claim] },
    {
      activityId: input.activityId,
      kind: "claim.added",
      summary: `${file.displayName} claimed ${describePaths(input.paths)}.`,
      thread: input.thread,
      createdAt: input.now,
    },
    input.now,
  );
  return { file: next, claim };
};

/**
 * Releases paths the thread holds; all of them when `paths` is omitted.
 * Releasing a folder also releases paths claimed inside it. Returns the claims
 * it changed, as they are now.
 */
export const releasePaths = (
  file: TeamWriterFile,
  input: {
    readonly activityId: TeamActivityId;
    readonly thread: TeamThreadRef;
    readonly paths?: ReadonlyArray<string> | undefined;
    readonly now: string;
  },
): { readonly file: TeamWriterFile; readonly changed: ReadonlyArray<TeamStateClaim> } => {
  const changed: Array<TeamStateClaim> = [];
  const releasedPaths: Array<string> = [];
  const claims = file.claims.map((claim) => {
    if (claim.releasedAt !== null || !sameThread(claim.thread, input.thread)) return claim;
    const releasing = input.paths;
    const kept =
      releasing === undefined
        ? []
        : claim.paths.filter(
            (path) =>
              !releasing.some((release) => path === release || path.startsWith(`${release}/`)),
          );
    if (kept.length === claim.paths.length) return claim;
    releasedPaths.push(...claim.paths.filter((path) => !kept.includes(path)));
    const next =
      kept.length === 0 ? { ...claim, releasedAt: input.now } : { ...claim, paths: kept };
    changed.push(next);
    return next;
  });
  if (changed.length === 0) return { file, changed };
  const next = withActivity(
    { ...file, claims },
    {
      activityId: input.activityId,
      kind: "claim.released",
      summary: `${file.displayName} released ${describePaths(releasedPaths)}.`,
      thread: input.thread,
      createdAt: input.now,
    },
    input.now,
  );
  return { file: next, changed };
};

/**
 * Releases every active claim of a thread made at or before `claimedBefore`
 * (all of them without it), when its work merged or was dropped.
 */
export const releaseThreadClaims = (
  file: TeamWriterFile,
  input: {
    readonly activityId: TeamActivityId;
    readonly thread: TeamThreadRef;
    /** Why, for the activity feed, e.g. "its pull request merged". */
    readonly reason: string;
    readonly claimedBefore?: string | undefined;
    readonly now: string;
  },
): { readonly file: TeamWriterFile; readonly released: ReadonlyArray<TeamStateClaim> } => {
  // No time, or one that does not parse: release them all.
  const parsed = Date.parse(input.claimedBefore ?? "");
  const before = Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  const released: Array<TeamStateClaim> = [];
  const claims = file.claims.map((claim) => {
    if (
      claim.releasedAt !== null ||
      !sameThread(claim.thread, input.thread) ||
      timeOf(claim.claimedAt) > before
    ) {
      return claim;
    }
    const next = { ...claim, releasedAt: input.now };
    released.push(next);
    return next;
  });
  if (released.length === 0) return { file, released };
  const next = withActivity(
    { ...file, claims },
    {
      activityId: input.activityId,
      kind: "claim.released",
      summary: `Released ${file.displayName}'s claims on ${describePaths(
        released.flatMap((claim) => claim.paths),
      )}: ${input.reason}.`,
      thread: input.thread,
      createdAt: input.now,
    },
    input.now,
  );
  return { file: next, released };
};

/**
 * Saves this writer's version of a task: a new one when `previous` is null,
 * else an edit of `previous` (the version the reader currently sees, from any
 * writer). The task's `updatedAt` is the activity time.
 */
export const saveTask = (
  file: TeamWriterFile,
  input: {
    readonly task: TeamStateTask;
    readonly previous: Pick<TeamStateTask, "status" | "title"> | null;
    readonly activityId: TeamActivityId;
  },
): TeamWriterFile => {
  const { task, previous } = input;
  const summary =
    previous === null
      ? `${file.displayName} created task "${task.title}".`
      : task.status === previous.status
        ? `${file.displayName} updated task "${previous.title}".`
        : `${file.displayName} moved task "${previous.title}" to ${task.status}.`;
  return withActivity(
    { ...file, tasks: [...file.tasks.filter((own) => own.taskId !== task.taskId), task] },
    {
      activityId: input.activityId,
      kind: previous === null ? "task.created" : "task.updated",
      summary,
      thread: task.thread,
      createdAt: task.updatedAt,
    },
    task.updatedAt,
  );
};

/** Adds a handoff note the agent wrote. */
export const addHandoff = (
  file: TeamWriterFile,
  input: { readonly note: TeamStateNote; readonly activityId: TeamActivityId },
): TeamWriterFile =>
  withActivity(
    { ...file, notes: [...file.notes, input.note] },
    {
      activityId: input.activityId,
      kind: "handoff.written",
      summary: `${file.displayName} wrote a handoff note.`,
      thread: input.note.thread,
      createdAt: input.note.createdAt,
    },
    input.note.createdAt,
  );

/**
 * Saves the thread's automatic note: one per thread, replaced on each turn,
 * never an activity line. This turn's files come first with their new
 * hashes; files of earlier turns keep theirs, up to
 * {@link TEAM_AUTOMATIC_NOTE_MAX_FILES}.
 */
export const saveAutomaticNote = (
  file: TeamWriterFile,
  input: {
    /** Used when the thread has no automatic note yet. */
    readonly handoffId: TeamHandoffId;
    readonly thread: TeamThreadRef;
    readonly task: { readonly taskId: TeamTaskId; readonly title: string } | null;
    /** This turn's files, normalized. */
    readonly files: ReadonlyArray<string>;
    /** Hash per file of this turn, null for a missing file. */
    readonly fileHashes: Readonly<Record<string, string | null>>;
    readonly commit: string | null;
    readonly now: string;
  },
): { readonly file: TeamWriterFile; readonly note: TeamStateNote } => {
  const existing = file.notes.find(
    (note) => note.automatic && sameThread(note.thread, input.thread),
  );
  const files = [
    ...input.files,
    ...(existing?.files ?? []).filter((path) => !input.files.includes(path)),
  ].slice(0, TEAM_AUTOMATIC_NOTE_MAX_FILES);
  const hashes: Record<string, string | null> = {};
  for (const path of files) {
    // A file of this turn that could not be hashed loses its old hash too.
    const hash = input.files.includes(path) ? input.fileHashes[path] : existing?.fileHashes?.[path];
    if (hash !== undefined) hashes[path] = hash;
  }
  const note: TeamStateNote = {
    handoffId: existing?.handoffId ?? input.handoffId,
    thread: input.thread,
    taskId: input.task?.taskId ?? null,
    changed: `Automatic note, not written by the agent: this chat changed ${files.length} ${
      files.length === 1 ? "file" : "files"
    }${input.task === null ? "" : ` for task "${input.task.title}"`}.`,
    left: null,
    risks: null,
    files,
    commit: input.commit,
    fileHashes: Object.keys(hashes).length === 0 ? null : hashes,
    automatic: true,
    createdAt: input.now,
  };
  const next = compactWriterFile(
    { ...file, notes: [...file.notes.filter((own) => own !== existing), note] },
    input.now,
  );
  return { file: next, note };
};

/**
 * Records where the thread's branch is on `origin` on its active claims with
 * that branch (`undefined`: not pushed). Returns the same file when nothing
 * changed, so callers can skip the write. No activity line.
 */
export const setClaimsPushed = (
  file: TeamWriterFile,
  input: {
    readonly thread: TeamThreadRef;
    readonly branch: string;
    readonly pushedCommit: string | undefined;
  },
): TeamWriterFile => {
  let changed = false;
  const claims = file.claims.map((claim) => {
    if (
      claim.releasedAt !== null ||
      claim.branch !== input.branch ||
      !sameThread(claim.thread, input.thread) ||
      claim.pushedCommit === input.pushedCommit
    ) {
      return claim;
    }
    changed = true;
    const { pushedCommit: _old, ...rest } = claim;
    return input.pushedCommit === undefined ? rest : { ...rest, pushedCommit: input.pushedCommit };
  });
  return changed ? { ...file, claims } : file;
};

/** Adds an open question ("Ask", slice 3d). `paths` must already be normalized. */
export const addQuestion = (file: TeamWriterFile, question: TeamStateQuestion): TeamWriterFile =>
  compactWriterFile(
    { ...file, questions: [...(file.questions ?? []), question] },
    question.askedAt,
  );

/** Drops a question once it is answered or no longer needed; the same file when it is not there. */
export const removeQuestion = (file: TeamWriterFile, questionId: string): TeamWriterFile =>
  file.questions?.some((question) => question.questionId === questionId) === true
    ? {
        ...file,
        questions: file.questions.filter((question) => question.questionId !== questionId),
      }
    : file;

/** Adds this writer's answer, replacing an earlier one to the same question. */
export const addAnswer = (
  file: TeamWriterFile,
  answer: {
    readonly questionId: string;
    readonly yes: boolean;
    readonly text: string | null;
    readonly answeredAt: string;
  },
): TeamWriterFile =>
  compactWriterFile(
    {
      ...file,
      answers: [
        ...(file.answers ?? []).filter((own) => own.questionId !== answer.questionId),
        answer,
      ],
    },
    answer.answeredAt,
  );
