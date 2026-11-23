// tunelo's MCP for the sessions tunelo opens, served by the service itself
// over Streamable HTTP on 127.0.0.1: the AI connects here instead of starting
// a `tunelo mcp` process per session (each one a whole runtime, ~45 MB).
//
// A request carries its session's ticket as `Authorization: Bearer`; a live
// ticket decides which tools are listed (McpHost.toolMode) and every call
// runs in McpHost exactly as one from `tunelo mcp` does, approvals and
// refusals included. The ticket reaches the AI through its environment, never
// argv (session-mcp-launch.ts). An MCP session ends when the client deletes
// it or its ticket ends; the tunnels it opened close with it.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { type CallToolResult, McpServer, WebStandardStreamableHTTPServerTransport, isInitializeRequest } from "@modelcontextprotocol/server";
import { resolveServerUrl } from "../tunnels/server-url.ts";
import { AGENT_VERSION } from "../version.ts";
import { createMcpContext } from "./mcp-context.ts";
import type { McpHost } from "./mcp-host.ts";
import { failure } from "./mcp-result.ts";
import { redactMessage } from "./redact.ts";
import { type ToolMode, registerSessionTools } from "./session-tool-registry.ts";

export const SESSION_MCP_PATH = "/mcp";
/** How long a new session waits for the service to name the Chat and Localman tools (as `tunelo mcp` does). */
const REMOTE_LIST_WAIT_MS = 8_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** MCP sessions one ticket may hold at once; a client that reconnects without deleting drops its oldest. */
const MAX_SESSIONS_PER_TICKET = 4;
const BEARER = /^Bearer ([A-Za-z0-9_-]{16,128})$/;
const NO_TICKET = "no live session ticket";

export interface SessionMcpHttpOptions {
	/** tunelo's config folder. */
	dir: string;
	log: (line: string) => void;
	/** The Tunelo server a session's tunnels use; read per session so a later `tunelo login` counts. */
	serverUrl?: () => string;
	listWaitMs?: number;
}

export interface SessionMcpHttp {
	url: string;
	port: number;
	/** Open MCP sessions (for tests and diagnostics). */
	sessions(): number;
	close(): Promise<void>;
}

type Entry = {
	ticket: string;
	hostSession: string;
	server: McpServer;
	transport: WebStandardStreamableHTTPServerTransport;
	sessionId?: string;
};

function sameTicket(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

/** The body; undefined once it grows past MAX_BODY_BYTES (the rest is not read). */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.pause();
				resolve(undefined);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function webRequest(req: IncomingMessage, origin: string, body: Buffer): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
	}
	const method = req.method ?? "GET";
	const withBody = method !== "GET" && method !== "HEAD" && body.length > 0;
	return new Request(`${origin}${req.url ?? "/"}`, { method, headers, ...(withBody ? { body: new Uint8Array(body) } : {}) });
}

async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name] = value;
	});
	res.writeHead(response.status, headers);
	if (!response.body) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	res.on("close", () => void reader.cancel().catch(() => undefined));
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		res.write(value);
	}
	res.end();
}

function jsonError(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...extra }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** Serves tunelo's MCP for `host`'s tickets on 127.0.0.1; sets `host.httpUrl` once it listens. */
export async function serveSessionMcp(host: McpHost, opts: SessionMcpHttpOptions): Promise<SessionMcpHttp> {
	const serverUrl = opts.serverUrl ?? (() => resolveServerUrl(undefined, undefined, opts.dir));
	const listWaitMs = opts.listWaitMs ?? REMOTE_LIST_WAIT_MS;
	const byId = new Map<string, Entry>();
	const all = new Set<Entry>();
	let port = 0;

	const close = (entry: Entry): void => {
		if (!all.delete(entry)) return;
		if (entry.sessionId) byId.delete(entry.sessionId);
		host.end(entry.hostSession);
		void entry.server.close().catch(() => undefined);
	};

	const stopListening = host.onRelease((ticket) => {
		for (const entry of [...all]) if (entry.ticket === ticket) close(entry);
	});

	/** The app servers' tools for a new session, as `tunelo mcp` waits for them. */
	const offeredFor = async (ticket: string, mode: ToolMode) => {
		if (mode === "advisor" || mode === "weigh") return { tools: [], writes: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), listWaitMs);
		});
		try {
			const answer = await Promise.race([host.remoteTools(ticket), late]);
			if (!answer) {
				opts.log("mcp http: Chat and Localman tools left out (not listed in time)");
				return { tools: [], writes: host.maySeeWrites(ticket) };
			}
			for (const gap of answer.unavailable) opts.log(redactMessage(`mcp http: ${gap.group} tools left out: ${gap.reason}`));
			return { tools: answer.tools, writes: answer.writes };
		} catch (err) {
			opts.log(redactMessage(`mcp http: Chat and Localman tools left out (${(err as Error).message})`));
			return { tools: [], writes: host.maySeeWrites(ticket) };
		} finally {
			clearTimeout(timer);
		}
	};

	/** Closes the oldest initialized sessions of `ticket` beyond MAX_SESSIONS_PER_TICKET. */
	const trim = (ticket: string): void => {
		const mine = [...all].filter((e) => e.ticket === ticket && e.sessionId !== undefined);
		for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_TICKET))) close(old);
	};

	/** A new MCP session for a live ticket; undefined when the ticket ended meanwhile (nothing is left behind). */
	const start = async (ticket: string, mode: ToolMode): Promise<Entry | undefined> => {
		const url = serverUrl();
		const hostSession = host.open(url, ticket);
		const server = new McpServer({ name: "tunelo", version: AGENT_VERSION });
		const forward = async (group: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
			try {
				return await host.call(hostSession, group, tool, args);
			} catch (err) {
				return failure(new Error(redactMessage(err instanceof Error ? err.message : String(err))));
			}
		};
		try {
			registerSessionTools(server, { mode, context: createMcpContext(url, opts.dir), offered: await offeredFor(ticket, mode), forward });
		} catch (err) {
			host.end(hostSession);
			throw err;
		}
		// The transport's callbacks run only once `self.entry` holds it.
		const self: { entry?: Entry } = {};
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (id) => {
				if (!self.entry) return;
				self.entry.sessionId = id;
				byId.set(id, self.entry);
				// Only a session that opened makes room: a failed initialize never closes a working one.
				trim(ticket);
			},
			onsessionclosed: () => {
				if (self.entry) close(self.entry);
			},
		});
		const entry: Entry = { ticket, hostSession, server, transport };
		self.entry = entry;
		transport.onclose = () => close(entry);
		all.add(entry);
		// The ticket may have ended while the tools were listed: its release saw no entry to close.
		if (host.toolMode(ticket) === undefined) {
			close(entry);
			return undefined;
		}
		await server.connect(transport);
		return entry;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const origin = `http://127.0.0.1:${port}`;
		if ((req.url ?? "").split("?")[0] !== SESSION_MCP_PATH) return void res.writeHead(404).end();
		// Only a client that dialed this address by number: no page reaches it through a name it controls.
		if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(403).end();
		const ticket = BEARER.exec(String(req.headers.authorization ?? ""))?.[1];
		const mode = ticket ? host.toolMode(ticket) : undefined;
		if (!ticket || !mode) return jsonError(res, 401, NO_TICKET, { "www-authenticate": "Bearer" });
		// No stream of server-initiated messages: tunelo sends none.
		if (req.method === "GET") return jsonError(res, 405, "no event stream", { allow: "POST, DELETE" });
		const body = await readBody(req);
		if (!body) return jsonError(res, 413, "request too large", { connection: "close" });
		const sid = req.headers["mcp-session-id"];
		if (typeof sid === "string") {
			const entry = byId.get(sid);
			if (!entry || !sameTicket(entry.ticket, ticket)) return jsonError(res, 404, "Session not found");
			return sendWebResponse(await entry.transport.handleRequest(webRequest(req, origin, body)), res);
		}
		let message: unknown;
		try {
			message = JSON.parse(body.toString("utf8"));
		} catch {
			return jsonError(res, 400, "body is not JSON");
		}
		if (req.method !== "POST" || !isInitializeRequest(message)) return jsonError(res, 400, "a session starts with initialize");
		const entry = await start(ticket, mode);
		if (!entry) return jsonError(res, 401, NO_TICKET, { "www-authenticate": "Bearer" });
		let response: Response;
		try {
			response = await entry.transport.handleRequest(webRequest(req, origin, body));
		} finally {
			// An initialize that did not open a session leaves nothing behind.
			if (!entry.sessionId) close(entry);
		}
		return sendWebResponse(response, res);
	};

	const http: Server = createServer((req, res) => {
		void handle(req, res).catch((err: unknown) => {
			opts.log(redactMessage(`mcp http: ${err instanceof Error ? err.message : String(err)}`));
			if (!res.headersSent) jsonError(res, 500, "tunelo could not answer");
			else res.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(0, "127.0.0.1", () => {
			http.off("error", reject);
			resolve();
		});
	});
	const address = http.address();
	port = typeof address === "object" && address ? address.port : 0;
	const url = `http://127.0.0.1:${port}${SESSION_MCP_PATH}`;
	host.httpUrl = url;
	return {
		url,
		port,
		sessions: () => all.size,
		close: async () => {
			stopListening();
			if (host.httpUrl === url) host.httpUrl = undefined;
			for (const entry of [...all]) close(entry);
			await new Promise<void>((resolve) => {
				http.close(() => resolve());
				http.closeAllConnections?.();
			});
		},
	};
}
