// A linked person (ADR 0025) is one row of "Tất cả": the latest message and
// the summed unread messages of their private chats, pinned when one of the
// chats is, opening the person's screen, its menu opening one chat. The
// platform folders keep every chat on its own, the "Tất cả" badge counts the
// person once, and without people the list is as it always was.
import { Code } from "@connectrpc/connect";
import { ChatType } from "@achoo254/chat-proto/chats";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const PERSON = /^Lan Anh, cùng một người trên Chat, Telegram, Zalo/;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/**
 * The paths the app navigated to. The person screen's route does not exist
 * in this list's tests, so the app sends an unknown path home right after:
 * the pushes record where the list went.
 */
function watchNavigation(): string[] {
	const pushed: string[] = [];
	const push = window.history.pushState.bind(window.history);
	vi.spyOn(window.history, "pushState").mockImplementation((state: unknown, unused: string, url?: string | URL | null) => {
		if (url !== undefined && url !== null) pushed.push(String(url));
		push(state, unused, url);
	});
	return pushed;
}

/**
 * Lan Anh on Chat, on Telegram (two-way) and on Zalo (a read-only copy),
 * linked as one person; Minh on Chat and a bot. Every chat has one unread
 * message, a minute apart: the bot's newest, then Telegram, Zalo, Lan Anh, Minh.
 */
function seed() {
	const start = Date.now() - 10 * 60_000;
	vi.useFakeTimers({ toFake: ["Date"] });
	const send = (from: number, chatId: number, text: string, minute: number): void => {
		vi.setSystemTime(start + minute * 60_000);
		fixture.send(from, chatId, text);
	};
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan Anh");
	const lanTelegram = fixture.addUser("Lan Anh");
	const lanZalo = fixture.addUser("Lan Anh");
	const minh = fixture.addUser("Minh");
	const bot = fixture.addUser("Trợ lý Bot", { username: "helper_bot", isBot: true });
	const minhChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, minh]);
	const lanChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	const telegramChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanTelegram], { externalApp: "telegram" });
	const zaloChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanZalo], { externalSource: "zalo" });
	const botChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, bot]);
	send(minh, minhChat, "Minh đây", 1);
	send(lan, lanChat, "Chào bạn", 2);
	send(lanZalo, zaloChat, "Tin từ Zalo", 3);
	send(lanTelegram, telegramChat, "Tin mới nhất từ Telegram", 4);
	send(bot, botChat, "Xin chào", 5);
	vi.useRealTimers();
	const person = fixture.people.link([lan, lanTelegram, lanZalo]);
	return { fixture, person: person.id, minhChat, lanChat, telegramChat, zaloChat, botChat };
}

function chatList(): HTMLElement {
	return screen.getByRole("list", { name: "Danh sách chat" });
}

/** The links of the chat list, top to bottom. */
function rowLinks(): string[] {
	return within(chatList())
		.getAllByRole("link")
		.map((link) => link.getAttribute("href") ?? "");
}

async function personRow(): Promise<HTMLElement> {
	return screen.findByRole("link", { name: PERSON }, LONG);
}

describe("person rows in the chat list", () => {
	it("shows one row for a linked person in Tất cả, with the newest message and the summed unread count", async () => {
		const { fixture, person, lanChat, telegramChat, zaloChat } = seed();
		renderMessaging(fixture, "/");
		const row = await personRow();
		expect(row.getAttribute("href")).toBe(`/p/${person}`);
		expect(row.getAttribute("aria-label")).toBe("Lan Anh, cùng một người trên Chat, Telegram, Zalo, 3 tin chưa đọc");
		expect(within(row).getByText("Tin mới nhất từ Telegram")).toBeTruthy();
		expect(within(row).getByText("3")).toBeTruthy();
		for (const app of ["Chat", "Telegram", "Zalo"]) expect(within(row).getByText(app)).toBeTruthy();
		const links = rowLinks();
		// The read-only Zalo copy is folded in like the others.
		for (const chatId of [lanChat, telegramChat, zaloChat]) expect(links).not.toContain(`/c/${chatId}`);
		expect(links.filter((href) => href.startsWith("/p/"))).toHaveLength(1);
	});

	it("lists each chat on its own in a platform folder, and counts the person once in the Tất cả badge", async () => {
		const { fixture, telegramChat } = seed();
		renderMessaging(fixture, "/");
		await personRow();
		const rail = screen.getByRole("navigation", { name: "Thư mục chat" });
		const all = within(rail).getByRole("button", { name: /^Tất cả/ });
		// Five unread chats, three of them the same person.
		await waitFor(() => expect(within(all).getByLabelText("3 chat chưa đọc")).toBeTruthy(), LONG);
		await userEvent.click(within(rail).getByRole("button", { name: /^Telegram/ }));
		await waitFor(() => expect(rowLinks()).toContain(`/c/${telegramChat}`), LONG);
		expect(rowLinks().some((href) => href.startsWith("/p/"))).toBe(false);
	});

	it("is pinned when one of the person's chats is pinned", async () => {
		const { fixture, zaloChat } = seed();
		fixture.pinChats([zaloChat]);
		renderMessaging(fixture, "/");
		const row = await personRow();
		expect(within(row).getByRole("img", { name: "Đã ghim" })).toBeTruthy();
		expect(rowLinks()[0]).toBe(row.getAttribute("href"));
	});

	it("offers only opening each of the person's chats in its menu", async () => {
		const { fixture, telegramChat } = seed();
		renderMessaging(fixture, "/");
		await personRow();
		await userEvent.click(screen.getByRole("button", { name: "Thao tác với Lan Anh" }));
		const menu = await screen.findByRole("menu", { name: "Thao tác với Lan Anh" }, LONG);
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Mở chat Chat", "Mở chat Telegram", "Mở chat Zalo"]);
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Mở chat Telegram" }));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${telegramChat}`), LONG);
		expect(screen.queryByRole("menu", { name: "Thao tác với Lan Anh" })).toBeNull();
	});

	it("opens the person's screen when the row is clicked", async () => {
		const { fixture, person } = seed();
		renderMessaging(fixture, "/");
		const row = await personRow();
		const pushed = watchNavigation();
		await userEvent.click(row);
		expect(pushed).toEqual([`/p/${person}`]);
	});

	it("moves through the person's row with Alt+↑/↓", async () => {
		const { fixture, person, lanChat, botChat, minhChat } = seed();
		renderMessaging(fixture, `/c/${lanChat}`);
		await personRow();
		expect(rowLinks()).toEqual([`/c/${botChat}`, `/p/${person}`, `/c/${minhChat}`]);
		const pushed = watchNavigation();
		// An open chat of the person stands at the person's row.
		fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${minhChat}`), LONG);
		fireEvent.keyDown(document, { key: "ArrowUp", altKey: true });
		await waitFor(() => expect(pushed).toEqual([`/c/${minhChat}`, `/p/${person}`]), LONG);
	});

	it("goes from the chat above the person's row to the row with Alt+↓", async () => {
		const { fixture, person, botChat } = seed();
		renderMessaging(fixture, `/c/${botChat}`);
		await personRow();
		const pushed = watchNavigation();
		fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
		await waitFor(() => expect(pushed).toEqual([`/p/${person}`]), LONG);
	});

	it("lists every chat as before when the people fail to load", async () => {
		const { fixture, lanChat, telegramChat, zaloChat } = seed();
		fixture.people.listFailure = Code.Internal;
		renderMessaging(fixture, "/");
		await waitFor(() => expect(fixture.people.calls).toContain("people"), LONG);
		await waitFor(() => expect(rowLinks()).toHaveLength(5), LONG);
		const links = rowLinks();
		for (const chatId of [lanChat, telegramChat, zaloChat]) expect(links).toContain(`/c/${chatId}`);
		expect(links.some((href) => href.startsWith("/p/"))).toBe(false);
		const rail = screen.getByRole("navigation", { name: "Thư mục chat" });
		expect(within(within(rail).getByRole("button", { name: /^Tất cả/ })).getByLabelText("5 chat chưa đọc")).toBeTruthy();
	});
});
