/**
 * How a session of any AI starts tunelo's own MCP: `tunelo mcp` over stdio
 * with the session's ticket and tunelo's config folder. It holds no token;
 * the service adds them. Each adapter puts this in its AI's own MCP config
 * shape (Claude's SDK record, ACP's `mcpServers` list).
 */
import { selfCommand } from "../service.ts";
import { type SessionMcp, TICKET_ENV } from "./session-tickets.ts";

export type SessionMcpLaunch = { command: string; args: string[]; env: Record<string, string> };

export function sessionMcpLaunch(mcp: Pick<SessionMcp, "ticket" | "configDir">): SessionMcpLaunch {
	const [command = process.execPath, ...args] = selfCommand("mcp");
	return { command, args, env: { [TICKET_ENV]: mcp.ticket, TUNELO_HOME: mcp.configDir } };
}
