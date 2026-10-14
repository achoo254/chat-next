import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code } from "@connectrpc/connect";
import { ChatType } from "@app/proto-ts/chats";
import { parseOperation } from "../src/outbox/outbox.ts";
import type { RemoteApi } from "../src/protocol/api.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

interface CallLog {
	chatId: number;
	text: string;
	randomId: number;
	start: number;
	end: number;
}

/** Wraps SendMessage with a fixed latency and records each call. */
function slowSends(api: RemoteApi, latencyMs: number, log: CallLog[]): RemoteApi {
	return {
		...api,
		messages: {
			...api.messages,
			sendMessage: async (request) => {
				const entry: CallLog = {
					chatId: Number(request.chatId ?? 0n),
					text: request.text ?? "",
					randomId: Number(request.randomId ?? 0n),
					start: Date.now(),
					end: 0,
				};
				log.push(entry);
				await new Promise((resolve) => setTimeout(resolve, latencyMs));
				try {
					return await api.messages.sendMessage(request);
				} finally {
					entry.end = Date.now();
				}
			},
		},
	};
}

describe("outbox", () => {
	it("sends one chat in order and different chats in parallel", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const one = server.createChat(ChatType.GROUP, "1", [self, a]);
		const two = server.createChat(ChatType.GROUP, "2", [self, a]);
		const log: CallLog[] = [];
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql, { api: slowSends(server.apiFor(self), 100, log) });
		await settle(core);

		const pending = await Promise.all([
			core.sendText(one, "a1"),
			core.sendText(one, "a2"),
			core.sendText(two, "b1"),
			core.sendText(one, "a3"),
		]);
		// Optimistic: visible right away after the newest real message.
		const view = await core.history(one);
		expect(view.pending.map((p) => p.text)).toEqual(["a1", "a2", "a3"]);
		expect(view.pending.every((p) => p.localSeq > 0 && !Number.isInteger(p.localSeq))).toBe(true);
		await settle(core);

		const chatOne = log.filter((c) => c.chatId === one);
		expect(chatOne.map((c) => c.text)).toEqual(["a1", "a2", "a3"]);
		for (let i = 1; i < chatOne.length; i++) {
			expect(chatOne[i]?.start).toBeGreaterThanOrEqual(chatOne[i - 1]?.end ?? Number.POSITIVE_INFINITY);
		}
		const b1 = log.find((c) => c.chatId === two);
		const a1 = chatOne[0];
		expect(b1?.start).toBeLessThan(a1?.end ?? 0); // chat two did not wait for chat one
		const confirmed = await core.history(one);
		expect(confirmed.pending).toEqual([]);
		expect(confirmed.messages.map((m) => m.text)).toEqual(["a1", "a2", "a3"]);
		// The confirmed message keeps the random_id the UI used as render key.
		expect(confirmed.messages.map((m) => m.randomId)).toEqual(
			pending.filter((p) => p?.chatId === one).map((p) => p?.randomId),
		);
		await core.close();
	});

	it("retries with the same random_id and never duplicates", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const log: CallLog[] = [];
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql, { api: slowSends(server.apiFor(self), 1, log) });
		await settle(core);
		server.faults.push({ method: "sendMessage", when: "before", code: Code.Unavailable, remaining: 2 });
		server.faults.push({ method: "sendMessage", when: "after", code: Code.DeadlineExceeded, remaining: 1 });
		const pending = await core.sendText(chat, "một lần thôi");
		if (pending === null) throw new Error("expected a pending message");
		await settle(core);
		// Two refused tries, one applied with the response lost; the realtime
		// echo of that one (same random_id) may settle it before a 4th try.
		expect(log.length).toBeGreaterThanOrEqual(3);
		expect(new Set(log.map((c) => c.randomId))).toEqual(new Set([pending.randomId]));
		expect(server.expectedMessages(chat, self).map((m) => m.text)).toEqual(["một lần thôi"]);
		const view = await core.history(chat);
		expect(view.messages.map((m) => m.text)).toEqual(["một lần thôi"]);
		expect(view.pending).toEqual([]);
		await core.close();
	});

	it("queues while offline and flushes when the network returns", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const { core, platform } = await startTestApp(server, self, sql);
		await settle(core);
		server.online = false;
		server.dropConnections();
		await core.sendText(chat, "khi mất mạng 1");
		await core.sendText(chat, "khi mất mạng 2");
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await core.history(chat)).pending.map((p) => p.text)).toEqual(["khi mất mạng 1", "khi mất mạng 2"]);
		server.online = true;
		platform.goOnline();
		await settle(core);
		expect(server.expectedMessages(chat, self).map((m) => m.text)).toEqual(["khi mất mạng 1", "khi mất mạng 2"]);
		expect((await core.history(chat)).pending).toEqual([]);
		await core.close();
	});

	it("keeps a refused message as failed and lets the next one through", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		server.faults.push({ method: "sendMessage", when: "before", code: Code.PermissionDenied, remaining: 1 });
		const refused = await core.sendText(chat, "bị từ chối");
		if (refused === null) throw new Error("expected a pending message");
		await core.sendText(chat, "đi tiếp");
		await settle(core);
		const view = await core.history(chat);
		expect(view.messages.map((m) => m.text)).toEqual(["đi tiếp"]);
		expect(view.pending.map((p) => [p.text, p.failure !== null])).toEqual([["bị từ chối", true]]);
		await core.retryOutbox(refused.outboxId);
		await settle(core);
		expect((await core.history(chat)).messages.map((m) => m.text)).toEqual(["đi tiếp", "bị từ chối"]);
		await core.close();
	});

	it("applies edit, delete and read optimistically and confirms them", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		await core.sendText(chat, "bản nháp");
		await settle(core);
		for (let i = 0; i < 3; i++) server.sendMessage(a, chat, `tin ${i}`);
		await settle(core);
		const dialog = (await core.dialogs())[0]?.dialog;
		expect(dialog?.unreadCount).toBe(3);

		await core.editText(chat, 1, "bản cuối");
		await core.deleteMessages(chat, [2], true);
		await core.markRead(chat, 4);
		// Local state changed before the server answered.
		const local = await core.history(chat);
		expect(local.messages.map((m) => m.text)).toEqual(["bản cuối", "tin 1", "tin 2"]);
		expect((await core.dialogs())[0]?.dialog.unreadCount).toBe(0);
		expect(await core.search("ban cuoi")).toHaveLength(1);
		await settle(core);
		expect(server.expectedMessages(chat, self).map((m) => m.text)).toEqual(["bản cuối", "tin 1", "tin 2"]);
		expect(Number(server.dialog(chat, self).readInboxMaxSeq)).toBe(4);
		const count = sql.db(dbName(self)).prepare("SELECT count(*) AS n FROM outbox").get();
		expect(Number(count?.n)).toBe(0);
		await core.close();
	});
});

describe("outbox idempotency", () => {
	it("accepts the same random_id once, also after it was confirmed", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const { core, platform } = await startTestApp(server, self, sql);
		await settle(core);
		server.online = false; // keep the first copy pending
		const first = await core.sendText(chat, "một", { randomId: 777 });
		const again = await core.sendText(chat, "một", { randomId: 777 });
		expect(first?.outboxId).toBeGreaterThan(0);
		expect(again?.outboxId).toBe(first?.outboxId);
		server.online = true;
		platform.goOnline();
		await settle(core);
		expect(await core.sendText(chat, "một", { randomId: 777 })).toBeNull();
		await settle(core);
		expect(server.expectedMessages(chat, self).map((m) => m.text)).toEqual(["một"]);
		await core.close();
	});
});

describe("outbox link previews", () => {
	it("passes no_link_preview through, also for rows queued before it existed", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const seen: { text: string; noLinkPreview: boolean }[] = [];
		const api = server.apiFor(self);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql, {
			api: {
				...api,
				messages: {
					...api.messages,
					sendMessage: (request) => {
						seen.push({ text: request.text ?? "", noLinkPreview: request.noLinkPreview ?? false });
						return api.messages.sendMessage(request);
					},
				},
			},
		});
		await settle(core);
		await core.sendText(chat, "https://example.com without preview", { noLinkPreview: true });
		await core.sendText(chat, "https://example.com with preview");
		await settle(core);
		expect(seen).toEqual([
			{ text: "https://example.com without preview", noLinkPreview: true },
			{ text: "https://example.com with preview", noLinkPreview: false },
		]);
		const old = parseOperation("send", JSON.stringify({ text: "x", entities: [], replyToSeq: 0, date: 1 }));
		expect(old).toEqual({ kind: "send", text: "x", entities: [], replyToSeq: 0, date: 1, noLinkPreview: false });
		await core.close();
	});
});
