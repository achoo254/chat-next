// tunelo's MCP served by the service over HTTP to the sessions it opens: the
// same tools and the same refusals as `tunelo mcp` over stdio, a live ticket
// for every request, and the session gone with its ticket.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { sessionMcpFor } from "../../src/machine.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { type SessionMcpHttp, serveSessionMcp } from "../../src/mcp/session-mcp-http.ts";
import { sessionMcpHttp } from "../../src/mcp/session-mcp-launch.ts";
import { HTTP_TICKET_ENV } from "../../src/mcp/session-tickets.ts";
import type { RemoteTool } from "../../src/mcp/remote-proxy.ts";
import { sessionMcpEnv, terminalCommand } from "../../src/providers/claude/index.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { textOf } from "../support/mcp-harness.ts";

const CHAT_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjaGF0In0.c2lnY2hhdA"; // secret-approved: made up ({"alg":"ES256"}.{"aud":"chat"}.sigchat), the fake Chat app's only token
const SEND = { chat_id: 7, text: "hi" };

let chat: FakeMcpApp;
let home: string;
let host: McpHost;
let served: SessionMcpHttp;
const clients: Client[] = [];

beforeAll(async () => {
	chat = await startFakeMcpApp();
	chat.accepted.add(CHAT_TOKEN);
	home = mkdtempSync(join(tmpdir(), "tunelo-mcp-http-"));
	const remote = new RemoteProxy({ endpoint: () => chat.url, token: async () => CHAT_TOKEN, forget: async () => undefined, account: () => "a" });
	host = new McpHost(home, { remote, enabledGroups: () => ["tunnel", "chat"], localWrites: () => false });
	served = await serveSessionMcp(host, { dir: home, log: () => undefined, serverUrl: () => "wss://tunnel.example" });
});

afterEach(async () => {
	for (const c of clients.splice(0)) await c.close().catch(() => undefined);
});

afterAll(async () => {
	await served.close();
	host.endAll();
	await chat.close();
	rmSync(home, { recursive: true, force: true });
});

async function connect(ticket: string): Promise<Client> {
	const client = new Client({ name: "test", version: "0" });
	const transport = new StreamableHTTPClientTransport(new URL(served.url), { requestInit: { headers: { Authorization: `Bearer ${ticket}` } } });
	await client.connect(transport);
	clients.push(client);
	return client;
}

/** A raw request to the endpoint, with the Host header chosen. */
function raw(headers: Record<string, string>, body: unknown, method = "POST"): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: served.port, path: "/mcp", method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

describe("tunelo's MCP over HTTP", () => {
	test("refuses a request without a live ticket, or reaching it by another name than 127.0.0.1", async () => {
		const at = { host: `127.0.0.1:${served.port}` };
		expect(await raw(at, INITIALIZE)).toBe(401);
		expect(await raw({ ...at, authorization: "Bearer not-a-ticket-of-this-service" }, INITIALIZE)).toBe(401);
		const ticket = host.tickets.issue("thread-ended");
		host.release(ticket);
		expect(await raw({ ...at, authorization: `Bearer ${ticket}` }, INITIALIZE)).toBe(401);
		const live = host.tickets.issue("thread-host");
		expect(await raw({ host: `localhost:${served.port}`, authorization: `Bearer ${live}` }, INITIALIZE)).toBe(403);
		host.release(live);
	});

	test("a session lists the tunnel and Chat tools, writes included, and its writes need the device's approval, once", async () => {
		const ticket = host.tickets.issue("thread-1");
		const client = await connect(ticket);
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain("open_http_tunnel");
		expect(names).toContain("chat_list_chats");
		expect(names).toContain("chat_send_message");
		expect(names).toContain("request_secret");

		const refused = await client.callTool({ name: "chat_send_message", arguments: SEND });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toMatch(/not approved/);

		host.approve(ticket, "chat_send_message", SEND);
		const sent = await client.callTool({ name: "chat_send_message", arguments: SEND });
		expect(sent.isError).toBeFalsy();
		// The app's token never leaves the service.
		expect(textOf(sent)).not.toContain(CHAT_TOKEN);
		expect((await client.callTool({ name: "chat_send_message", arguments: SEND })).isError).toBe(true);
		host.release(ticket);
	});

	test("the AI's CLI in a terminal lists advisor_weigh alone", async () => {
		const ticket = host.tickets.issue("thread-term", "advisor-weigh");
		const client = await connect(ticket);
		expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["advisor_weigh"]);
		host.release(ticket);
	});

	test("a session ends with its ticket: its MCP session is gone and a call says so", async () => {
		const ticket = host.tickets.issue("thread-2");
		const client = await connect(ticket);
		expect(served.sessions()).toBeGreaterThan(0);
		const before = served.sessions();
		host.release(ticket);
		expect(served.sessions()).toBe(before - 1);
		await expect(client.listTools()).rejects.toThrow();
	});

	test("one ticket cannot use another ticket's session", async () => {
		const a = host.tickets.issue("thread-a");
		const b = host.tickets.issue("thread-b");
		const client = await connect(a);
		const sid = (client.transport as StreamableHTTPClientTransport).sessionId ?? "";
		const status = await raw({ host: `127.0.0.1:${served.port}`, authorization: `Bearer ${b}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(status).toBe(404);
		host.release(a);
		host.release(b);
	});
	test("a GET opens no event stream, and a client's DELETE ends its session", async () => {
		const ticket = host.tickets.issue("thread-del");
		expect(await raw({ host: `127.0.0.1:${served.port}`, authorization: `Bearer ${ticket}` }, undefined, "GET")).toBe(405);
		const client = await connect(ticket);
		const before = served.sessions();
		await (client.transport as StreamableHTTPClientTransport).terminateSession();
		expect(served.sessions()).toBe(before - 1);
		host.release(ticket);
	});

	test("an initialize the transport refuses leaves nothing behind", async () => {
		const ticket = host.tickets.issue("thread-bad-init");
		const before = served.sessions();
		// Without text/event-stream in Accept the transport answers 406 and opens no session.
		const status = await raw({ host: `127.0.0.1:${served.port}`, authorization: `Bearer ${ticket}`, accept: "application/json" }, INITIALIZE);
		expect(status).toBe(406);
		expect(served.sessions()).toBe(before);
		host.release(ticket);
	});

	test("one ticket keeps four sessions at most, the oldest goes", async () => {
		const ticket = host.tickets.issue("thread-cap");
		const before = served.sessions();
		const first = await connect(ticket);
		for (let i = 0; i < 4; i++) await connect(ticket);
		expect(served.sessions()).toBe(before + 4);
		await expect(first.listTools()).rejects.toThrow();
		host.release(ticket);
		expect(served.sessions()).toBe(before);
	});
});

describe("tunelo's MCP over HTTP, special tickets", () => {
	test("an Advisor thread's session lists Advisor's tools only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tunelo-mcp-http-adv-"));
		const advisorHost = new McpHost(dir, { enabledGroups: () => ["tunnel"], localWrites: () => false, isAdvisorThread: (id) => id === "advisor-thread" });
		const own = await serveSessionMcp(advisorHost, { dir, log: () => undefined, serverUrl: () => "wss://tunnel.example" });
		try {
			const ticket = advisorHost.tickets.issue("advisor-thread");
			const client = new Client({ name: "test", version: "0" });
			await client.connect(new StreamableHTTPClientTransport(new URL(own.url), { requestInit: { headers: { Authorization: `Bearer ${ticket}` } } }));
			const names = (await client.listTools()).tools.map((t) => t.name).sort();
			expect(names.length).toBeGreaterThan(0);
			for (const name of names) expect(name).toMatch(/^advisor_/);
			await client.close();
		} finally {
			await own.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a ticket that ends while its tools are listed gets no session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tunelo-mcp-http-slow-"));
		let listed: () => void = () => undefined;
		const slowList = new Promise<void>((resolve) => (listed = resolve));
		const remote = {
			tools: async (): Promise<RemoteTool[]> => {
				await slowList;
				return [];
			},
			call: async () => ({ content: [] }),
			redact: (text: string) => text,
			close: async () => undefined,
		} as unknown as RemoteProxy;
		const slowHost = new McpHost(dir, { remote, enabledGroups: () => ["tunnel", "chat"], localWrites: () => false });
		const own = await serveSessionMcp(slowHost, { dir, log: () => undefined, serverUrl: () => "wss://tunnel.example" });
		try {
			const ticket = slowHost.tickets.issue("thread-slow");
			const pending = new Promise<number>((resolve, reject) => {
				const req = http.request(
					{ host: "127.0.0.1", port: own.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${ticket}` } },
					(res) => {
						res.resume();
						resolve(res.statusCode ?? 0);
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify(INITIALIZE));
			});
			await new Promise((r) => setTimeout(r, 50));
			slowHost.release(ticket);
			listed();
			expect(await pending).toBe(401);
			expect(own.sessions()).toBe(0);
		} finally {
			await own.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});


describe("a session's MCP config", () => {
	test("a lease names the service's endpoint once it listens", () => {
		const lease = sessionMcpFor(host, new ConfigStore(home))("thread-lease");
		expect(lease?.url).toBe(served.url);
		lease?.release();
	});

	test("the HTTP config names the ticket from the environment, never itself", () => {
		const http = sessionMcpHttp({ ticket: "tk_1", url: served.url });
		expect(http?.config).toEqual({ type: "http", url: served.url, headers: { Authorization: `Bearer \${${HTTP_TICKET_ENV}}` } });
		expect(http?.env).toEqual({ [HTTP_TICKET_ENV]: "tk_1" });
		expect(sessionMcpHttp({ ticket: "tk_1" })).toBeUndefined();
	});

	test("claude in a terminal gets the endpoint in --mcp-config and the ticket in its environment only", () => {
		const out = terminalCommand(
			"/bin/claude",
			{ dir: "/w", advisor: { ticket: "tk_secret", configDir: "/cfg", url: served.url, noteCommand: ["/t", "advisor", "note", "x"], stopCommand: ["/t", "advisor", "stop", "x"] } },
			() => "0b0c3f6e-1d2a-4c5b-8e9f-0a1b2c3d4e5f",
			"darwin",
		);
		expect(out.args.join(" ")).not.toContain("tk_secret");
		const mcp = JSON.parse(out.args[out.args.indexOf("--mcp-config") + 1] ?? "") as { mcpServers: Record<string, { type: string; url: string }> };
		expect(mcp.mcpServers["tunelo-advisor"]).toMatchObject({ type: "http", url: served.url });
		expect(out.env).toEqual({ [HTTP_TICKET_ENV]: "tk_secret" });
	});

	test("claude's environment for the SDK: the ticket and loopback added to NO_PROXY, nothing for stdio", () => {
		const env = sessionMcpEnv({ ticket: "tk_2", configDir: "/cfg", url: served.url, approveWrite: () => undefined, describeWrite: async () => undefined }, { NO_PROXY: "corp.example" });
		expect(env).toEqual({ [HTTP_TICKET_ENV]: "tk_2", NO_PROXY: "corp.example,127.0.0.1,localhost", no_proxy: "corp.example,127.0.0.1,localhost" });
		expect(sessionMcpEnv({ ticket: "tk_2", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined })).toEqual({});
	});
});
