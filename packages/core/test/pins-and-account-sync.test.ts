import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ChatType, DialogSchema, NotificationSettingsSchema, NotificationSound } from "@achoo254/chat-proto/chats";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { EventKeys } from "../src/events/bus.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, MUTE_FOREVER, unreadTotals } from "../src/model/types.ts";
import { createRemoteApi } from "../src/protocol/api.ts";
import { toDialog, toNotificationSettings, toUpdate } from "../src/protocol/map.ts";
import { parseNotificationSettings } from "../src/repo/rows.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;
const NOW = Math.floor(new Date("2026-10-15T09:00:00Z").getTime() / 1000);

describe("protocol mapping", () => {
	it("maps the dialog's pinned messages and unread mark, the new updates and the settings", () => {
		const dialog = toDialog(
			create(DialogSchema, { chatId: big(7), pinnedMessageCount: 3, pinnedMessageSeq: big(42), unreadMark: true }),
		);
		expect(dialog).toMatchObject({ chatId: 7, pinnedMessageCount: 3, pinnedMessageSeq: 42, unreadMark: true });
		const unpinAll = toUpdate(
			create(UpdateSchema, { kind: { case: "pin", value: { chatId: big(7), seqs: [big(3), big(5)] } } }),
		);
		expect(unpinAll.body).toEqual({ kind: "pin", chatId: 7, seq: 0, pinned: false, seqs: [3, 5] });
		const mark = toUpdate(
			create(UpdateSchema, { kind: { case: "dialogUnreadMark", value: { chatId: big(7), unread: true } } }),
		);
		expect(mark.body).toEqual({ kind: "dialog_unread_mark", chatId: 7, unread: true });
		const settings = create(NotificationSettingsSchema, { groupsEnabled: true, sound: NotificationSound.OFF, badgeMuted: true });
		expect(toNotificationSettings(settings)).toMatchObject({ groupsEnabled: true, privateEnabled: false, sound: "off", badgeMuted: true });
		// A sound from a newer server plays the default one.
		expect(toNotificationSettings(create(NotificationSettingsSchema, { sound: 9 as NotificationSound })).sound).toBe("default");
		const update = toUpdate(create(UpdateSchema, { kind: { case: "notificationSettings", value: { settings } } }));
		expect(update.body).toMatchObject({ kind: "notification_settings", settings: { sound: "off" } });
		expect(toUpdate(create(UpdateSchema, { kind: { case: "notificationSettings", value: {} } })).body).toEqual({
			kind: "unknown",
		});
	});

	it("reads stored settings defensively", () => {
		expect(parseNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
		expect(parseNotificationSettings("not json")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
		expect(parseNotificationSettings(JSON.stringify({ groupsEnabled: false, sound: "loud" }))).toEqual({
			...DEFAULT_NOTIFICATION_SETTINGS,
			groupsEnabled: false,
		});
	});

	it("exposes the new RPCs through createRemoteApi", () => {
		const api = createRemoteApi({} as never);
		expect(typeof api.chats.setDialogUnreadMark).toBe("function");
		expect(typeof api.chats.getChatOnlineCount).toBe("function");
		expect(typeof api.chats.getNotificationSettings).toBe("function");
		expect(typeof api.chats.setNotificationSettings).toBe("function");
		expect(typeof api.messages.getPinnedMessages).toBe("function");
		expect(typeof api.messages.unpinAllMessages).toBe("function");
	});
});

describe("unread badge", () => {
	it("counts a chat marked as unread as one message and honours the muted setting", () => {
		const dialogs = [
			{ unreadCount: 0, muteUntil: 0, unreadMark: true },
			{ unreadCount: 2, muteUntil: 0, unreadMark: true },
			{ unreadCount: 0, muteUntil: MUTE_FOREVER, unreadMark: true },
			{ unreadCount: 0, muteUntil: 0, unreadMark: false },
		];
		expect(unreadTotals(dialogs, NOW)).toEqual({ messages: 3, chats: 2 });
		expect(unreadTotals(dialogs, NOW, true)).toEqual({ messages: 4, chats: 3 });
	});
});

describe("pinned messages", () => {
	it("lists pins newest first and keeps the dialog's count in step with other sessions", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const seqs = ["một", "hai", "ba"].map((text) => server.sendMessage(a, chat, text).seq);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const pinEvents: string[] = [];
		core.events.subscribe(EventKeys.pins(chat), () => pinEvents.push("pins"));

		for (const seq of seqs) server.pin(chat, seq, true);
		await settle(core);
		let view = (await core.dialogs()).find((v) => v.dialog.chatId === chat);
		expect(view?.dialog).toMatchObject({ pinnedMessageCount: 3, pinnedMessageSeq: seqs[2] });
		expect(view?.chat?.pinnedSeq).toBe(seqs[2]);
		expect(pinEvents.length).toBeGreaterThan(0);

		const first = await core.pinnedMessages(chat, { limit: 2 });
		expect(first.messages.map((m) => m.text)).toEqual(["ba", "hai"]);
		expect(first).toMatchObject({ count: 3, hasMore: true });
		const next = await core.pinnedMessages(chat, { offsetSeq: first.messages[1]?.seq ?? 0, limit: 2 });
		expect(next.messages.map((m) => m.text)).toEqual(["một"]);
		expect(next.hasMore).toBe(false);
		// Pinned messages do not enter the history cache (it assumes contiguous ranges).
		expect((await core.history(chat)).messages.map((m) => m.text)).toEqual(["một", "hai", "ba"]);

		// Unpinning the newest falls back to the next one.
		server.pin(chat, seqs[2] ?? 0, false);
		await settle(core);
		view = (await core.dialogs()).find((v) => v.dialog.chatId === chat);
		expect(view?.dialog).toMatchObject({ pinnedMessageCount: 2, pinnedMessageSeq: seqs[1] });
		expect(view?.chat?.pinnedSeq).toBe(seqs[1]);

		// Unpin all from this session reaches the local state through sync.
		await core.unpinAllMessages(chat);
		await settle(core);
		view = (await core.dialogs()).find((v) => v.dialog.chatId === chat);
		expect(view?.dialog).toMatchObject({ pinnedMessageCount: 0, pinnedMessageSeq: 0 });
		expect(view?.chat?.pinnedSeq).toBe(0);
		expect((await core.pinnedMessages(chat)).count).toBe(0);
		await core.close();
	});
});

describe("unread mark", () => {
	it("syncs the mark across sessions and clears it when the chat is read", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const top = server.sendMessage(a, chat, "xin chào").seq;
		server.readHistory(self, chat, top);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);

		// Marked on another device.
		server.markUnread(self, chat, true);
		await settle(core);
		expect((await core.dialogs())[0]?.dialog.unreadMark).toBe(true);
		expect(await core.unreadTotals()).toEqual({ messages: 1, chats: 1 });

		// Reading the chat here clears it, even with nothing new to read.
		await core.markRead(chat, top);
		expect((await core.dialogs())[0]?.dialog.unreadMark).toBe(false);
		await settle(core);
		expect(Boolean(server.dialog(chat, self).unreadMark)).toBe(false);
		expect(await core.unreadTotals()).toEqual({ messages: 0, chats: 0 });

		// Marked here; the server and this session agree.
		await core.setDialogUnreadMark(chat, true);
		expect((await core.dialogs())[0]?.dialog.unreadMark).toBe(true);
		await settle(core);
		expect(server.dialog(chat, self).unreadMark).toBe(true);
		await core.setDialogUnreadMark(chat, false);
		await settle(core);
		expect((await core.dialogs())[0]?.dialog.unreadMark).toBe(false);
		expect(server.dialog(chat, self).unreadMark).toBe(false);
		await core.close();
	});
});

describe("notification settings", () => {
	it("takes the settings with the first snapshot, follows other sessions and feeds the badge", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const quiet = server.createChat(ChatType.GROUP, "Im lặng", [self, a]);
		server.sendMessage(a, quiet, "một");
		server.sendMessage(a, quiet, "hai");
		server.muteDialog(self, quiet, MUTE_FOREVER);
		server.setNotify(self, { channelsPreview: false });
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		expect(await core.notificationSettings()).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, channelsPreview: false });
		// Muted chats stay out of the badge by default.
		expect(await core.unreadTotals()).toEqual({ messages: 0, chats: 0 });

		const changed: string[] = [];
		core.events.subscribe(EventKeys.notificationSettings, () => changed.push("settings"));
		server.setNotify(self, { badgeMuted: true, sound: NotificationSound.SOFT });
		await settle(core);
		expect(await core.notificationSettings()).toMatchObject({ badgeMuted: true, sound: "soft", channelsPreview: false });
		expect(changed).toHaveLength(1);
		expect(await core.unreadTotals()).toEqual({ messages: 2, chats: 1 });

		const after = await core.setNotificationSettings({ groupsEnabled: false, badgeMuted: false });
		expect(after).toMatchObject({ groupsEnabled: false, badgeMuted: false, sound: "soft" });
		expect(await core.notificationSettings()).toEqual(after);
		await settle(core);
		expect(server.notifySettings(self)).toMatchObject({ groupsEnabled: false, badgeMuted: false });
		expect(await core.unreadTotals()).toEqual({ messages: 0, chats: 0 });
		await core.close();
	});
});

describe("per-user updates without a chat while connected", () => {
	it("delivers pinned_dialogs, chat_deleted and notification_settings in realtime", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const one = server.createChat(ChatType.GROUP, "Một", [self, a]);
		const two = server.createChat(ChatType.GROUP, "Hai", [self, a]);
		for (const chat of [one, two]) server.sendMessage(a, chat, "xin chào");
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const differences = server.calls.get("getDifference") ?? 0;

		server.pinDialogs(self, [two]);
		server.setNotify(self, { privatePreview: false });
		server.deleteChat(one);
		await settle(core);
		const views = await core.dialogs();
		expect(views.map((v) => v.dialog.chatId)).toEqual([two]);
		expect(views[0]?.dialog.pinned).toBe(true);
		expect((await core.notificationSettings()).privatePreview).toBe(false);
		// Applied from the live socket, not recovered by a difference.
		expect(server.calls.get("getDifference") ?? 0).toBe(differences);
		await core.close();
	});
});

describe("online count", () => {
	it("asks the server for the number of members online", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const b = server.addUser("Bình");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a, b]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		expect(await core.onlineCount(chat)).toBe(1);
		const { core: other } = await startTestApp(server, a, new MemorySqlFactory());
		await settle(other);
		expect(await core.onlineCount(chat)).toBe(2);
		await other.close();
		await core.close();
	});
});
