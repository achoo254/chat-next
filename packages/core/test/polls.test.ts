import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema, PollSchema } from "@achoo254/chat-proto/messages";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { ChatType } from "@achoo254/chat-proto/chats";
import { toMessage, toUpdate } from "../src/protocol/map.ts";
import { putMessage, putPoll, WriteBatch } from "../src/repo/writes.ts";
import { rowToMessage } from "../src/repo/rows.ts";
import type { Poll } from "../src/model/types.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-11-28T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

const wirePoll = create(PollSchema, {
	question: "Ăn gì?",
	options: ["Phở", "Bún"],
	multiple: true,
	counts: [2, 1],
	voters: 3,
	chosen: [0],
});

describe("polls", () => {
	it("maps the poll of a message and of a poll update", () => {
		const message = toMessage(create(MessageSchema, { chatId: big(5), seq: big(2), fromId: big(9), poll: wirePoll }));
		expect(message.poll).toEqual({
			question: "Ăn gì?",
			options: ["Phở", "Bún"],
			multiple: true,
			publicVoters: false,
			quiz: false,
			correct: [],
			explanation: "",
			closed: false,
			counts: [2, 1],
			voters: 3,
			chosen: [0],
			resultsHidden: false,
		});
		expect(toMessage(create(MessageSchema, { chatId: big(5), seq: big(3), text: "hi" })).poll).toBeUndefined();
		const update = toUpdate(
			create(UpdateSchema, { kind: { case: "poll", value: { chatId: big(5), seq: big(2), poll: wirePoll } } }),
		);
		expect(update.body).toMatchObject({ kind: "poll", chatId: 5, seq: 2, poll: { counts: [2, 1], chosen: [0] } });
	});

	it("stores a poll and its newest results in the local database", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const seq = server.sendMessage(a, chat, "").seq;
		await settle(core);
		const stored = server.expectedMessages(chat, self).find((m) => m.seq === seq);
		if (stored === undefined) throw new Error("message missing");
		const poll: Poll | undefined = toMessage(create(MessageSchema, { poll: wirePoll })).poll;
		if (poll === undefined) throw new Error("poll missing");
		const db = sql.db(dbName(self));
		const batch = new WriteBatch();
		putMessage(batch, { ...stored, poll });
		putPoll(batch, chat, seq, { ...poll, counts: [2, 2], voters: 4, chosen: [0, 1], closed: true });
		for (const statement of batch.statements) db.prepare(statement.sql).run(...(statement.params ?? []));

		const row = db.prepare("SELECT * FROM messages WHERE chat_id = ? AND seq = ?").get(chat, seq);
		if (row === undefined) throw new Error("row missing");
		const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
		expect(rowToMessage(values).poll).toMatchObject({
			question: "Ăn gì?",
			counts: [2, 2],
			voters: 4,
			chosen: [0, 1],
			closed: true,
		});
		await core.close();
	});
});
