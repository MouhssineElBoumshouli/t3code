/**
 * team-layer: holder marks in the file tree (team/UI_PLAN.md slice 1). The
 * tree draws a short text in its decoration lane: teammates' initials, or how
 * many of the person's chats hold the file. It reads the function from a ref,
 * so the tree is built once; `onChange` re-renders its rows when the marks change.
 */
import {
  fileHolders,
  findProjectTeam,
  type TeamHolder,
} from "@t3tools/client-runtime/state/teamMarkers";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useThreadShell } from "~/state/entities";
import { useTeamFeed } from "~/state/teamFeed";

export interface TeamTreeDecoration {
  readonly text: string;
  readonly title: string;
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
  // Keyed by the ids, not the ref object, which callers may rebuild each render.
  const environmentId = input.threadRef?.environmentId ?? null;
  const threadId = input.threadRef?.threadId ?? null;
  const decorate = useMemo(() => {
    const projectTeam = findProjectTeam(teams, projectId);
    if (projectTeam === null) return noDecoration;
    const viewing =
      environmentId === null || threadId === null ? null : { environmentId, threadId };
    return (path: string) => treeDecorationFor(fileHolders(projectTeam, path, viewing));
  }, [teams, projectId, environmentId, threadId]);
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
