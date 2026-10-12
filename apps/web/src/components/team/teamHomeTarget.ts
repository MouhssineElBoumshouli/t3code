// team-layer: which project the Team home / Today entries open (team/UI_PLAN.md slice 4).
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * The open chat's project, a new unsent chat's included; else the page's own
 * (on `/team` itself); else the fallback. Empty lets the page pick one.
 */
export function teamHomeTarget(input: {
  readonly thread: ProjectRef | null | undefined;
  readonly draft: ProjectRef | null | undefined;
  readonly page?: Partial<ProjectRef>;
  readonly fallback?: ProjectRef | null;
}): Partial<ProjectRef> {
  const chat = input.thread ?? input.draft;
  if (chat) return { environmentId: chat.environmentId, projectId: chat.projectId };
  if (input.page?.environmentId !== undefined && input.page.projectId !== undefined) {
    return { environmentId: input.page.environmentId, projectId: input.page.projectId };
  }
  return input.fallback
    ? { environmentId: input.fallback.environmentId, projectId: input.fallback.projectId }
    : {};
}
