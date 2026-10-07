/**
 * team-layer: the presence chip in the chat header (team/UI_PLAN.md slice 1,
 * Option B's chip). Teammates' faces and whether the team state is current;
 * a click opens who is on what and the latest handoff notes. Solo projects
 * show nothing here. Times are worded when drawn; nothing ticks.
 */
import { findProjectTeam, teammatesOf } from "@t3tools/client-runtime/state/teamMarkers";
import type { EnvironmentId, ProjectId, TeamFeedTeam } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useTeamFeed } from "~/state/teamFeed";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { TeamFace } from "./TeamHolderMarks";

/** What the chip says about the team state. */
export function syncLabel(sync: TeamFeedTeam["sync"]): { text: string; warn: boolean } {
  switch (sync.status) {
    case "synced":
      return { text: sync.unshared ? "sharing…" : "synced", warn: false };
    case "offline":
      return { text: "offline", warn: true };
    case "notFresh":
      return { text: "not fresh", warn: true };
    case "solo":
      return { text: "on this computer", warn: false };
  }
}

const syncSentence = (sync: TeamFeedTeam["sync"]) => {
  const since = sync.readAt === null ? "" : ` Last read ${formatRelativeTimeLabel(sync.readAt)}.`;
  switch (sync.status) {
    case "synced":
      return sync.unshared
        ? "Up to date with the team. Your latest change is still being shared."
        : "Up to date with the team.";
    case "offline":
      return `The team's repo could not be reached; this is the last state seen.${since} Your changes are shared when it is back.`;
    case "notFresh":
      return `The team state could not be read just now; this is the last state read.${since}`;
    case "solo":
      return "Kept on this computer.";
  }
};

const MAX_FACES = 3;
const MAX_PATHS = 3;

export const TeamPresenceChip = memo(function TeamPresenceChip(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const teams = useTeamFeed(props.environmentId);
  const team = useMemo(
    () => findProjectTeam(teams, props.projectId)?.team ?? null,
    [teams, props.projectId],
  );
  const teammates = useMemo(() => (team === null ? [] : teammatesOf(team)), [team]);
  // Solo: no faces, no empty team UI.
  if (team === null || team.solo) return null;
  const label = syncLabel(team.sync);
  const names = (memberId: string) =>
    team.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-team-presence
            aria-label={`Team ${team.name}: ${teammates.length} teammates, ${label.text}`}
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {teammates.length > 0 ? (
          <span className="flex items-center -space-x-1">
            {teammates.slice(0, MAX_FACES).map((teammate) => (
              <TeamFace
                key={teammate.member.memberId}
                initials={teammate.initials}
                hue={teammate.hue}
                className="ring-1 ring-background"
              />
            ))}
            {teammates.length > MAX_FACES ? (
              <span className="pl-1.5 text-3xs">+{teammates.length - MAX_FACES}</span>
            ) : null}
          </span>
        ) : null}
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", label.warn ? "bg-warning" : "bg-success")}
          />
          {label.text}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <PopoverTitle>{team.name}</PopoverTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">{syncSentence(team.sync)}</p>

        <div className="mt-3 flex flex-col gap-2.5">
          {teammates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No teammates yet. People with push access to the repo join by opening the project.
            </p>
          ) : (
            teammates.map((teammate) => {
              const paths = [...new Set(teammate.claims.flatMap((claim) => claim.paths))];
              return (
                <div key={teammate.member.memberId} className="flex items-start gap-2">
                  <TeamFace initials={teammate.initials} hue={teammate.hue} size="md" />
                  <div className="min-w-0 flex-1 text-xs">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-foreground">
                        {teammate.member.displayName}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        seen {formatRelativeTimeLabel(teammate.member.lastSeenAt)}
                      </span>
                    </div>
                    {teammate.tasks.map((task) => (
                      <div key={task.taskId} className="truncate text-muted-foreground">
                        {task.title}
                      </div>
                    ))}
                    <div className="truncate font-mono text-2xs text-muted-foreground">
                      {paths.length === 0
                        ? "holds nothing"
                        : `holds ${paths.slice(0, MAX_PATHS).join(", ")}${
                            paths.length > MAX_PATHS ? ` +${paths.length - MAX_PATHS}` : ""
                          }`}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {team.handoffs.length > 0 ? (
          <div className="mt-3 border-t border-border/60 pt-2">
            <div className="mb-1 text-2xs font-medium text-muted-foreground">Latest handoffs</div>
            {team.handoffs.map((note) => (
              <div key={note.handoffId} className="py-0.5 text-xs">
                <span className="font-medium text-foreground">{names(note.memberId)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {formatRelativeTimeLabel(note.createdAt)}:{" "}
                </span>
                <span className="text-foreground/90">{note.headline}</span>
              </div>
            ))}
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
