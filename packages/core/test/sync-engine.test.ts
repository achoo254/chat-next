import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ChatType } from "@app/proto-ts/chats";
import { MessageSchema } from "@app/proto-ts/messages";
import { UpdateSchema } from "@app/proto-ts/updates";
import { EventBus } from "../src/events/bus.ts";
import type { UpdateBatch } from "../src/model/types.ts";
import { toUpdate } from "../src/protocol/map.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { systemTimers } from "@app/platform";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

function messageUpdate(pts: number, chatId: number, seq: number, fromId: number, text: string): UpdateBatch {
	const update = create(UpdateSchema, {
		pts: big(pts),
		ptsCount: 1,
		serverEpoch: 1n,
		kind: {
			case: "messageNew",
			value: {
				message: create(MessageSchema, { chatId: big(chatId), seq: big(seq), fromId: big(fromId), text }),
			},
		},
	});
	return { updates: [toUpdate(update)], users: [], chats: [] };
}

async function engineOn(server: FakeServer, self: number): Promise<{ engine: SyncEngine; sql: MemorySqlFactory }> {
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
	return { engine, sql };
}

async function idle(engine: SyncEngine): Promise<void> {
	for (let i = 0; i < 500 && engine.busy; i++) await vi.advanceTimersByTimeAsync(10);
	expect(engine.busy).toBe(false);
}

describe("gap handling (150 ms)", () => {
	it("waits for a missing update before asking the server", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const { engine, sql } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		const before = server.calls.get("getDifference") ?? 0;

		// pts 2 arrives before pts 1; pts 1 comes 100 ms later: no difference.
		server.sendMessage(a, chat, "một");
		server.sendMessage(a, chat, "hai");
		engine.ingest(messageUpdate(2, chat, 2, a, "hai"));
		await vi.advanceTimersByTimeAsync(100);
		expect(server.calls.get("getDifference") ?? 0).toBe(before);
		engine.ingest(messageUpdate(1, chat, 1, a, "một"));
		await idle(engine);
		expect(server.calls.get("getDifference") ?? 0).toBe(before);
		expect(engine.state.pts).toBe(2);

		// pts 3 never arrives: after 150 ms the engine asks for it.
		server.sendMessage(a, chat, "ba");
		server.sendMessage(a, chat, "bốn");
		engine.ingest(messageUpdate(4, chat, 4, a, "bốn"));
		await vi.advanceTimersByTimeAsync(140);
		expect(server.calls.get("getDifference") ?? 0).toBe(before);
		await vi.advanceTimersByTimeAsync(20);
		await idle(engine);
		expect(server.calls.get("getDifference") ?? 0).toBe(before + 1);
		expect(engine.state.pts).toBe(4);
		const texts = sql
			.db("engine.sqlite3")
			.prepare("SELECT text FROM messages ORDER BY seq")
			.all()
			.map((row) => row.text);
		expect(texts).toEqual(["một", "hai", "ba", "bốn"]);
		engine.stop();
	});

	it("fetches an unknown author and chat before applying the update", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const { engine, sql } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		// Created after the client synced, and the frame carries no entities:
		// the engine must not render an unknown author or chat.
		const stranger = server.addUser("Người lạ");
		const chat = server.createChat(ChatType.GROUP, "Mới", [self, stranger]);
		server.sendMessage(stranger, chat, "chào");
		engine.ingest(messageUpdate(1, chat, 1, stranger, "chào"));
		await idle(engine);
		expect(server.calls.get("getUsers")).toBe(1);
		expect(server.calls.get("getChat")).toBe(1);
		const db = sql.db("engine.sqlite3");
		expect(db.prepare("SELECT name FROM users WHERE id = ?").get(stranger)?.name).toBe("Người lạ");
		expect(db.prepare("SELECT title FROM chats WHERE id = ?").get(chat)?.title).toBe("Mới");
		expect(db.prepare("SELECT text FROM messages WHERE chat_id = ?").get(chat)?.text).toBe("chào");
		engine.stop();
	});
});

describe("large chats", () => {
	it("holds realtime updates of a chat while its difference runs", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Lớn", [self, a]);
		server.switchToLarge(chat);
		const api = server.apiFor(self);
		// GetChatDifference answers slowly so realtime frames arrive meanwhile.
		const slow = {
			...api,
			updates: {
				...api.updates,
				getChatDifference: async (request: Parameters<typeof api.updates.getChatDifference>[0]) => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return api.updates.getChatDifference(request);
				},
			},
		};
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql, { api: slow });
		await settle(core);
		core.openChat(chat);
		await settle(core);
		const seqs = (): number[] =>
			sql
				.db(dbName(self))
				.prepare("SELECT seq FROM messages WHERE chat_id = ? ORDER BY seq")
				.all(chat)
				.map((row) => Number(row.seq));

		// Frames of 1 and 2 are lost; 3 arrives and opens a gap.
		server.network.lossRate = 1;
		server.sendMessage(a, chat, "1");
		server.sendMessage(a, chat, "2");
		server.network.lossRate = 0;
		server.sendMessage(a, chat, "3");
		await vi.advanceTimersByTimeAsync(160); // gap timer fired, difference in flight
		expect(server.calls.get("getChatDifference") ?? 0).toBe(0); // still waiting in the slow wrapper
		server.sendMessage(a, chat, "4"); // realtime frame of 4 arrives now
		await vi.advanceTimersByTimeAsync(50);
		expect(seqs()).not.toContain(4); // held, not applied, while the difference runs
		await settle(core);
		expect(seqs()).toEqual([1, 2, 3, 4]);
		await core.close();
	});

	it("reloads the visible window on chat too_long and revalidates older stale cache on scroll", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Lớn", [self, a]);
		server.switchToLarge(chat);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		core.openChat(chat);
		for (let i = 1; i <= 80; i++) server.sendMessage(a, chat, `cũ ${i}`);
		await settle(core);
		await core.close();

		// Offline long enough for the chat log to be truncated; messages are
		// deleted and added meanwhile.
		server.deleteMessages(a, chat, [5, 6]);
		for (let i = 1; i <= 20; i++) server.sendMessage(a, chat, `mới ${i}`);
		server.truncateLogs();

		const { core: next } = await startTestApp(server, self, sql, { userIdHint: self });
		next.openChat(chat);
		await settle(next);
		const db = sql.db(dbName(self));
		const stale = Number(db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ? AND stale = 1").get(chat)?.n);
		expect(stale).toBeGreaterThan(0);
		// Stale rows stay searchable but flagged until checked.
		const hits = await next.search("cu 3");
		expect(hits.some((m) => m.stale)).toBe(true);
		// Scrolling into the stale range checks it against the server.
		const seqs: number[] = [];
		let offset = 0;
		for (;;) {
			const page = await next.history(chat, { offsetSeq: offset, limit: 30 });
			seqs.unshift(...page.messages.map((m) => m.seq));
			const first = page.messages[0];
			if (!page.hasOlder || first === undefined) break;
			offset = first.seq;
		}
		expect(seqs).toEqual(server.expectedMessages(chat, self).map((m) => m.seq));
		expect(Number(db.prepare("SELECT count(*) AS n FROM messages WHERE stale = 1").get()?.n)).toBe(0);
		await next.close();
	});
});

describe("notifications", () => {
	it("notifies incoming messages unless their chat is open in the foreground", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const open = server.createChat(ChatType.GROUP, "Đang mở", [self, a]);
		const other = server.createChat(ChatType.GROUP, "Khác", [self, a]);
		const sql = new MemorySqlFactory();
		const { core, platform } = await startTestApp(server, self, sql);
		await settle(core);
		core.openChat(open);
		server.sendMessage(a, open, "không báo");
		server.sendMessage(a, other, "có báo");
		await settle(core);
		expect(platform.notifications.map((n) => [n.title, n.body])).toEqual([["Khác", "An: có báo"]]);
		platform.setForeground(false);
		server.sendMessage(a, open, "tab ẩn");
		await settle(core);
		expect(platform.notifications.at(-1)?.body).toBe("An: tab ẩn");
		await core.markRead(open, 3);
		expect(platform.cleared).toContain(`chat:${open}`);
		await core.close();
	});
});
