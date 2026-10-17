import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { TypingAction } from "@app/proto-ts/realtime";
import { TYPING_REPEAT_MS, TYPING_SHOWN_MS } from "../src/app/typing.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-17T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

async function twoPeople() {
	const server = new FakeServer();
	const an = server.addUser("An");
	const binh = server.addUser("Bình");
	const chatId = server.createChat(ChatType.GROUP, "Nhóm", [an, binh]);
	const sql = new MemorySqlFactory();
	const a = (await startTestApp(server, an, sql)).core;
	const b = (await startTestApp(server, binh, sql)).core;
	await settle(a);
	await settle(b);
	a.openChat(chatId);
	b.openChat(chatId);
	await vi.advanceTimersByTimeAsync(50);
	return { server, an, binh, chatId, a, b };
}

describe("typing", () => {
	it("shows someone typing until it expires, and throttles repeats", async () => {
		const { server, binh, chatId, a, b } = await twoPeople();
		b.sendTyping(chatId, 0, "typing");
		b.sendTyping(chatId, 0, "typing");
		await vi.advanceTimersByTimeAsync(50);
		expect(server.typingSent).toEqual([{ userId: binh, chatId, action: TypingAction.TYPING }]);
		expect(a.typing()).toEqual([{ chatId, userId: binh, topicId: 0, action: "typing" }]);

		// Still typing: the repeat keeps it on screen past the first expiry.
		await vi.advanceTimersByTimeAsync(TYPING_REPEAT_MS);
		b.sendTyping(chatId, 0, "typing");
		await vi.advanceTimersByTimeAsync(TYPING_SHOWN_MS - 100);
		expect(server.typingSent).toHaveLength(2);
		expect(a.typing()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(a.typing()).toEqual([]);
	});

	it("ends when the person posts or cancels", async () => {
		const { server, binh, chatId, a, b } = await twoPeople();
		b.sendTyping(chatId, 0, "photo");
		await vi.advanceTimersByTimeAsync(50);
		expect(a.typing()).toEqual([{ chatId, userId: binh, topicId: 0, action: "photo" }]);
		server.sendMessage(binh, chatId, "ảnh đây");
		await vi.advanceTimersByTimeAsync(50);
		expect(a.typing()).toEqual([]);

		b.sendTyping(chatId, 0, "typing");
		await vi.advanceTimersByTimeAsync(50);
		expect(a.typing()).toHaveLength(1);
		b.sendTyping(chatId, 0, "cancel");
		// A second cancel has nothing left to end.
		b.sendTyping(chatId, 0, "cancel");
		await vi.advanceTimersByTimeAsync(50);
		expect(a.typing()).toEqual([]);
		expect(server.typingSent.filter((t) => t.action === TypingAction.CANCEL)).toHaveLength(1);
	});
});

describe("typing sends", () => {
	it("start over after a post and end when another chat opens", async () => {
		const { server, an, binh, chatId, a, b } = await twoPeople();
		const other = server.createChat(ChatType.PRIVATE, "", [an, binh]);
		await settle(b);
		const sent = () => server.typingSent.filter((t) => t.userId === binh).map((t) => t.action);
		b.sendTyping(chatId, 0, "typing");
		await b.sendText(chatId, "xong");
		// Right after posting, the next keystroke is sent again.
		b.sendTyping(chatId, 0, "typing");
		await vi.advanceTimersByTimeAsync(50);
		expect(sent()).toEqual([TypingAction.TYPING, TypingAction.TYPING]);

		// Opening another chat ends the typing in the previous one first.
		b.openChat(other);
		await vi.advanceTimersByTimeAsync(50);
		expect(sent().at(-1)).toBe(TypingAction.CANCEL);
		expect(a.typing()).toEqual([]);
	});
});
