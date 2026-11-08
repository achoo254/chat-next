/**
 * The MCP tools of tunelo, by group. `tunelo mcp` lists them without the
 * service (so a client always gets an answer to `initialize` and
 * `tools/list`) and forwards each call over the control socket; the service
 * runs the call with its own session, so no token leaves it. The first
 * group is `tunnel`, the tools of the Tunelo CLI 1.x.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
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

export interface ToolGroup {
	name: string;
	register(tools: ToolRegistrar, session: McpSession): void;
}

export const MCP_GROUPS: readonly ToolGroup[] = [
	{
		name: "tunnel",
		register: (tools, session) =>
			registerTunnelTools(tools, session.context, session.tunnels),
	},
];

/** The tools of every group for one session. */
export function toolTables(session: McpSession): Map<string, ToolTable> {
	const tables = new Map<string, ToolTable>();
	for (const group of MCP_GROUPS) {
		const table = new ToolTable();
		group.register(table, session);
		tables.set(group.name, table);
	}
	return tables;
}
