import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("clearing Cloud của tôi", () => {
	it("drops every note but keeps the chat in the list, pinned or not", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const other = server.addUser("An");
		const cloud = server.createChat(ChatType.PRIVATE, "", [self]);
		const talk = server.createChat(ChatType.PRIVATE, "", [self, other]);
		server.sendMessage(self, cloud, "Link tài liệu onboarding");
		server.sendMessage(self, cloud, "Mật khẩu wifi phòng họp ở bảng");
		server.sendMessage(other, talk, "Chào");
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		expect((await core.history(cloud)).messages).toHaveLength(2);

		server.clearSavedChat(self, cloud);
		await settle(core);
		const views = await core.dialogs();
		const kept = views.find((view) => view.dialog.chatId === cloud);
		expect(kept).toBeDefined();
		expect(kept?.chat?.left).toBe(false);
		expect(kept?.topMessage ?? null).toBeNull();
		expect((await core.history(cloud)).messages).toEqual([]);
		// Other chats are untouched.
		expect(views.some((view) => view.dialog.chatId === talk)).toBe(true);
		await core.close();
	});

	it("keeps an unpinned Cloud in its place in the list, here and after a full sync", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const an = server.addUser("An");
		const binh = server.addUser("Bình");
		const older = server.createChat(ChatType.PRIVATE, "", [self, an]);
		const cloud = server.createChat(ChatType.PRIVATE, "", [self]);
		const newer = server.createChat(ChatType.PRIVATE, "", [self, binh]);
		server.sendMessage(an, older, "Hôm qua");
		vi.advanceTimersByTime(60_000);
		server.sendMessage(self, cloud, "Link tài liệu onboarding");
		vi.advanceTimersByTime(60_000);
		server.sendMessage(binh, newer, "Hôm nay");
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const order = async (app: typeof core) => (await app.dialogs()).map((view) => view.dialog.chatId);
		expect(await order(core)).toEqual([newer, cloud, older]);

		server.clearSavedChat(self, cloud);
		await settle(core);
		expect(await order(core)).toEqual([newer, cloud, older]);
		expect((await core.history(cloud)).messages).toEqual([]);
		await core.close();

		// A device that syncs from scratch puts it in the same place.
		const fresh = await startTestApp(server, self, new MemorySqlFactory());
		await settle(fresh.core);
		expect(await order(fresh.core)).toEqual([newer, cloud, older]);
		await fresh.core.close();
	});
});
