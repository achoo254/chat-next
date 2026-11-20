/**
 * How a session of any AI starts tunelo's own MCP: `tunelo mcp` over stdio
 * with the session's ticket and tunelo's config folder. It holds no token;
 * the service adds them. Each adapter puts this in its AI's own MCP config
 * shape (Claude's SDK record, ACP's `mcpServers` list).
 */
import { selfCommand } from "../service.ts";
import { ADVISOR_MCP_ENV, ADVISOR_WEIGH_MCP_ENV, type SessionMcp, TICKET_ENV } from "./session-tickets.ts";

export type SessionMcpLaunch = { command: string; args: string[]; env: Record<string, string> };

export function sessionMcpLaunch(mcp: Pick<SessionMcp, "ticket" | "configDir" | "advisorSession" | "advisorWeighOnly">): SessionMcpLaunch {
	const [command = process.execPath, ...args] = selfCommand("mcp");
	const env: Record<string, string> = { [TICKET_ENV]: mcp.ticket, TUNELO_HOME: mcp.configDir };
	if (mcp.advisorSession) env[ADVISOR_MCP_ENV] = "1";
	if (mcp.advisorWeighOnly) env[ADVISOR_WEIGH_MCP_ENV] = "1";
	return { command, args, env };
}

/** Thread ids that may go into the argv of `tunelo advisor note` and `tunelo advisor stop` (the core's own UUIDs). */
const NOTE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The argv that prints Advisor's note for a message of the thread's CLI in a
 * terminal (`tunelo advisor note <thread>`, reading the hook's JSON on
 * stdin); undefined for an id that is not plainly one.
 */
export function advisorNoteCommand(threadId: string): string[] | undefined {
	return NOTE_THREAD_ID.test(threadId) ? selfCommand("advisor", "note", threadId) : undefined;
}

/**
 * The argv of the check made as the thread's CLI in a terminal ends a turn
 * (`tunelo advisor stop <thread>`, reading the hook's JSON on stdin); undefined
 * for an id that is not plainly one.
 */
export function advisorStopCommand(threadId: string): string[] | undefined {
	return NOTE_THREAD_ID.test(threadId) ? selfCommand("advisor", "stop", threadId) : undefined;
}
