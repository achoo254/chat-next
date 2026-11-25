// The chat inbox end to end: devices manage the subscriptions over the sealed
// link (ChatInboxList, ChatInboxSet, ChatInboxRemove, answered with
// ChatInboxState), and the inbox reads Chat's MCP server through the
// service's proxy with the account's token, then writes the turn into the
// chat's real session: a running turn is never interrupted, the new turn goes
// in once it ends.
import { join } from "node:path";
import { ChatInboxItemState, ErrorCode, ErrorReason, ThreadState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatInbox } from "../../src/chat-inbox/chat-inbox.ts";
import { InboxStore } from "../../src/chat-inbox/inbox-store.ts";
import { chatInboxStateBody } from "../../src/chat-inbox/inbox-wire.ts";
import { ConfigStore } from "../../src/config.ts";
import type { AgentCore } from "../../src/core/agent-core.ts";
import { type ToolGroup, toolGroup } from "../../src/mcp/groups.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { type FakeLog, fakeProvider } from "../fake-provider.ts";
import { makeCore, tempDir } from "../harness.ts";
import { pairedDevice } from "../support/device-link.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";

const chatGroup = toolGroup("chat") as ToolGroup;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup(app?: FakeMcpApp) {
	const log: FakeLog = { starts: [], sent: [], closed: 0 };
	const { core, audit } = makeCore([fakeProvider("fake", log)]);
	cleanup.push(() => core.stop());
	const proxy = app
		? new RemoteProxy({ endpoint: () => app.url, token: async () => "chat-token", forget: async () => undefined, account: () => "https://auth.example alice" })
		: undefined;
	if (proxy) cleanup.push(() => proxy.close());
	const inbox = new ChatInbox({
		store: new InboxStore(join(tempDir("chat-inbox-link-"), "data")),
		callChat: (tool, args) => (proxy ? proxy.call(chatGroup, tool, args) : Promise.reject(new Error("no Chat here"))),
		account: () => (proxy ? "https://auth.example alice" : ""),
		threads: core,
		provider: async () => "fake",
		// Polled by hand here; batches go in right after their quiet time.
		timing: { pollMs: 3_600_000, quietMs: 10, maxWaitMs: 50 },
	});
	inbox.start();
	cleanup.push(() => inbox.stop());
	return { core, audit, inbox, log };
}

/** The chat's live thread. */
const chatThread = (core: AgentCore, chatId: bigint) => core.list().find((t) => t.chatId === chatId && !t.archived);

describe("chat inbox over the device link", () => {
	test("a device subscribes, lists, changes and removes chats; a bad request is refused", async () => {
		const { core, audit, inbox } = setup();
		const link = await pairedDevice({ core, audit, config: new ConfigStore(tempDir("cfg-")), chatInbox: inbox });
		const set = await link.request("1", { case: "chatInboxSet", value: { chatId: 5n, title: "Lan", app: "telegram", enabled: false, perHourLimit: 0 } });
		expect(set.id).toBe("1");
		expect(set.body.case).toBe("chatInboxState");
		const items = set.body.case === "chatInboxState" ? set.body.value.items : [];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ chatId: 5n, title: "Lan", app: "telegram", enabled: false, perHourLimit: 20, state: ChatInboxItemState.ACTIVE, deliveredLastHour: 0, missed: 0, lastDeliveryAt: 0n });

		const changed = await link.request("2", { case: "chatInboxSet", value: { chatId: 5n, title: "Lan", app: "telegram", enabled: false, perHourLimit: 3 } });
		expect(changed.body.case === "chatInboxState" ? changed.body.value.items[0]?.perHourLimit : -1).toBe(3);

		const listed = await link.request("3", { case: "chatInboxList", value: {} });
		expect(listed.body.case === "chatInboxState" ? listed.body.value.items.map((i) => i.chatId) : []).toEqual([5n]);

		const bad = await link.request("4", { case: "chatInboxSet", value: { chatId: 6n, title: "", app: "", enabled: true, perHourLimit: 500 } });
		expect(bad.body.case).toBe("error");
		expect(bad.body.case === "error" ? bad.body.value.code : undefined).toBe(ErrorCode.INVALID);

		const removed = await link.request("5", { case: "chatInboxRemove", value: { chatId: 5n } });
		expect(removed.body.case === "chatInboxState" ? removed.body.value.items : null).toEqual([]);
		link.close();
	});

	test("a machine without the inbox says the request is unsupported", async () => {
		const { core, audit } = setup();
		const link = await pairedDevice({ core, audit, config: new ConfigStore(tempDir("cfg-")) });
		const answer = await link.request("1", { case: "chatInboxList", value: {} });
		expect(answer.body.case === "error" ? answer.body.value.reason : undefined).toBe(ErrorReason.UNSUPPORTED_REQUEST);
		link.close();
	});

	test("every state reaches devices as its proto value", () => {
		const states = (["active", "hidden", "limited", "error", "signed-out"] as const).map(
			(state) => chatInboxStateBody([{ chatId: "9", title: "", app: "", enabled: true, perHourLimit: 20, state, deliveredLastHour: 0, missed: 0, lastDeliveryAt: 0 }]).items?.[0]?.state,
		);
		expect(states).toEqual([ChatInboxItemState.ACTIVE, ChatInboxItemState.HIDDEN, ChatInboxItemState.LIMITED, ChatInboxItemState.ERROR, ChatInboxItemState.SIGNED_OUT]);
	});
});

describe("chat inbox with Chat's MCP server and a real session", () => {
	test("new messages read with the account's token become a turn of the chat's session; a running turn is not interrupted", async () => {
		const app = await startFakeMcpApp();
		cleanup.push(() => app.close());
		app.accepted.add("chat-token");
		app.inbox = { selfId: 1, chats: new Map([[5, [{ seq: 1, from_id: 22, text: "before the subscription" }]]]), hidden: new Set(), users: [{ id: 22, name: "Lan" }] };
		const post = (text: string, from = 22) => {
			const list = app.inbox?.chats.get(5) ?? [];
			list.push({ seq: (list.at(-1)?.seq ?? 0) + 1, from_id: from, text });
		};
		const { core, inbox, log } = setup(app);
		inbox.set({ chatId: 5n, title: "Lan", app: "telegram", enabled: true, perHourLimit: 0 });
		await vi.waitFor(() => expect(app.calls.map((c) => c.name)).toContain("list_chats"));
		await inbox.tick();

		post("xin chào");
		post("my own reply", 1);
		await inbox.tick();
		await vi.waitFor(() => expect(log.sent.some((t) => t.includes("Lan: xin chào"))).toBe(true), { timeout: 5_000 });
		const sent = log.sent.find((t) => t.includes("xin chào")) ?? "";
		expect(sent).toContain("[Tin mới từ Lan qua Telegram, chat 5, seq 2]");
		expect(sent).not.toContain("before the subscription");
		expect(sent).not.toContain("my own reply");
		const thread = chatThread(core, 5n);
		expect(thread?.chatId).toBe(5n);
		// Only the reads the inbox needs, with the account's token.
		expect([...new Set(app.calls.map((c) => c.name))].sort()).toEqual(["get_me", "get_messages", "list_chats"]);
		expect(new Set(app.seen)).toEqual(new Set(["chat-token"]));
		await vi.waitFor(() => expect(chatThread(core, 5n)?.state).toBe(ThreadState.IDLE));

		// The user works in the session: the next message waits for that turn to end.
		await core.send(thread?.id ?? "", "slow", "");
		expect(chatThread(core, 5n)?.state).toBe(ThreadState.RUNNING);
		post("còn đó không?");
		await inbox.tick();
		await new Promise((r) => setTimeout(r, 1_500));
		expect(log.sent.some((t) => t.includes("còn đó không?"))).toBe(false);
		expect(chatThread(core, 5n)?.state).toBe(ThreadState.RUNNING);
		await core.interrupt(thread?.id ?? "");
		await vi.waitFor(() => expect(log.sent.some((t) => t.includes("Lan: còn đó không?"))).toBe(true), { timeout: 5_000 });
		expect(log.sent.findIndex((t) => t.includes("còn đó không?"))).toBeGreaterThan(log.sent.indexOf("slow"));
		expect(core.list().filter((t) => t.chatId === 5n)).toHaveLength(1);
		expect(inbox.list()[0]).toMatchObject({ state: "active", deliveredLastHour: 2 });
	});

	test("a chat the user hid from AI is never read: the state says hidden", async () => {
		const app = await startFakeMcpApp();
		cleanup.push(() => app.close());
		app.accepted.add("chat-token");
		app.inbox = { selfId: 1, chats: new Map([[9, [{ seq: 1, from_id: 22, text: "secret" }]]]), hidden: new Set([9]), users: [] };
		const { inbox, log } = setup(app);
		inbox.set({ chatId: 9n, title: "Hidden", app: "", enabled: true, perHourLimit: 0 });
		await vi.waitFor(() => expect(inbox.list()[0]?.state).toBe("hidden"), { timeout: 5_000 });
		expect(log.sent).toEqual([]);
	});
});
