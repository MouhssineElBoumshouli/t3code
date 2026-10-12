// team-layer: which project the Team home / Today entries open.
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { teamHomeTarget } from "./teamHomeTarget";

const ref = (projectId: string) => ({
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make(projectId),
});

describe("teamHomeTarget", () => {
  it("opens a new unsent chat's project, not the first project", () => {
    expect(teamHomeTarget({ thread: null, draft: ref("draft"), fallback: ref("first") })).toEqual(
      ref("draft"),
    );
  });

  it("prefers the open chat, then the page's own project, then the fallback", () => {
    expect(teamHomeTarget({ thread: ref("chat"), draft: ref("draft"), page: ref("page") })).toEqual(
      ref("chat"),
    );
    expect(
      teamHomeTarget({ thread: null, draft: null, page: ref("page"), fallback: ref("first") }),
    ).toEqual(ref("page"));
    expect(teamHomeTarget({ thread: null, draft: null, fallback: ref("first") })).toEqual(
      ref("first"),
    );
    expect(teamHomeTarget({ thread: null, draft: null })).toEqual({});
  });
});
