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
 * when the session runs in its AI's bypass mode. A client started elsewhere
 * (`claude mcp add tunelo -- tunelo mcp`) has no ticket and acts as this OS
 * user and only reads, unless the owner turned writes on for such clients
 * (`tunelo config mcp-local-writes on`, local-writes.ts). A ticket that is no
 * longer live is refused. Every call is logged on the machine (group, tool,
 * outcome; never its arguments). Nothing leaves without redact().
 *
 * A session with a ticket also has the sign-in secret tools (request_secret,
 * fill_secret; sign-in-secrets/secret-tools.ts), the tunelo browser tools
 * (open_browser, request_takeover, virtual_authenticator;
 * remote-browser/browser-tools.ts) and Advisor (advisor_weigh;
 * advisor/advisor-tools.ts), bound to that ticket and its thread.
 */
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { WriteCard } from "../providers/types.ts";
import { type ChatFileSession, type FileStamp, describeFiles } from "./chat-file-tools.js";
import { bodyExcerpt, cardHeaders, reachesLocal } from "./localman-cards.js";
import {
	GROUP_NAMES,
	type GroupName,
	type McpSession,
	TOOL_GROUPS,
	type ToolGroup,
	ToolTable,
	WRITE_APPROVAL_REASON,
	actsForUser,
	exposedToolName,
	hasAppServer,
	runsInService,
	sessionTool,
	toolGroup,
	toolTables,
} from "./groups.js";
import { type LocalTunnel, LocalTunnels } from "./local-tunnels.js";
import { createMcpContext } from "./mcp-context.js";
import { LOCAL_WRITES_OFF, LocalWritesSetting } from "./local-writes.js";
import { failure } from "./mcp-result.js";
import { AppNotGrantedError, RemoteProxy, type RemoteTool, identityAccess } from "./remote-proxy.js";
import { hideSensitiveHeaders, redact, redactMessage } from "./redact.js";
import { SessionTickets } from "./session-tickets.js";
import type { ToolMode } from "./session-tool-registry.ts";
import { WriteApprovals, approvalKey } from "./write-approvals.js";
import { SECRETS_GROUP, SECRET_TOOLS, registerSecretTools } from "../sign-in-secrets/secret-tools.ts";
import type { SecretService } from "../sign-in-secrets/secret-service.ts";
import { BROWSER_GROUP, BROWSER_TOOLS, registerBrowserTools } from "../remote-browser/browser-tools.ts";
import type { RemoteBrowser } from "../remote-browser/remote-browser.ts";
import { ADVISOR_GROUP, ADVISOR_TOOLS, type AdvisorHooks, registerAdvisorTools } from "../advisor/advisor-tools.ts";

interface Entry {
	session: McpSession;
	tables: Map<GroupName, ToolTable>;
	/** The ticket the client presented, if any. */
	ticket?: string;
	/** The tools only a session with a ticket has, by group (secrets, browser). */
	ticketTools?: Map<string, ToolTable>;
}

/** The groups of tools only a session tunelo opened has, and their tools. */
const TICKET_GROUPS: Readonly<Record<string, readonly string[]>> = {
	[SECRETS_GROUP]: SECRET_TOOLS,
	[BROWSER_GROUP]: BROWSER_TOOLS,
	[ADVISOR_GROUP]: ADVISOR_TOOLS,
};

const NO_SESSION =
	"This MCP session ended (tunelo restarted); reconnect the MCP client.";
const TICKET_ENDED =
	"This claude session's access to tunelo ended; start a new session.";
const ADVISOR_ONLY = "Advisor's session only has advisor_weigh, advisor_git and advisor_grep.";
const WEIGH_ONLY = "In a terminal, tunelo's MCP only has advisor_weigh.";
const NOT_APPROVED =
	"This was not approved on the device: tunelo runs it only after the user approves this exact call.";
/** How long a card the service puts up for a write waits for the user's answer. */
export const WRITE_ASK_MS = 10 * 60_000;
/** How long a card waits for the name of the chat a message goes to. */
const DESCRIBE_WAIT_MS = 3_000;
const PREVIEW_CHARS = 300;

export interface McpHostOptions {
	remote?: RemoteProxy;
	tickets?: SessionTickets;
	approvals?: WriteApprovals;
	/** The groups turned on on this machine; all when unset. */
	enabledGroups?: () => readonly GroupName[] | undefined;
	/** A session (by the label of its ticket) runs in its AI's mode that skips every prompt now. */
	sessionBypassed?: (owner: string) => boolean;
	/** Whether a client without a ticket may run write tools; mcp-local-writes.json when unset. */
	localWrites?: () => boolean;
	/** The machine's sign-in secrets; without them a session has no secret tools. */
	secrets?: () => SecretService | undefined;
	/** The tunelo browser; without it a session has no browser tools. */
	browser?: () => RemoteBrowser | undefined;
	/** Advisor (its threads' state, the key, calls the core can stop); without it a session has no Advisor tools. */
	advisor?: () => AdvisorHooks | undefined;
	/** The thread is one of Advisor's own (the core's word): its session gets Advisor's tools only. */
	isAdvisorThread?: (threadId: string) => boolean;
	/**
	 * A session (by the label of its ticket) whose every write the user
	 * approves (a Chat conversation's AI thread): a write that comes without
	 * an approval (its AI never asked, as agy in full access) is asked about
	 * on the device here instead of refused.
	 */
	asksEveryWrite?: (owner: string) => boolean;
	/**
	 * Puts the approval card of such a write on the owner's thread; resolves
	 * true once the user allows it, false when declined, cancelled, the
	 * session ended or `signal` aborted.
	 */
	askWrite?: (owner: string, call: WriteAsk, signal: AbortSignal) => Promise<boolean>;
	/** How long that card waits; WRITE_ASK_MS when unset (tests). */
	writeAskMs?: number;
	/** The working folder of a session's thread (by the label of its ticket): chat_send_file sends files of it only. */
	sessionDir?: (owner: string) => string | undefined;
	/** Paths a session may never send from (tunelo's own folders, the user's secrets). */
	isSensitive?: (path: string) => boolean;
	log?: (line: string) => void;
}

/** A write the service asks the user about itself: the tool as tunelo's MCP serves it, its arguments, and its card. */
export interface WriteAsk {
	name: string;
	input: Record<string, unknown>;
	reason: string;
	card?: WriteCard;
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
	private readonly localWrites: () => boolean;
	private readonly log: (line: string) => void;
	private readonly releaseListeners = new Set<(ticket: string) => void>();
	/** The cards the service put up for writes and waits on, by ticket: they end with it. */
	private readonly asking = new Map<string, Set<AbortController>>();
	/**
	 * The files each chat_send_file card showed (by approvalKey), until its
	 * call is approved; then those the approved call must still match, until
	 * it runs. Both end with their session.
	 */
	private readonly shownFiles = new Map<string, FileStamp[]>();
	private readonly approvedFiles = new Map<string, FileStamp[][]>();
	/**
	 * Where the service serves tunelo's MCP over HTTP to the sessions it opens
	 * (session-mcp-http.ts); undefined until it listens, and on a machine where
	 * it could not: those sessions then start `tunelo mcp` over stdio.
	 */
	httpUrl: string | undefined;

	constructor(
		private readonly dir: string,
		private readonly options: McpHostOptions = {},
	) {
		this.tickets = options.tickets ?? new SessionTickets();
		this.approvals = options.approvals ?? new WriteApprovals();
		this.remote = options.remote ?? new RemoteProxy(identityAccess(dir));
		this.log = options.log ?? (() => undefined);
		if (options.localWrites) this.localWrites = options.localWrites;
		else {
			const setting = new LocalWritesSetting(dir);
			this.localWrites = () => setting.enabled();
		}
	}

	/** Whether a client presenting `ticket` (or none) may run write tools at all. */
	maySeeWrites(ticket?: string): boolean {
		if (ticket !== undefined && this.tickets.scope(ticket) === "advisor-weigh") return false;
		return (ticket !== undefined && this.tickets.owner(ticket) !== undefined) || this.localWrites();
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
		const session: McpSession = { context, tunnels: new LocalTunnels(context), ...(ticket ? { ticketed: true, chatFiles: this.chatFiles(ticket) } : {}) };
		this.sessions.set(id, { session, tables: toolTables(session), ...(ticket ? { ticket, ticketTools: this.ticketTools(ticket) } : {}) });
		return id;
	}

	/** What chat_send_file needs of the session with `ticket`: its thread's folder, and Chat's server. */
	private chatFiles(ticket: string): ChatFileSession {
		const chat = toolGroup("chat");
		const unavailable = async () => failure(new Error("The chat tools are not available"));
		return {
			dir: () => {
				const owner = this.tickets.owner(ticket);
				return owner === undefined ? undefined : this.options.sessionDir?.(owner);
			},
			isSensitive: (path) => this.options.isSensitive?.(path) ?? true,
			callApp: (tool, args) => (chat ? this.remote.call(chat, tool, args) : unavailable()),
			callInternal: (tool, args) => (chat ? this.remote.callInternal(chat, tool, args) : unavailable()),
			approvedFiles: (args) => {
				const key = approvalKey(ticket, "chat", "send_file", args);
				const waiting = this.approvedFiles.get(key);
				const stamps = waiting?.shift();
				if (waiting && waiting.length === 0) this.approvedFiles.delete(key);
				return stamps;
			},
		};
	}

	private ticketTools(ticket: string): Map<string, ToolTable> {
		const tables = new Map<string, ToolTable>();
		const threadId = this.tickets.owner(ticket);
		if (!threadId) return tables;
		const session = { key: ticket, threadId };
		const advisor = this.options.advisor?.();
		// The AI's own CLI in a terminal asks Advisor and nothing else: no secrets, no browser.
		if (this.tickets.scope(ticket) === "advisor-weigh") {
			if (advisor && !this.advisorThread(threadId)) {
				const table = new ToolTable();
				registerAdvisorTools(table, { hooks: advisor, threadId }, "work-session");
				tables.set(ADVISOR_GROUP, table);
			}
			return tables;
		}
		// An Advisor thread's session has Advisor's tools and nothing else (none at all without them).
		if (this.advisorThread(threadId)) {
			if (advisor) {
				const table = new ToolTable();
				registerAdvisorTools(table, { hooks: advisor, threadId });
				tables.set(ADVISOR_GROUP, table);
			}
			return tables;
		}
		const service = this.options.secrets?.();
		if (service) {
			const table = new ToolTable();
			registerSecretTools(table, { service, session });
			tables.set(SECRETS_GROUP, table);
		}
		const browser = this.options.browser?.();
		if (browser) {
			const table = new ToolTable();
			registerBrowserTools(table, { browser, session });
			tables.set(BROWSER_GROUP, table);
		}
		if (advisor) {
			const table = new ToolTable();
			registerAdvisorTools(table, { hooks: advisor, threadId }, "work-session");
			tables.set(ADVISOR_GROUP, table);
		}
		return tables;
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
		// Advisor's own session reads only: none of Chat's, Localman's, the tunnels', the secrets' or the browser's tools.
		if (entry.ticket && groupName !== ADVISOR_GROUP && this.advisorThread(who)) {
			this.log(`mcp ${who}: ${groupName} ${tool} refused (Advisor's session)`);
			return failure(new Error(ADVISOR_ONLY));
		}
		if (entry.ticket && this.tickets.scope(entry.ticket) === "advisor-weigh" && (groupName !== ADVISOR_GROUP || tool !== "advisor_weigh")) {
			this.log(`mcp ${who}: ${groupName} ${tool} refused (terminal: advisor_weigh only)`);
			return failure(new Error(WEIGH_ONLY));
		}
		if (Object.hasOwn(TICKET_GROUPS, groupName)) return this.callTicketTool(entry, who, groupName, tool, args);
		const group = toolGroup(groupName);
		if (!group || !this.enabled(group.name)) {
			return failure(new Error(`The ${groupName} tools are off on this machine`));
		}
		if (!group.allowedTools.includes(tool)) {
			return failure(new Error(`${tool} is not a tool tunelo offers`));
		}
		const refusal = await this.writeRefusal(entry.ticket, who, group, tool, args);
		if (refusal) {
			this.log(redactMessage(`mcp ${who}: ${group.name} ${tool} refused (not approved)`));
			return failure(new Error(refusal));
		}
		const table = entry.tables.get(group.name);
		const result = !runsInService(group, tool)
			? await this.remote.call(group, tool, args)
			: table
				? await table.call(tool, args)
				: failure(new Error(`${exposedToolName(group.name, tool)} works only in a session tunelo opened`));
		this.log(redactMessage(`mcp ${who}: ${group.name} ${tool} ${result.isError ? "failed" : "ok"}`));
		return this.clean(group, tool, result);
	}

	/** A sign-in secret or browser tool: only for a session tunelo opened; its result never holds a secret value (redact). */
	private async callTicketTool(entry: Entry, who: string, group: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
		if (!TICKET_GROUPS[group]?.includes(tool)) return failure(new Error(`${tool} is not a tool tunelo offers`));
		const table = entry.ticketTools?.get(group);
		if (!table) return failure(new Error(`The ${group} tools are only offered in a session tunelo opened.`));
		const result = await table.call(tool, args);
		this.log(redactMessage(`mcp ${who}: ${group} ${tool} ${result.isError ? "failed" : "ok"}`));
		return { ...result, content: result.content.map((item) => (item.type === "text" ? { ...item, text: redact(item.text) } : item)) };
	}

	/** The thread is an Advisor thread (its session gets Advisor's tools only). */
	private advisorThread(threadId: string): boolean {
		// Asked of the core itself; Advisor's hooks only where the core is not wired (tests).
		const isAdvisor = this.options.isAdvisorThread;
		if (isAdvisor) return isAdvisor(threadId);
		return this.options.advisor?.()?.sessionDir?.(threadId) !== undefined;
	}

	/** Why a write may not run now; undefined when it may (or is no write). */
	private async writeRefusal(ticket: string | undefined, who: string, group: ToolGroup, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
		if (!actsForUser(group, tool, args)) return undefined;
		if (!ticket) return this.localWrites() ? undefined : LOCAL_WRITES_OFF;
		if (this.options.sessionBypassed?.(who) === true) return undefined;
		// Approved already: the AI asked the device for this exact call (exactly one card).
		const approved =
			this.approvals.consume(ticket, group.name, tool, args) ||
			(this.options.asksEveryWrite?.(who) === true && (await this.askOnDevice(ticket, who, group, tool, args)));
		if (!approved) return NOT_APPROVED;
		return this.holdShownFiles(ticket, group, tool, args);
	}

	/**
	 * An approved chat_send_file runs only on the files its card showed: they
	 * are kept for the run to compare. Refused when no card listed them.
	 */
	private holdShownFiles(ticket: string, group: ToolGroup, tool: string, args: Record<string, unknown>): string | undefined {
		if (group.name !== "chat" || tool !== "send_file") return undefined;
		const key = approvalKey(ticket, group.name, tool, args);
		const shown = this.shownFiles.get(key);
		if (!shown) return "The approval card did not list these files, so nothing was sent: call chat_send_file again.";
		this.shownFiles.delete(key);
		this.approvedFiles.set(key, [...(this.approvedFiles.get(key) ?? []), shown]);
		return undefined;
	}

	/** The card of a write its AI ran without asking, put up by the service; true once the user allows it in time. */
	private async askOnDevice(ticket: string, who: string, group: ToolGroup, tool: string, args: Record<string, unknown>): Promise<boolean> {
		const ask = this.options.askWrite;
		if (!ask) return false;
		const exposed = exposedToolName(group.name, tool);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.writeAskMs ?? WRITE_ASK_MS);
		const waiting = this.asking.get(ticket) ?? new Set<AbortController>();
		waiting.add(controller);
		this.asking.set(ticket, waiting);
		try {
			const card = await this.describeWrite(exposed, args, ticket).catch(() => undefined);
			if (controller.signal.aborted) return false;
			return await ask(who, { name: exposed, input: args, reason: WRITE_APPROVAL_REASON, ...(card ? { card } : {}) }, controller.signal);
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
			waiting.delete(controller);
			if (waiting.size === 0 && this.asking.get(ticket) === waiting) this.asking.delete(ticket);
		}
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

	/** The user approved this call of a tool (as tunelo's MCP names it) on the device: it may run once. */
	approve(ticket: string, exposed: string, input: unknown): void {
		const found = sessionTool(exposed);
		if (found) this.approvals.grant(ticket, found.group.name, found.tool, input);
	}

	/**
	 * What a client presenting a live `ticket` may list (session-tool-registry.ts);
	 * undefined for an unknown or ended ticket.
	 */
	toolMode(ticket: string): ToolMode | undefined {
		const threadId = this.tickets.owner(ticket);
		if (threadId === undefined) return undefined;
		if (this.tickets.scope(ticket) === "advisor-weigh") return "weigh";
		return this.advisorThread(threadId) ? "advisor" : "session";
	}

	/** Calls `listener` with each ticket as it ends; returns how to stop. */
	onRelease(listener: (ticket: string) => void): () => void {
		this.releaseListeners.add(listener);
		return () => {
			this.releaseListeners.delete(listener);
		};
	}

	/** Ends a session's ticket and its approvals not spent. */
	release(ticket: string): void {
		this.tickets.revoke(ticket);
		for (const controller of this.asking.get(ticket) ?? []) controller.abort();
		this.asking.delete(ticket);
		for (const files of [this.shownFiles, this.approvedFiles]) {
			for (const key of [...files.keys()]) if (key.startsWith(`${ticket}\n`)) files.delete(key);
		}
		for (const listener of this.releaseListeners) listener(ticket);
		this.approvals.forget(ticket);
		this.options.secrets?.()?.endSession(ticket);
		this.options.browser?.()?.endSession(ticket);
	}

	/**
	 * What a write's approval card shows: the chat a message goes to (by
	 * name when Chat answers in time) and the start of the text, or the
	 * method and URL of a request, the files of the machine sent (of the
	 * session with `ticket`); devices word it from `write`, `summary` is the
	 * English line for those that cannot ("" to keep their default).
	 * Undefined for a call that is no write of tunelo's MCP.
	 */
	async describeWrite(exposed: string, input: Record<string, unknown>, ticket?: string): Promise<WriteCard | undefined> {
		const found = sessionTool(exposed);
		if (!found || !found.group.writeTools.includes(found.tool)) return undefined;
		const text = (v: unknown) => (typeof v === "string" ? v : "");
		if (found.group.name === "chat" && (found.tool === "send_message" || found.tool === "send_file")) {
			const chatId = typeof input.chat_id === "number" ? input.chat_id : Number(input.chat_id);
			const chat = await this.chatName(found.group, chatId);
			const members = chat?.members ? ` (${chat.members} members)` : "";
			const to = chat ? `«${chat.title}»${members}` : `chat ${String(input.chat_id)}`;
			const body = text(found.tool === "send_file" ? input.caption : input.text);
			const cut = redact(body.slice(0, PREVIEW_CHARS));
			const preview = body.length > PREVIEW_CHARS ? `${cut}… (${body.length} characters)` : cut;
			const write = {
				tool: exposed,
				chatId: Number.isSafeInteger(chatId) ? BigInt(chatId) : 0n,
				chatTitle: redact(chat?.title ?? ""),
				chatMembers: chat?.members ?? 0,
				text: cut,
				textLength: body.length,
			};
			if (found.tool === "send_message") return { summary: redact(`Send to ${to}: ${preview}`), write };
			const owner = ticket === undefined ? undefined : this.tickets.owner(ticket);
			const dir = owner === undefined ? undefined : this.options.sessionDir?.(owner);
			const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
			const { files, stamps } = await describeFiles(dir, paths, (p) => this.options.isSensitive?.(p) ?? true);
			// What the approved call must still find: kept with the session's ticket.
			if (ticket !== undefined) this.shownFiles.set(approvalKey(ticket, "chat", "send_file", input), stamps);
			const listed = files.map((f) => (f.problem ? `${f.name} (cannot be sent: ${f.problem})` : `${f.name} (${f.size} bytes)`)).join(", ");
			return { summary: redact(`Send ${files.length === 1 ? "1 file" : `${files.length} files`} to ${to}: ${listed}${preview ? ` — ${preview}` : ""}`), write: { ...write, files } };
		}
		if (found.group.name === "kb" && found.tool === "save_note") {
			const title = redact(text(input.title));
			const space = text(input.space);
			const body = text(input.markdown);
			const cut = redact(body.slice(0, PREVIEW_CHARS));
			const preview = body.length > PREVIEW_CHARS ? `${cut}… (${body.length} characters)` : cut;
			// kb saves a note private, always (save-note-tool.ts in kb-next).
			return {
				summary: redact(`Save a private note «${title}» to ${space ? `the Space ${space}` : "your private Space"}: ${preview}`),
				write: { tool: exposed, title, space, visibility: "private", text: cut, textLength: body.length },
			};
		}
		if (found.group.name === "localman" && found.tool === "send_request") {
			const method = text(input.method).toUpperCase() || "GET";
			const url = redact(text(input.url));
			const body = text(input.body);
			const headers = cardHeaders(headerList(input.headers, "name"));
			const local = reachesLocal(text(input.url));
			return {
				summary: redact(`${method} ${url}${local ? " (through your machine)" : ""}`),
				write: { tool: exposed, method, url, headers, text: bodyExcerpt(body), textLength: body.length, reachesLocal: local },
			};
		}
		if (found.group.name === "localman" && found.tool === "create_collection_node") {
			const collectionId = text(input.collectionId);
			const collectionName = (await this.collectionName(found.group, collectionId)) ?? "";
			const draft = (typeof input.draft === "object" && input.draft !== null ? input.draft : {}) as Record<string, unknown>;
			const title = redact(text(input.name));
			const kind = text(input.kind) || "request";
			const method = text(draft.method).toUpperCase();
			const url = redact(text(draft.url));
			const enabled = Array.isArray(draft.headers) ? draft.headers.filter((h) => (h as { enabled?: unknown } | null)?.enabled !== false) : [];
			const into = collectionName ? `«${collectionName}»` : `collection ${collectionId}`;
			return {
				summary: redact(`Save the ${kind} «${title}» to ${into}${method || url ? `: ${method} ${url}`.trimEnd() : ""}`),
				write: { tool: exposed, title, method, url, headers: cardHeaders(headerList(enabled, "key")), collectionId, collectionName: redact(collectionName) },
			};
		}
		return { summary: "", write: { tool: exposed } };
	}

	/** The title (with its members) or the peer's name of a chat; undefined when Chat does not say in time. */
	private async chatName(group: ToolGroup, chatId: number): Promise<{ title: string; members: number } | undefined> {
		if (!Number.isFinite(chatId)) return undefined;
		const answer = (await this.readForCard(group, "get_chat", { chat_id: chatId })) as
			| { chat?: { title?: string; member_count?: number; peer_user_id?: number | string }; users?: { id?: number | string; name?: string; username?: string }[] }
			| undefined;
		// A one-to-one chat has no title: it is named after the other person (peer_user_id), never after the caller.
		const peerId = answer?.chat?.peer_user_id;
		const peer = peerId === undefined ? undefined : answer?.users?.find((u) => String(u.id) === String(peerId));
		const name = answer?.chat?.title || peer?.name || (peer?.username ? `@${peer.username}` : "");
		if (!name) return undefined;
		const count = answer?.chat?.member_count;
		return { title: name, members: answer?.chat?.title && typeof count === "number" ? count : 0 };
	}

	/** The name of a Localman collection; undefined when Localman does not say in time. */
	private async collectionName(group: ToolGroup, collectionId: string): Promise<string | undefined> {
		if (collectionId === "") return undefined;
		const answer = (await this.readForCard(group, "get_collection", { collectionId })) as { name?: unknown } | undefined;
		return typeof answer?.name === "string" && answer.name !== "" ? answer.name : undefined;
	}

	/** A read tool's JSON answer for a card, if it comes within DESCRIBE_WAIT_MS; undefined otherwise. */
	private async readForCard(group: ToolGroup, tool: string, args: Record<string, unknown>): Promise<unknown> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), DESCRIBE_WAIT_MS);
		});
		try {
			const result = await Promise.race([this.remote.call(group, tool, args), late]);
			const first = result?.content[0];
			if (!result || result.isError || first?.type !== "text") return undefined;
			return JSON.parse(first.text) as unknown;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The tools of the app servers' groups that are on, for `tunelo mcp` to
	 * list; a group whose server cannot be reached now is left out, with why.
	 * A group the machine's sign-in does not cover yet (the Knowledge Base on
	 * a machine signed in before it) is listed all the same: each of its tools
	 * answers what to do, which the AI can tell the user.
	 */
	async remoteTools(ticket?: string): Promise<{ tools: OfferedTool[]; unavailable: { group: GroupName; reason: string }[]; writes: boolean }> {
		if (ticket !== undefined && this.tickets.scope(ticket) === "advisor-weigh") return { tools: [], unavailable: [], writes: false };
		const writes = this.maySeeWrites(ticket);
		const groups = TOOL_GROUPS.filter((g) => hasAppServer(g) && this.enabled(g.name));
		const settled = await Promise.allSettled(groups.map((g) => this.remote.tools(g)));
		const tools: OfferedTool[] = [];
		const unavailable: { group: GroupName; reason: string }[] = [];
		settled.forEach((outcome, i) => {
			const group = groups[i];
			if (!group) return;
			if (outcome.status === "fulfilled") {
				for (const tool of outcome.value) {
					if (!writes && group.writeTools.includes(tool.name)) continue;
					tools.push({ ...tool, group: group.name, exposed: exposedToolName(group.name, tool.name) });
				}
			} else if (outcome.reason instanceof AppNotGrantedError) {
				for (const name of group.allowedTools) {
					if (runsInService(group, name) || (!writes && group.writeTools.includes(name))) continue;
					tools.push({
						name,
						description: `Not available on this machine yet. ${outcome.reason.message}`,
						inputSchema: { type: "object" },
						group: group.name,
						exposed: exposedToolName(group.name, name),
					});
				}
			} else {
				const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				unavailable.push({ group: group.name, reason: redactMessage(reason) });
			}
		});
		return { tools, unavailable, writes };
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

/** `{name, value}` pairs from a request's headers, the name under `nameKey` (`name` for a send, `key` for a saved request's rows). */
function headerList(value: unknown, nameKey: "name" | "key"): { name: string; value: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const row = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
		const name = row[nameKey];
		return typeof name === "string" && name !== "" ? [{ name, value: typeof row.value === "string" ? row.value : "" }] : [];
	});
}
