// Read position and unread counts across the reader's devices: what the
// chat list badges, the folder counts and the unread divider read from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { systemTimers } from "@app/platform";
import { EventBus } from "../src/events/bus.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-16T03:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

async function dialogOf(core: Awaited<ReturnType<typeof startTestApp>>["core"], chatId: number) {
	const views = await core.dialogs();
	return views.find((view) => view.dialog.chatId === chatId)?.dialog;
}

describe("unread state across the reader's devices", () => {
	it("keeps the read position and the count of both devices on the server's", async () => {
		const server = new FakeServer();
		const reader = server.addUser("Đạt");
		const sender = server.addUser("Ngân");
		const chat = server.createChat(ChatType.PRIVATE, "", [reader, sender]);
		const phone = await startTestApp(server, reader, new MemorySqlFactory());
		const web = await startTestApp(server, reader, new MemorySqlFactory());
		await settle(phone.core);
		await settle(web.core);

		// Messages 1..5 from the sender; the reader reads 3 on the phone.
		for (const text of ["1", "2", "3", "4", "5"]) server.sendMessage(sender, chat, text);
		await settle(web.core);
		await phone.core.markRead(chat, 3);
		await settle(phone.core);
		await settle(web.core);
		expect(await dialogOf(web.core, chat)).toMatchObject({ readInboxMaxSeq: 3, unreadCount: 2 });

		// The reader reads everything on the web and answers twice between
		// new incoming messages; the phone follows.
		await web.core.markRead(chat, 5);
		await web.core.sendText(chat, "own 6");
		await settle(web.core);
		server.sendMessage(sender, chat, "7");
		await settle(web.core);
		await web.core.markRead(chat, 7);
		await web.core.sendText(chat, "own 8");
		await settle(web.core);
		server.sendMessage(sender, chat, "9");
		server.sendMessage(sender, chat, "10");
		await settle(web.core);
		await web.core.markRead(chat, 9);
		await settle(web.core);
		await settle(phone.core);

		for (const core of [web.core, phone.core]) {
			expect(await dialogOf(core, chat)).toMatchObject({ readInboxMaxSeq: 9, unreadCount: 1 });
			expect(await core.unreadTotals()).toEqual({ messages: 1, chats: 1 });
		}
		// Reading the rest on the phone clears the web's badge.
		await phone.core.markRead(chat, 10);
		await settle(phone.core);
		await settle(web.core);
		expect(await dialogOf(web.core, chat)).toMatchObject({ readInboxMaxSeq: 10, unreadCount: 0 });
		expect(await web.core.unreadTotals()).toEqual({ messages: 0, chats: 0 });
	});

	it("counts a new mention or reply at once and clears it with the read on every device", async () => {
		const server = new FakeServer();
		const reader = server.addUser("Đạt");
		const sender = server.addUser("Ngân");
		const group = server.createChat(ChatType.GROUP, "Vận hành", [reader, sender]);
		const web = await startTestApp(server, reader, new MemorySqlFactory());
		const phone = await startTestApp(server, reader, new MemorySqlFactory());
		await settle(web.core);
		await settle(phone.core);
		const mine = server.sendMessage(reader, group, "câu hỏi").seq;
		server.sendMessage(sender, group, "Đạt xem giúp", 0, {
			entities: [{ type: EntityType.MENTION_NAME, offset: 0, length: 3, userId: BigInt(reader) }],
		});
		server.sendMessage(sender, group, "không nhắc ai");
		server.sendMessage(sender, group, "trả lời", 0, { replyToSeq: BigInt(mine) });
		await settle(web.core);
		await settle(phone.core);
		for (const core of [web.core, phone.core]) {
			expect(await dialogOf(core, group)).toMatchObject({ unreadCount: 3, unreadMentionsCount: 2 });
		}

		// Part read on the web: the server's count of mentions left follows.
		await web.core.markRead(group, mine + 2);
		await settle(web.core);
		await settle(phone.core);
		for (const core of [web.core, phone.core]) {
			expect(await dialogOf(core, group)).toMatchObject({ unreadCount: 1, unreadMentionsCount: 1 });
		}
		// Everything read on the phone: no "@" anywhere, at once on the phone.
		await phone.core.markRead(group, mine + 3);
		expect(await dialogOf(phone.core, group)).toMatchObject({ unreadCount: 0, unreadMentionsCount: 0 });
		await settle(phone.core);
		await settle(web.core);
		expect(await dialogOf(web.core, group)).toMatchObject({ unreadCount: 0, unreadMentionsCount: 0 });
	});

	it("takes a read made elsewhere while this device was cut off", async () => {
		const server = new FakeServer();
		const reader = server.addUser("Đạt");
		const sender = server.addUser("Đôn");
		const chat = server.createChat(ChatType.PRIVATE, "", [reader, sender]);
		const web = await startTestApp(server, reader, new MemorySqlFactory());
		const phone = await startTestApp(server, reader, new MemorySqlFactory());
		await settle(web.core);
		for (let i = 1; i <= 12; i++) server.sendMessage(sender, chat, `đôn ${i}`);
		await settle(web.core);
		expect(await dialogOf(web.core, chat)).toMatchObject({ unreadCount: 12 });

		server.dropConnections();
		server.readHistory(reader, chat, 12);
		await settle(phone.core);
		await settle(web.core);
		expect(await dialogOf(web.core, chat)).toMatchObject({ readInboxMaxSeq: 12, unreadCount: 0 });
		expect(await web.core.unreadTotals()).toEqual({ messages: 0, chats: 0 });
	});

	it("takes the read position from the server before counting a chat's first history page", async () => {
		const server = new FakeServer();
		const reader = server.addUser("Đạt");
		const sender = server.addUser("Ngân");
		const chat = server.createChat(ChatType.PRIVATE, "", [reader, sender]);
		for (let i = 1; i <= 10; i++) server.sendMessage(sender, chat, `tin ${i}`);
		server.readHistory(reader, chat, 8);
		// A device that opens the chat (a link) before its dialog list synced.
		const driver = await new MemorySqlFactory().open("fresh.sqlite3");
		await migrate(driver);
		const repo = new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
		const engine = new SyncEngine({ repo, api: server.apiFor(reader), timers: systemTimers, selfId: reader, onSessionEnded: () => undefined });
		await engine.load();
		await engine.fetchHistory(chat, "older", 0, 60);
		expect(await repo.dialog(chat)).toMatchObject({ readInboxMaxSeq: 8, unreadCount: 2 });
		engine.stop();
	});
});
