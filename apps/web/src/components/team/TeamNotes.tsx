/**
 * team-layer: notes on Team home / Today (team/UI_PLAN.md slice 4). Team: for
 * everyone, for you, from you (with who has seen it); solo: notes to future
 * you. The person a note is for can reply and mark it done; done notes fold
 * away. A note can sit on a file or folder and be marked for agents.
 *
 * Everything comes from the team feed; each action is one `team.note` call,
 * and the feed brings the result back.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  holderHue,
  holderInitials,
  teamMemberName,
} from "@t3tools/client-runtime/state/teamMarkers";
import {
  notePathInProject,
  projectPathToTeamPath,
  teamNoteLists,
} from "@t3tools/client-runtime/state/teamNotes";
import {
  canMarkTeamNoteDone,
  type EnvironmentId,
  TEAM_NOTE_LIMITS,
  type TeamFeedTeam,
  type TeamMemberId,
  type TeamNote,
  type TeamNoteInput,
} from "@t3tools/contracts";
import { BotIcon, FileIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { teamFeed } from "~/state/teamFeed";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { TeamFace } from "./TeamHolderMarks";

const EVERYONE = "everyone";

/** One note action; a failure shows as a toast. Resolves true when it was saved. */
function useNoteAction(environmentId: EnvironmentId) {
  const note = useAtomCommand(teamFeed.note, { reportFailure: false });
  return useCallback(
    (input: TeamNoteInput, failedTitle: string | null) =>
      note({ environmentId, input }).then((result) => {
        if (result._tag !== "Failure") return true;
        if (failedTitle !== null && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: failedTitle,
            description: error instanceof Error ? error.message : "Try again.",
          });
        }
        return false;
      }),
    [note, environmentId],
  );
}

const nameOf = (team: TeamFeedTeam, memberId: TeamMemberId) => teamMemberName(team, memberId);

/** The three lists (team) or one (solo), the done ones folded, and the form. */
export function TeamNotes(props: {
  readonly environmentId: EnvironmentId;
  readonly team: TeamFeedTeam;
  readonly pathPrefix: string;
}) {
  const { environmentId, team, pathPrefix } = props;
  const act = useNoteAction(environmentId);
  const lists = teamNoteLists(team);
  const [showDone, setShowDone] = useState(false);

  // Notes for this person count as seen once the page shows them; each is sent once.
  const sentSeen = useRef(new Set<string>());
  const teamId = team.teamId;
  const unseenKey = lists.unseen.map((note) => note.noteId).join(",");
  useEffect(() => {
    const noteIds = unseenKey
      .split(",")
      .filter((noteId) => noteId !== "" && !sentSeen.current.has(noteId));
    if (noteIds.length === 0) return;
    for (const noteId of noteIds) sentSeen.current.add(noteId);
    void act({ _tag: "seen", teamId, noteIds }, null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Keyed by the ids, not the new array each push brings.
  }, [unseenKey, act, teamId]);

  const item = (note: TeamNote, from: boolean) => (
    <NoteItem
      key={note.noteId}
      note={note}
      team={team}
      pathPrefix={pathPrefix}
      showSeen={from}
      act={act}
    />
  );

  return (
    <div className="flex flex-col gap-3" data-team-notes>
      <p className="text-xs text-muted-foreground">
        {team.solo
          ? "Notes to future you. Kept on this computer; if this project becomes a team, the team can read them."
          : "Not private: notes are kept in the team state in this repo, so anyone with access to the repo can read them."}
      </p>
      <NoteForm team={team} pathPrefix={pathPrefix} act={act} />
      {team.solo ? (
        <NoteList title="Notes to future me" count={lists.forYou.length}>
          {lists.forYou.map((note) => item(note, false))}
        </NoteList>
      ) : (
        <>
          <NoteList title="For you" count={lists.forYou.length} badge>
            {lists.forYou.map((note) => item(note, false))}
          </NoteList>
          <NoteList title="For everyone" count={lists.forEveryone.length}>
            {lists.forEveryone.map((note) => item(note, false))}
          </NoteList>
          <NoteList title="From you" count={lists.fromYou.length}>
            {lists.fromYou.map((note) => item(note, true))}
          </NoteList>
        </>
      )}
      {lists.done.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Button
            size="compact"
            variant="ghost-muted"
            className="self-start"
            aria-expanded={showDone}
            onClick={() => setShowDone((shown) => !shown)}
          >
            {showDone ? "Hide done" : `Done (${lists.done.length})`}
          </Button>
          {showDone ? (
            <ul className="flex flex-col gap-2 opacity-75">
              {lists.done.map((note) => item(note, note.from === team.me))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function NoteList(props: {
  readonly title: string;
  readonly count: number;
  /** Count open notes in a badge, like the presence chip's questions. */
  readonly badge?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {props.title}
        {props.badge && props.count > 0 ? (
          <Badge variant="warning">
            {props.count} {props.count === 1 ? "note" : "notes"}
          </Badge>
        ) : null}
      </h3>
      {props.count === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="flex flex-col gap-2">{props.children}</ul>
      )}
    </div>
  );
}

function NoteItem(props: {
  readonly note: TeamNote;
  readonly team: TeamFeedTeam;
  readonly pathPrefix: string;
  /** From you: say who has seen it. */
  readonly showSeen: boolean;
  readonly act: ReturnType<typeof useNoteAction>;
}) {
  const { note, team, act } = props;
  const me = team.me;
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);
  const path = notePathInProject(note, props.pathPrefix);
  const done = note.doneAt !== null;
  const canDone = me !== null && canMarkTeamNoteDone(note, me);
  const mine = note.from === me;
  // The person it is for replies; the author answers a reply.
  const canReply = !done && !team.solo && (note.to === me || note.to === null || mine);
  const from = nameOf(team, note.from);
  const to = note.to === null ? "everyone" : note.to === me ? "you" : nameOf(team, note.to);

  const run = (input: TeamNoteInput, failedTitle: string) => {
    setPending(true);
    return act(input, failedTitle).then((saved) => {
      setPending(false);
      return saved;
    });
  };
  const sendReply = () => {
    const text = reply.trim();
    if (text.length === 0) return;
    void run(
      { _tag: "reply", teamId: team.teamId, noteId: note.noteId, text },
      "Your reply was not sent",
    ).then((saved) => {
      if (!saved) return;
      setReply("");
      setReplying(false);
    });
  };

  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border border-border/70 p-2.5 text-xs"
      data-team-note
    >
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {team.solo ? null : (
          <>
            <TeamFace
              initials={holderInitials(
                team.members.find((member) => member.memberId === note.from)?.displayName ??
                  note.from,
              )}
              hue={holderHue(`member:${note.from}`)}
            />
            <span className="font-medium text-foreground">{from}</span>
            <span>to {to}</span>
            <span>·</span>
          </>
        )}
        <span>{formatRelativeTimeLabel(note.createdAt)}</span>
        {path === null ? null : (
          <span className="inline-flex items-center gap-1">
            <FileIcon aria-hidden className="size-3" />
            <code className="font-mono text-foreground/90">{path}</code>
          </span>
        )}
        {note.forAgents ? (
          <Badge variant="info">
            <BotIcon aria-hidden />
            Agents know this
          </Badge>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-foreground">{note.text}</p>
      {note.replies.length === 0 ? null : (
        <ul className="flex flex-col gap-1 border-l-2 border-border pl-2">
          {note.replies.map((answer) => (
            <li key={answer.replyId}>
              <span className="font-medium">{nameOf(team, answer.by)}:</span>{" "}
              <span className="whitespace-pre-wrap break-words">{answer.text}</span>
            </li>
          ))}
        </ul>
      )}
      {props.showSeen && !team.solo ? (
        <p className="text-muted-foreground">
          {note.seenBy.length === 0
            ? "Not seen yet"
            : `Seen by ${note.seenBy.map((memberId) => nameOf(team, memberId)).join(", ")}`}
        </p>
      ) : null}
      {done ? (
        <p className="text-muted-foreground">
          Done{note.doneBy === null || team.solo ? "" : ` by ${nameOf(team, note.doneBy)}`}{" "}
          {formatRelativeTimeLabel(note.doneAt!)}
        </p>
      ) : null}
      {replying ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            size="compact"
            className="min-w-40 flex-1"
            placeholder="Reply"
            aria-label="Your reply"
            maxLength={TEAM_NOTE_LIMITS.text}
            value={reply}
            disabled={pending}
            autoFocus
            onValueChange={setReply}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendReply();
              if (event.key === "Escape") setReplying(false);
            }}
          />
          <Button size="compact" variant="outline" disabled={pending} onClick={sendReply}>
            Send
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {canReply && !replying ? (
          <Button size="compact" variant="ghost-muted" onClick={() => setReplying(true)}>
            Reply
          </Button>
        ) : null}
        {canDone ? (
          <Button
            size="compact"
            variant="ghost-muted"
            disabled={pending}
            onClick={() =>
              void run(
                { _tag: "done", teamId: team.teamId, noteId: note.noteId, done: !done },
                "The note was not changed",
              )
            }
          >
            {done ? "Open again" : "Mark done"}
          </Button>
        ) : null}
        {mine ? (
          <Button
            size="compact"
            variant="ghost-destructive"
            disabled={pending}
            onClick={() =>
              void run(
                { _tag: "remove", teamId: team.teamId, noteId: note.noteId },
                "The note was not removed",
              )
            }
          >
            Remove
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function NoteForm(props: {
  readonly team: TeamFeedTeam;
  readonly pathPrefix: string;
  readonly act: ReturnType<typeof useNoteAction>;
}) {
  const { team, act } = props;
  const [text, setText] = useState("");
  const [to, setTo] = useState<string>(EVERYONE);
  const [path, setPath] = useState("");
  const [forAgents, setForAgents] = useState(false);
  const [pending, setPending] = useState(false);
  const teammates = team.members.filter((member) => member.memberId !== team.me);
  const hasPath = path.trim().length > 0;

  const send = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const recipient = teammates.find((member) => member.memberId === to)?.memberId ?? null;
    setPending(true);
    void act(
      {
        _tag: "write",
        teamId: team.teamId,
        text: trimmed,
        to: team.solo ? null : recipient,
        ...(hasPath ? { path: projectPathToTeamPath(path, props.pathPrefix) } : {}),
        forAgents: hasPath && forAgents,
      },
      "The note was not saved",
    ).then((saved) => {
      setPending(false);
      if (!saved) return;
      setText("");
      setPath("");
      setForAgents(false);
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
      <Textarea
        size="sm"
        rows={2}
        placeholder={team.solo ? "A note to future you" : "A note to the team or one teammate"}
        aria-label="Note"
        maxLength={TEAM_NOTE_LIMITS.text}
        value={text}
        disabled={pending}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {team.solo ? null : (
          <div className="w-44">
            <Select
              value={to}
              items={Object.fromEntries([
                [EVERYONE, "For everyone"],
                ...teammates.map((member) => [member.memberId, `For ${member.displayName}`]),
              ])}
              onValueChange={(value) => setTo(typeof value === "string" ? value : EVERYONE)}
            >
              <SelectTrigger size="sm" aria-label="Who the note is for">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={EVERYONE}>For everyone</SelectItem>
                {teammates.map((member) => (
                  <SelectItem key={member.memberId} value={member.memberId}>
                    For {member.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
        <Input
          size="compact"
          className="min-w-40 flex-1"
          placeholder="On a file or folder (optional), e.g. src/db"
          aria-label="File or folder the note is about (optional)"
          value={path}
          disabled={pending}
          onValueChange={setPath}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={hasPath && forAgents}
            disabled={!hasPath || pending}
            onCheckedChange={(checked) => setForAgents(checked === true)}
          />
          Agents should know this
          <span className="text-muted-foreground">
            {hasPath
              ? "· told to an agent when it plans or edits there, once per chat"
              : "· needs a file or folder"}
          </span>
        </label>
        <Button size="compact" disabled={pending || text.trim().length === 0} onClick={send}>
          {pending ? "Saving…" : "Add note"}
        </Button>
      </div>
    </div>
  );
}
