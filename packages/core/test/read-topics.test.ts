import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { systemTimers } from "@achoo254/chat-platform";
import { ChatType } from "@achoo254/chat-proto/chats";
import { MessageSchema } from "@achoo254/chat-proto/messages";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { EventBus } from "../src/events/bus.ts";
import { toUpdate } from "../src/protocol/map.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { realtimeUrlFor } from "../src/transport/realtime.ts";
import { FakeServer } from "./support/fake-server.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

async function engineOn(server: FakeServer, self: number): Promise<{ engine: SyncEngine; repo: Repository; sql: MemorySqlFactory }> {
	const sql = new MemorySqlFactory();
	const driver = await sql.open("engine.sqlite3");
	await migrate(driver);
	const repo = new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
	const engine = new SyncEngine({
		repo,
		api: server.apiFor(self),
		timers: systemTimers,
		selfId: self,
		onSessionEnded: () => undefined,
	});
	await engine.load();
	return { engine, repo, sql };
}

async function idle(engine: SyncEngine): Promise<void> {
	for (let i = 0; i < 500 && engine.busy; i++) await vi.advanceTimersByTimeAsync(10);
	expect(engine.busy).toBe(false);
}

describe("read updates (chat_pts, top_seq)", () => {
	it("keeps a large chat's unread count exact without re-reading dialogs", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Lớn", [self, a]);
		server.switchToLarge(chat);
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		const dialogsBefore = server.calls.get("getDialogs") ?? 0;

		// Three messages land in the chat's own log while this client is not
		// looking; then another device reads up to the second one.
		for (const text of ["một", "hai", "ba"]) server.sendMessage(a, chat, text);
		server.readHistory(self, chat, 2);
		engine.requestDifference();
		await idle(engine);

		const dialog = await repo.dialog(chat);
		expect(dialog?.readInboxMaxSeq).toBe(2);
		expect(dialog?.unreadCount).toBe(1);
		expect(server.calls.get("getChatDifference") ?? 0).toBeGreaterThan(0);
		expect(server.calls.get("getDialogs") ?? 0).toBe(dialogsBefore);

		// A later message counts once on top.
		server.sendMessage(a, chat, "bốn");
		engine.requestChatDifference(chat);
		await idle(engine);
		expect((await repo.dialog(chat))?.unreadCount).toBe(2);
		engine.stop();
	});

	it("refreshes a chat and its dialog with GetPeerDialogs after an unpin", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const { seq } = server.sendMessage(a, chat, "ghim");
		server.pin(chat, seq, true);
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		expect((await repo.chat(chat))?.pinnedSeq).toBe(seq);

		server.pin(chat, seq, false);
		engine.requestDifference();
		await idle(engine);
		expect(server.calls.get("getPeerDialogs")).toBe(1);
		expect((await repo.chat(chat))?.pinnedSeq).toBe(0);
		expect((await repo.dialog(chat))?.topSeq).toBe(seq);
		engine.stop();
	});

	it("falls back to GetChat when the API has no GetPeerDialogs", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const { seq } = server.sendMessage(a, chat, "ghim");
		server.pin(chat, seq, true);
		const full = server.apiFor(self);
		const sql = new MemorySqlFactory();
		const driver = await sql.open("engine.sqlite3");
		await migrate(driver);
		const repo = new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
		const engine = new SyncEngine({
			repo,
			api: { ...full, chats: { getDialogs: full.chats.getDialogs, getChat: full.chats.getChat } },
			timers: systemTimers,
			selfId: self,
			onSessionEnded: () => undefined,
		});
		await engine.load();
		engine.requestDifference();
		await idle(engine);
		server.pin(chat, seq, false);
		engine.requestDifference();
		await idle(engine);
		expect(server.calls.get("getPeerDialogs") ?? 0).toBe(0);
		expect((await repo.chat(chat))?.pinnedSeq).toBe(0);
		engine.stop();
	});
});

describe("forum topics", () => {
	it("stores a message's topic and keeps per-topic read state", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Diễn đàn", [self, a]);
		const { engine, sql } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		const pts = engine.state.pts;
		const message = (seq: number, topicId: number) =>
			toUpdate(
				create(UpdateSchema, {
					pts: big(pts + seq),
					ptsCount: 1,
					serverEpoch: 1n,
					kind: {
						case: "messageNew",
						value: {
							message: create(MessageSchema, {
								chatId: big(chat),
								seq: big(seq),
								fromId: big(a),
								text: `tin ${seq}`,
								topicId: big(topicId),
								linkPreview: { url: "https://example.com/", siteName: "Ví dụ", title: "Tiêu đề", description: "" },
							}),
						},
					},
				}),
			);
		const read = toUpdate(
			create(UpdateSchema, {
				pts: big(pts + 4),
				ptsCount: 1,
				serverEpoch: 1n,
				kind: {
					case: "read",
					value: { chatId: big(chat), maxSeq: 2n, topicId: 7n, unreadCount: 2, topicUnreadCount: 0, topSeq: 3n },
				},
			}),
		);
		const topicChanged = toUpdate(
			create(UpdateSchema, {
				pts: big(pts + 5),
				ptsCount: 1,
				serverEpoch: 1n,
				kind: { case: "topicChanged", value: { topic: { chatId: big(chat), id: 7n, title: "Cảnh báo" } } },
			}),
		);
		engine.ingest({ updates: [message(1, 7), message(2, 7), message(3, 1), read, topicChanged], users: [], chats: [] });
		await idle(engine);
		expect(engine.state.pts).toBe(pts + 5);
		const db = sql.db("engine.sqlite3");
		expect(db.prepare("SELECT seq, topic_id FROM messages WHERE chat_id = ? ORDER BY seq").all(chat)).toEqual([
			{ seq: 1, topic_id: 7 },
			{ seq: 2, topic_id: 7 },
			{ seq: 3, topic_id: 1 },
		]);
		const preview = db.prepare("SELECT link_preview FROM messages WHERE chat_id = ? AND seq = 1").get(chat)?.link_preview;
		expect(JSON.parse(String(preview))).toEqual({ url: "https://example.com/", siteName: "Ví dụ", title: "Tiêu đề", description: "" });
		const states = db
			.prepare("SELECT topic_id, read_inbox_max_seq, unread_count, counted_through FROM read_states WHERE chat_id = ? ORDER BY topic_id")
			.all(chat);
		expect(states).toEqual([
			{ topic_id: 0, read_inbox_max_seq: 2, unread_count: 2, counted_through: 3 },
			{ topic_id: 7, read_inbox_max_seq: 2, unread_count: 0, counted_through: 3 },
		]);
		engine.stop();
	});
});

describe("realtime URL", () => {
	it("is /ws on the app's own origin", () => {
		expect(realtimeUrlFor("https://chat.hoandat.com")).toBe("wss://chat.hoandat.com/ws");
		expect(realtimeUrlFor("https://chat.inetdev.io.vn/")).toBe("wss://chat.inetdev.io.vn/ws");
		expect(realtimeUrlFor("http://localhost:5173")).toBe("ws://localhost:5173/ws");
	});
});
