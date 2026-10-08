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

/** "Also held by Yassine, your chat "Search page"", for a tooltip. */
export function TeamHoldersText(props: { readonly holders: ReadonlyArray<TeamHolder> }) {
  return (
    <>
      Also held by{" "}
      {props.holders.map((holder, index) => (
        <span key={holderKey(holder)}>
          {index > 0 ? ", " : null}
          {holder.kind === "member" ? holder.name : <ChatName holder={holder} />}
        </span>
      ))}
    </>
  );
}

/**
 * Up to three holders, teammates first. With `tooltip`, who they are shows on
 * hover; inside another tooltip's trigger (a sidebar row, a tab title) a
 * nested tooltip never opens, so there the outer tooltip carries
 * {@link TeamHoldersText} instead.
 */
export function TeamHolderMarks(props: {
  readonly holders: ReadonlyArray<TeamHolder>;
  readonly tooltip?: boolean;
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
  const chips = (
    <>
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
    </>
  );
  const marksProps = {
    role: "img",
    "aria-label": label,
    "data-team-holders": true,
    className: cn("inline-flex shrink-0 items-center gap-0.5", props.className),
  };
  if (props.tooltip === false) return <span {...marksProps}>{chips}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span {...marksProps} />}>{chips}</TooltipTrigger>
      <TooltipPopup side="top">
        <TeamHoldersText holders={props.holders} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** Who else holds files a thread's claims cover. */
export function useThreadHolders(threadRef: ScopedThreadRef): ReadonlyArray<TeamHolder> {
  const { environmentId, threadId } = threadRef;
  const teams = useTeamFeed(environmentId);
  return useMemo(() => {
    for (const team of teams) {
      const found = threadHolders(team, { environmentId, threadId });
      if (found.length > 0) return found;
    }
    return [];
  }, [teams, environmentId, threadId]);
}

/** Who else holds a file of the thread's project. */
export function useFileHolders(
  threadRef: ScopedThreadRef,
  relativePath: string,
): ReadonlyArray<TeamHolder> {
  const { environmentId, threadId } = threadRef;
  const teams = useTeamFeed(environmentId);
  const shell = useThreadShell(threadRef);
  const projectId = shell?.projectId ?? null;
  return useMemo(() => {
    const projectTeam = findProjectTeam(teams, projectId);
    return projectTeam === null
      ? []
      : fileHolders(projectTeam, relativePath, { environmentId, threadId });
  }, [teams, projectId, relativePath, environmentId, threadId]);
}

/** A sidebar thread's mark. The row's own tooltip names the holders ({@link TeamThreadHoldersLine}). */
export const TeamThreadMarks = memo(function TeamThreadMarks(props: {
  readonly threadRef: ScopedThreadRef;
}) {
  return <TeamHolderMarks holders={useThreadHolders(props.threadRef)} tooltip={false} />;
});

/** The holders line in a sidebar row's tooltip; rendered only while it is open. */
export function TeamThreadHoldersLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly className?: string;
}) {
  const holders = useThreadHolders(props.threadRef);
  if (holders.length === 0) return null;
  return (
    <div className={props.className}>
      <TeamHolderMarks holders={holders} tooltip={false} />
      <div className="min-w-0 wrap-break-word text-foreground/75">
        <TeamHoldersText holders={holders} />
      </div>
    </div>
  );
}

/** An open file's tab mark. The tab's own tooltip names the holders ({@link TeamFileHoldersLine}). */
export const TeamFileMarks = memo(function TeamFileMarks(props: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  return (
    <TeamHolderMarks
      holders={useFileHolders(props.threadRef, props.relativePath)}
      tooltip={false}
      className="ml-1"
    />
  );
});

/** The holders line in a file tab's tooltip; rendered only while it is open. */
export function TeamFileHoldersLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const holders = useFileHolders(props.threadRef, props.relativePath);
  if (holders.length === 0) return null;
  return (
    <div className="text-muted-foreground">
      <TeamHoldersText holders={holders} />
    </div>
  );
}
