// team-layer: the Team home page, "Today" when solo (team/UI_PLAN.md slice 4).
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { TeamHomeRoute } from "../components/team/TeamHomeRoute";

export interface TeamHomeSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

export const Route = createFileRoute("/team")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: (raw: Record<string, unknown>): TeamHomeSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId.length > 0
      ? { projectId: ProjectId.make(raw.projectId) }
      : {}),
  }),
  component: TeamHomeRouteView,
});

function TeamHomeRouteView() {
  const search = Route.useSearch();
  return <TeamHomeRoute environmentId={search.environmentId} projectId={search.projectId} />;
}
