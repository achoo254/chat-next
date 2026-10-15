import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a chat this device never synced", () => {
	// The server writes no update when a private chat is created (only its
	// first message does), so the chat the creator opens right after
	// CreatePrivate, or one opened from a /c/<id> link, is not stored yet.
	it("is fetched from the server and stored when the app asks for it", async () => {
		const server = new FakeServer();
		const self = server.addUser("An");
		const peer = server.addUser("Bình");
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);

		const chatId = server.createChat(ChatType.PRIVATE, "", [self, peer]);
		const chat = await core.chat(chatId);
		expect(chat).toMatchObject({ id: chatId, type: "private", peerUserId: peer });
		expect(await core.chat(chatId)).toMatchObject({ id: chatId });
		expect((await core.users([peer]))[0]?.id).toBe(peer);
	});

	it("is still null when the server does not know it or the user is not a member", async () => {
		const server = new FakeServer();
		const self = server.addUser("An");
		const other = server.addUser("Chi");
		const third = server.addUser("Dũng");
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);

		const foreign = server.createChat(ChatType.GROUP, "Không phải của An", [other, third]);
		expect(await core.chat(foreign)).toBeNull();
		expect(await core.chat(9_999)).toBeNull();
	});
});
