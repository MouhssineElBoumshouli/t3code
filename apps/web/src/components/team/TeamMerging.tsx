/**
 * team-layer: merging help, slice 1 (team/MERGE_HELP_PLAN.md section 3). The
 * server's merge checks as lines: clashes and files to regenerate first, then
 * pairs that merge cleanly, each with when it was checked. Used by Team home
 * / Today's "Merging" section and the presence popover. Times are worded
 * when drawn; nothing ticks.
 */
import {
  mergePairPending,
  mergePairSentence,
  projectMergePairs,
} from "@t3tools/client-runtime/state/teamMerging";
import type { ProjectId, TeamFeedTeam, TeamMergePair } from "@t3tools/contracts";
import { Fragment } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

/** A pair's identity in a list: its chat and what it merges with. */
export const mergePairKey = (pair: TeamMergePair) =>
  `${pair.mine.thread.threadId}|${
    pair.other._tag === "branch"
      ? `${pair.other.memberId}/${pair.other.branch}`
      : pair.other._tag === "chat"
        ? pair.other.thread.threadId
        : pair.other.branch
  }`;

/** Text and `code` parts, each with where it starts (its key). */
function codeParts(text: string) {
  const parts: Array<{ text: string; code: boolean; start: number }> = [];
  let start = 0;
  for (const [index, part] of text.split("`").entries()) {
    parts.push({ text: part, code: index % 2 === 1, start });
    start += part.length + 1;
  }
  return parts;
}

/** A sentence with `code` spans. */
export function MergeSentence(props: { readonly text: string }) {
  const parts = codeParts(props.text);
  return (
    <>
      {parts.map((part) =>
        part.code ? (
          <code key={part.start} className="font-mono text-2xs">
            {part.text}
          </code>
        ) : (
          <Fragment key={part.start}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** One pair: a dot by status, the sentence, and when it was checked. */
export function MergePairLine(props: {
  readonly team: TeamFeedTeam;
  readonly pair: TeamMergePair;
  readonly pathPrefix: string;
}) {
  const { team, pair } = props;
  const pending = mergePairPending(team, pair);
  return (
    <li className="flex items-start gap-2 text-xs" data-team-merge={pair.status}>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          pair.status === "clash"
            ? "bg-warning"
            : pair.status === "regenerate"
              ? "bg-muted-foreground"
              : "bg-success",
        )}
      />
      <span className="min-w-0">
        <MergeSentence text={mergePairSentence(team, pair, props.pathPrefix)} />
        <span className="text-muted-foreground">
          {" "}
          · {pending ?? `checked ${formatRelativeTimeLabel(pair.checkedAt)}`}
        </span>
      </span>
    </li>
  );
}

/** The "Merging" section's body on Team home / Today. */
export function TeamMergingList(props: {
  readonly team: TeamFeedTeam;
  readonly projectId: ProjectId;
  readonly pathPrefix: string;
}) {
  const { team } = props;
  if (team.merging?.unavailable !== undefined) {
    return <p className="text-xs text-muted-foreground">{team.merging.unavailable}</p>;
  }
  // Clashes first, as the server orders them.
  const pairs = projectMergePairs(team, props.projectId);
  if (pairs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {team.solo
          ? "Nothing to report. After each turn, chats with their own worktree are combined with each other and with the main branch to find clashes before you merge."
          : "Nothing to report. After each turn, your chats are combined with teammates' pushed branches and the main branch to find clashes before you merge."}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {pairs.map((pair) => (
        <MergePairLine
          key={mergePairKey(pair)}
          team={team}
          pair={pair}
          pathPrefix={props.pathPrefix}
        />
      ))}
    </ul>
  );
}
