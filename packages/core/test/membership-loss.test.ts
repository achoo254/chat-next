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

async function groupWithSelf() {
	const server = new FakeServer();
	const self = server.addUser("An");
	const admin = server.addUser("Bình");
	const other = server.addUser("Chi");
	const chatId = server.createChat(ChatType.GROUP, "Vận hành", [admin, self, other]);
	server.sendMessage(admin, chatId, "chào cả nhóm");
	const { core } = await startTestApp(server, self, new MemorySqlFactory());
	await settle(core);
	return { server, core, self, admin, other, chatId };
}

describe("losing membership of a group", () => {
	it("marks a chat the user was removed from as removed and purges it", async () => {
		const { server, core, self, admin, chatId } = await groupWithSelf();
		server.removeMember(chatId, self, admin);
		await settle(core);

		expect(await core.chat(chatId)).toMatchObject({ left: true, removed: true });
		expect((await core.dialogs()).map((view) => view.dialog.chatId)).not.toContain(chatId);
	});

	it("does not call leaving the group a removal", async () => {
		const { server, core, self, chatId } = await groupWithSelf();
		server.removeMember(chatId, self, self);
		await settle(core);

		expect(await core.chat(chatId)).toMatchObject({ left: true, removed: false });
	});

	it("forgets the removal when the user is added back", async () => {
		const { server, core, self, admin, chatId } = await groupWithSelf();
		server.removeMember(chatId, self, admin);
		await settle(core);
		server.addMember(chatId, self, admin);
		await settle(core);

		expect(await core.chat(chatId)).toMatchObject({ left: false, removed: false });
	});

	it("purges the chat when the server refuses its history after a missed member_removed", async () => {
		const { server, core, self, chatId } = await groupWithSelf();
		server.dropMemberSilently(chatId, self);

		const view = await core.history(chatId, { direction: "older", offsetSeq: 0, limit: 40 });
		expect(view.messages).toEqual([]);
		expect(await core.chat(chatId)).toMatchObject({ left: true, removed: false });
		expect((await core.dialogs()).map((d) => d.dialog.chatId)).not.toContain(chatId);

		// A left chat is not asked for again: no refused request, no failure.
		const again = await core.history(chatId, { direction: "older", offsetSeq: 0, limit: 40 });
		expect(again).toMatchObject({ failure: null, hasOlder: false, messages: [] });
	});

	it("writes nothing for a chat that does not exist, so views are not woken to ask again", async () => {
		const { core } = await groupWithSelf();
		const keys: string[] = [];
		const stop = core.events.subscribeBatches((batch) => keys.push(...batch));

		const view = await core.history(987_654_321, { direction: "older", offsetSeq: 0, limit: 40 });
		await settle(core);
		stop();

		expect(view.failure).toBe("permanent");
		expect(await core.chat(987_654_321)).toBeNull();
		expect(keys.filter((key) => key.includes("987654321"))).toEqual([]);
	});

	it("updates the member count when someone else is removed", async () => {
		const { server, core, admin, other, chatId } = await groupWithSelf();
		expect((await core.chat(chatId))?.memberCount).toBe(3);
		server.removeMember(chatId, other, admin);
		await settle(core);

		expect(await core.chat(chatId)).toMatchObject({ left: false, memberCount: 2 });
	});
});
