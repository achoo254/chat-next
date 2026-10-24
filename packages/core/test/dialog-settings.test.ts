import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { systemTimers } from "@achoo254/chat-platform";
import { ChatType, DialogSchema, GetDialogsResponseSchema } from "@achoo254/chat-proto/chats";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { isReturnPath, signInUrl } from "../src/auth/web.ts";
import { EventBus } from "../src/events/bus.ts";
import { isMuted, MUTE_FOREVER, unreadTotals } from "../src/model/types.ts";
import { createRemoteApi } from "../src/protocol/api.ts";
import { toDialog, toDialogsPage, toUpdate } from "../src/protocol/map.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { FakeServer } from "./support/fake-server.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;
const NOW = Math.floor(new Date("2026-10-14T09:00:00Z").getTime() / 1000);

async function engineOn(server: FakeServer, self: number): Promise<{ engine: SyncEngine; repo: Repository }> {
	const sql = new MemorySqlFactory();
	const driver = await sql.open("engine.sqlite3");
	await migrate(driver);
	const repo = new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
	const engine = new SyncEngine({
		repo,
		api: server.apiFor(self),
		timers: systemTimers,
		selfId: self,
		onSessionEnded: () => undefined,
	});
	await engine.load();
	return { engine, repo };
}

async function idle(engine: SyncEngine): Promise<void> {
	for (let i = 0; i < 500 && engine.busy; i++) await vi.advanceTimersByTimeAsync(10);
	expect(engine.busy).toBe(false);
}

describe("protocol mapping", () => {
	it("maps mute and pin of a dialog and the pinned order of the first page", () => {
		const dialog = toDialog(create(DialogSchema, { chatId: big(7), muteUntil: big(MUTE_FOREVER), pinned: true }));
		expect(dialog).toMatchObject({ chatId: 7, muteUntil: MUTE_FOREVER, pinned: true });
		const page = toDialogsPage(create(GetDialogsResponseSchema, { pinnedChatIds: [big(9), big(7)] }));
		expect(page.pinnedChatIds).toEqual([9, 7]);
	});

	it("maps the dialog_mute, pinned_dialogs and chat_deleted updates", () => {
		const mute = toUpdate(
			create(UpdateSchema, { kind: { case: "dialogMute", value: { chatId: big(3), muteUntil: big(NOW + 60) } } }),
		);
		expect(mute.body).toEqual({ kind: "dialog_mute", chatId: 3, muteUntil: NOW + 60 });
		const pins = toUpdate(create(UpdateSchema, { kind: { case: "pinnedDialogs", value: { chatIds: [big(2), big(1)] } } }));
		expect(pins.body).toEqual({ kind: "pinned_dialogs", chatIds: [2, 1] });
		const deleted = toUpdate(
			create(UpdateSchema, { kind: { case: "chatDeleted", value: { chatId: big(4), forEveryone: true } } }),
		);
		expect(deleted.body).toEqual({ kind: "chat_deleted", chatId: 4, forEveryone: true });
	});

	it("exposes the new RPCs through createRemoteApi", () => {
		const api = createRemoteApi({} as never);
		expect(typeof api.chats.setDialogMute).toBe("function");
		expect(typeof api.chats.setDialogPinned).toBe("function");
		expect(typeof api.chats.reorderPinnedDialogs).toBe("function");
		expect(typeof api.chats.deleteChat).toBe("function");
		expect(typeof api.chats.getCommonChats).toBe("function");
		expect(typeof api.messages.getMessageReactions).toBe("function");
		expect(typeof api.users.getBlockedUsers).toBe("function");
		expect(typeof api.moderation?.getReports).toBe("function");
	});
});

describe("unread badge", () => {
	it("leaves muted chats out unless asked to include them", () => {
		const dialogs = [
			{ unreadCount: 3, muteUntil: 0 },
			{ unreadCount: 5, muteUntil: NOW + 3600 },
			{ unreadCount: 2, muteUntil: NOW - 1 },
			{ unreadCount: 0, muteUntil: 0 },
			{ unreadCount: 4, muteUntil: MUTE_FOREVER },
		];
		expect(isMuted(dialogs[1] ?? { muteUntil: 0 }, NOW)).toBe(true);
		expect(isMuted(dialogs[2] ?? { muteUntil: 0 }, NOW)).toBe(false);
		expect(unreadTotals(dialogs, NOW)).toEqual({ messages: 5, chats: 2 });
		expect(unreadTotals(dialogs, NOW, true)).toEqual({ messages: 14, chats: 4 });
	});
});

describe("dialog settings sync", () => {
	it("takes mute and pinned order from the snapshot and keeps pinned chats on top", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const old = server.createChat(ChatType.GROUP, "Cũ", [self, a]);
		const fresh = server.createChat(ChatType.GROUP, "Mới", [self, a]);
		server.sendMessage(a, old, "cũ");
		server.sendMessage(a, fresh, "mới");
		server.muteDialog(self, fresh, NOW + 3600);
		server.pinDialogs(self, [old]);
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		const views = await repo.dialogViews(10);
		expect(views.map((v) => v.dialog.chatId)).toEqual([old, fresh]);
		expect(views[0]?.dialog.pinned).toBe(true);
		expect(views[1]?.dialog).toMatchObject({ pinned: false, muteUntil: NOW + 3600 });
	});

	it("follows mute, pin order and deletion from another session", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const one = server.createChat(ChatType.GROUP, "Một", [self, a]);
		const two = server.createChat(ChatType.GROUP, "Hai", [self, a]);
		const three = server.createChat(ChatType.GROUP, "Ba", [self, a]);
		for (const chat of [one, two, three]) server.sendMessage(a, chat, "xin chào");
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);

		server.muteDialog(self, two, MUTE_FOREVER);
		server.pinDialogs(self, [one, two]);
		engine.requestDifference();
		await idle(engine);
		let views = await repo.dialogViews(10);
		expect(views.map((v) => v.dialog.chatId)).toEqual([one, two, three]);
		expect((await repo.dialog(two))?.muteUntil).toBe(MUTE_FOREVER);

		server.pinDialogs(self, [two]);
		server.muteDialog(self, two, 0);
		engine.requestDifference();
		await idle(engine);
		views = await repo.dialogViews(10);
		expect(views[0]?.dialog).toMatchObject({ chatId: two, pinned: true, muteUntil: 0 });
		expect(views.filter((v) => v.dialog.pinned)).toHaveLength(1);

		server.deleteChat(two);
		engine.requestDifference();
		await idle(engine);
		expect(await repo.dialog(two)).toBeNull();
		expect(await repo.messagesBefore(two, 0, 10)).toEqual([]);
		expect((await repo.chat(two))?.left).toBe(true);
	});
});

describe("return to the page after sign-in", () => {
	it("passes only same-origin paths", () => {
		expect(signInUrl("vi", { returnTo: "/chat/12?topic=3" })).toBe("/auth/login?locale=vi&return_to=%2Fchat%2F12%3Ftopic%3D3");
		expect(signInUrl("vi", { returnTo: "/" })).toBe("/auth/login?locale=vi");
		for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "/\t/x", "/auth/login", "chat", ""]) {
			expect(isReturnPath(bad)).toBe(false);
			expect(signInUrl("vi", { returnTo: bad })).toBe("/auth/login?locale=vi");
		}
		expect(isReturnPath(`/${"a".repeat(512)}`)).toBe(false);
	});
});
