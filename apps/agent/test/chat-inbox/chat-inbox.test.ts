// The chat inbox: subscribed chats' new messages become one turn of the
// chat's AI session. Nothing is read without a subscription; a chat starts
// after its newest message; the user's own and service messages are skipped;
// messages close together make one turn; a subscription delivers at most its
// turns an hour and counts the rest; a chat hidden from AI is never pushed;
// a busy session gets its turn once free; subscriptions survive a restart.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ThreadState, type ThreadSummary, ThreadSummarySchema } from "@achoo254/chat-proto/remote/remote";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChatInbox, type ChatInboxOptions, type InboxThreads } from "../../src/chat-inbox/chat-inbox.ts";
import { CHAT_INBOX_FILE, InboxStore } from "../../src/chat-inbox/inbox-store.ts";
import type { AgentCore } from "../../src/core/agent-core.ts";
import { tempDir } from "../harness.ts";

const SELF = 1;
const PERSON = 22;
const CHAT = 5;

type Msg = { seq: number; from_id: number; text: string; media?: { kind: string; file_name?: string }; action?: Record<string, unknown> };

/** Chat's MCP as the inbox calls it: protojson answers, a chat hidden from AI left out of lists and refused. */
function fakeChat() {
	const chats = new Map<number, Msg[]>();
	const hidden = new Set<number>();
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const answer = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
	const refuse = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "permission_denied", message } }) }] });
	const call: ChatInboxOptions["callChat"] = async (tool, args) => {
		calls.push({ tool, args });
		if (tool === "get_me") return answer({ user: { id: String(SELF), name: "Me" } });
		if (tool === "list_chats") {
			return answer({ dialogs: [...chats].filter(([id]) => !hidden.has(id)).map(([id, m]) => ({ chat_id: String(id), top_seq: String(m.at(-1)?.seq ?? 0) })) });
		}
		const id = Number(args.chat_id);
		if (hidden.has(id)) return refuse("chat_hidden_from_ai: the user hid this chat from AI");
		const all = chats.get(id) ?? [];
		const offset = Number(args.offset_seq ?? 0);
		const limit = Number(args.limit ?? 50);
		const newer = args.direction === "newer";
		const picked = newer ? all.filter((m) => m.seq > offset).slice(0, limit) : all.slice(-limit).reverse();
		return answer({
			messages: picked.map((m) => ({ ...m, seq: String(m.seq), from_id: String(m.from_id), date: "1764000000" })),
			users: [
				{ id: String(SELF), name: "Me" },
				{ id: String(PERSON), name: "Lan" },
			],
			has_newer: newer && all.some((m) => m.seq > (picked.at(-1)?.seq ?? offset)),
		});
	};
	const post = (chat: number, from: number, text: string, extra: Partial<Msg> = {}) => {
		const list = chats.get(chat) ?? [];
		list.push({ seq: (list.at(-1)?.seq ?? 0) + 1, from_id: from, text, ...extra });
		chats.set(chat, list);
	};
	return { chats, hidden, calls, call, post, reads: () => calls.filter((c) => c.tool === "get_messages").length };
}

/** The core's sessions as the inbox sees them: a chat's thread, its state, the turns sent and the threads created. */
function fakeThreads() {
	const threads: ThreadSummary[] = [];
	const turns: { threadId: string; text: string }[] = [];
	const created: Parameters<AgentCore["create"]>[0][] = [];
	const listeners = new Set<(s: ThreadSummary) => void>();
	const api: InboxThreads = {
		list: () => threads.map((t) => ({ ...t })),
		send: async (threadId, text) => {
			turns.push({ threadId, text });
		},
		create: async (req) => {
			created.push(req);
			const t = create(ThreadSummarySchema, { id: `t${threads.length + 1}`, chatId: req.chat?.chatId ?? 0n, state: ThreadState.IDLE });
			threads.push(t);
			turns.push({ threadId: t.id, text: req.text });
			return t;
		},
		onStatus: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
	const setState = (threadId: string, state: ThreadState) => {
		const t = threads.find((x) => x.id === threadId);
		if (!t) throw new Error("no thread");
		t.state = state;
		for (const fn of listeners) fn({ ...t });
	};
	return { api, threads, turns, created, setState };
}

let chat: ReturnType<typeof fakeChat>;
let threads: ReturnType<typeof fakeThreads>;
let dataDir: string;
let account: string;
let provider: string;
const inboxes: ChatInbox[] = [];

function inbox(): ChatInbox {
	const i = new ChatInbox({
		store: new InboxStore(dataDir),
		callChat: chat.call,
		account: () => account,
		threads: threads.api,
		provider: async () => provider,
		now: () => Date.now(),
	});
	i.start();
	inboxes.push(i);
	return i;
}

const subscribe = (i: ChatInbox, extra: { enabled?: boolean; perHourLimit?: number; chatId?: bigint } = {}) =>
	i.set({ chatId: extra.chatId ?? BigInt(CHAT), title: "Lan", app: "telegram", enabled: extra.enabled ?? true, perHourLimit: extra.perHourLimit ?? 0 });

/** One poll, the quiet time and its slack: a batch read now has gone in after this. */
const settle = () => vi.advanceTimersByTimeAsync(5_000 + 6_000);

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-11-25T10:00:00+07:00") });
	chat = fakeChat();
	threads = fakeThreads();
	dataDir = join(tempDir("chat-inbox-"), "data");
	account = "https://auth.example alice";
	provider = "fake";
});

afterEach(() => {
	for (const i of inboxes.splice(0)) i.stop();
	vi.useRealTimers();
});

describe("chat inbox", () => {
	test("reads nothing while no subscription is on, and stops reading once none is", async () => {
		const i = inbox();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(chat.calls).toEqual([]);
		expect(i.polling).toBe(false);
		subscribe(i);
		expect(i.polling).toBe(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(chat.calls.length).toBeGreaterThan(0);
		subscribe(i, { enabled: false });
		expect(i.polling).toBe(false);
		const before = chat.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(chat.calls.length).toBe(before);
		i.remove(BigInt(CHAT));
		expect(i.list()).toEqual([]);
	});

	test("a chat subscribed starts after its newest message: nothing older is pushed", async () => {
		chat.post(CHAT, PERSON, "old one");
		chat.post(CHAT, PERSON, "old two");
		const i = inbox();
		subscribe(i);
		await settle();
		await settle();
		expect(threads.turns).toEqual([]);
		chat.post(CHAT, PERSON, "new one");
		await settle();
		expect(threads.turns).toHaveLength(1);
		const text = threads.turns[0]?.text ?? "";
		expect(text).toContain("[Tin mới từ Lan qua Telegram, chat 5, seq 3]");
		expect(text).toContain("Lan: new one");
		expect(text).not.toContain("old");
		// Approval-carded tools only, and Zalo cannot be sent to by tools.
		expect(text).toMatch(/thẻ duyệt/);
		expect(text).toMatch(/Zalo/);
		// A new session for the chat, on the machine's AI, linked to the chat.
		expect(threads.created).toHaveLength(1);
		expect(threads.created[0]).toMatchObject({ provider: "fake", dir: "", chat: { chatId: 5n, title: "Lan", app: "telegram" } });
	});

	test("messages close together make one turn; a chat busy for long still goes in within the longest wait", async () => {
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, PERSON, "first");
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, PERSON, "second", { media: { kind: "MEDIA_KIND_PHOTO" } });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(threads.turns).toEqual([]);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(threads.turns).toHaveLength(1);
		expect(threads.turns[0]?.text).toContain("seq 1–2]");
		expect(threads.turns[0]?.text).toContain("Lan: first");
		expect(threads.turns[0]?.text).toContain("Lan: [ảnh] second");

		// A message every poll: the turn goes in once the first waited 30 s.
		const start = Date.now();
		for (let n = 0; n < 10 && threads.turns.length === 1; n++) {
			chat.post(CHAT, PERSON, `chatty ${n}`, n === 0 ? { media: { kind: "MEDIA_KIND_DOCUMENT", file_name: "hop-dong.pdf" } } : {});
			await vi.advanceTimersByTimeAsync(5_000);
		}
		expect(threads.turns).toHaveLength(2);
		expect(Date.now() - start).toBeLessThanOrEqual(40_000);
		expect(threads.turns[1]?.text).toContain("[tệp: hop-dong.pdf]");
		// The second turn goes into the session the first one opened.
		expect(threads.created).toHaveLength(1);
		expect(threads.turns[1]?.threadId).toBe(threads.turns[0]?.threadId);
	});

	test("the user's own messages and service messages are not pushed", async () => {
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, SELF, "I wrote this");
		chat.post(CHAT, PERSON, "", { action: { chat_edit_title: { title: "x" } } });
		await settle();
		expect(threads.turns).toEqual([]);
		chat.post(CHAT, PERSON, "from Lan");
		await settle();
		expect(threads.turns).toHaveLength(1);
		expect(threads.turns[0]?.text).not.toContain("I wrote this");
	});

	test("beyond the turns an hour nothing is pushed: the state says limited and the messages are counted", async () => {
		const i = inbox();
		subscribe(i, { perHourLimit: 1 });
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, PERSON, "one");
		await settle();
		expect(threads.turns).toHaveLength(1);
		chat.post(CHAT, PERSON, "two");
		chat.post(CHAT, PERSON, "three");
		await settle();
		expect(threads.turns).toHaveLength(1);
		expect(i.list()[0]).toMatchObject({ state: "limited", missed: 2, deliveredLastHour: 1, perHourLimit: 1 });
		expect(i.list()[0]?.lastDeliveryAt).toBeGreaterThan(0);
		// The hour frees a turn: pushing goes on (what was missed stays missed).
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(i.list()[0]).toMatchObject({ state: "active", deliveredLastHour: 0, missed: 2 });
		chat.post(CHAT, PERSON, "four");
		await settle();
		expect(threads.turns).toHaveLength(2);
		expect(threads.turns[1]?.text).toContain("four");
		expect(threads.turns[1]?.text).not.toContain("three");
	});

	test("a limit out of range is refused; 0 keeps the current one", () => {
		const i = inbox();
		expect(() => subscribe(i, { perHourLimit: 121 })).toThrow(/per_hour_limit/);
		expect(subscribe(i)[0]?.perHourLimit).toBe(20);
		expect(subscribe(i, { perHourLimit: 5 })[0]?.perHourLimit).toBe(5);
		expect(subscribe(i, { perHourLimit: 0 })[0]?.perHourLimit).toBe(5);
		expect(() => subscribe(i, { chatId: 0n })).toThrow(/chat id/);
	});

	test("a chat hidden from AI is not read or pushed; shown again, it goes on from its newest message", async () => {
		chat.post(CHAT, PERSON, "before");
		chat.hidden.add(CHAT);
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(i.list()[0]?.state).toBe("hidden");
		chat.post(CHAT, PERSON, "while hidden");
		await vi.advanceTimersByTimeAsync(120_000);
		expect(threads.turns).toEqual([]);
		expect(i.list()[0]?.state).toBe("hidden");
		chat.hidden.delete(CHAT);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(i.list()[0]?.state).toBe("active");
		chat.post(CHAT, PERSON, "after");
		await settle();
		expect(threads.turns).toHaveLength(1);
		expect(threads.turns[0]?.text).toContain("after");
		expect(threads.turns[0]?.text).not.toContain("while hidden");
	});

	test("a turn waits while the chat's session runs, and goes in once it is idle", async () => {
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, PERSON, "hello");
		await settle();
		const threadId = threads.turns[0]?.threadId ?? "";
		threads.setState(threadId, ThreadState.RUNNING);
		chat.post(CHAT, PERSON, "are you there");
		await settle();
		await settle();
		expect(threads.turns).toHaveLength(1);
		// More messages while it waits join the same turn.
		chat.post(CHAT, PERSON, "hello??");
		await settle();
		threads.setState(threadId, ThreadState.WAITING);
		await settle();
		expect(threads.turns).toHaveLength(1);
		threads.setState(threadId, ThreadState.IDLE);
		await vi.advanceTimersByTimeAsync(0);
		expect(threads.turns).toHaveLength(2);
		expect(threads.turns[1]?.text).toContain("are you there");
		expect(threads.turns[1]?.text).toContain("hello??");
	});

	test("signed out of Chat: nothing is read and the state says so", async () => {
		account = "";
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(chat.calls).toEqual([]);
		expect(i.list()[0]?.state).toBe("signed-out");
	});

	test("no signed-in AI: the turn waits (state error) and goes in once there is one", async () => {
		provider = "";
		const i = inbox();
		subscribe(i);
		await vi.advanceTimersByTimeAsync(5_000);
		chat.post(CHAT, PERSON, "hi");
		await settle();
		expect(threads.turns).toEqual([]);
		expect(i.list()[0]?.state).toBe("error");
		provider = "fake";
		await vi.advanceTimersByTimeAsync(5_000);
		expect(threads.turns).toHaveLength(1);
		expect(i.list()[0]?.state).toBe("active");
	});

	test("subscriptions survive a restart, in an owner-only file, from the last message seen", async () => {
		chat.post(CHAT, PERSON, "old");
		const first = inbox();
		subscribe(first, { perHourLimit: 7 });
		first.set({ chatId: 6n, title: "Nhóm\nbạn", app: "zalo", enabled: false, perHourLimit: 0 });
		await vi.advanceTimersByTimeAsync(5_000);
		first.stop();
		const file = join(dataDir, CHAT_INBOX_FILE);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		const saved = JSON.parse(readFileSync(file, "utf8")) as { subscriptions: { chatId: string; lastSeenSeq: number | null }[] };
		expect(saved.subscriptions.map((s) => [s.chatId, s.lastSeenSeq])).toEqual([
			["5", 1],
			["6", null],
		]);
		// Messages while the service was down are not pushed: only those after it starts again.
		chat.post(CHAT, PERSON, "while down");
		const again = inbox();
		expect(again.list()).toEqual([
			expect.objectContaining({ chatId: "5", title: "Lan", app: "telegram", enabled: true, perHourLimit: 7, missed: 0 }),
			expect.objectContaining({ chatId: "6", title: "Nhóm bạn", app: "zalo", enabled: false, perHourLimit: 20 }),
		]);
		await settle();
		expect(threads.turns).toEqual([]);
		expect(again.list()[0]).toMatchObject({ state: "active", missed: 1 });
		chat.post(CHAT, PERSON, "after the restart");
		await settle();
		expect(threads.turns).toHaveLength(1);
		expect(threads.turns[0]?.text).toContain("after the restart");
		expect(threads.turns[0]?.text).not.toContain("while down");
	});

	test("tells listeners when an item changes, not on every poll", async () => {
		const i = inbox();
		const heard: number[] = [];
		i.onChange((items) => heard.push(items.length));
		subscribe(i);
		expect(heard).toEqual([1]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(heard).toEqual([1]);
		chat.post(CHAT, PERSON, "hi");
		await settle();
		expect(heard.length).toBe(2);
	});
});
