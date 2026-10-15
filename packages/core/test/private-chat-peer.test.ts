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

	it("is fetched in requests of at most 200 users the server accepts", async () => {
		const { server, core } = await existingUser();
		const unknown = Array.from({ length: 450 }, (_, i) => server.addUser(`Người ${i}`));
		const before = server.calls.get("getUsers") ?? 0;

		const users = await core.users(unknown);

		expect(users.map((user) => user.id).sort((a, b) => a - b)).toEqual([...unknown].sort((a, b) => a - b));
		expect(server.calls.get("getUsers") ?? 0).toBe(before + 3);
	});

	// What an older build may have stored for the assistant chat; the
	// next start reloads the chat itself from the server.
	it.each([
		["a peer of 0", "UPDATE chats SET peer_user_id = 0 WHERE id = ?"],
		["the user as peer of a two-member chat", "UPDATE chats SET peer_user_id = (SELECT id FROM users WHERE is_self = 1) WHERE id = ?"],
		["a peer nobody knows", "UPDATE chats SET peer_user_id = 987654 WHERE id = ?"],
		["no chat at all", "DELETE FROM chats WHERE id = ?"],
	])("is repaired on the next start for a device that stored %s", async (_, corrupt) => {
		const { server, core, sql, self, bot } = await existingUser();
		const chatId = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		server.addMember(chatId, self, self);
		await settle(core);
		await core.close();
		const db = sql.db(dbName(self));
		db.prepare(corrupt).run(chatId);
		db.prepare("DELETE FROM users WHERE id = ?").run(bot);

		const { core: restarted } = await startTestApp(server, self, sql);
		await settle(restarted);

		const view = (await restarted.dialogs()).find((d) => d.dialog.chatId === chatId);
		expect(view?.chat).toMatchObject({ type: "private", peerUserId: bot, memberCount: 2 });
		expect(view?.peer).toMatchObject({ id: bot, name: "Trợ lý" });
	});

	it("leaves chats that show fine alone on start", async () => {
		const { server, core, sql, self, bot } = await existingUser();
		const chatId = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		server.addMember(chatId, self, self);
		await settle(core);
		await core.close();
		const before = server.calls.get("getPeerDialogs") ?? 0;

		const { core: restarted } = await startTestApp(server, self, sql);
		await settle(restarted);

		expect(server.calls.get("getPeerDialogs") ?? 0).toBe(before);
	});
});
