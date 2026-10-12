// team-layer: the seed scripts give each demo folder its own team.
import { TeamId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import { demoTeamId, demoTeamName } from "./teamDemoRepo.ts";

const isTeamId = Schema.is(TeamId);

describe("demoTeamId", () => {
  it("gives each demo folder its own team, and the same one on a re-run", () => {
    const fifteen = demoTeamId("/home/me/code/team-demo15");
    assert.notStrictEqual(fifteen, demoTeamId("/home/me/code/team-demo16"));
    assert.notStrictEqual(fifteen, demoTeamId("/home/other/team-demo15"));
    assert.strictEqual(fifteen, demoTeamId("/home/me/code/team-demo15/"));
    assert.match(fifteen, /^team-demo15-[0-9a-f]{8}$/u);
    assert.isTrue(isTeamId(fifteen));
  });

  it("names the team after the demo's number", () => {
    assert.strictEqual(demoTeamName("/home/me/code/team-demo15"), "Demo team 15");
    assert.strictEqual(demoTeamName("/home/me/code/pinboard"), "pinboard");
  });
});
