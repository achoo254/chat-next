import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema, ReactionCountSchema } from "@app/proto-ts/messages";
import { UpdateSchema } from "@app/proto-ts/updates";
import { ChatType } from "@app/proto-ts/chats";
import { toMessage, toUpdate } from "../src/protocol/map.ts";
import { putMessage, WriteBatch } from "../src/repo/writes.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

describe("recalled messages", () => {
	it("maps the recall flag of message_delete and of a placeholder message", () => {
		const recall = toUpdate(
			create(UpdateSchema, { kind: { case: "messageDelete", value: { chatId: big(5), seqs: [big(2)], recalled: true } } }),
		);
		expect(recall.body).toEqual({ kind: "message_delete", chatId: 5, seqs: [2], recalled: true });
		const old = toUpdate(create(UpdateSchema, { kind: { case: "messageDelete", value: { chatId: big(5), seqs: [big(2)] } } }));
		expect(old.body).toMatchObject({ recalled: false });
		const placeholder = toMessage(create(MessageSchema, { chatId: big(5), seq: big(2), fromId: big(9), recalled: true }));
		expect(placeholder).toMatchObject({ seq: 2, fromId: 9, text: "", recalled: true, reactions: [] });
	});

	it("keeps a placeholder in place of a message recalled on another device, unsearchable and not unread", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const secret = server.sendMessage(a, chat, "kế hoạch bí mật").seq;
		server.sendMessage(a, chat, "tin còn lại");
		server.react(self, chat, secret, "👍");
		await settle(core);
		expect((await core.dialogs())[0]?.dialog.unreadCount).toBe(2);
		expect(await core.search("bi mat")).toHaveLength(1);

		server.deleteMessages(a, chat, [secret]);
		await settle(core);
		const view = await core.history(chat);
		const placeholder = view.messages.find((m) => m.seq === secret);
		expect(placeholder).toMatchObject({ recalled: true, text: "", fromId: a, reactions: [], entities: [] });
		expect(view.messages.map((m) => m.seq)).toEqual(server.expectedMessages(chat, self).map((m) => m.seq));
		expect(await core.search("bi mat")).toHaveLength(0);
		expect((await core.dialogs())[0]?.dialog.unreadCount).toBe(1);
		// Reading past it leaves nothing unread.
		await core.markRead(chat, Math.max(...server.messageSeqs(chat)));
		await settle(core);
		expect((await core.dialogs())[0]?.dialog.unreadCount).toBe(0);
		await core.close();
	});

	it("recalls your own message locally at once and removes a message deleted only for you", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const theirs = server.sendMessage(a, chat, "của An").seq;
		await core.sendText(chat, "của tôi");
		await settle(core);
		const mine = (await core.history(chat)).messages.find((m) => m.text === "của tôi")?.seq ?? 0;

		await core.deleteMessages(chat, [mine], true);
		await core.deleteMessages(chat, [theirs], false);
		const local = await core.history(chat);
		expect(local.messages.map((m) => [m.seq, m.recalled])).toEqual([[mine, true]]);
		await settle(core);
		// The server agrees: the author's placeholder stays, the hidden one is gone.
		const db = sql.db(dbName(self));
		const rows = db.prepare("SELECT seq, recalled, text, search_text FROM messages WHERE chat_id = ? ORDER BY seq").all(chat);
		expect(rows.map((r) => [Number(r.seq), Number(r.recalled), String(r.text), String(r.search_text)])).toEqual([
			[mine, 1, "", ""],
		]);
		expect(server.expectedMessages(chat, self).map((m) => [m.seq, m.recalled])).toEqual([[mine, true]]);
		await core.close();
	});

	it("never turns a placeholder back into the message, even from a newer edit", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const seq = server.sendMessage(a, chat, "lỡ gửi").seq;
		await settle(core);
		const live = server.expectedMessages(chat, self).find((m) => m.seq === seq);
		server.deleteMessages(a, chat, [seq]);
		await settle(core);
		// A late copy of the live message (an edit or history page delivered
		// out of order) does not bring the content back.
		const db = sql.db(dbName(self));
		const late = new WriteBatch();
		if (live === undefined) throw new Error("message missing");
		putMessage(late, { ...live, text: "lỡ gửi (sửa)", editVersion: 5 });
		for (const statement of late.statements) db.prepare(statement.sql).run(...(statement.params ?? []));
		const row = db.prepare("SELECT recalled, text, search_text FROM messages WHERE chat_id = ? AND seq = ?").get(chat, seq);
		expect([Number(row?.recalled), String(row?.text), String(row?.search_text)]).toEqual([1, "", ""]);
		await core.close();
	});
});

describe("reaction chips", () => {
	it("keep the most recent reactors so avatars render without another call", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const [a, b, c, d] = ["An", "Bình", "Chi", "Dũng"].map((name) => server.addUser(name));
		const members = [self, a ?? 0, b ?? 0, c ?? 0, d ?? 0];
		const chat = server.createChat(ChatType.GROUP, "Nhóm", members);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const seq = server.sendMessage(self, chat, "thả cảm xúc đi").seq;
		for (const user of [a, b, c, d]) server.react(user ?? 0, chat, seq, "👍");
		await settle(core);
		const message = (await core.history(chat)).messages.find((m) => m.seq === seq);
		expect(message?.reactions).toEqual([{ emoji: "👍", count: 4, chosen: false, recentUserIds: [d, c, b] }]);
		// Their users are cached for the avatars.
		expect((await core.users([d ?? 0, c ?? 0, b ?? 0])).map((u) => u.id).sort()).toEqual([b, c, d].sort());

		const wire = create(ReactionCountSchema, { emoji: "🔥", count: 2, recentUserIds: [big(7), big(8)] });
		const mapped = toMessage(create(MessageSchema, { chatId: big(1), seq: big(1), reactions: [wire] }));
		expect(mapped.reactions).toEqual([{ emoji: "🔥", count: 2, chosen: false, recentUserIds: [7, 8] }]);
		await core.close();
	});
});
