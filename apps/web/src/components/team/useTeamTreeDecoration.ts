/**
 * team-layer: holder marks in the file tree (team/UI_PLAN.md slice 1). The
 * tree draws a short text in its decoration lane: teammates' initials, or how
 * many of the person's chats hold the file, and "✎" for an open note on it
 * (slice 4). Merge checks (MERGE_HELP_PLAN.md slice 1) add "clash" on a file
 * that would conflict, and a quiet "✓" on a holder's mark when their work
 * merges cleanly with this chat. It reads the function from a ref,
 * so the tree is built once; `onChange` re-renders its rows when the marks change.
 */
import {
  fileHolders,
  findProjectTeam,
  type TeamHolder,
  teamMemberName,
} from "@t3tools/client-runtime/state/teamMarkers";
import {
  type FileMergeMark,
  fileMergeMark,
  mergePairSentence,
  projectMergePairs,
  viewerMergePairs,
} from "@t3tools/client-runtime/state/teamMerging";
import { fileNotes } from "@t3tools/client-runtime/state/teamNotes";
import type { EnvironmentId, ScopedThreadRef, TeamFeedTeam, TeamNote } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useThreadShell } from "~/state/entities";
import { useTeamFeed } from "~/state/teamFeed";

export interface TeamTreeDecoration {
  readonly text: string;
  readonly title: string;
}

/** A note on the row (slice 4): "✎", and who left it in the tooltip. */
function notesDecoration(
  team: TeamFeedTeam,
  notes: ReadonlyArray<TeamNote>,
): TeamTreeDecoration | null {
  if (notes.length === 0) return null;
  const lines = notes.map((note) => {
    const from =
      team.solo || note.from === team.me
        ? "Your note"
        : `Note from ${teamMemberName(team, note.from)}`;
    const text = note.text.length > 80 ? `${note.text.slice(0, 79)}…` : note.text;
    return `${from}: "${text}"`;
  });
  return { text: notes.length === 1 ? "✎" : `✎${notes.length}`, title: lines.join("\n") };
}

/** Holder marks and note marks on one row, in one decoration. */
function joinDecorations(
  holders: TeamTreeDecoration | null,
  notes: TeamTreeDecoration | null,
): TeamTreeDecoration | null {
  if (holders === null || notes === null) return holders ?? notes;
  return { text: `${holders.text} ${notes.text}`, title: `${holders.title}\n${notes.title}` };
}

/** Adds what the merge checks say to the row's holder marks. */
function withMergeMark(
  team: TeamFeedTeam,
  holders: TeamTreeDecoration | null,
  mark: FileMergeMark | null,
  pathPrefix: string,
): TeamTreeDecoration | null {
  if (mark === null) return holders;
  const sentence = (pair: Parameters<typeof mergePairSentence>[1]) =>
    mergePairSentence(team, pair, pathPrefix).replaceAll("`", "");
  if (mark.clashes.length > 0) {
    const lines = [...new Set(mark.clashes.map(({ pair }) => sentence(pair)))];
    return {
      text: holders === null ? "clash" : `${holders.text} clash`,
      title: [...(holders === null ? [] : [holders.title]), ...lines].join("\n"),
    };
  }
  // Clean: quiet the holder's mark; nothing to add on a file nobody else holds.
  if (holders === null) return null;
  return {
    text: `${holders.text} ✓`,
    title: [holders.title, ...mark.clean.map(sentence)].join("\n"),
  };
}

/** The text and tooltip for one row's holders; null when nothing is marked. */
export function treeDecorationFor(holders: ReadonlyArray<TeamHolder>): TeamTreeDecoration | null {
  if (holders.length === 0) return null;
  const members = holders.filter((holder) => holder.kind === "member");
  const chats = holders.length - members.length;
  const parts = [
    ...members.slice(0, 2).map((holder) => holder.initials),
    ...(members.length > 2 ? [`+${members.length - 2}`] : []),
    ...(chats > 0 ? [chats === 1 ? "+1 chat" : `+${chats} chats`] : []),
  ];
  const names = [
    ...members.map((holder) => holder.name),
    ...(chats > 0 ? [chats === 1 ? "another of your chats" : `${chats} of your other chats`] : []),
  ];
  return { text: parts.join(" "), title: `Also held by ${names.join(", ")}` };
}

/** Styles for the decoration lane, added to the tree's own unsafe CSS. */
export const TEAM_TREE_DECORATION_CSS = `
[data-item-section="decoration"] > span {
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  white-space: nowrap;
}
`;

const noDecoration = (): TeamTreeDecoration | null => null;

export function useTeamTreeDecoration(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  /** Called after the marks changed, to re-render the tree's rows. */
  readonly onChange: () => void;
}) {
  const teams = useTeamFeed(input.environmentId);
  const shell = useThreadShell(input.threadRef);
  const projectId = shell?.projectId ?? null;
  const sharedCheckout = shell !== null && shell !== undefined && shell.worktreePath === null;
  // Keyed by the ids, not the ref object, which callers may rebuild each render.
  const environmentId = input.threadRef?.environmentId ?? null;
  const threadId = input.threadRef?.threadId ?? null;
  const decorate = useMemo(() => {
    const projectTeam = findProjectTeam(teams, projectId);
    if (projectTeam === null) return noDecoration;
    const viewing =
      environmentId === null || threadId === null ? null : { environmentId, threadId };
    const mergePairs = viewerMergePairs(
      projectMergePairs(projectTeam.team, projectId),
      viewing === null ? null : { ...viewing, sharedCheckout: sharedCheckout },
    );
    return (path: string) => {
      const holders = fileHolders(projectTeam, path, viewing);
      return joinDecorations(
        withMergeMark(
          projectTeam.team,
          treeDecorationFor(holders),
          fileMergeMark({ pairs: mergePairs, pathPrefix: projectTeam.pathPrefix, path, holders }),
          projectTeam.pathPrefix,
        ),
        notesDecoration(projectTeam.team, fileNotes(projectTeam, path)),
      );
    };
  }, [teams, projectId, environmentId, threadId, sharedCheckout]);
  const decorateRef = useRef(decorate);
  const onChangeRef = useRef(input.onChange);
  onChangeRef.current = input.onChange;
  useEffect(() => {
    if (decorateRef.current === decorate) return;
    decorateRef.current = decorate;
    onChangeRef.current();
  }, [decorate]);
  return decorateRef;
}
