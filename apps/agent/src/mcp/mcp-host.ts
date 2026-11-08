/**
 * The service side of `tunelo mcp`: one session per connected MCP client,
 * holding the tunnels it opened and the confirm tokens it was given. A
 * session ends (and its tunnels close) when its client disconnects from the
 * control socket.
 *
 * A client started by a claude session tunelo opened presents that
 * session's ticket; one started elsewhere (`claude mcp add tunelo -- tunelo
 * mcp`) has none and acts as this OS user, with the same tools. A ticket
 * that is no longer live is refused. Every call is logged on the machine
 * (group, tool, outcome; never its arguments).
 */
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	GROUP_NAMES,
	type GroupName,
	type McpSession,
	TOOL_GROUPS,
	type ToolTable,
	exposedToolName,
	toolGroup,
	toolTables,
} from "./groups.js";
import { type LocalTunnel, LocalTunnels } from "./local-tunnels.js";
import { createMcpContext } from "./mcp-context.js";
import { failure } from "./mcp-result.js";
import { RemoteProxy, type RemoteTool, identityAccess } from "./remote-proxy.js";
import { SessionTickets } from "./session-tickets.js";

interface Entry {
	session: McpSession;
	tables: Map<GroupName, ToolTable>;
	/** The ticket the client presented, if any. */
	ticket?: string;
}

const NO_SESSION =
	"This MCP session ended (tunelo restarted); reconnect the MCP client.";
const TICKET_ENDED =
	"This claude session's access to tunelo ended; start a new session.";

export interface McpHostOptions {
	remote?: RemoteProxy;
	tickets?: SessionTickets;
	/** The groups turned on on this machine; all when unset. */
	enabledGroups?: () => readonly GroupName[] | undefined;
	log?: (line: string) => void;
}

/** A tool of an app's MCP server as `tunelo mcp` offers it. */
export interface OfferedTool extends RemoteTool {
	group: GroupName;
	/** The name the client sees (exposedToolName). */
	exposed: string;
}

export class McpHost {
	private readonly sessions = new Map<string, Entry>();
	readonly tickets: SessionTickets;
	private readonly remote: RemoteProxy;
	private readonly log: (line: string) => void;

	constructor(
		private readonly dir: string,
		private readonly options: McpHostOptions = {},
	) {
		this.tickets = options.tickets ?? new SessionTickets();
		this.remote = options.remote ?? new RemoteProxy(identityAccess(dir));
		this.log = options.log ?? (() => undefined);
	}

	private enabled(group: GroupName): boolean {
		const on = this.options.enabledGroups?.() ?? GROUP_NAMES;
		return on.includes(group);
	}

	/**
	 * Starts a session for a client of the Tunelo server `serverUrl`; with
	 * the ticket of the claude session that started the client, if any.
	 */
	open(serverUrl: string, ticket?: string): string {
		if (ticket !== undefined && !this.tickets.owner(ticket)) throw new Error(TICKET_ENDED);
		const id = randomUUID();
		const context = createMcpContext(serverUrl, this.dir);
		const session: McpSession = { context, tunnels: new LocalTunnels(context) };
		this.sessions.set(id, { session, tables: toolTables(session), ...(ticket ? { ticket } : {}) });
		return id;
	}

	async call(
		id: string,
		groupName: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<CallToolResult> {
		const entry = this.sessions.get(id);
		if (!entry) return failure(new Error(NO_SESSION));
		const who = entry.ticket ? this.tickets.owner(entry.ticket) : "local";
		if (!who) return failure(new Error(TICKET_ENDED));
		const group = toolGroup(groupName);
		if (!group || !this.enabled(group.name)) {
			return failure(new Error(`The ${groupName} tools are off on this machine`));
		}
		if (!group.allowedTools.includes(tool)) {
			return failure(new Error(`${tool} is not a tool tunelo offers`));
		}
		const table = entry.tables.get(group.name);
		const result = table ? await table.call(tool, args) : await this.remote.call(group, tool, args);
		this.log(`mcp ${who}: ${group.name} ${tool} ${result.isError ? "failed" : "ok"}`);
		return result;
	}

	/**
	 * The tools of the app servers' groups that are on, for `tunelo mcp` to
	 * list; a group whose server cannot be reached now is left out, with why.
	 */
	async remoteTools(): Promise<{ tools: OfferedTool[]; unavailable: { group: GroupName; reason: string }[] }> {
		const groups = TOOL_GROUPS.filter((g) => !g.register && this.enabled(g.name));
		const settled = await Promise.allSettled(groups.map((g) => this.remote.tools(g)));
		const tools: OfferedTool[] = [];
		const unavailable: { group: GroupName; reason: string }[] = [];
		settled.forEach((outcome, i) => {
			const group = groups[i];
			if (!group) return;
			if (outcome.status === "fulfilled") {
				for (const tool of outcome.value) {
					tools.push({ ...tool, group: group.name, exposed: exposedToolName(group.name, tool.name) });
				}
			} else {
				const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				unavailable.push({ group: group.name, reason });
			}
		});
		return { tools, unavailable };
	}

	/** Lists the app servers' tools ahead of a session that will ask for them. */
	warm(): void {
		void this.remoteTools().catch(() => undefined);
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
		void this.remote.close();
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
