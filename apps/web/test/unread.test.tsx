// Unread state on screen: the divider, marking read, the list and folder
// badges, the tab title and the scroll button, on the real client core and
// the core's in-memory protocol server.
import { ChatType } from "@achoo254/chat-proto/chats";
import { EntityType } from "@achoo254/chat-proto/messages";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { entity } from "./support/demo-data.ts";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => {
	window.localStorage.clear();
});

function chatList(): HTMLElement {
	return screen.getByRole("list", { name: "Danh sách chat" });
}

function row(title: string): HTMLElement {
	const link = within(chatList())
		.getAllByRole("link")
		.find((element) => element.textContent?.includes(title));
	if (link === undefined) throw new Error(`no row ${title}`);
	return link;
}

async function openRow(title: string, text: string | RegExp): Promise<HTMLElement> {
	await userEvent.click(row(title));
	const log = screen.getByRole("log", { name: "Tin nhắn" });
	await within(log).findByText(text, {}, LONG);
	return log;
}

function readInbox(fixture: ChatFixture, chatId: number): number {
	return Number(fixture.server.dialog(chatId, fixture.selfId).readInboxMaxSeq);
}

describe("unread divider", () => {
	it("sits above the first message after the read position when a kept chat is opened again", async () => {
		const fixture = new ChatFixture();
		const ngan = fixture.addUser("Ngân");
		const lan = fixture.addUser("Lan Anh");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
		const other = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, other, "Chào buổi sáng");
		fixture.send(ngan, chat, "tin một");
		fixture.send(ngan, chat, "tin hai");
		renderMessaging(fixture, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("tin hai", {}, LONG);
		await waitFor(() => expect(readInbox(fixture, chat)).toBe(2), LONG);

		// The reader answers, reads one more, and goes to another chat.
		await userEvent.type(screen.getByRole("textbox", { name: /^Tin nhắn tới / }), "mình trả lời{Enter}");
		await within(log).findByText("mình trả lời", {}, LONG);
		fixture.send(ngan, chat, "tin bốn");
		await waitFor(() => expect(readInbox(fixture, chat)).toBe(4), LONG);
		await openRow("Lan Anh", "Chào buổi sáng");

		// One new message while away; the chat's window is still kept.
		fixture.send(ngan, chat, "tin năm");
		await waitFor(() => expect(row("Ngân").querySelector(".badge")?.textContent).toBe("1"), LONG);
		const again = await openRow("Ngân", "tin năm");
		const divider = await within(again).findByRole("separator", {}, LONG);
		expect(divider.nextElementSibling?.textContent).toContain("tin năm");
	});
});

describe("marking read", () => {
	it("reads the chat opened after a chat with more messages", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan Anh");
		const don = fixture.addUser("Đôn");
		const busy = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		const quiet = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, don]);
		for (let i = 1; i <= 20; i++) fixture.send(lan, busy, `bận ${i}`);
		fixture.send(don, quiet, "đôn một");
		fixture.send(don, quiet, "đôn hai");
		renderMessaging(fixture, `/c/${busy}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("bận 20", {}, LONG);
		await waitFor(() => expect(readInbox(fixture, busy)).toBe(20), LONG);
		await waitFor(() => expect(document.title).toMatch(/^\(2\)/), LONG);

		await openRow("Đôn", "đôn hai");
		await waitFor(() => expect(readInbox(fixture, quiet)).toBe(2), LONG);
		await waitFor(() => expect(row("Đôn").querySelector(".badge")).toBeNull(), LONG);
		const rail = screen.getByRole("navigation", { name: "Thư mục chat" });
		await waitFor(() => expect(rail.querySelector(".badge")).toBeNull(), LONG);
		await waitFor(() => expect(document.title).not.toMatch(/^\(/), LONG);
	});
});

describe("badges across devices", () => {
	it("clears the row, folder and title badges when another device reads the chat", async () => {
		const fixture = new ChatFixture();
		const don = fixture.addUser("Đôn");
		const lan = fixture.addUser("Lan Anh");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, don]);
		const other = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, other, "Chào buổi sáng");
		fixture.server.readHistory(fixture.selfId, other, 1);
		for (let i = 1; i <= 3; i++) fixture.send(don, chat, `đôn ${i}`);
		renderMessaging(fixture, `/c/${other}`);
		await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await waitFor(() => expect(row("Đôn").querySelector(".badge")?.textContent).toBe("3"), LONG);
		const rail = screen.getByRole("navigation", { name: "Thư mục chat" });
		expect(within(rail).getAllByLabelText("1 chat chưa đọc").length).toBeGreaterThan(0);
		await waitFor(() => expect(document.title).toMatch(/^\(3\)/), LONG);

		// Read on the phone.
		fixture.server.readHistory(fixture.selfId, chat, 3);
		await waitFor(() => expect(row("Đôn").querySelector(".badge")).toBeNull(), LONG);
		expect(rail.querySelector(".badge")).toBeNull();
		await waitFor(() => expect(document.title).not.toMatch(/^\(/), LONG);
	});
});

/** Lays the open list out as a browser would: 100 px per message, a 500 px tall view scrolled to `top`. */
function layOut(log: HTMLElement): { scrollTo(top: number): void } {
	let top = 0;
	const rows = () => [...log.querySelectorAll<HTMLElement>("[data-seq]")];
	Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 500 });
	Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => rows().length * 100 });
	Object.defineProperty(log, "scrollTop", {
		configurable: true,
		get: () => top,
		set: (value: number) => {
			top = Math.max(0, Math.min(value, rows().length * 100 - 500));
		},
	});
	log.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 500 });
	const original = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const index = rows().indexOf(this);
		if (index === -1 || !log.contains(this)) return original.call(this);
		return DOMRect.fromRect({ x: 0, y: index * 100 - top, width: 600, height: 80 });
	};
	return {
		scrollTo(next: number) {
			log.scrollTop = next;
			log.dispatchEvent(new Event("scroll"));
		},
	};
}

describe("new messages in the open chat", () => {
	afterEach(() => {
		delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
	});

	it("reads them at once at the bottom, and counts them on the scroll button while scrolled up", async () => {
		const fixture = new ChatFixture();
		const ngan = fixture.addUser("Ngân");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
		for (let i = 1; i <= 10; i++) fixture.send(ngan, chat, `tin ${i}`);
		renderMessaging(fixture, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("tin 10", {}, LONG);
		await waitFor(() => expect(readInbox(fixture, chat)).toBe(10), LONG);

		// At the bottom: the row never shows the new message as unread.
		const badges: string[] = [];
		const watch = new MutationObserver(() => {
			const text = row("Ngân").querySelector(".badge")?.textContent;
			if (text !== undefined) badges.push(text);
		});
		watch.observe(chatList(), { subtree: true, childList: true, characterData: true });
		fixture.send(ngan, chat, "tin 11");
		await within(log).findByText("tin 11", {}, LONG);
		await waitFor(() => expect(readInbox(fixture, chat)).toBe(11), LONG);
		watch.disconnect();
		expect(badges).toEqual([]);

		// Scrolled up to the first messages: new ones are counted, not read.
		const layout = layOut(log);
		layout.scrollTo(0);
		fixture.send(ngan, chat, "tin 12");
		await within(log).findByText("tin 12", {}, LONG);
		const toBottom = await screen.findByRole("button", { name: "Xuống tin mới nhất, 1 tin chưa đọc" }, LONG);
		expect(toBottom.querySelector(".badge")?.textContent).toBe("1");
		await waitFor(() => expect(row("Ngân").querySelector(".badge")?.textContent).toBe("1"), LONG);
		expect(readInbox(fixture, chat)).toBe(11);

		// Scrolling down reads them.
		layout.scrollTo(10_000);
		await waitFor(() => expect(readInbox(fixture, chat)).toBe(12), LONG);
		await waitFor(() => expect(row("Ngân").querySelector(".badge")).toBeNull(), LONG);
	});
});

describe("forum topics", () => {
	it("reads each topic on its own", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan Anh");
		const forum = fixture.createChat(ChatType.GROUP, "Dự án", [fixture.selfId, lan], { forum: true });
		const topic = (id: number, title: string) => ({ id, title, iconColor: 0, creatorId: lan, pinned: false, closed: false, hidden: false, unreadCount: 1 });
		fixture.topics.set(forum, [topic(1, "Chung"), topic(2, "Thiết kế")]);
		fixture.send(lan, forum, "bản phác màn đăng nhập", { topicId: 2n });
		fixture.send(lan, forum, "họp lúc 16:00", { topicId: 1n });
		renderMessaging(fixture, `/c/${forum}/t/1`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("họp lúc 16:00", {}, LONG);
		const topics = fixture.topics.get(forum) ?? [];
		await waitFor(() => expect(topics.find((t) => t.id === 1)?.unreadCount).toBe(0), LONG);

		// The other topic is still unread, though the chat's own position moved past it.
		const rows = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		await userEvent.click(await within(rows).findByRole("button", { name: /Thiết kế/ }, LONG));
		await within(screen.getByRole("log", { name: "Tin nhắn" })).findByText("bản phác màn đăng nhập", {}, LONG);
		await waitFor(() => expect(topics.find((t) => t.id === 2)?.unreadCount).toBe(0), LONG);
	});
});

describe("mentions", () => {
	it("shows the @ badge for a new mention and clears it once the chat is read", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan Anh");
		const group = fixture.createChat(ChatType.GROUP, "Vận hành", [fixture.selfId, lan]);
		const other = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, other, "Chào buổi sáng");
		fixture.send(lan, group, "Bắt đầu ca trực");
		fixture.server.readHistory(fixture.selfId, group, 1);
		renderMessaging(fixture, `/c/${other}`);
		await screen.findByRole("log", { name: "Tin nhắn" }, LONG);

		const text = "@ductrung xem giúp cảnh báo này";
		fixture.send(lan, group, text, { entities: [entity(EntityType.MENTION, text, "@ductrung")] });
		await waitFor(() => expect(within(row("Vận hành")).getByRole("img", { name: "Có người nhắc bạn" })).toBeTruthy(), LONG);

		await openRow("Vận hành", /xem giúp cảnh báo này/);
		await waitFor(() => expect(within(row("Vận hành")).queryByRole("img", { name: "Có người nhắc bạn" })).toBeNull(), LONG);
		expect(screen.queryByRole("button", { name: /^Tới tin nhắc bạn/ })).toBeNull();
	});
});
