// Success criteria of the client sync engine (phase 5):
// - 10,000 updates with 5% frame loss and 5% reordering end equal to the server;
// - kicked while offline: nothing of that chat stays searchable locally;
// - a server_epoch change resyncs without losing a message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code } from "@connectrpc/connect";
import { ChatType } from "@app/proto-ts/chats";
import type { ChatCore } from "../src/app/start-app.ts";
import { FakeServer, seededRandom } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

interface ClientMessageRow {
	seq: number;
	text: string;
	editVersion: number;
	reactions: string;
	fromId: number;
}

function clientMessages(sql: MemorySqlFactory, self: number, chatId: number): ClientMessageRow[] {
	return sql
		.db(dbName(self))
		.prepare("SELECT seq, text, edit_version, reactions, from_id FROM messages WHERE chat_id = ? ORDER BY seq")
		.all(chatId)
		.map((row) => ({
			seq: Number(row.seq),
			text: String(row.text),
			editVersion: Number(row.edit_version),
			reactions: String(row.reactions),
			fromId: Number(row.from_id),
		}));
}

function serverMessages(server: FakeServer, self: number, chatId: number): ClientMessageRow[] {
	return server.expectedMessages(chatId, self).map((m) => ({
		seq: m.seq,
		text: m.text,
		editVersion: m.editVersion,
		reactions: JSON.stringify(m.reactions),
		fromId: m.fromId,
	}));
}

async function allHistory(core: ChatCore, chatId: number): Promise<number[]> {
	const seqs: number[] = [];
	let offset = 0;
	for (let page = 0; page < 1000; page++) {
		const view = await core.history(chatId, { direction: "older", offsetSeq: offset, limit: 40 });
		expect(view.failure).toBeNull();
		seqs.unshift(...view.messages.map((m) => m.seq));
		const first = view.messages[0];
		if (!view.hasOlder || first === undefined) break;
		offset = first.seq;
	}
	return seqs;
}

describe("chaos: lossy, reordering realtime", () => {
	it("ends equal to the server after 10,000 updates with 5% loss and 5% reordering", async () => {
		const seed = Number(process.env.CHAOS_SEED ?? "42");
		const server = new FakeServer(seed);
		const self = server.addUser("Tôi");
		const others = [server.addUser("An"), server.addUser("Bình"), server.addUser("Chi")];
		const [a = 0, b = 0, c = 0] = others;
		const dm = server.createChat(ChatType.PRIVATE, "", [self, a]);
		const group = server.createChat(ChatType.GROUP, "Nhóm", [self, a, b, c]);
		const channel = server.createChat(ChatType.GROUP, "Lớn", [self, a, b, c]);
		const chats = [dm, group, channel];
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		core.openChat(channel);

		server.network.lossRate = 0.05;
		server.network.reorderRate = 0.05;
		// A few RPC failures on the send path: before applying, and after
		// applying with the response lost (the retry must not duplicate).
		server.faults.push({ method: "sendMessage", when: "before", code: Code.Unavailable, remaining: 5 });
		server.faults.push({ method: "sendMessage", when: "after", code: Code.Unavailable, remaining: 5 });

		const rng = seededRandom(seed + 7);
		const pick = <T>(items: readonly T[]): T => {
			const item = items[Math.floor(rng() * items.length)];
			if (item === undefined) throw new Error("empty pick");
			return item;
		};
		const target = 10_000;
		let switched = false;
		let op = 0;
		while ((server.updatesFor.get(self) ?? 0) < target) {
			op++;
			const chatId = pick(chats);
			const seqs = server.messageSeqs(chatId);
			const roll = rng();
			const membersOf = chatId === dm ? [a] : others;
			if (!switched && (server.updatesFor.get(self) ?? 0) > target / 3) {
				server.switchToLarge(channel);
				switched = true;
			} else if (roll < 0.55 || seqs.length === 0) {
				server.sendMessage(pick(membersOf), chatId, `tin ${op} xin chào ${Math.floor(rng() * 1000)}`);
			} else if (roll < 0.63) {
				const seq = pick(seqs);
				const author = server.expectedMessages(chatId, self).find((m) => m.seq === seq)?.fromId ?? 0;
				if (author !== self && author !== 0) server.editMessage(author, chatId, seq, `sửa ${op}`);
			} else if (roll < 0.69) {
				server.deleteMessages(pick(membersOf), chatId, [pick(seqs)]);
			} else if (roll < 0.76) {
				server.react(pick(membersOf), chatId, pick(seqs), pick(["👍", "❤️", "😂"]));
			} else if (roll < 0.81) {
				server.readHistory(self, chatId, pick(seqs));
			} else if (roll < 0.85) {
				server.pin(chatId, pick(seqs), rng() < 0.6);
			} else if (roll < 0.88) {
				server.readHistory(pick(membersOf), chatId, Math.max(...seqs));
			} else if (roll < 0.9) {
				server.hideMessages(self, chatId, [pick(seqs)]);
			} else if (roll < 0.93) {
				void core.sendText(chatId, `của tôi ${op}`);
			} else if (roll < 0.932) {
				server.dropConnections();
			} else {
				server.sendMessage(pick(membersOf), chatId, `nhanh ${op}`);
			}
			await vi.advanceTimersByTimeAsync(Math.floor(rng() * 15));
		}

		// Heal the network; one more message per chat exposes any trailing gap.
		server.network.lossRate = 0;
		server.network.reorderRate = 0;
		await settle(core);
		for (const chatId of chats) server.sendMessage(a, chatId, "cuối");
		await settle(core);

		// The run must have gone through every recovery path.
		expect(server.framesLost).toBeGreaterThan(100);
		expect(server.framesReordered).toBeGreaterThan(100);
		expect(server.calls.get("getDifference") ?? 0).toBeGreaterThan(10);
		expect(server.calls.get("getChatDifference") ?? 0).toBeGreaterThan(10);
		expect(server.calls.get("sendMessage") ?? 0).toBeGreaterThan(10);
		if (process.env.CHAOS_STATS === "1") {
			console.log({ seed, lost: server.framesLost, reordered: server.framesReordered, calls: Object.fromEntries(server.calls) });
		}
		expect(server.updatesFor.get(self)).toBeGreaterThanOrEqual(target);
		for (const chatId of chats) {
			expect(clientMessages(sql, self, chatId), `messages of chat ${chatId}`).toEqual(
				serverMessages(server, self, chatId),
			);
			const views = await core.dialogs();
			const view = views.find((v) => v.dialog.chatId === chatId);
			const expected = server.dialog(chatId, self);
			expect(view?.dialog.topSeq).toBe(Number(expected.topSeq));
			expect(view?.dialog.readInboxMaxSeq).toBe(Number(expected.readInboxMaxSeq));
			expect(view?.dialog.readOutboxMaxSeq).toBe(Number(expected.readOutboxMaxSeq));
			expect(view?.dialog.unreadCount, `unread of chat ${chatId}`).toBe(expected.unreadCount);
			expect(view?.chat?.pinnedSeq, `pinned of chat ${chatId}`).toBe(server.pinnedSeq(chatId));
		}
		const state = sql.db(dbName(self)).prepare("SELECT pts, server_epoch FROM sync_state").get();
		expect(Number(state?.pts)).toBe(server.userPts(self));
		const chatPts = sql.db(dbName(self)).prepare("SELECT chat_pts FROM chat_sync_state WHERE chat_id = ?").get(channel);
		expect(Number(chatPts?.chat_pts)).toBe(server.chatPtsOf(channel));
		const outbox = sql.db(dbName(self)).prepare("SELECT count(*) AS n FROM outbox").get();
		expect(Number(outbox?.n)).toBe(0);
		await core.close();
	}, 300_000);
});

describe("chaos: permission purge and epoch", () => {
	it("forgets a chat the user was removed from while offline", async () => {
		const server = new FakeServer(3);
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const secret = server.createChat(ChatType.GROUP, "Kín", [self, a]);
		const kept = server.createChat(ChatType.GROUP, "Mở", [self, a]);
		const sql = new MemorySqlFactory();
		const first = await startTestApp(server, self, sql);
		await settle(first.core);
		server.sendMessage(a, secret, "Kế hoạch bí mật số một");
		server.sendMessage(a, kept, "Kế hoạch công khai");
		await settle(first.core);
		expect(await first.core.search("bi mat")).toHaveLength(1);
		await first.core.close();

		// Offline: removed from the chat, and the chat keeps going.
		server.removeMember(secret, self, a);
		server.sendMessage(a, secret, "bí mật số hai");

		const second = await startTestApp(server, self, sql, { userIdHint: self });
		await settle(second.core);
		expect(await second.core.search("bi mat")).toEqual([]);
		expect(await second.core.search("ke hoach")).toHaveLength(1);
		const dialogs = await second.core.dialogs();
		expect(dialogs.map((d) => d.dialog.chatId)).toEqual([kept]);
		const db = sql.db(dbName(self));
		expect(db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?").get(secret)?.n).toBe(0);
		expect(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get('"mat"')?.n).toBe(0);
		await second.core.close();
	});

	it("forgets the chat too when the log no longer reaches back (too_long)", async () => {
		const server = new FakeServer(4);
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const secret = server.createChat(ChatType.GROUP, "Kín", [self, a]);
		const sql = new MemorySqlFactory();
		const first = await startTestApp(server, self, sql);
		await settle(first.core);
		server.sendMessage(a, secret, "bí mật");
		await settle(first.core);
		await first.core.close();

		server.removeMember(secret, self, a);
		server.truncateLogs();

		const second = await startTestApp(server, self, sql, { userIdHint: self });
		await settle(second.core);
		expect(await second.core.search("bi mat")).toEqual([]);
		expect(await second.core.dialogs()).toEqual([]);
		await second.core.close();
	});

	it("resyncs after a server_epoch change without losing a message", async () => {
		const server = new FakeServer(5);
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const other = server.createChat(ChatType.PRIVATE, "", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		for (let i = 1; i <= 120; i++) server.sendMessage(a, i % 3 === 0 ? other : chat, `trước ${i}`);
		await settle(core);
		core.openChat(chat);

		// Restore from backup: the last 2 messages of `chat` are lost, pts
		// rewinds, the epoch increases and the socket is told to resync.
		server.restoreWithNewEpoch(chat, 2);
		for (let i = 1; i <= 30; i++) server.sendMessage(a, i % 2 === 0 ? other : chat, `sau ${i}`);
		await settle(core);

		const state = sql.db(dbName(self)).prepare("SELECT pts, server_epoch FROM sync_state").get();
		expect(Number(state?.server_epoch)).toBe(server.epoch);
		expect(Number(state?.pts)).toBe(server.userPts(self));
		for (const chatId of [chat, other]) {
			const expected = server.expectedMessages(chatId, self);
			expect(await allHistory(core, chatId)).toEqual(expected.map((m) => m.seq));
			const texts = clientMessages(sql, self, chatId).map((m) => m.text);
			expect(texts).toEqual(expected.map((m) => m.text));
		}
		// Realtime keeps flowing in the new epoch.
		server.sendMessage(a, chat, "mới nhất");
		await settle(core);
		const newest = await core.history(chat, { limit: 1 });
		expect(newest.messages.map((m) => m.text)).toEqual(["mới nhất"]);
		await core.close();
	});
});
