/**
 * How a session of any AI starts tunelo's own MCP: `tunelo mcp` over stdio
 * with the session's ticket and tunelo's config folder. It holds no token;
 * the service adds them. Each adapter puts this in its AI's own MCP config
 * shape (Claude's SDK record, ACP's `mcpServers` list).
 */
import { selfCommand } from "../service.ts";
import { ADVISOR_MCP_ENV, ADVISOR_WEIGH_MCP_ENV, HTTP_TICKET_ENV, type SessionMcp, TICKET_ENV } from "./session-tickets.ts";

export type SessionMcpLaunch = { command: string; args: string[]; env: Record<string, string> };

export function sessionMcpLaunch(mcp: Pick<SessionMcp, "ticket" | "configDir" | "advisorSession" | "advisorWeighOnly">): SessionMcpLaunch {
	const [command = process.execPath, ...args] = selfCommand("mcp");
	const env: Record<string, string> = { [TICKET_ENV]: mcp.ticket, TUNELO_HOME: mcp.configDir };
	if (mcp.advisorSession) env[ADVISOR_MCP_ENV] = "1";
	if (mcp.advisorWeighOnly) env[ADVISOR_WEIGH_MCP_ENV] = "1";
	return { command, args, env };
}

/** tunelo's MCP over the service's HTTP endpoint, as an AI's MCP config names it. */
export type SessionMcpHttp = {
	config: { type: "http"; url: string; headers: Record<string, string> };
	/** What the AI's process needs in its environment: the ticket, which the config names as `${TUNELO_MCP_HTTP_TICKET}`. */
	env: Record<string, string>;
};

/**
 * tunelo's MCP for a session over the service's own endpoint, when the service
 * serves one; undefined otherwise (the session starts `tunelo mcp`). The
 * ticket goes into the AI's environment and the config only names it, so it
 * never shows in a process list (Claude Code expands `${VAR}` in headers).
 */
export function sessionMcpHttp(mcp: Pick<SessionMcp, "ticket" | "url">): SessionMcpHttp | undefined {
	if (!mcp.url) return undefined;
	return {
		config: { type: "http", url: mcp.url, headers: { Authorization: `Bearer \${${HTTP_TICKET_ENV}}` } },
		env: { [HTTP_TICKET_ENV]: mcp.ticket },
	};
}

/** Hosts a proxy must never carry: the service's endpoint is on loopback. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

/**
 * NO_PROXY (both spellings) with loopback added to what `env` already says.
 * Claude Code sends an http MCP through HTTP(S)_PROXY, Authorization header
 * and all, unless NO_PROXY names the host (tried with 2.1.330).
 */
export function loopbackNoProxy(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const given = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((h) => h.trim()).filter(Boolean);
	const value = [...given, ...LOOPBACK_HOSTS.filter((h) => !given.includes(h))].join(",");
	return { NO_PROXY: value, no_proxy: value };
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
