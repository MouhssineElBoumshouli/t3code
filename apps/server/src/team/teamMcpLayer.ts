/**
 * The team tools on T3's `/mcp` server (fork-only, team/DESIGN.md D5), added
 * next to upstream's toolkits: `server.ts` builds this on top of
 * `McpHttpServer.layer`, which stays exactly upstream's.
 *
 * @module teamMcpLayer
 */
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as TeamHandlers from "../mcp/toolkits/team/handlers.ts";
import { TeamToolkit } from "../mcp/toolkits/team/tools.ts";

export const layer = toolkitRegistration(TeamToolkit, TeamHandlers.layer);
