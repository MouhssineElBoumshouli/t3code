/**
 * team-layer: the plan card (team/UI_PLAN.md slice 2). In the agent's message,
 * the files it said it would change before editing, each with who else held
 * it when the plan was checked. A record, so it never updates: the marks in
 * the file tree and sidebar show who holds what now.
 */
import { planHolders } from "@t3tools/client-runtime/state/teamMarkers";
import type { TeamPlanActivityPayload } from "@t3tools/contracts";
import { teamPlanSummary } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { MiddleTruncate } from "~/components/ui/middle-truncate";

import { TeamHolderMarks, TeamHolderNames } from "./TeamHolderMarks";

export const TeamPlanCard = memo(function TeamPlanCard(props: {
  readonly plan: TeamPlanActivityPayload;
  readonly resolvedTheme: "light" | "dark";
}) {
  const files = useMemo(
    () => props.plan.files.map((file) => ({ path: file.path, holders: planHolders(file.holders) })),
    [props.plan],
  );
  const held = files.filter((file) => file.holders.length > 0).length;
  return (
    <section
      aria-label="Planned files"
      data-team-plan
      className="rounded-lg bg-secondary text-xs dark:bg-input/20"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2 pb-1.5">
        <span className="font-medium text-foreground">{teamPlanSummary(files.length)}</span>
        <span className="text-muted-foreground">
          {held === 0
            ? `${props.plan.solo ? "no other chat holds" : "nobody else holds"} ${files.length === 1 ? "it" : "them"}`
            : `${held} held ${props.plan.solo ? "by another chat" : "by others"}`}
        </span>
      </div>
      <ul className="pb-1.5">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 px-3 py-0.5">
            <PierreEntryIcon
              pathValue={file.path}
              kind="file"
              theme={props.resolvedTheme}
              className="size-3.5 shrink-0 text-muted-foreground/70"
            />
            <span className="flex min-w-0 font-mono text-foreground/85">
              <MiddleTruncate value={file.path} />
            </span>
            {file.holders.length > 0 ? (
              <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 text-muted-foreground">
                <TeamHolderMarks holders={file.holders} />
                <span className="truncate">
                  held by <TeamHolderNames holders={file.holders} />
                </span>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {props.plan.shared ? null : (
        <p className="border-t border-border/60 px-3 py-1.5 text-muted-foreground">
          Not shared yet: the team's remote could not be reached, so teammates' newest claims may be
          missing.
        </p>
      )}
    </section>
  );
});
