import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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
import { LOCAL_WRITES_FILE, LocalWritesSetting } from "../../src/mcp/local-writes.ts";
import { McpHost, type McpHostOptions } from "../../src/mcp/mcp-host.ts";
import { WriteApprovals } from "../../src/mcp/write-approvals.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { Decision, PromptState } from "@achoo254/chat-proto/remote/remote";
import { fakeProvider } from "../fake-provider.ts";
import { byCase, makeCore } from "../harness.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { startFakeTunnelServer, type FakeTunnelServer } from "../support/fake-tunnel-server.ts";
import { buildCliBundle, buildServiceBundle, machineEnv, mcpClient, startService, textOf } from "../support/mcp-harness.ts";

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*/;
const CHAT_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjaGF0In0.c2lnY2hhdA";
const LOCALMAN_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJsbSJ9.c2lnbG0";

describe("the tool groups", () => {
	test("are tunnel, chat, localman and kb, each write tool allowed, each two-step tool a write tool", () => {
		expect(TOOL_GROUPS.map((g) => g.name)).toEqual(["tunnel", "chat", "localman", "kb"]);
		for (const group of TOOL_GROUPS) {
			expect(group.app).toBe(group.name);
			for (const tool of group.writeTools) expect(group.allowedTools).toContain(tool);
			for (const tool of group.twoStepTools) expect(group.writeTools).toContain(tool);
		}
		expect(toolGroup("chat")?.writeTools).toEqual(["send_message", "send_media", "forward_messages", "start_private_chat", "send_file"]);
		// The upload tools are the service's own: never allowed to an agent.
		for (const tool of toolGroup("chat")?.internalTools ?? []) expect(toolGroup("chat")?.allowedTools).not.toContain(tool);
		expect(toolGroup("chat")?.internalTools).toEqual(["start_media_upload", "complete_media_upload"]);
		expect(toolGroup("localman")?.writeTools).toEqual(["send_request", "create_collection_node"]);
		expect(toolGroup("kb")).toMatchObject({ writeTools: ["save_note"], twoStepTools: ["save_note"] });
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
		expect(sessionTool("chat_send_message")).toMatchObject({ tool: "send_message", group: { name: "chat" } });
		expect(sessionTool("whoami")).toMatchObject({ tool: "whoami", group: { name: "tunnel" } });
		expect(sessionTool("chat_delete_messages")).toBeUndefined();
		expect(sessionTool("chat_start_media_upload")).toBeUndefined();
		expect(sessionTool("chat_send_file")).toMatchObject({ tool: "send_file", group: { name: "chat" } });
	});

	test("the chat group runs send_file in the service, only for a session tunelo opened; the rest on Chat's server", () => {
		const context = createMcpContext("wss://tunnel.example", mkdtempSync(join(tmpdir(), "tunelo-groups-")));
		const chat = toolGroup("chat");
		const listed = (ticketed: boolean) => {
			const table = new ToolTable();
			chat?.register?.(table, { context, tunnels: new LocalTunnels(context), ...(ticketed ? { ticketed } : {}) });
			return table.entries().map(([name]) => name);
		};
		expect(listed(true)).toEqual(["send_file"]);
		expect(listed(false)).toEqual([]);
	});

	test("approval: write tools, two-step ones only with their confirm token", () => {
		expect(needsApproval("chat_send_message", {})).toBe(true);
		for (const tool of ["chat_send_media", "chat_forward_messages", "chat_start_private_chat", "chat_send_file"]) expect(needsApproval(tool, {})).toBe(true);
		expect(needsApproval("chat_list_people", {})).toBe(false);
		expect(needsApproval("localman_send_request", {})).toBe(true);
		expect(needsApproval("chat_list_chats", {})).toBe(false);
		expect(needsApproval("revoke_linked_machine", { dry_run: true })).toBe(false);
		expect(needsApproval("revoke_linked_machine", { confirm_token: "" })).toBe(false);
		expect(needsApproval("revoke_linked_machine", { confirm_token: "t" })).toBe(true);
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

	function host(enabled?: ("tunnel" | "chat" | "localman")[], extra: Partial<McpHostOptions> = {}) {
		const lines: string[] = [];
		const remote = new RemoteProxy({ endpoint: () => chat.url, token: async () => CHAT_TOKEN, forget: async () => undefined, account: () => "a" });
		const h = new McpHost(home, { remote, log: (l) => lines.push(l), ...(enabled ? { enabledGroups: () => enabled } : {}), ...extra });
		return { h, lines };
	}

	const SEND = { chat_id: 7, text: "hi" };

	test("a session's write runs only with the device's approval of that exact call, once", async () => {
		const { h, lines } = host();
		const ticket = h.tickets.issue("thread-1");
		const id = h.open("wss://tunnel.example", ticket);
		const sentBefore = chat.calls.filter((c) => c.name === "send_message").length;
		const sent = () => chat.calls.filter((c) => c.name === "send_message").length - sentBefore;

		expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved on the device/);
		expect(sent()).toBe(0);

		h.approve(ticket, "chat_send_message", SEND);
		expect(textOf(await h.call(id, "chat", "send_message", { ...SEND, text: "other" }))).toMatch(/not approved/);
		expect((await h.call(id, "chat", "send_message", { text: "hi", chat_id: 7 })).isError).toBeUndefined();
		expect(sent()).toBe(1);
		expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
		expect(sent()).toBe(1);
		expect(lines).toContain("mcp thread-1: chat send_message refused (not approved)");

		// Another session's approval does not count.
		const other = h.tickets.issue("thread-2");
		h.approve(other, "chat_send_message", SEND);
		expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
		h.endAll();
	});

	test("an approval expires after a minute and ends with its session", async () => {
		let now = 0;
		const { h } = host(undefined, { approvals: new WriteApprovals(() => now) });
		const ticket = h.tickets.issue("thread-1");
		const id = h.open("wss://tunnel.example", ticket);
		h.approve(ticket, "chat_send_message", SEND);
		now = 60_001;
		expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
		now = 0;
		h.approve(ticket, "chat_send_message", SEND);
		h.release(ticket);
		const again = h.tickets.issue("thread-1");
		const id2 = h.open("wss://tunnel.example", again);
		expect(textOf(await h.call(id2, "chat", "send_message", SEND))).toMatch(/not approved/);
		h.endAll();
	});

	test("reads and dry runs need no approval; a bypassed session needs none", async () => {
		const { h } = host(undefined, { sessionBypassed: (who) => who === "bypassed" });
		const ticket = h.tickets.issue("thread-1");
		const id = h.open("wss://tunnel.example", ticket);
		expect((await h.call(id, "chat", "list_chats", {})).isError).toBeUndefined();
		const dryRun = await h.call(id, "tunnel", "revoke_linked_machine", { id: "l1", dry_run: true });
		expect(textOf(dryRun)).not.toMatch(/not approved/);
		const bypassed = h.open("wss://tunnel.example", h.tickets.issue("bypassed"));
		expect((await h.call(bypassed, "chat", "send_message", SEND)).isError).toBeUndefined();
		h.endAll();
	});

	test("without a ticket, writes are off by default: refused and not listed; reads still run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tunelo-local-writes-"));
		const remote = new RemoteProxy({ endpoint: () => chat.url, token: async () => CHAT_TOKEN, forget: async () => undefined, account: () => "a" });
		const h = new McpHost(dir, { remote, enabledGroups: () => ["tunnel", "chat"] });
		const id = h.open("wss://tunnel.example");
		const before = chat.calls.length;
		const refused = await h.call(id, "chat", "send_message", SEND);
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toMatch(/tunelo config mcp-local-writes on/);
		expect(textOf(await h.call(id, "tunnel", "open_http_tunnel", { port: 3000 }))).toMatch(/mcp-local-writes/);
		expect(chat.calls.length).toBe(before);
		expect((await h.call(id, "chat", "list_chats", {})).isError).toBeUndefined();
		expect((await h.remoteTools()).tools.map((t) => t.exposed)).not.toContain("chat_send_message");
		expect((await h.remoteTools()).writes).toBe(false);

		// Turned on: the same client writes, and sees the write tools.
		await new LocalWritesSetting(dir).set(true);
		expect((await h.call(id, "chat", "send_message", SEND)).isError).toBeUndefined();
		expect((await h.remoteTools()).tools.map((t) => t.exposed)).toContain("chat_send_message");

		// Off again; a session's ticket is not affected either way (its writes need the device's approval).
		await new LocalWritesSetting(dir).set(false);
		const ticket = h.tickets.issue("thread-1");
		const session = h.open("wss://tunnel.example", ticket);
		expect((await h.remoteTools(ticket)).tools.map((t) => t.exposed)).toContain("chat_send_message");
		expect(textOf(await h.call(session, "chat", "send_message", SEND))).toMatch(/not approved on the device/);
		h.approve(ticket, "chat_send_message", SEND);
		expect((await h.call(session, "chat", "send_message", SEND)).isError).toBeUndefined();
		await new LocalWritesSetting(dir).set(true);
		expect(textOf(await h.call(session, "chat", "send_message", SEND))).toMatch(/not approved on the device/);
		h.endAll();
		rmSync(dir, { recursive: true, force: true });
	});

	test("an unreadable setting counts as off", () => {
		const dir = mkdtempSync(join(tmpdir(), "tunelo-local-writes-"));
		writeFileSync(join(dir, LOCAL_WRITES_FILE), "{ not json");
		expect(new LocalWritesSetting(dir).enabled()).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("headers of the user's own requests come back hidden", async () => {
		const lm = await startFakeMcpApp();
		lm.accepted.add(CHAT_TOKEN);
		const remote = new RemoteProxy({ endpoint: (app) => (app === "chat" ? chat.url : lm.url), token: async () => CHAT_TOKEN, forget: async () => undefined, account: () => "a" });
		const h = new McpHost(home, { remote, enabledGroups: () => ["chat", "localman"] });
		const id = h.open("wss://tunnel.example");
		const entry = textOf(await h.call(id, "localman", "get_history_entry", { id: "h1" }));
		expect(entry).not.toContain("dXNlcjpwYXNz");
		expect(entry).not.toContain("sid=secret");
		expect(entry).toContain("text/plain");
		expect(entry).toContain("*/*");
		h.endAll();
		await lm.close();
	});

	test("a card names the chat a message goes to, or the request sent, with the details devices word it from", async () => {
		const { h } = host();
		expect(await h.describeWrite("chat_send_message", SEND)).toEqual({
			summary: "Send to «Team» (12 members): hi",
			write: { tool: "chat_send_message", chatId: 7n, chatTitle: "Team", chatMembers: 12, text: "hi", textLength: 2 },
		});
		expect(await h.describeWrite("chat_send_message", { chat_id: 8, text: "hi" })).toMatchObject({ summary: "Send to «Lan»: hi", write: { chatTitle: "Lan", chatMembers: 0 } });
		const long = "x".repeat(400);
		const cut = await h.describeWrite("chat_send_message", { chat_id: 7, text: long });
		expect(cut?.summary).toMatch(/… \(400 characters\)$/);
		expect(cut?.write).toMatchObject({ text: "x".repeat(300), textLength: 400 });
		expect(await h.describeWrite("localman_send_request", { method: "post", url: "http://localhost:5173/api" })).toEqual({
			summary: "POST http://localhost:5173/api (through your machine)",
			write: { tool: "localman_send_request", method: "POST", url: "http://localhost:5173/api", headers: [], text: "", textLength: 0, reachesLocal: true },
		});
		// Other writes: the details only; reads: nothing.
		expect(await h.describeWrite("open_http_tunnel", { port: 3000 })).toEqual({ summary: "", write: { tool: "open_http_tunnel" } });
		expect(await h.describeWrite("chat_get_messages", { chat_id: 7 })).toBeUndefined();
		chat.accepted.delete(CHAT_TOKEN);
		const { h: refused } = host();
		expect(await refused.describeWrite("chat_send_message", SEND)).toMatchObject({ summary: "Send to chat 7: hi", write: { chatId: 7n, chatTitle: "" } });
		chat.accepted.add(CHAT_TOKEN);
		h.endAll();
		refused.endAll();
	});

	describe("a session whose every write the user approves (a Chat conversation's AI thread)", () => {
		type Asked = { owner: string; name: string; summary: string; tool: string; signal: AbortSignal };
		function asking(answer: (a: Asked) => Promise<boolean>, extra: Partial<McpHostOptions> = {}) {
			const asked: Asked[] = [];
			const made = host(undefined, {
				asksEveryWrite: (who) => who === "chat-thread",
				askWrite: (owner, call, signal) => {
					const a = { owner, name: call.name, summary: call.card?.summary ?? "", tool: call.card?.write.tool ?? "", signal };
					asked.push(a);
					return answer(a);
				},
				...extra,
			});
			return { ...made, asked };
		}
		const sentCount = () => chat.calls.filter((c) => c.name === "send_message").length;

		test("a write its AI never asked about gets a card from the service, and runs once allowed", async () => {
			const { h, asked } = asking(async () => true);
			const id = h.open("wss://tunnel.example", h.tickets.issue("chat-thread"));
			const before = sentCount();
			expect((await h.call(id, "chat", "send_message", SEND)).isError).toBeUndefined();
			expect(sentCount() - before).toBe(1);
			expect(asked.map((a) => [a.owner, a.name, a.summary, a.tool])).toEqual([["chat-thread", "chat_send_message", "Send to «Team» (12 members): hi", "chat_send_message"]]);
			h.endAll();
		});

		test("declined, nothing goes", async () => {
			const { h, asked } = asking(async () => false);
			const id = h.open("wss://tunnel.example", h.tickets.issue("chat-thread"));
			const before = sentCount();
			expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
			expect(sentCount() - before).toBe(0);
			expect(asked).toHaveLength(1);
			h.endAll();
		});

		test("approved already by the AI's own card: no second card", async () => {
			const { h, asked } = asking(async () => true);
			const ticket = h.tickets.issue("chat-thread");
			const id = h.open("wss://tunnel.example", ticket);
			h.approve(ticket, "chat_send_message", SEND);
			expect((await h.call(id, "chat", "send_message", SEND)).isError).toBeUndefined();
			expect(asked).toHaveLength(0);
			h.endAll();
		});

		test("an ordinary session is still refused without asking", async () => {
			const { h, asked } = asking(async () => true);
			const id = h.open("wss://tunnel.example", h.tickets.issue("thread-1"));
			expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
			expect(asked).toHaveLength(0);
			h.endAll();
		});

		test("a card nobody answers in time, or whose session ends, refuses the write", async () => {
			const waitAbort = (a: Asked) => new Promise<boolean>((resolve) => a.signal.addEventListener("abort", () => resolve(false)));
			const timed = asking(waitAbort, { writeAskMs: 20 });
			const id = timed.h.open("wss://tunnel.example", timed.h.tickets.issue("chat-thread"));
			expect(textOf(await timed.h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
			timed.h.endAll();

			const ended = asking(waitAbort);
			const ticket = ended.h.tickets.issue("chat-thread");
			const id2 = ended.h.open("wss://tunnel.example", ticket);
			const call = ended.h.call(id2, "chat", "send_message", SEND);
			await vi.waitFor(() => expect(ended.asked).toHaveLength(1));
			ended.h.release(ticket);
			expect(textOf(await call)).toMatch(/not approved/);
			ended.h.endAll();
		});

		/** The host wired to a core as the service wires it, with a Chat conversation's AI thread and an ordinary one. */
		async function withCore() {
			const { core, work } = makeCore([fakeProvider()]);
			const { h } = host(undefined, {
				sessionBypassed: (who) => core.writesSkipApproval(who),
				asksEveryWrite: (who) => core.asksEveryWrite(who),
				askWrite: (who, call, signal) => core.askWrite(who, call, signal),
			});
			const chatThread = await core.create({ provider: "fake", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: false }, device: "phone", chat: { chatId: 7n, title: "Team", app: "telegram" } });
			const plain = await core.create({ provider: "fake", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: false }, device: "phone" });
			const cards = (threadId: string) => byCase(core.snapshot(threadId), "approval");
			return { core, h, chatThread, plain, cards };
		}

		test("as agy in full access runs it (no card of its own): exactly one card on the thread, and the answer decides", async () => {
			const { core, h, chatThread, cards } = await withCore();
			const ticket = h.tickets.issue(chatThread.id);
			const id = h.open("wss://tunnel.example", ticket);
			for (const [decision, sends] of [[Decision.ALLOW, 1], [Decision.DENY, 0]] as const) {
				const before = sentCount();
				const call = h.call(id, "chat", "send_message", SEND);
				await vi.waitFor(() => expect(cards(chatThread.id).filter((c) => c.body.value.state === PromptState.PENDING)).toHaveLength(1));
				const card = cards(chatThread.id).find((c) => c.body.value.state === PromptState.PENDING);
				if (!card) throw new Error("no card");
				expect(card.body.value).toMatchObject({ name: "chat_send_message", summary: "Send to «Team» (12 members): hi", write: { tool: "chat_send_message", chatId: 7n, chatTitle: "Team" } });
				core.respond(chatThread.id, card.id, card.revision, { decision }, "phone");
				const result = await call;
				expect(result.isError === true).toBe(decision === Decision.DENY);
				expect(sentCount() - before).toBe(sends);
			}
			expect(cards(chatThread.id)).toHaveLength(2);
			h.endAll();
			await core.stop();
		});

		test("as Claude asks first (its card approved the call): no second card from the service", async () => {
			const { core, h, chatThread, cards } = await withCore();
			const ticket = h.tickets.issue(chatThread.id);
			const id = h.open("wss://tunnel.example", ticket);
			h.approve(ticket, "chat_send_message", SEND);
			expect((await h.call(id, "chat", "send_message", SEND)).isError).toBeUndefined();
			expect(cards(chatThread.id)).toHaveLength(0);
			h.endAll();
			await core.stop();
		});

		test("an ordinary thread's unapproved write is refused without a card", async () => {
			const { core, h, plain, cards } = await withCore();
			const id = h.open("wss://tunnel.example", h.tickets.issue(plain.id));
			expect(textOf(await h.call(id, "chat", "send_message", SEND))).toMatch(/not approved/);
			expect(cards(plain.id)).toHaveLength(0);
			h.endAll();
			await core.stop();
		});
	});

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

	test("without a ticket and with local writes on, it acts as the local user, with the same tools", async () => {
		const { h, lines } = host(undefined, { localWrites: () => true });
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
		const { h: all } = host(undefined, { localWrites: () => true });
		const id2 = all.open("wss://tunnel.example");
		expect(textOf(await all.call(id2, "chat", "delete_messages", { chat_id: 7 }))).toMatch(/not a tool tunelo offers/);
		expect(textOf(await all.call(id2, "tunnel", "kill_everything", {}))).toMatch(/not a tool tunelo offers/);
		expect(chat.calls.length).toBe(before);
		// The server's upload tools are the service's own: never listed.
		expect((await all.remoteTools()).tools.map((t) => t.exposed).sort()).toEqual([
			"chat_get_chat",
			"chat_list_chats",
			"chat_send_media",
			"chat_send_message",
			"kb_get_document",
			"kb_list_spaces",
			"kb_recent",
			"kb_save_note",
			"kb_search",
			"localman_create_collection_node",
			"localman_get_collection",
			"localman_get_history_entry",
			"localman_list_collections",
			"localman_list_workspaces",
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
		const mcp = new McpHost(dir, { remote: new RemoteProxy({ endpoint: () => "http://127.0.0.1:9/mcp", token: async () => "t", forget: async () => undefined, account: () => "a" }) });
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
			TUNELO_TEST_TICKET_FILE: join(home, "ticket"),
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

	test("without a ticket and with local writes off (the default), lists and runs only read tools", async () => {
		const { client, transport } = mcpClient(bundle, tunnelServer.wsUrl, home);
		await client.connect(transport);
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["whoami", "list_local_tunnels", "chat_list_chats", "localman_list_collections"]));
		for (const write of ["open_http_tunnel", "close_tunnel", "revoke_linked_machine", "chat_send_message", "localman_send_request"]) {
			expect(names).not.toContain(write);
		}
		const before = chat.calls.length;
		// Not listed, so the client cannot even call it.
		await expect(client.callTool({ name: "chat_send_message", arguments: { chat_id: 7, text: "x" } })).rejects.toThrow(/not found/);
		expect(chat.calls.length).toBe(before);
		await client.close();
	});

	test("`tunelo config mcp-local-writes on` without a terminal (an AI client's shell, a script) is refused and changes nothing", () => {
		const env = machineEnv(home);
		const on = spawnSync(process.execPath, [bundle, "config", "mcp-local-writes", "on"], { env, encoding: "utf8", input: "yes\n" });
		expect(on.status).toBe(1);
		expect(on.stderr).toMatch(/needs a person at a terminal/);
		expect(new LocalWritesSetting(join(home, "tunelo")).enabled()).toBe(false);
	});

	test("once the owner turns writes on in a terminal, a client without a ticket lists and runs every tool, no token reaching it", async () => {
		const env = machineEnv(home);
		// What `tunelo config mcp-local-writes on` writes after the owner typed yes.
		await new LocalWritesSetting(join(home, "tunelo")).set(true);
		try {
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
			// Each app saw only its own token.
			expect(new Set(chat.seen)).toEqual(new Set([CHAT_TOKEN]));
			expect(new Set(localman.seen)).toEqual(new Set([LOCALMAN_TOKEN]));
			// The list route answers names and schemas only.
			const listed = await callControl(join(home, "tunelo"), "POST", "/mcp/tools", {});
			expect(JSON.stringify(listed)).toContain("chat_send_message");
			expect(JSON.stringify(listed)).not.toMatch(JWT);
			await client.close();
		} finally {
			const off = spawnSync(process.execPath, [bundle, "config", "mcp-local-writes", "off"], { env, encoding: "utf8" });
			expect(off.stdout).toMatch(/: off/);
		}
	});

	test("with a session's ticket (as Bash in that session could read it), a write without the device's approval is refused", async () => {
		const ticket = readFileSync(join(home, "ticket"), "utf8");
		const { client, transport } = mcpClient(bundle, tunnelServer.wsUrl, home, { TUNELO_MCP_TICKET: ticket });
		await client.connect(transport);
		const before = chat.calls.length;
		const sent = await client.callTool({ name: "chat_send_message", arguments: { chat_id: 7, text: "injected" } });
		expect(sent.isError).toBe(true);
		expect(textOf(sent)).toMatch(/not approved on the device/);
		expect(chat.calls.length).toBe(before);
		expect((await client.callTool({ name: "chat_list_chats", arguments: {} })).isError).toBeFalsy();
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
