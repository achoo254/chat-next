import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Command } from "commander";
import { createMcpContext } from "./mcp/mcp-context.js";
import { createTuneloMcpServer } from "./mcp/mcp-server.js";
import { printServerMigration, resolveServerUrl } from "./server-url.js";

/**
 * `tunelo mcp`: MCP server over stdio, e.g. `claude mcp add tunelo -- tunelo mcp`.
 * Every tunnel it opened closes when the client disconnects or the process
 * is stopped.
 */
export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Run an MCP server (stdio) that opens tunnels for agents")
		.option("--server <url>", "Tunnel server URL")
		.action(async (options: { server?: string }) => {
			const serverUrl = resolveServerUrl(options.server, printServerMigration);
			const context = createMcpContext(serverUrl);
			const { server, tunnels } = createTuneloMcpServer(context);

			let exiting = false;
			const shutdown = (): void => {
				if (exiting) return;
				exiting = true;
				tunnels.closeAll();
				void server.close().finally(() => process.exit(0));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			process.stdin.on("end", shutdown);
			// Last resort (sync): sockets close even on an abrupt exit path.
			process.on("exit", () => tunnels.closeAll());

			const transport = new StdioServerTransport();
			transport.onclose = shutdown;
			await server.connect(transport);
			context.log(`ready (server ${serverUrl})`);
		});
}
