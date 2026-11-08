/**
 * The service side of `tunelo mcp`: one session per connected MCP client,
 * holding the tunnels it opened and the confirm tokens it was given. A
 * session ends (and its tunnels close) when its client disconnects from the
 * control socket.
 */
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type McpSession, type ToolTable, toolTables } from "./groups.js";
import { type LocalTunnel, LocalTunnels } from "./local-tunnels.js";
import { createMcpContext } from "./mcp-context.js";
import { failure } from "./mcp-result.js";

interface Entry {
	session: McpSession;
	tables: Map<string, ToolTable>;
}

const NO_SESSION =
	"This MCP session ended (tunelo restarted); reconnect the MCP client.";

export class McpHost {
	private readonly sessions = new Map<string, Entry>();

	constructor(private readonly dir: string) {}

	/** Starts a session for a client of the Tunelo server `serverUrl`. */
	open(serverUrl: string): string {
		const id = randomUUID();
		const context = createMcpContext(serverUrl, this.dir);
		const session: McpSession = { context, tunnels: new LocalTunnels(context) };
		this.sessions.set(id, { session, tables: toolTables(session) });
		return id;
	}

	async call(
		id: string,
		group: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<CallToolResult> {
		const entry = this.sessions.get(id);
		if (!entry) return failure(new Error(NO_SESSION));
		const table = entry.tables.get(group);
		if (!table) return failure(new Error(`Unknown tool group ${group}`));
		return table.call(tool, args);
	}

	/** Ends a session: every tunnel it opened closes. */
	end(id: string): void {
		const entry = this.sessions.get(id);
		if (!entry) return;
		this.sessions.delete(id);
		entry.session.tunnels.closeAll();
	}

	endAll(): void {
		for (const id of [...this.sessions.keys()]) this.end(id);
	}

	/** Tunnels every session holds. */
	tunnels(): LocalTunnel[] {
		return [...this.sessions.values()].flatMap((entry) =>
			entry.session.tunnels.list(),
		);
	}

	/** Closes a tunnel of any session; false when none has that id. */
	closeTunnel(tunnelId: string): boolean {
		for (const entry of this.sessions.values()) {
			if (entry.session.tunnels.close(tunnelId)) return true;
		}
		return false;
	}
}
