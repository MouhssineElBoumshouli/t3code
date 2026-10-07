/**
 * team-layer: the holder marks (team/UI_PLAN.md slice 1). One small chip is
 * reused everywhere: a teammate's initials in their color, or a colored
 * square for another of the person's chats. Static: nothing animates.
 */
import {
  findProjectTeam,
  fileHolders,
  type TeamHolder,
  threadHolders,
} from "@t3tools/client-runtime/state/teamMarkers";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadShell } from "~/state/entities";
import { useTeamFeed } from "~/state/teamFeed";

/** Readable on light and dark backgrounds with white text. */
export const holderColor = (hue: number) => `hsl(${hue} 55% 45%)`;

/** A person's initials in their color. Its name goes on the surrounding tooltip or label. */
export function TeamFace(props: {
  readonly initials: string;
  readonly hue: number;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white leading-none",
        props.size === "md" ? "size-5 text-4xs" : "size-3.5 text-5xs",
        props.className,
      )}
      style={{ backgroundColor: holderColor(props.hue) }}
    >
      {props.initials}
    </span>
  );
}

/** Another of the person's chats, by its title; read only when the tooltip opens. */
function ChatName(props: { readonly holder: Extract<TeamHolder, { kind: "chat" }> }) {
  const shell = useThreadShell({
    environmentId: props.holder.environmentId,
    threadId: props.holder.threadId,
  });
  return <>your chat "{shell?.title ?? "another chat"}"</>;
}

const holderKey = (holder: TeamHolder) =>
  holder.kind === "member"
    ? `member:${holder.memberId}`
    : `chat:${holder.environmentId}/${holder.threadId}`;

/** Up to three holders, teammates first, with who they are in a tooltip. */
export function TeamHolderMarks(props: {
  readonly holders: ReadonlyArray<TeamHolder>;
  readonly className?: string;
}) {
  if (props.holders.length === 0) return null;
  const shown = props.holders.slice(0, 3);
  const more = props.holders.length - shown.length;
  const members = props.holders.filter((holder) => holder.kind === "member");
  const chats = props.holders.length - members.length;
  const label = `Also held by ${[
    ...members.map((holder) => holder.name),
    ...(chats > 0 ? [chats === 1 ? "another of your chats" : `${chats} of your chats`] : []),
  ].join(", ")}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-team-holders
            className={cn("inline-flex shrink-0 items-center gap-0.5", props.className)}
          />
        }
      >
        {shown.map((holder) =>
          holder.kind === "member" ? (
            <TeamFace key={holderKey(holder)} initials={holder.initials} hue={holder.hue} />
          ) : (
            <span
              key={holderKey(holder)}
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-xs"
              style={{ backgroundColor: holderColor(holder.hue) }}
            />
          ),
        )}
        {more > 0 ? <span className="text-3xs text-muted-foreground">+{more}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        Also held by{" "}
        {props.holders.map((holder, index) => (
          <span key={holderKey(holder)}>
            {index > 0 ? ", " : null}
            {holder.kind === "member" ? holder.name : <ChatName holder={holder} />}
          </span>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A sidebar thread's mark: who else holds files its claims cover. */
export const TeamThreadMarks = memo(function TeamThreadMarks(props: {
  readonly threadRef: ScopedThreadRef;
}) {
  const { environmentId, threadId } = props.threadRef;
  const teams = useTeamFeed(environmentId);
  const holders = useMemo(() => {
    for (const team of teams) {
      const found = threadHolders(team, { environmentId, threadId });
      if (found.length > 0) return found;
    }
    return [];
  }, [teams, environmentId, threadId]);
  return <TeamHolderMarks holders={holders} />;
});

/** An open file's tab mark: who else holds that file. */
export const TeamFileMarks = memo(function TeamFileMarks(props: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const { environmentId, threadId } = props.threadRef;
  const teams = useTeamFeed(environmentId);
  const shell = useThreadShell(props.threadRef);
  const projectId = shell?.projectId ?? null;
  const holders = useMemo(() => {
    const projectTeam = findProjectTeam(teams, projectId);
    return projectTeam === null
      ? []
      : fileHolders(projectTeam, props.relativePath, { environmentId, threadId });
  }, [teams, projectId, props.relativePath, environmentId, threadId]);
  return <TeamHolderMarks holders={holders} className="ml-1" />;
});
