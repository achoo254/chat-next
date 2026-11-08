/**
 * The service's client of the Chat and Localman MCP servers (Streamable
 * HTTP). It adds the account's token of the app to every request, lists
 * the tools a group allows (cached ten minutes) and runs them. Only tool
 * results leave it: never a token, which it also cuts out of any result
 * that would echo one.
 */
import {
	Client,
	InsufficientScopeError,
	SdkError,
	SdkErrorCode,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	type AppName,
	ResourceNotGrantedError,
	SessionExpiredError,
	appResources,
	identitySession,
} from "../identity/session.ts";
import { AGENT_VERSION } from "../version.ts";
import type { ToolAnnotations, ToolGroup } from "./groups.js";
import { failure } from "./mcp-result.js";
import { redact, redactMessage } from "./redact.js";

/** How the service reaches an app's MCP server as the signed-in account. */
export interface RemoteAccess {
	/** The app's MCP endpoint, which is also its resource (the token `aud`). */
	endpoint(app: AppName): string;
	token(app: AppName): Promise<string>;
	/** The server refused `token` before it expired: the next token() refreshes. */
	forget(app: AppName, token: string): Promise<void>;
	/** Who is signed in ("" for nobody): tool lists are kept per account. */
	account(): string;
}

const NOT_SIGNED_IN = "This machine is not signed in: run `tunelo login` on it.";

/** Access with this machine's sign-in (identity/session.ts). */
export function identityAccess(dir: string): RemoteAccess {
	const session = identitySession(dir);
	const resource = (app: AppName): string => {
		const info = session.info();
		if (!info) throw new SessionExpiredError(NOT_SIGNED_IN);
		return appResources(info.issuer)[app];
	};
	return {
		endpoint: resource,
		token: (app) => session.getAppToken(app),
		forget: (app, token) => session.forgetAccessToken(resource(app), token),
		account: () => {
			const info = session.info();
			return info ? `${info.issuer} ${info.sub}` : "";
		},
	};
}

/** A remote tool as `tunelo mcp` lists it, under the server's own name. */
export interface RemoteTool {
	name: string;
	title?: string;
	description: string;
	/** JSON Schema of the arguments, as the server advertises it. */
	inputSchema: Record<string, unknown>;
	annotations?: ToolAnnotations;
}

export interface RemoteProxyOptions {
	now?: () => number;
	/** Bound on connecting plus listing, so a server down does not hold a session's start. */
	listTimeoutMs?: number;
	/** Bound on one tool call (a Localman request may take two minutes). */
	callTimeoutMs?: number;
}

const LIST_TTL_MS = 10 * 60_000;
const MAX_LIST_PAGES = 5;
/** A server that could not list its tools is not asked again for this long. */
const LIST_FAILURE_TTL_MS = 30_000;
/** Tokens sent are remembered this long, to cut them out of anything a server echoes. */
const SENT_TOKEN_TTL_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What an agent should read when a call fails before the tool ran. */
function explain(app: AppName, err: unknown): string {
	// The app's id, not its product name (that one belongs to the brand package).
	const server = `the ${app} MCP server`;
	if (err instanceof InsufficientScopeError) {
		return `This machine's sign-in does not allow this ${app} tool: run \`tunelo login\` on it again.`;
	}
	if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpForbidden) {
		return `${server} refused this tool for this machine's sign-in: run \`tunelo login\` on it again.`;
	}
	if (err instanceof UnauthorizedError || (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpAuthentication)) {
		return `${server} did not accept this machine's sign-in: run \`tunelo login\` on it again.`;
	}
	if (err instanceof SessionExpiredError || err instanceof ResourceNotGrantedError) return err.message;
	const message = err instanceof Error ? err.message : String(err);
	return `${server} could not be reached: ${message}`;
}

/** One connected client per app. */
interface Connection {
	client: Client;
}

export class RemoteProxy {
	private readonly lists = new Map<string, { at: number; tools: RemoteTool[] } | { at: number; failure: Error }>();
	private readonly loading = new Map<string, Promise<RemoteTool[]>>();
	private readonly connections = new Map<AppName, Promise<Connection>>();
	/** Every token sent, until when it is still cut out of answers. */
	private readonly sent = new Map<string, number>();
	private readonly now: () => number;
	private readonly listTimeoutMs: number;
	private readonly callTimeoutMs: number;

	constructor(
		private readonly access: RemoteAccess,
		options: RemoteProxyOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.listTimeoutMs = options.listTimeoutMs ?? 5_000;
		this.callTimeoutMs = options.callTimeoutMs ?? 150_000;
	}

	/** Any text bound for an agent: without the tokens sent, JWTs or Bearer values. */
	redact(text: string): string {
		const at = this.now();
		for (const [token, until] of this.sent) if (until <= at) this.sent.delete(token);
		return redact(text, this.sent.keys());
	}

	private failed(app: AppName, err: unknown): Error {
		return new Error(redactMessage(explain(app, err), this.sent.keys()));
	}

	/** The group's tools the server offers this account, among those the group allows. */
	tools(group: ToolGroup): Promise<RemoteTool[]> {
		const key = `${group.name}\n${this.access.account()}`;
		const cached = this.lists.get(key);
		if (cached && "failure" in cached && this.now() - cached.at < LIST_FAILURE_TTL_MS) return Promise.reject(cached.failure);
		if (cached && "tools" in cached && this.now() - cached.at < LIST_TTL_MS) return Promise.resolve(cached.tools);
		const pending = this.loading.get(key);
		if (pending) return pending;
		const load = this.fetchTools(group).then(
			(tools) => {
				this.lists.set(key, { at: this.now(), tools });
				return tools;
			},
			(err: unknown) => {
				const failure = err instanceof Error ? err : new Error(String(err));
				this.lists.set(key, { at: this.now(), failure });
				throw failure;
			},
		);
		const tracked = load.finally(() => this.loading.delete(key));
		this.loading.set(key, tracked);
		return tracked;
	}

	/** Runs `tool` of `group` on its server; a failure comes back as a tool error. */
	async call(group: ToolGroup, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
		if (!group.allowedTools.includes(tool)) return failure(new Error(`${tool} is not a tool tunelo offers`));
		try {
			const result = await this.withClient(group.app, this.callTimeoutMs, (client) =>
				client.callTool({ name: tool, arguments: args }, { timeout: this.callTimeoutMs }),
			);
			const content = Array.isArray(result.content) ? result.content : [];
			const texts = content.flatMap((item) =>
				isRecord(item) && item.type === "text" && typeof item.text === "string"
					? [{ type: "text" as const, text: this.redact(item.text) }]
					: [],
			);
			return { content: texts, ...(result.isError === true ? { isError: true } : {}) };
		} catch (err) {
			return failure(this.failed(group.app, err));
		}
	}

	/** Closes every connection; the next call opens a new one. */
	async close(): Promise<void> {
		const open = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(open.map((p) => p.then((c) => c.client.close()).catch(() => undefined)));
	}

	private async fetchTools(group: ToolGroup): Promise<RemoteTool[]> {
		try {
			return await this.withClient(group.app, this.listTimeoutMs, async (client) => {
				const listed: RemoteTool[] = [];
				let cursor: string | undefined;
				for (let page = 0; page < MAX_LIST_PAGES; page++) {
					const answer = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.listTimeoutMs });
					for (const tool of answer.tools) {
						if (!group.allowedTools.includes(tool.name)) continue;
						listed.push({
							name: tool.name,
							...(tool.title ? { title: this.redact(tool.title) } : {}),
							description: this.redact(tool.description ?? ""),
							inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" },
							...(tool.annotations ? { annotations: pickAnnotations(tool.annotations) } : {}),
						});
					}
					cursor = answer.nextCursor;
					if (!cursor) break;
				}
				return listed;
			});
		} catch (err) {
			throw this.failed(group.app, err);
		}
	}

	/** Runs `use` on the app's client, connecting first; a failed client is dropped. */
	private async withClient<T>(app: AppName, connectTimeoutMs: number, use: (client: Client) => Promise<T>): Promise<T> {
		let pending = this.connections.get(app);
		if (!pending) {
			pending = this.connect(app, connectTimeoutMs);
			this.connections.set(app, pending);
		}
		let connection: Connection | undefined;
		try {
			connection = await pending;
			return await use(connection.client);
		} catch (err) {
			// A refused or broken connection: the next call starts a new one.
			if (this.connections.get(app) === pending) this.connections.delete(app);
			void connection?.client.close().catch(() => undefined);
			throw err;
		}
	}

	private async connect(app: AppName, timeoutMs: number): Promise<Connection> {
		// The token each answer was asked with: a 401 forgets exactly that one,
		// never the fresh token another call already got.
		const askedWith = new WeakMap<Response, string>();
		const transport = new StreamableHTTPClientTransport(new URL(this.access.endpoint(app)), {
			authProvider: {
				token: async () => {
					const token = await this.access.token(app);
					this.sent.set(token, this.now() + SENT_TOKEN_TTL_MS);
					return token;
				},
				// Refreshed once; a second 401 fails the request.
				onUnauthorized: async ({ response }) => {
					const token = askedWith.get(response);
					if (token) await this.access.forget(app, token);
				},
			},
			fetch: async (url, init) => {
				const response = await fetch(url, init);
				const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "");
				if (bearer) askedWith.set(response, bearer);
				return response;
			},
			onInsufficientScope: "throw",
		});
		const client = new Client({ name: "tunelo", version: AGENT_VERSION });
		await client.connect(transport, { timeout: timeoutMs });
		return { client };
	}
}

function pickAnnotations(a: Record<string, unknown>): ToolAnnotations {
	const out: ToolAnnotations = {};
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		if (typeof a[key] === "boolean") out[key] = a[key];
	}
	return out;
}
