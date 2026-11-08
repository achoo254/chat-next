/**
 * The service side of `tunelo mcp`: one session per connected MCP client,
 * holding the tunnels it opened and the confirm tokens it was given. A
 * session ends (and its tunnels close) when its client disconnects from the
 * control socket.
 *
 * A client started by a claude session tunelo opened presents that
 * session's ticket. The ticket only names the session (any process of the
 * user can read it): a write of a session runs only with the approval the
 * user gave on the device for that exact call (write-approvals.ts), or
 * when the session runs in bypassPermissions. A client started elsewhere
 * (`claude mcp add tunelo -- tunelo mcp`) has no ticket and acts as this OS
 * user (`localWrites` decides whether it may write). A ticket that is no
 * longer live is refused. Every call is logged on the machine (group, tool,
 * outcome; never its arguments). Nothing leaves without redact().
 */
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	GROUP_NAMES,
	type GroupName,
	type McpSession,
	TOOL_GROUPS,
	type ToolGroup,
	type ToolTable,
	actsForUser,
	exposedToolName,
	sessionTool,
	toolGroup,
	toolTables,
} from "./groups.js";
import { type LocalTunnel, LocalTunnels } from "./local-tunnels.js";
import { createMcpContext } from "./mcp-context.js";
import { failure } from "./mcp-result.js";
import { RemoteProxy, type RemoteTool, identityAccess } from "./remote-proxy.js";
import { hideSensitiveHeaders, redact, redactMessage } from "./redact.js";
import { SessionTickets } from "./session-tickets.js";
import { WriteApprovals } from "./write-approvals.js";

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
const NOT_APPROVED =
	"This was not approved on the device: tunelo runs it only after the user approves this exact call.";
const NO_LOCAL_WRITES =
	"Writes need a claude session tunelo opened (with its approval card); this client may only read.";
/** How long a card waits for the name of the chat a message goes to. */
const DESCRIBE_WAIT_MS = 3_000;
const PREVIEW_CHARS = 300;

export interface McpHostOptions {
	remote?: RemoteProxy;
	tickets?: SessionTickets;
	approvals?: WriteApprovals;
	/** The groups turned on on this machine; all when unset. */
	enabledGroups?: () => readonly GroupName[] | undefined;
	/** The permission mode a session (by the label of its ticket) runs in now. */
	sessionMode?: (owner: string) => string | undefined;
	/** Whether a client without a ticket may run write tools; yes when unset. */
	localWrites?: () => boolean;
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
	readonly approvals: WriteApprovals;
	private readonly remote: RemoteProxy;
	private readonly log: (line: string) => void;

	constructor(
		private readonly dir: string,
		private readonly options: McpHostOptions = {},
	) {
		this.tickets = options.tickets ?? new SessionTickets();
		this.approvals = options.approvals ?? new WriteApprovals();
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
		const refusal = this.writeRefusal(entry.ticket, who, group, tool, args);
		if (refusal) {
			this.log(redactMessage(`mcp ${who}: ${group.name} ${tool} refused (not approved)`));
			return failure(new Error(refusal));
		}
		const table = entry.tables.get(group.name);
		const result = table ? await table.call(tool, args) : await this.remote.call(group, tool, args);
		this.log(redactMessage(`mcp ${who}: ${group.name} ${tool} ${result.isError ? "failed" : "ok"}`));
		return this.clean(group, tool, result);
	}

	/** Why a write may not run now; undefined when it may (or is no write). */
	private writeRefusal(ticket: string | undefined, who: string, group: ToolGroup, tool: string, args: Record<string, unknown>): string | undefined {
		if (!actsForUser(group, tool, args)) return undefined;
		if (!ticket) return (this.options.localWrites?.() ?? true) ? undefined : NO_LOCAL_WRITES;
		if (this.options.sessionMode?.(who) === "bypassPermissions") return undefined;
		return this.approvals.consume(ticket, group.name, tool, args) ? undefined : NOT_APPROVED;
	}

	/** A result as it may leave the service. */
	private clean(group: ToolGroup, tool: string, result: CallToolResult): CallToolResult {
		const masks = group.maskHeaderTools?.includes(tool) ?? false;
		const content = result.content.map((item) =>
			item.type === "text"
				? { ...item, text: this.remote.redact(masks ? hideSensitiveHeaders(item.text) : item.text) }
				: item,
		);
		return { ...result, content };
	}

	/** The user approved this call of a claude tool on the device: it may run once. */
	approve(ticket: string, claudeName: string, input: unknown): void {
		const found = sessionTool(claudeName);
		if (found) this.approvals.grant(ticket, found.group.name, found.tool, input);
	}

	/** Ends a session's ticket and its approvals not spent. */
	release(ticket: string): void {
		this.tickets.revoke(ticket);
		this.approvals.forget(ticket);
	}

	/**
	 * One line telling the user what a write does, for its approval card:
	 * the chat a message goes to (by name when Chat answers in time) and
	 * the start of the text, or the method and URL of a request.
	 */
	async describeWrite(claudeName: string, input: Record<string, unknown>): Promise<string | undefined> {
		const found = sessionTool(claudeName);
		if (!found) return undefined;
		const text = (v: unknown) => (typeof v === "string" ? v : "");
		if (found.group.name === "chat" && found.tool === "send_message") {
			const chatId = typeof input.chat_id === "number" ? input.chat_id : Number(input.chat_id);
			const to = (await this.chatName(found.group, chatId)) ?? `chat ${String(input.chat_id)}`;
			const body = text(input.text);
			const preview = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}… (${body.length} characters)` : body;
			return redact(`Send to ${to}: ${preview}`);
		}
		if (found.group.name === "localman" && found.tool === "send_request") {
			return redact(`${text(input.method).toUpperCase() || "GET"} ${text(input.url)}`);
		}
		return undefined;
	}

	/** «Title» (N members), or the peer's name, of a chat; undefined when Chat does not say in time. */
	private async chatName(group: ToolGroup, chatId: number): Promise<string | undefined> {
		if (!Number.isFinite(chatId)) return undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), DESCRIBE_WAIT_MS);
		});
		try {
			const result = await Promise.race([this.remote.call(group, "get_chat", { chat_id: chatId }), late]);
			const first = result?.content[0];
			if (!result || result.isError || first?.type !== "text") return undefined;
			const answer = JSON.parse(first.text) as {
				chat?: { title?: string; member_count?: number };
				users?: { name?: string; username?: string }[];
			};
			const peer = answer.users?.[0];
			const name = answer.chat?.title || peer?.name || (peer?.username ? `@${peer.username}` : "");
			if (!name) return undefined;
			const members = answer.chat?.member_count ? ` (${answer.chat.member_count} members)` : "";
			return `«${name}»${members}`;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
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
				unavailable.push({ group: group.name, reason: redactMessage(reason) });
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
