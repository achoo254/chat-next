/**
 * The MCP tools of tunelo, by group: a static list, no registry. `tunelo
 * mcp` answers `initialize` and `tools/list` itself and forwards each call
 * over the control socket; the service runs it with its own sign-in, so no
 * token leaves it.
 *
 * - `tunnel`: the tools of the Tunelo CLI 1.x, run in the service.
 * - `chat`, `localman`: a few tools of the Chat and Localman MCP servers,
 *   which the service calls with the account's token for that app.
 *
 * `writeTools` act for the user where others see it (a message, a request,
 * a public tunnel). In a session tunelo opens, they always go through an
 * approval card unless the session runs in bypassPermissions (see
 * `needsApproval`). `twoStepTools` are write tools whose server first answers
 * a dry run with a `confirm_token`: only the call carrying it acts.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { AppName } from "../identity/session.ts";
import { failure } from "./mcp-result.js";
import { registerTunnelTools } from "./mcp-server.js";
import type { McpContext } from "./mcp-context.js";
import type { LocalTunnels } from "./local-tunnels.js";

export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolConfig {
	title: string;
	description: string;
	inputSchema?: z.ZodObject;
	annotations?: ToolAnnotations;
}

/** A tool's arguments: what its schema parses, nothing without one. */
export type ToolArgs<S> = S extends z.ZodObject ? z.infer<S> : undefined;

/** What tool modules register into: the same shape as `McpServer.registerTool`. */
export interface ToolRegistrar {
	registerTool<S extends z.ZodObject | undefined = undefined>(
		name: string,
		config: ToolConfig & { inputSchema?: S },
		run: (args: ToolArgs<S>) => Promise<CallToolResult>,
	): void;
}

type AnyRun = (args: unknown) => Promise<CallToolResult>;

/** The tools of one group, by name, with their runners. */
export class ToolTable implements ToolRegistrar {
	private readonly tools = new Map<string, { config: ToolConfig; run: AnyRun }>();

	registerTool<S extends z.ZodObject | undefined = undefined>(
		name: string,
		config: ToolConfig & { inputSchema?: S },
		run: (args: ToolArgs<S>) => Promise<CallToolResult>,
	): void {
		// The runner takes what its own schema parses; call() only ever passes
		// it that, so widening the parameter for storage is safe.
		this.tools.set(name, { config, run: run as AnyRun });
	}

	entries(): [string, ToolConfig][] {
		return [...this.tools].map(([name, tool]) => [name, tool.config]);
	}

	/** Validates `args` with the tool's schema, then runs it. */
	async call(name: string, args: unknown): Promise<CallToolResult> {
		const tool = this.tools.get(name);
		if (!tool) return failure(new Error(`Unknown tool ${name}`));
		const schema = tool.config.inputSchema;
		if (!schema) return tool.run(undefined);
		const parsed = schema.safeParse(args ?? {});
		if (!parsed.success) {
			return failure(new Error(`Invalid arguments: ${parsed.error.message}`));
		}
		return tool.run(parsed.data);
	}
}

/** State of one MCP client (one `tunelo mcp` process) in the service. */
export interface McpSession {
	context: McpContext;
	/** Tunnels this client opened; they close with the session. */
	tunnels: LocalTunnels;
}

export const GROUP_NAMES = ["tunnel", "chat", "localman"] as const;
export type GroupName = (typeof GROUP_NAMES)[number];

export interface ToolGroup {
	name: GroupName;
	/** The app whose token the group's calls carry (its resource, the token `aud`). */
	app: AppName;
	/** Every tool of the group an agent may call; anything else is refused. */
	allowedTools: readonly string[];
	writeTools: readonly string[];
	twoStepTools: readonly string[];
	/** Tools run in the service itself; absent for a group served by its app's MCP server. */
	register?: (tools: ToolRegistrar, session: McpSession) => void;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
	{
		name: "tunnel",
		app: "tunnel",
		allowedTools: [
			"open_http_tunnel",
			"open_tcp_tunnel",
			"list_local_tunnels",
			"close_tunnel",
			"tunnel_status",
			"whoami",
			"list_tunnel_requests",
			"get_tunnel_request",
			"close_local_tunnel_process",
			"list_linked_machines",
			"revoke_linked_machine",
		],
		// Opening a tunnel puts a local port on the internet.
		writeTools: [
			"open_http_tunnel",
			"open_tcp_tunnel",
			"close_tunnel",
			"close_local_tunnel_process",
			"revoke_linked_machine",
		],
		twoStepTools: ["revoke_linked_machine"],
		register: (tools, session) =>
			registerTunnelTools(tools, session.context, session.tunnels),
	},
	{
		// chat-next server/internal/chatmcp/tools_chat.go
		name: "chat",
		app: "chat",
		allowedTools: [
			"get_me",
			"list_chats",
			"get_chat",
			"get_messages",
			"search_messages",
			"search_users",
			"resolve_username",
			"get_users",
			"send_message",
		],
		writeTools: ["send_message"],
		twoStepTools: [],
	},
	{
		// localman-next apps/api: collections, api-client history and proxy, tunelo machines
		name: "localman",
		app: "localman",
		allowedTools: [
			"list_collections",
			"get_collection",
			"search_collections",
			"list_history",
			"get_history_entry",
			"list_machines",
			"list_machine_ports",
			"send_request",
		],
		writeTools: ["send_request"],
		twoStepTools: [],
	},
];

export function toolGroup(name: string): ToolGroup | undefined {
	return TOOL_GROUPS.find((group) => group.name === name);
}

/**
 * The name a client sees for a group's tool. Tunnel tools keep the names of
 * the Tunelo CLI 1.x; the others carry their app, so that two apps never
 * share a name and the agent can tell `chat_send_message` from Localman's.
 */
export function exposedToolName(group: GroupName, tool: string): string {
	return group === "tunnel" ? tool : `${group}_${tool}`;
}

/** The server name of tunelo's MCP in a claude session. */
export const SESSION_MCP_SERVER = "tunelo";
const CLAUDE_PREFIX = `mcp__${SESSION_MCP_SERVER}__`;

/** The group and tool behind a claude tool name such as `mcp__tunelo__chat_send_message`. */
export function sessionTool(claudeName: string): { group: ToolGroup; tool: string } | undefined {
	if (!claudeName.startsWith(CLAUDE_PREFIX)) return undefined;
	const exposed = claudeName.slice(CLAUDE_PREFIX.length);
	for (const group of TOOL_GROUPS) {
		for (const tool of group.allowedTools) {
			if (exposedToolName(group.name, tool) === exposed) return { group, tool };
		}
	}
	return undefined;
}

/** A write tool of tunelo's MCP, whatever the input. */
export function isWriteTool(claudeName: string): boolean {
	const found = sessionTool(claudeName);
	return found !== undefined && found.group.writeTools.includes(found.tool);
}

/**
 * Whether this call of a claude tool acts for the user and so needs the
 * user's approval: a write tool, and for a two-step tool only the call that
 * carries the `confirm_token` (the dry run before it changes nothing, so
 * the user is asked once).
 */
export function needsApproval(claudeName: string, input: unknown): boolean {
	const found = sessionTool(claudeName);
	if (!found || !found.group.writeTools.includes(found.tool)) return false;
	if (!found.group.twoStepTools.includes(found.tool)) return true;
	const token = (input as { confirm_token?: unknown } | null)?.confirm_token;
	return typeof token === "string" && token !== "";
}

/** The tools of every group served in the service, for one session. */
export function toolTables(session: McpSession): Map<GroupName, ToolTable> {
	const tables = new Map<GroupName, ToolTable>();
	for (const group of TOOL_GROUPS) {
		if (!group.register) continue;
		const table = new ToolTable();
		group.register(table, session);
		tables.set(group.name, table);
	}
	return tables;
}
