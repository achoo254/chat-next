// What the AIs tunelo knows call advisor_weigh of tunelo's MCP. Without
// dependencies, so the office (which acts a call out as a visit to Advisor)
// does not load Advisor's tools.
import { SESSION_MCP_SERVER } from "../mcp/session-mcp-server.js";

/** Claude `mcp__tunelo__advisor_weigh`, agy `mcp_tunelo_advisor_weigh`. */
const WEIGH_NAMES = new Set([`mcp__${SESSION_MCP_SERVER}__advisor_weigh`, `mcp_${SESSION_MCP_SERVER}_advisor_weigh`]);

/** A tool call of an AI is advisor_weigh of tunelo's MCP. */
export function isAdvisorWeigh(aiToolName: string): boolean {
  return WEIGH_NAMES.has(aiToolName);
}
