// Features the server and core sync to every session, on the real client core
// and the in-memory server: recalled messages as placeholders, several pinned
// messages (bar, list, unpin all, per topic), reaction chips with the latest
// reactors, "marked as unread", notification settings with the badge and the
// browser notifications they allow, and the online count of groups.
import { NotificationSound } from "@app/proto-ts/chats";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { seedDemo, type Demo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

async function openChat(demo: Demo, chatId: number, waitFor: string | RegExp) {
	renderMessaging(demo.fixture, `/c/${chatId}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText(waitFor, {}, LONG);
	return log;
}

function messageOf(log: HTMLElement, text: string): HTMLElement {
	const message = within(log).getByText(text).closest<HTMLElement>(".msg");
	if (message === null) throw new Error(`no message "${text}"`);
	return message;
}

async function rowOf(name: string): Promise<HTMLElement> {
	const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
	const row = (await within(list).findByText(name, {}, LONG)).closest<HTMLElement>("li");
	if (row === null) throw new Error(`no row "${name}"`);
	return row;
}

/** The signed-in user's dialog of a chat as the server keeps it. */
async function serverDialog(demo: Demo, chatId: number) {
	const response = await demo.fixture.server.apiFor(demo.fixture.selfId).chats.getDialogs({ limit: 100 });
	const dialog = response.dialogs.find((item) => Number(item.chatId) === chatId);
	if (dialog === undefined) throw new Error(`no dialog ${chatId}`);
	return dialog;
}

describe("recalled messages", () => {
	it("shows the placeholder in the history, in replies and in the chat list, with only 'Xoá ở phía tôi'", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { huy, lan } = demo.ids.users;
		const recalled = f.send(huy, demo.ids.ops, "Tin này sẽ bị thu hồi");
		f.send(lan, demo.ids.ops, "Mình trả lời tin vừa rồi", { replyToSeq: BigInt(recalled) });
		f.server.deleteMessages(huy, demo.ids.ops, [recalled]);
		const log = await openChat(demo, demo.ids.ops, "Mình trả lời tin vừa rồi");

		const placeholder = await waitFor(() => {
			const found = log.querySelector<HTMLElement>(`.msg[data-seq="${recalled}"]`);
			if (found === null) throw new Error("placeholder not rendered");
			return found;
		}, LONG);
		expect(placeholder.querySelector(".bubble.recalled")?.textContent).toMatch(/^Quang HuyTin nhắn đã thu hồi\d\d:\d\d$/);
		expect(within(placeholder).queryByRole("toolbar")).toBeNull();
		expect(within(log).queryByText("Tin này cần phiên bản mới hơn")).toBeNull();
		expect(within(log).queryByText("Tin này sẽ bị thu hồi")).toBeNull();
		const reply = messageOf(log, "Mình trả lời tin vừa rồi").querySelector(".reply");
		expect(reply?.textContent).toBe("Quang HuyTin nhắn đã thu hồi");

		fireEvent.contextMenu(placeholder);
		const menu = await screen.findByRole("menu", { name: "Thao tác với tin" });
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Xoá ở phía tôi"]);
		expect(screen.queryByRole("group", { name: "Thả cảm xúc" })).toBeNull();
		await userEvent.keyboard("{Escape}");

		// Recalled while the chat is open, and as the chat list's last message.
		const last = f.send(huy, demo.ids.ops, "Gửi nhầm chat");
		await within(log).findByText("Gửi nhầm chat", {}, LONG);
		f.server.deleteMessages(huy, demo.ids.ops, [last]);
		await waitFor(() => expect(within(log).queryByText("Gửi nhầm chat")).toBeNull(), LONG);
		expect(log.querySelector(`.msg[data-seq="${last}"] .bubble.recalled`)).not.toBeNull();
		const row = await rowOf("Vận hành hệ thống");
		await waitFor(() => expect(row.querySelector(".preview")?.textContent).toBe("Quang Huy: Tin nhắn đã thu hồi"), LONG);
	});
});

describe("pinned messages", () => {
	it("counts the pins, rotates through them, lists them and unpins one or all", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { huy, lan } = demo.ids.users;
		const second = f.send(lan, demo.ids.ops, "Quy trình trực sự cố tuần này");
		const third = f.send(huy, demo.ids.ops, "Lịch họp giao ban thứ Hai");
		f.server.pin(demo.ids.ops, second, true);
		f.server.pin(demo.ids.ops, third, true);
		await openChat(demo, demo.ids.ops, "Lịch họp giao ban thứ Hai");

		const bar = await waitFor(() => {
			const found = document.querySelector<HTMLElement>(".pinned");
			if (found?.textContent?.includes("Tin ghim 3/3") !== true) throw new Error("bar not ready");
			return found;
		}, LONG);
		expect(bar.textContent).toBe("Tin ghim 3/3 · Lịch họp giao ban thứ Hai");
		await userEvent.click(within(bar).getByRole("button", { name: "Nhảy tới tin ghim 3/3" }));
		await waitFor(() => expect(bar.textContent).toBe("Tin ghim 2/3 · Quy trình trực sự cố tuần này"));
		await userEvent.click(within(bar).getByRole("button", { name: "Nhảy tới tin ghim 2/3" }));
		await waitFor(() => expect(bar.textContent).toMatch(/^Tin ghim 1\/3 · Checklist sau nâng cấp/));
		await userEvent.click(within(bar).getByRole("button", { name: "Nhảy tới tin ghim 1/3" }));
		await waitFor(() => expect(bar.textContent).toBe("Tin ghim 3/3 · Lịch họp giao ban thứ Hai"));

		await userEvent.click(within(bar).getByRole("button", { name: "Tất cả tin ghim, 3 tin" }));
		const dialog = await screen.findByRole("dialog", { name: "Tin ghim · 3" }, LONG);
		const rows = await within(dialog).findAllByRole("listitem", {}, LONG);
		expect(rows.map((row) => row.querySelector(".pin-text")?.textContent)).toEqual([
			"Lịch họp giao ban thứ Hai",
			"Quy trình trực sự cố tuần này",
			expect.stringMatching(/^Checklist sau nâng cấp/),
		]);
		await userEvent.click(within(dialog).getByRole("button", { name: "Bỏ ghim tin của Lan Anh" }));
		await waitFor(() => expect(f.pins.at(-1)).toEqual({ chatId: demo.ids.ops, seq: second, pinned: false }), LONG);
		await waitFor(() => expect(within(dialog).getByRole("heading").textContent).toBe("Tin ghim · 2"), LONG);
		await waitFor(() => expect(document.querySelector(".pinned")?.textContent).toBe("Tin ghim 2/2 · Lịch họp giao ban thứ Hai"), LONG);

		await userEvent.click(within(dialog).getByRole("button", { name: "Bỏ ghim tất cả" }));
		const confirm = await screen.findByRole("dialog", { name: "Bỏ ghim tất cả tin?" });
		expect(within(confirm).getByText(/2 tin ghim trong “Vận hành hệ thống” sẽ được bỏ ghim cho mọi thành viên/)).toBeTruthy();
		await userEvent.click(within(confirm).getByRole("button", { name: "Bỏ ghim tất cả" }));
		expect(await screen.findByText("Đã bỏ ghim 2 tin")).toBeTruthy();
		await waitFor(() => expect(document.querySelector(".pinned")).toBeNull(), LONG);
		expect((await serverDialog(demo, demo.ids.ops)).pinnedMessageCount).toBe(0);
	});

	it("asks for the pins of the open forum topic", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const seq = f.send(demo.ids.users.ha, demo.ids.forum, "Quy ước đặt tên màn hình", { topicId: 12n });
		f.server.pin(demo.ids.forum, seq, true);
		renderMessaging(f, `/c/${demo.ids.forum}/t/12`);
		const bar = await waitFor(() => {
			const found = document.querySelector<HTMLElement>(".pinned");
			if (found === null) throw new Error("no bar");
			return found;
		}, LONG);
		await waitFor(() => expect(bar.textContent).toBe("Tin ghim · Quy ước đặt tên màn hình"), LONG);
		expect(f.pinnedRequests).toContainEqual({ chatId: demo.ids.forum, topicId: 12 });
	});
});

describe("reaction chips", () => {
	it("shows up to three latest reactors, the count only for more, and the count alone without them", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { huy, ha } = demo.ids.users;
		const log = await openChat(demo, demo.ids.ops, "Dashboard ổn định.");
		const chip = within(log).getByRole("button", { name: "👍 3 người: bạn, Minh, Lan Anh" });
		expect(chip.querySelectorAll(".r-avs .avatar")).toHaveLength(3);
		expect(chip.textContent).toBe("👍ĐTMLA");

		f.react(huy, demo.ids.ops, Number(messageOf(log, "Dashboard ổn định.").dataset.seq), "🔥");
		f.react(ha, demo.ids.ops, Number(messageOf(log, "Dashboard ổn định.").dataset.seq), "🔥");
		const fire = await within(log).findByRole("button", { name: "🔥 2 người: Thu Hà, Quang Huy" }, LONG);
		expect(fire.textContent).toBe("🔥THQH");

		const upgrade = within(log).getByText(/Sáng nay mình sẽ nâng cấp/).closest<HTMLElement>(".msg");
		f.react(ha, demo.ids.ops, Number(upgrade?.dataset.seq), "👍");
		const four = await within(log).findByRole("button", { name: "👍 4 người: Thu Hà, bạn, Minh và 1 người khác" }, LONG);
		expect(four.querySelectorAll(".r-avs .avatar")).toHaveLength(3);
		expect(four.textContent?.endsWith("+1")).toBe(true);
	});

	it("falls back to the count when the server sends no reactors", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.anonymousReactions.add(demo.ids.ops);
		const log = await openChat(demo, demo.ids.ops, "Dashboard ổn định.");
		const chip = within(log).getByRole("button", { name: "👍 3 người, gồm bạn" });
		expect(chip.querySelector(".r-avs")).toBeNull();
		expect(chip.textContent).toBe("👍3");
	});
});

describe("marked as unread", () => {
	it("syncs the mark from the row menu, shows the dot and clears it when the chat opens", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		renderMessaging(f);
		const row = await rowOf("Deploy Bot");
		fireEvent.contextMenu(row);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với chat Deploy Bot" })).getByRole("menuitem", { name: "Đánh dấu chưa đọc" }));
		expect(await screen.findByText("Đã đánh dấu chưa đọc")).toBeTruthy();
		await waitFor(() => expect(within(row).getByRole("img", { name: "Đánh dấu chưa đọc" }).className).toBe("badge dot"), LONG);
		expect((await serverDialog(demo, demo.ids.bot)).unreadMark).toBe(true);

		// Another session clears it; then marks the channel, read so far.
		f.server.markUnread(f.selfId, demo.ids.bot, false);
		await waitFor(() => expect(within(row).queryByRole("img", { name: "Đánh dấu chưa đọc" })).toBeNull(), LONG);
		f.server.markUnread(f.selfId, demo.ids.channel, true);
		const channelRow = await rowOf("Thông báo hoandat");
		await waitFor(() => expect(within(channelRow).getByRole("img", { name: "Đánh dấu chưa đọc" })).toBeTruthy(), LONG);

		await userEvent.click(within(channelRow).getByRole("link"));
		await waitFor(() => expect(within(channelRow).queryByRole("img", { name: "Đánh dấu chưa đọc" })).toBeNull(), LONG);
		await waitFor(async () => expect((await serverDialog(demo, demo.ids.channel)).unreadMark).toBe(false), LONG);
	});
});

describe("notification settings", () => {
	it("loads and saves the synced settings and keeps the in-chat sound on this device", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.server.setNotify(f.selfId, { channelsEnabled: false });
		renderMessaging(f, "/settings/notifications");
		const channels = await screen.findByRole("switch", { name: "Thông báo kênh" }, LONG);
		expect(channels.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByRole("switch", { name: "Hiện nội dung tin trong thông báo kênh" }).hasAttribute("disabled")).toBe(true);

		await userEvent.click(screen.getByRole("switch", { name: "Thông báo nhóm" }));
		await waitFor(() => expect(f.server.notifySettings(f.selfId).groupsEnabled).toBe(false), LONG);
		await userEvent.click(screen.getByRole("switch", { name: "Hiện nội dung tin trong thông báo chat riêng tư" }));
		await waitFor(() => expect(f.server.notifySettings(f.selfId).privatePreview).toBe(false), LONG);
		await userEvent.click(within(screen.getByRole("group", { name: "Âm báo" })).getByRole("button", { name: "Nhẹ" }));
		await waitFor(() => expect(f.server.notifySettings(f.selfId).sound).toBe(NotificationSound.SOFT), LONG);
		expect(await screen.findAllByText("Đã lưu cài đặt thông báo")).not.toHaveLength(0);

		await userEvent.click(screen.getByRole("switch", { name: "Phát âm thanh khi đang mở chat" }));
		expect(window.localStorage.getItem(`chat:sound-in-chat:${f.selfId}`)).toBe("1");

		// A change made on another session shows here.
		f.server.setNotify(f.selfId, { channelsEnabled: true });
		await waitFor(() => expect(screen.getByRole("switch", { name: "Thông báo kênh" }).getAttribute("aria-checked")).toBe("true"), LONG);
	});

	it("counts muted chats in the folder badges and the tab title only when chosen", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		renderMessaging(f);
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		const groups = () => within(rail).getByRole("button", { name: /^Nhóm/ }).querySelector(".badge")?.getAttribute("aria-label");
		await waitFor(() => expect(groups()).toBe("2 chat chưa đọc"), LONG);
		await waitFor(() => expect(document.title).toMatch(/^\(\d+\)/), LONG);
		const without = Number(/^\((\d+)\)/.exec(document.title)?.[1]);

		f.server.setNotify(f.selfId, { badgeMuted: true });
		await waitFor(() => expect(groups()).toBe("3 chat chưa đọc"), LONG);
		// Team Mobile (muted) has one unread message.
		await waitFor(() => expect(document.title).toMatch(new RegExp(`^\\(${without + 1}\\)`)), LONG);
	});

	it("shows browser notifications per chat type, hides the text when asked and never for muted chats", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.server.setNotify(f.selfId, { groupsEnabled: false, privatePreview: false });
		renderMessaging(f);
		await rowOf("Lan Anh");
		f.send(demo.ids.users.lan, demo.ids.lanAnh, "Tối nay mình gửi bản cuối");
		f.send(demo.ids.users.huy, demo.ids.ops, "Tin trong nhóm");
		f.send(demo.ids.users.minh, demo.ids.mobile, "Tin trong nhóm đã tắt thông báo");
		f.send(demo.ids.users.announcer, demo.ids.channel, "Bài mới trên kênh");
		await waitFor(() => expect(f.notifications.map((n) => n.title)).toEqual(expect.arrayContaining(["Lan Anh", "Thông báo hoandat"])), LONG);
		expect(f.notifications.find((n) => n.title === "Lan Anh")?.body).toBe("Bạn có tin nhắn mới");
		expect(f.notifications.find((n) => n.title === "Thông báo hoandat")?.body).toMatch(/Bài mới trên kênh$/);
		expect(f.notifications.some((n) => n.title === "Vận hành hệ thống" || n.title === "Team Mobile")).toBe(false);
	});
});

describe("online count", () => {
	it("shows members and members online from GetChatOnlineCount in the header and info panel", async () => {
		const demo = seedDemo();
		demo.fixture.onlineCounts.set(demo.ids.ops, 3);
		await openChat(demo, demo.ids.ops, "Dashboard ổn định.");
		const head = document.querySelector(".convo-head");
		await waitFor(() => expect(head?.textContent).toMatch(/5 thành viên · 3 đang hoạt động$/), LONG);
		const info = screen.queryByRole("complementary", { name: "Thông tin nhóm" }) ?? (await (async () => {
			await userEvent.click(screen.getByRole("button", { name: "Thông tin chat" }));
			return screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		})());
		await waitFor(() => expect(within(info).getByText("5 thành viên · 3 đang hoạt động")).toBeTruthy(), LONG);
	});

	it("shows the member count alone when nobody else is online", async () => {
		const demo = seedDemo();
		demo.fixture.onlineCounts.set(demo.ids.ops, 0);
		const asked = vi.spyOn(demo.fixture.onlineCounts, "get");
		await openChat(demo, demo.ids.ops, "Dashboard ổn định.");
		await waitFor(() => expect(asked).toHaveBeenCalledWith(demo.ids.ops), LONG);
		const head = document.querySelector(".convo-head");
		await waitFor(() => expect(head?.textContent).toMatch(/5 thành viên$/), LONG);
		expect(head?.textContent).not.toMatch(/đang hoạt động/);
	});
});
