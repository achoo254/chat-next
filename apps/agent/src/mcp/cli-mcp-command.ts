import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import {
	type ControlStream,
	callControl,
	streamControl,
} from "../control-socket.ts";
import {
	printServerMigration,
	resolveServerUrl,
} from "../tunnels/server-url.js";
import { AGENT_VERSION } from "../version.ts";
import { MCP_GROUPS, ToolTable } from "./groups.js";
import { LocalTunnels } from "./local-tunnels.js";
import { createMcpContext } from "./mcp-context.js";
import { failure } from "./mcp-result.js";

const NOT_RUNNING =
	"tunelo is not running in the background: run `tunelo start`, then call the tool again.";

/**
 * This client's session in the background service. It lasts while the
 * stream to the service stays open; a restarted service gets a new one on
 * the next call (the tunnels of the old one closed with it).
 */
class ServiceSession {
	private pending: Promise<{ id: string; stream: ControlStream }> | null =
		null;

	constructor(
		private readonly dir: string,
		private readonly serverUrl: string,
	) {}

	id(): Promise<string> {
		this.pending ??= this.open();
		return this.pending.then((session) => session.id);
	}

	private async open(): Promise<{ id: string; stream: ControlStream }> {
		let resolveId: (id: string) => void = () => undefined;
		const idReady = new Promise<string>((resolve) => (resolveId = resolve));
		const stream = await streamControl(
			this.dir,
			"/mcp/session",
			{ server: this.serverUrl },
			(message) => {
				const id = (message as { session?: unknown }).session;
				if (typeof id === "string") resolveId(id);
			},
		).catch((err: unknown) => {
			this.pending = null;
			throw err;
		});
		void stream.done.then(() => {
			this.pending = null;
			resolveId("");
		});
		const id = await idReady;
		if (!id) throw new Error(NOT_RUNNING);
		return { id, stream };
	}

	close(): void {
		void this.pending?.then((session) => session.stream.close()).catch(() => undefined);
	}
}

function isToolResult(value: unknown): value is CallToolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { content?: unknown }).content)
	);
}

/**
 * `tunelo mcp`: MCP server over stdio, e.g. `claude mcp add tunelo -- tunelo mcp`.
 * It answers `initialize` and `tools/list` by itself and runs every tool in
 * the background service, which holds the sign-in; without the service a
 * call says to start it. Tunnels it opened close when this process ends.
 */
export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Run an MCP server (stdio) that opens tunnels for agents")
		.option("--server <url>", "Tunnel server URL")
		.action(async (options: { server?: string }) => {
			const dir = configDir();
			const serverUrl = resolveServerUrl(options.server, printServerMigration);
			const context = createMcpContext(serverUrl, dir);
			const session = new ServiceSession(dir, serverUrl);
			const server = new McpServer({ name: "tunelo", version: AGENT_VERSION });

			const forward = async (
				group: string,
				tool: string,
				args: Record<string, unknown>,
			): Promise<CallToolResult> => {
				try {
					const id = await session.id();
					const result = await callControl(dir, "POST", "/mcp/call", {
						session: id,
						group,
						tool,
						args,
					});
					if (!isToolResult(result)) {
						throw new Error("tunelo answered something else than a tool result");
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return failure(
						new Error(message.startsWith("tunelo is not running") ? NOT_RUNNING : message),
					);
				}
			};

			// The tool list comes from the same table the service runs.
			for (const group of MCP_GROUPS) {
				const table = new ToolTable();
				group.register(table, { context, tunnels: new LocalTunnels(context) });
				for (const [name, config] of table.entries()) {
					const { title, description, annotations, inputSchema } = config;
					if (inputSchema) {
						server.registerTool(
							name,
							{ title, description, inputSchema, ...(annotations ? { annotations } : {}) },
							(args: Record<string, unknown>) => forward(group.name, name, args),
						);
					} else {
						server.registerTool(
							name,
							{ title, description, ...(annotations ? { annotations } : {}) },
							() => forward(group.name, name, {}),
						);
					}
				}
			}

			let exiting = false;
			const shutdown = (): void => {
				if (exiting) return;
				exiting = true;
				session.close();
				void server.close().finally(() => process.exit(0));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			process.stdin.on("end", shutdown);

			const transport = new StdioServerTransport();
			transport.onclose = shutdown;
			await server.connect(transport);
			context.log(`ready (server ${serverUrl})`);
		});
}
