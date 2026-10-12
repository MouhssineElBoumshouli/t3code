/**
 * team-layer: the sidebar icon row's entry to the Team home page, "Today" when
 * solo (team/UI_PLAN.md slice 4). It opens the page for the project of the
 * open chat (or of the page itself); elsewhere the page picks a project.
 */
import { findProjectTeam } from "@t3tools/client-runtime/state/teamMarkers";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { HouseIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import { useThreadShell } from "~/state/entities";
import { useTeamFeed } from "~/state/teamFeed";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TeamHomeRailItem = memo(function TeamHomeRailItem() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const params = useParams({ strict: false });
  const shell = useThreadShell(
    params.environmentId !== undefined && params.threadId !== undefined
      ? {
          environmentId: EnvironmentId.make(params.environmentId),
          threadId: ThreadId.make(params.threadId),
        }
      : null,
  );
  // On the page itself, its own project.
  const search = useSearch({ strict: false });
  const environmentId = shell?.environmentId ?? search.environmentId ?? null;
  const projectId = shell?.projectId ?? search.projectId ?? null;
  const teams = useTeamFeed(environmentId);
  const isTeam = findProjectTeam(teams, projectId)?.team.solo === false;
  const label = isTeam ? "Team home" : "Today";

  const open = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/team",
      search: environmentId !== null && projectId !== null ? { environmentId, projectId } : {},
    });
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={open} size="icon" data-team-home-entry>
              {isTeam ? <UsersIcon /> : <HouseIcon />}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});
