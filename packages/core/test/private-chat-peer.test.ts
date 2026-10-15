import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code } from "@connectrpc/connect";
import { ChatType } from "@app/proto-ts/chats";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

// A private chat created for an existing user without a message (the
// assistant bot's chat) reaches the device only as member_added. The chat
// is named and shown by its peer, so the device must learn who that is.
async function existingUser() {
	const server = new FakeServer();
	const self = server.addUser("An");
	const friend = server.addUser("Bình");
	const bot = server.addUser("Trợ lý");
	const first = server.createChat(ChatType.PRIVATE, "", [self, friend]);
	server.sendMessage(friend, first, "chào");
	const sql = new MemorySqlFactory();
	const { core } = await startTestApp(server, self, sql);
	await settle(core);
	return { server, core, sql, self, bot };
}

describe("the peer of a private chat", () => {
	it("is fetched when the chat arrives in an update without it", async () => {
		const { server, core, self, bot } = await existingUser();
		server.framesWithoutPeers = true;
		// The dialog refresh that would also bring the peer fails.
		server.faults.push({ method: "getPeerDialogs", when: "before", code: Code.Unavailable, remaining: 1 });
		const chatId = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		server.addMember(chatId, self, self);
		await settle(core);

		const view = (await core.dialogs()).find((d) => d.dialog.chatId === chatId);
		expect(view?.chat?.peerUserId).toBe(bot);
		expect(view?.peer).toMatchObject({ id: bot, name: "Trợ lý" });
	});

	it("is fetched when asked for while the device never stored it", async () => {
		const { server, core, sql, self, bot } = await existingUser();
		const chatId = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		server.addMember(chatId, self, self);
		await settle(core);
		// A device that took the chat before the peer was sent with it.
		sql.db(dbName(self)).prepare("DELETE FROM users WHERE id = ?").run(bot);
		expect((await core.dialogs()).find((d) => d.dialog.chatId === chatId)?.peer).toBeNull();

		const before = server.calls.get("getUsers") ?? 0;
		expect(await core.users([bot, self])).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: bot, name: "Trợ lý" })]),
		);
		expect(server.calls.get("getUsers") ?? 0).toBe(before + 1);
		expect((await core.dialogs()).find((d) => d.dialog.chatId === chatId)?.peer).toMatchObject({ id: bot });
		// Known users are not asked for again.
		await core.users([bot, self]);
		expect(server.calls.get("getUsers") ?? 0).toBe(before + 1);
	});
});
