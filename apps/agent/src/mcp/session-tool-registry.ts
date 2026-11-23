// The tools tunelo's MCP lists, the same wherever it is served: `tunelo mcp`
// over stdio (the user's own `claude mcp add tunelo -- tunelo mcp`, and the
// AIs that take only stdio) and the service's own endpoint over HTTP (the
// sessions tunelo opens). Every call goes to `forward`, which runs it in the
// service; this file only names the tools.
import type { CallToolResult, McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { ADVISOR_GROUP, registerAdvisorTools } from "../advisor/advisor-tools.ts";
import { BROWSER_GROUP, registerBrowserTools } from "../remote-browser/browser-tools.ts";
import { SECRETS_GROUP, registerSecretTools } from "../sign-in-secrets/secret-tools.ts";
import { TOOL_GROUPS, ToolTable } from "./groups.ts";
import { LocalTunnels } from "./local-tunnels.ts";
import type { McpContext } from "./mcp-context.ts";
import type { OfferedTool } from "./mcp-host.ts";

export type ToolArgs = Record<string, unknown>;

/** Runs one tool in the service and answers with its result. */
export type ForwardCall = (group: string, tool: string, args: ToolArgs) => Promise<CallToolResult>;

/**
 * Which tools a client sees: "local" without a ticket (tunnels and the app
 * servers' tools), "session" for a session tunelo opened (also secrets, the
 * browser and Advisor), "advisor" for an Advisor thread's session (Advisor's
 * tools only) and "weigh" for the AI's CLI in a terminal (advisor_weigh only).
 * The service refuses anything else whatever is listed.
 */
export type ToolMode = "local" | "session" | "advisor" | "weigh";

export interface SessionToolOptions {
	mode: ToolMode;
	/** Resolves the tunnel tools' definitions; they run in the service all the same. */
	context: McpContext;
	/** The app servers' tools the service offers now, and whether this client may write. */
	offered: { tools: OfferedTool[]; writes: boolean };
	forward: ForwardCall;
}

/** Arguments as the server's JSON Schema advertises them; the server itself validates them. */
function advertisedSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<ToolArgs> {
	return {
		"~standard": {
			version: 1,
			vendor: "tunelo",
			validate: (value) =>
				typeof value === "object" && value !== null && !Array.isArray(value)
					? { value: value as ToolArgs }
					: { issues: [{ message: "Tool arguments must be a JSON object" }] },
			jsonSchema: { input: () => schema, output: () => schema },
		},
	};
}

/** Adds every tool of `table` to `server`, each forwarded to `group` in the service. */
function registerTable(server: McpServer, group: string, table: ToolTable, forward: ForwardCall, skip: (name: string) => boolean, needsSchema: boolean): void {
	for (const [name, config] of table.entries()) {
		if (skip(name)) continue;
		const { title, description, annotations, inputSchema } = config;
		if (inputSchema) {
			server.registerTool(
				name,
				{ title, description, inputSchema, ...(annotations ? { annotations } : {}) },
				(args: ToolArgs) => forward(group, name, args),
			);
		} else if (!needsSchema) {
			server.registerTool(name, { title, description, ...(annotations ? { annotations } : {}) }, () => forward(group, name, {}));
		}
	}
}

/** Lists tunelo's tools on `server` for a client of `mode`. */
export function registerSessionTools(server: McpServer, opts: SessionToolOptions): void {
	const { mode, context, offered, forward } = opts;
	const advisorOnly = mode === "advisor" || mode === "weigh";
	if (!advisorOnly) {
		// The tunnel tools come from the same table the service runs; a client that may not write does not see write tools.
		for (const group of TOOL_GROUPS) {
			if (!group.register) continue;
			const table = new ToolTable();
			group.register(table, { context, tunnels: new LocalTunnels(context) });
			registerTable(server, group.name, table, forward, (name) => !offered.writes && group.writeTools.includes(name), false);
		}
	}

	// Sign-in secrets, the tunelo browser and Advisor: only a session tunelo opened has a device to ask and a thread.
	if (mode !== "local") {
		const all: [string, (t: ToolTable) => void][] = [
			[SECRETS_GROUP, (t) => registerSecretTools(t)],
			[BROWSER_GROUP, (t) => registerBrowserTools(t)],
			[ADVISOR_GROUP, (t) => registerAdvisorTools(t, undefined, mode === "advisor" ? "advisor-session" : "work-session")],
		];
		const groups = advisorOnly ? all.filter(([group]) => group === ADVISOR_GROUP) : all;
		for (const [group, register] of groups) {
			const table = new ToolTable();
			register(table);
			registerTable(server, group, table, forward, () => false, true);
		}
	}

	if (advisorOnly) return;
	for (const tool of offered.tools) {
		server.registerTool(
			tool.exposed,
			{
				...(tool.title ? { title: tool.title } : {}),
				description: tool.description,
				inputSchema: advertisedSchema(tool.inputSchema),
				...(tool.annotations ? { annotations: tool.annotations } : {}),
			},
			(args: ToolArgs) => forward(tool.group, tool.name, args),
		);
	}
}
