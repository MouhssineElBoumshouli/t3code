/**
 * team-layer: the sidebar icon row's entry to the Team home page, "Today" when
 * solo (team/UI_PLAN.md slice 4). It opens the page for the project of the
 * open chat, a new unsent one included (or of the page itself); elsewhere the
 * page picks a project.
 */
import { findProjectTeam } from "@t3tools/client-runtime/state/teamMarkers";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { HouseIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTeamFeed } from "~/state/teamFeed";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { teamHomeTarget } from "./teamHomeTarget";

export const TeamHomeRailItem = memo(function TeamHomeRailItem() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { activeThread, activeDraftThread } = useHandleNewThread();
  const target = teamHomeTarget({
    thread: activeThread,
    draft: activeDraftThread,
    page: useSearch({ strict: false }),
  });
  const environmentId = target.environmentId ?? null;
  const projectId = target.projectId ?? null;
  const teams = useTeamFeed(environmentId);
  const isTeam = findProjectTeam(teams, projectId)?.team.solo === false;
  const label = isTeam ? "Team home" : "Today";

  const open = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/team",
      search: target,
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
