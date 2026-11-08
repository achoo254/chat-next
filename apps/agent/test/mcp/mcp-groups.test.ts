import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { callControl } from "../../src/control-socket.ts";
import { sessionMcpFor } from "../../src/machine.ts";
import {
	TOOL_GROUPS,
	ToolTable,
	exposedToolName,
	needsApproval,
	sessionTool,
	toolGroup,
} from "../../src/mcp/groups.ts";
import { LocalTunnels } from "../../src/mcp/local-tunnels.ts";
import { createMcpContext } from "../../src/mcp/mcp-context.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { startFakeTunnelServer, type FakeTunnelServer } from "../support/fake-tunnel-server.ts";
import { buildCliBundle, buildServiceBundle, mcpClient, startService, textOf } from "../support/mcp-harness.ts";

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*/;
const CHAT_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjaGF0In0.c2lnY2hhdA";
const LOCALMAN_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJsbSJ9.c2lnbG0";

describe("the tool groups", () => {
	test("are tunnel, chat and localman, each write tool allowed, each two-step tool a write tool", () => {
		expect(TOOL_GROUPS.map((g) => g.name)).toEqual(["tunnel", "chat", "localman"]);
		for (const group of TOOL_GROUPS) {
			expect(group.app).toBe(group.name);
			for (const tool of group.writeTools) expect(group.allowedTools).toContain(tool);
			for (const tool of group.twoStepTools) expect(group.writeTools).toContain(tool);
		}
		expect(toolGroup("chat")?.writeTools).toEqual(["send_message"]);
		expect(toolGroup("localman")?.writeTools).toEqual(["send_request"]);
	});

	test("the tunnel group allows exactly the tools the service runs", () => {
		const context = createMcpContext("wss://tunnel.example", mkdtempSync(join(tmpdir(), "tunelo-groups-")));
		const table = new ToolTable();
		toolGroup("tunnel")?.register?.(table, { context, tunnels: new LocalTunnels(context) });
		expect(table.entries().map(([name]) => name).sort()).toEqual([...(toolGroup("tunnel")?.allowedTools ?? [])].sort());
	});

	test("no two groups expose the same name", () => {
		const names = TOOL_GROUPS.flatMap((g) => g.allowedTools.map((t) => exposedToolName(g.name, t)));
		expect(new Set(names).size).toBe(names.length);
		expect(sessionTool("mcp__tunelo__chat_send_message")).toMatchObject({ tool: "send_message", group: { name: "chat" } });
		expect(sessionTool("mcp__tunelo__whoami")).toMatchObject({ tool: "whoami", group: { name: "tunnel" } });
		expect(sessionTool("mcp__tunelo__chat_delete_messages")).toBeUndefined();
	});

	test("approval: write tools, two-step ones only with their confirm token", () => {
		expect(needsApproval("mcp__tunelo__chat_send_message", {})).toBe(true);
		expect(needsApproval("mcp__tunelo__localman_send_request", {})).toBe(true);
		expect(needsApproval("mcp__tunelo__chat_list_chats", {})).toBe(false);
		expect(needsApproval("mcp__tunelo__revoke_linked_machine", { dry_run: true })).toBe(false);
		expect(needsApproval("mcp__tunelo__revoke_linked_machine", { confirm_token: "" })).toBe(false);
		expect(needsApproval("mcp__tunelo__revoke_linked_machine", { confirm_token: "t" })).toBe(true);
	});
});

describe("the service's MCP host", () => {
	let chat: FakeMcpApp;
	let home: string;

	beforeAll(async () => {
		chat = await startFakeMcpApp();
		chat.accepted.add(CHAT_TOKEN);
		home = mkdtempSync(join(tmpdir(), "tunelo-host-"));
	});
	afterAll(async () => {
		await chat.close();
		rmSync(home, { recursive: true, force: true });
	});

	function host(enabled?: ("tunnel" | "chat" | "localman")[]) {
		const lines: string[] = [];
		const remote = new RemoteProxy({ endpoint: () => chat.url, token: async () => CHAT_TOKEN, forget: async () => undefined });
		const h = new McpHost(home, { remote, log: (l) => lines.push(l), ...(enabled ? { enabledGroups: () => enabled } : {}) });
		return { h, lines };
	}

	test("a session's ticket names it in the log; an ended ticket is refused", async () => {
		const { h, lines } = host();
		const ticket = h.tickets.issue("thread-1");
		const id = h.open("wss://tunnel.example", ticket);
		const ok = await h.call(id, "chat", "list_chats", {});
		expect(ok.isError).toBeUndefined();
		expect(lines).toEqual(["mcp thread-1: chat list_chats ok"]);
		h.tickets.revoke(ticket);
		const ended = await h.call(id, "chat", "list_chats", {});
		expect(textOf(ended)).toMatch(/ended/);
		expect(() => h.open("wss://tunnel.example", ticket)).toThrow(/ended/);
		h.endAll();
	});

	test("without a ticket it acts as the local user, with the same tools", async () => {
		const { h, lines } = host();
		const id = h.open("wss://tunnel.example");
		expect((await h.call(id, "chat", "send_message", { chat_id: 7, text: "x" })).isError).toBeUndefined();
		expect(lines).toEqual(["mcp local: chat send_message ok"]);
		h.endAll();
	});

	test("refuses a tool outside the list and a group turned off", async () => {
		const { h } = host(["tunnel", "localman"]);
		const id = h.open("wss://tunnel.example");
		const before = chat.calls.length;
		expect(textOf(await h.call(id, "chat", "list_chats", {}))).toMatch(/off on this machine/);
		const { h: all } = host();
		const id2 = all.open("wss://tunnel.example");
		expect(textOf(await all.call(id2, "chat", "delete_messages", { chat_id: 7 }))).toMatch(/not a tool tunelo offers/);
		expect(textOf(await all.call(id2, "tunnel", "kill_everything", {}))).toMatch(/not a tool tunelo offers/);
		expect(chat.calls.length).toBe(before);
		expect((await all.remoteTools()).tools.map((t) => t.exposed).sort()).toEqual([
			"chat_list_chats",
			"chat_send_message",
			"localman_list_collections",
			"localman_send_request",
		]);
		h.endAll();
		all.endAll();
	});
});

describe("sessions of the machine", () => {
	test("get a ticket of the service's MCP, ended with them; none with sessionMcp off", () => {
		const dir = mkdtempSync(join(tmpdir(), "tunelo-session-mcp-"));
		const config = new ConfigStore(dir);
		const mcp = new McpHost(dir, { remote: new RemoteProxy({ endpoint: () => "http://127.0.0.1:9/mcp", token: async () => "t", forget: async () => undefined }) });
		const lease = sessionMcpFor(mcp, config)("thread-9");
		expect(lease?.configDir).toBe(dir);
		expect(mcp.tickets.owner(lease?.ticket ?? "")).toBe("thread-9");
		lease?.release();
		expect(mcp.tickets.owner(lease?.ticket ?? "")).toBeUndefined();
		config.update((c) => {
			c.sessionMcp = false;
		});
		expect(sessionMcpFor(mcp, config)("thread-10")).toBeUndefined();
		mcp.endAll();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("tunelo mcp with the service", () => {
	let bundle: string;
	let service: Awaited<ReturnType<typeof startService>>;
	let tunnelServer: FakeTunnelServer;
	let chat: FakeMcpApp;
	let localman: FakeMcpApp;
	let home: string;

	beforeAll(async () => {
		bundle = await buildCliBundle("tunelo-mcp-groups");
		const serviceBundle = await buildServiceBundle("tunelo-mcp-groups");
		tunnelServer = await startFakeTunnelServer();
		chat = await startFakeMcpApp();
		localman = await startFakeMcpApp();
		chat.accepted.add(CHAT_TOKEN);
		localman.accepted.add(LOCALMAN_TOKEN);
		home = mkdtempSync(join(tmpdir(), "tunelo-mcp-groups-"));
		service = await startService(serviceBundle, home, {
			TUNELO_TEST_REMOTE_APPS: JSON.stringify({
				chat: { url: chat.url, token: CHAT_TOKEN },
				localman: { url: localman.url, token: LOCALMAN_TOKEN },
			}),
		});
	});

	afterAll(async () => {
		await service.stop();
		await tunnelServer.close();
		await chat.close();
		await localman.close();
		rmSync(home, { recursive: true, force: true });
	});

	test("lists the tools of all three groups and runs them with no token reaching the client", async () => {
		const { client, transport } = mcpClient(bundle, tunnelServer.wsUrl, home);
		await client.connect(transport);
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["open_http_tunnel", "whoami", "chat_list_chats", "chat_send_message", "localman_list_collections", "localman_send_request"]));
		expect(names).not.toContain("chat_delete_messages");
		expect(names).not.toContain("localman_list_chats");

		const sent = await client.callTool({ name: "chat_send_message", arguments: { chat_id: 7, text: "test" } });
		expect(textOf(sent)).toContain('"sent":"test"');
		const request = await client.callTool({ name: "localman_send_request", arguments: { method: "GET", url: "http://localhost:5173" } });
		expect(textOf(request)).toContain("localhost:5173");
		for (const result of [sent, request]) expect(JSON.stringify(result)).not.toMatch(JWT);
		// The list route answers names and schemas only.
		const listed = await callControl(join(home, "tunelo"), "POST", "/mcp/tools", {});
		expect(JSON.stringify(listed)).toContain("chat_send_message");
		expect(JSON.stringify(listed)).not.toMatch(JWT);
		// Each app saw only its own token.
		expect(new Set(chat.seen)).toEqual(new Set([CHAT_TOKEN]));
		expect(new Set(localman.seen)).toEqual(new Set([LOCALMAN_TOKEN]));
		await client.close();
	});

	test("refuses a ticket the service never gave (an ended session)", async () => {
		const { client, transport } = mcpClient(bundle, tunnelServer.wsUrl, home, { TUNELO_MCP_TICKET: "not-a-live-ticket" });
		await client.connect(transport);
		const result = await client.callTool({ name: "chat_list_chats", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/ended/);
		await client.close();
	});
});
