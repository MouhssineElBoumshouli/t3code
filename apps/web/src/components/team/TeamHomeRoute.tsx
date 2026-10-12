/**
 * team-layer: picks the project for the Team home page (team/UI_PLAN.md slice 4).
 * Entry points pass the project of the chat you came from; without one, the
 * page opens the primary environment's first project the team layer has open,
 * else its first project.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useTeamFeed } from "~/state/teamFeed";

import { SidebarInset } from "../ui/sidebar";
import { TeamHomePage } from "./TeamHomePage";

export function TeamHomeRoute(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly projectId: ProjectId | undefined;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  const projects = useProjects();
  const teams = useTeamFeed(environmentId);
  const projectId = useMemo(() => {
    if (props.projectId !== undefined) return props.projectId;
    const here = projects.filter((project) => project.environmentId === environmentId);
    const inFeed = new Set(teams.flatMap((team) => team.projects.map((p) => p.projectId)));
    return (here.find((project) => inFeed.has(project.id)) ?? here[0])?.id ?? null;
  }, [props.projectId, projects, environmentId, teams]);

  if (environmentId === null || projectId === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 items-center justify-center">
        <p className="text-sm text-muted-foreground">Add a project to see its day here.</p>
      </SidebarInset>
    );
  }
  // Keyed so a different project starts with its own "since you were last here".
  return (
    <TeamHomePage
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId}
      projectId={projectId}
    />
  );
}
