/**
 * The MCP tools of tunelo, by group: a static list, no registry. `tunelo
 * mcp` answers `initialize` and `tools/list` itself and forwards each call
 * over the control socket; the service runs it with its own sign-in, so no
 * token leaves it.
 *
 * - `tunnel`: the tools of the Tunelo CLI 1.x, run in the service.
 * - `chat`, `localman`, `kb`: a few tools of the Chat, Localman and
 *   Knowledge Base MCP servers, which the service calls with the account's
 *   token for that app. `chat`
 *   also has `send_file`, run in the service (chat-file-tools.ts): it
 *   uploads files of the session's folder with the server's internal upload
 *   tools, which no agent sees.
 *
 * `writeTools` act for the user where others see it (a message, a request,
 * a public tunnel). In a session tunelo opens, they always go through an
 * approval card unless the session runs in its AI's bypass mode (see
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
import { type ChatFileSession, registerChatFileTools } from "./chat-file-tools.js";

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
	/**
	 * A session tunelo opened (it presented a ticket): it has the tools that
	 * work on its thread's folder. `chatFiles` runs them; absent where the
	 * tools are only listed.
	 */
	ticketed?: boolean;
	chatFiles?: ChatFileSession;
}

export const GROUP_NAMES = ["tunnel", "chat", "localman", "kb"] as const;
export type GroupName = (typeof GROUP_NAMES)[number];

export interface ToolGroup {
	name: GroupName;
	/** The app whose token the group's calls carry (its resource, the token `aud`). */
	app: AppName;
	/** Every tool of the group an agent may call; anything else is refused. */
	allowedTools: readonly string[];
	writeTools: readonly string[];
	twoStepTools: readonly string[];
	/** Tools whose results may carry the headers of the user's own requests: their secret values are hidden. */
	maskHeaderTools?: readonly string[];
	/** Tools run in the service itself; absent for a group served by its app's MCP server. */
	register?: (tools: ToolRegistrar, session: McpSession) => void;
	/** Set when the group also has tools on its app's MCP server: the ones `register` runs (every other tool goes to the server). */
	localTools?: readonly string[];
	/** Tools of the app's server the service calls itself (RemoteProxy.callInternal): never listed, never called by an agent. */
	internalTools?: readonly string[];
	/** Query parameters of the app's MCP endpoint the group's tools need (not part of the resource, the token `aud`). */
	serverQuery?: Readonly<Record<string, string>>;
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
			"list_people",
			"get_contacts",
			"send_message",
			"send_media",
			"forward_messages",
			"start_private_chat",
			"send_file",
		],
		writeTools: ["send_message", "send_media", "forward_messages", "start_private_chat", "send_file"],
		twoStepTools: [],
		register: (tools, session) => {
			if (session.ticketed) registerChatFileTools(tools, session.chatFiles);
		},
		localTools: ["send_file"],
		// Bytes never travel in a tool call: send_file PUTs them to the URLs these answer.
		internalTools: ["start_media_upload", "complete_media_upload"],
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
			// sharing.listWorkspaces: the workspaces whose collections list_collections reads (workspaceId).
			"list_workspaces",
			"send_request",
			// client.createCollectionNode: adds a request (or folder, example) to a collection.
			"create_collection_node",
		],
		writeTools: ["send_request", "create_collection_node"],
		twoStepTools: [],
		maskHeaderTools: ["list_history", "get_history_entry", "send_request"],
		// Localman serves the mock and client toolsets by default; list_workspaces is in sharing (scope client:read).
		serverQuery: { toolsets: "client,sharing" },
	},
	{
		// kb-next apps/server/src/mcp: read the Knowledge Base as the user, save a private note
		name: "kb",
		app: "kb",
		allowedTools: ["search", "get_document", "list_spaces", "recent", "save_note"],
		writeTools: ["save_note"],
		// The call without confirm_token only previews; the one with it saves.
		twoStepTools: ["save_note"],
	},
];

/** The tool runs in the service (the group's `register`), not on its app's MCP server. */
export function runsInService(group: ToolGroup, tool: string): boolean {
	return group.register !== undefined && (group.localTools?.includes(tool) ?? true);
}

/** The group has tools on its app's MCP server. */
export function hasAppServer(group: ToolGroup): boolean {
	return group.register === undefined || group.localTools !== undefined;
}

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

export { SESSION_MCP_SERVER } from "./session-mcp-server.js";

/**
 * The group and tool behind a tool name as tunelo's MCP serves it, such as
 * `chat_send_message`. Each AI names the tool its own way (Claude:
 * `mcp__tunelo__chat_send_message`); its adapter takes that off first.
 */
export function sessionTool(exposed: string): { group: ToolGroup; tool: string } | undefined {
	for (const group of TOOL_GROUPS) {
		for (const tool of group.allowedTools) {
			if (exposedToolName(group.name, tool) === exposed) return { group, tool };
		}
	}
	return undefined;
}

/** A write tool of tunelo's MCP, whatever the input. */
export function isWriteTool(exposed: string): boolean {
	const found = sessionTool(exposed);
	return found !== undefined && found.group.writeTools.includes(found.tool);
}

/**
 * Whether this call acts for the user (and so needs the user's approval):
 * a write tool, and for a two-step tool only the call that carries the
 * `confirm_token` (the dry run before it changes nothing, so the user is
 * asked once).
 */
export function actsForUser(group: ToolGroup, tool: string, input: unknown): boolean {
	if (!group.writeTools.includes(tool)) return false;
	if (!group.twoStepTools.includes(tool)) return true;
	const token = (input as { confirm_token?: unknown } | null)?.confirm_token;
	return typeof token === "string" && token !== "";
}

/** Why a write's approval card asks (English; devices word their own from ApprovalWrite). */
export const WRITE_APPROVAL_REASON = "It acts as you in Chat, Localman or on the internet: tunelo asks you every time.";

/** actsForUser, for a tool name as tunelo's MCP serves it. */
export function needsApproval(exposed: string, input: unknown): boolean {
	const found = sessionTool(exposed);
	return found !== undefined && actsForUser(found.group, found.tool, input);
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
