// The screen of a linked person (ADR 0025, /p/<id>): the messages of their
// private chats in one list in date order, each saying which app it came
// through; older pages at the top without moving what is on screen; a chat
// that fails to load says so with a retry while the others show; no forward
// or delete (sending, replying and editing: person-send.test.tsx); reactions go to the message's own chat; reading marks each
// chat only up to what is shown; the way in from a private chat; and a
// person that is not there.
import { ChatType } from "@achoo254/chat-proto/chats";
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { App } from "../src/app.tsx";
import type { MessagingConnector } from "../src/messaging/data/connector.ts";
import type { ChatSource } from "../src/messaging/data/source.ts";
import { ChatStore } from "../src/messaging/data/store.ts";
import { MergedReadMarker } from "../src/messaging/people/merged-read.ts";
import { matchRoute } from "../src/router.tsx";
import { ChatFixture, fixtureConnector } from "./support/fake-chat.ts";
import { settle } from "./support/fake-history-source.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { routerFetch } from "./support/router-fetch.ts";

const LONG = { timeout: 8000 };
const ROW_PX = 50;
const VIEW_PX = 500;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Renders the app with the data source seen through `wrap` (failing reads, watched read receipts). */
function renderWrapped(fixture: ChatFixture, path: string, wrap: (source: ChatSource) => ChatSource): RenderResult {
	window.history.replaceState(null, "", path);
	const rpcFetch = routerFetch((router) => fixture.routes(router));
	const base = fixtureConnector(fixture, async () => new MemorySqlFactory());
	const connector: MessagingConnector = async (options) => {
		const client = await base(options);
		return { ...client, source: wrap(client.source) };
	};
	return render(<App rpcFetch={rpcFetch} messagingConnector={connector} />);
}

/**
 * Lan Anh on Chat and on Telegram, linked as one person, and Minh (in no
 * person). `messages` lists who writes where, a minute apart, oldest first.
 */
function seed(messages: readonly { chat: "chat" | "telegram"; text: string }[]) {
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan Anh");
	const lanTelegram = fixture.addUser("Lan Anh");
	const minh = fixture.addUser("Minh");
	const lanChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	const telegramChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanTelegram], { externalApp: "telegram" });
	const minhChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, minh]);
	const start = Date.now() - (messages.length + 10) * 60_000;
	vi.useFakeTimers({ toFake: ["Date"] });
	messages.forEach(({ chat, text }, minute) => {
		vi.setSystemTime(start + minute * 60_000);
		if (chat === "chat") fixture.send(lan, lanChat, text);
		else fixture.send(lanTelegram, telegramChat, text);
	});
	vi.setSystemTime(start + (messages.length + 10) * 60_000);
	vi.useRealTimers();
	fixture.send(minh, minhChat, "Minh đây");
	const person = fixture.people.link([lan, lanTelegram]);
	return { fixture, person: person.id, lanChat, telegramChat, minhChat };
}

function numbered(chat: "chat" | "telegram", count: number, prefix: string): { chat: "chat" | "telegram"; text: string }[] {
	return Array.from({ length: count }, (_, i) => ({ chat, text: `${prefix} ${i + 1}` }));
}

async function timeline(): Promise<HTMLElement> {
	return screen.findByRole("log", { name: "Tin nhắn với Lan Anh" }, LONG);
}

/** The bubbles of the list, top to bottom. */
function bubbles(log: HTMLElement): HTMLElement[] {
	return [...log.querySelectorAll<HTMLElement>(".msg")];
}

/**
 * Lays the list out as jsdom does not: each child of the message list is
 * ROW_PX high and the list shows VIEW_PX; scrollTop is kept per element.
 */
function layOut(): void {
	const scroll = new WeakMap<Element, number>();
	const inList = (element: HTMLElement): boolean => element.parentElement?.classList.contains("messages") === true;
	vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
		return inList(this) ? [...(this.parentElement?.children ?? [])].indexOf(this) * ROW_PX : 0;
	});
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("messages") ? this.children.length * ROW_PX : 0;
	});
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("messages") ? VIEW_PX : 0;
	});
	vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
		return scroll.get(this) ?? 0;
	});
	vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
		const max = this.classList.contains("messages") ? Math.max(0, this.children.length * ROW_PX - VIEW_PX) : 0;
		scroll.set(this, Math.max(0, Math.min(value, max)));
	});
}

describe("the person screen", () => {
	it("merges the person's chats in date order, each message labelled with its app", async () => {
		const { fixture, person } = seed([
			{ chat: "chat", text: "Chào từ Chat" },
			{ chat: "telegram", text: "Chào từ Telegram" },
			{ chat: "chat", text: "Lại Chat" },
		]);
		renderMessaging(fixture, `/p/${person}`);
		const log = await timeline();
		await waitFor(() => expect(bubbles(log)).toHaveLength(3), LONG);
		const rows = bubbles(log);
		expect(rows.map((row) => row.textContent ?? "")).toEqual([
			expect.stringContaining("Chào từ Chat"),
			expect.stringContaining("Chào từ Telegram"),
			expect.stringContaining("Lại Chat"),
		]);
		// The app in words, not only a colour.
		expect(rows.map((row) => row.querySelector(".msg-app")?.textContent)).toEqual(["Chat", "Telegram", "Chat"]);
		expect(within(screen.getByRole("region", { name: "Lan Anh" })).getByText("Dòng thời gian gộp")).toBeTruthy();
		const ids = screen.getByRole("group", { name: "Mở từng cuộc trò chuyện" });
		expect(within(ids).getByRole("button", { name: "Mở chat Telegram" })).toBeTruthy();
		expect(within(ids).getByRole("button", { name: "Mở chat Chat" })).toBeTruthy();
		// The composer writes to the person, through the chats chosen on its target row.
		expect(await screen.findByRole("textbox", { name: "Tin nhắn tới Lan Anh" }, LONG)).toBeTruthy();
	});

	it("opens an identity's own chat from the header", async () => {
		const { fixture, person, telegramChat } = seed([{ chat: "telegram", text: "Xin chào" }]);
		renderMessaging(fixture, `/p/${person}`);
		await timeline();
		await userEvent.click(screen.getByRole("button", { name: "Mở chat Telegram" }));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${telegramChat}`), LONG);
	});

	it("loads older messages at the top while the first message on screen stays where it was", async () => {
		layOut();
		// Telegram's only message is older than every Chat message: it shows once Chat is loaded back to it.
		const { fixture, person } = seed([{ chat: "telegram", text: "Cũ nhất" }, ...numbered("chat", 40, "Tin")]);
		renderMessaging(fixture, `/p/${person}`);
		const log = await timeline();
		await waitFor(() => expect(bubbles(log)).toHaveLength(30), LONG);
		expect(log.textContent).not.toContain("Cũ nhất");
		const first = bubbles(log)[0];
		if (first === undefined) throw new Error("no first message");
		expect(first.textContent).toContain("Tin 11");
		// The newest message is in view.
		expect(log.scrollTop).toBe(log.scrollHeight - VIEW_PX);

		log.scrollTop = 0;
		fireEvent.scroll(log);
		const before = first.offsetTop - log.scrollTop;
		await waitFor(() => expect(log.textContent).toContain("Cũ nhất"), LONG);
		await waitFor(() => expect(within(log).getByText("Không còn tin cũ hơn")).toBeTruthy(), LONG);
		expect(bubbles(log)).toHaveLength(41);
		// Older rows were added above: the message that was first on screen did not move.
		expect(first.isConnected).toBe(true);
		expect(first.offsetTop - log.scrollTop).toBe(before);
		expect(log.scrollTop).toBeGreaterThan(0);
	});

	it("names the chat that failed to load, with a retry, while the other chat's messages show", async () => {
		const { fixture, person, telegramChat } = seed([
			{ chat: "chat", text: "Tin từ Chat" },
			{ chat: "telegram", text: "Tin từ Telegram" },
		]);
		let failing = true;
		renderWrapped(fixture, `/p/${person}`, (source) => ({
			...source,
			history: (chatId, request) => (failing && chatId === telegramChat ? Promise.reject(new Error("offline")) : source.history(chatId, request)),
		}));
		const log = await timeline();
		const alert = await screen.findByRole("alert", {}, LONG);
		expect(alert.textContent).toContain("Không tải được tin nhắn Telegram");
		await waitFor(() => expect(log.textContent).toContain("Tin từ Chat"), LONG);
		expect(log.textContent).not.toContain("Tin từ Telegram");

		failing = false;
		await userEvent.click(within(alert).getByRole("button", { name: "Thử lại" }));
		await waitFor(() => expect(log.textContent).toContain("Tin từ Telegram"), LONG);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("offers no forward and no delete on a message, in its buttons or its menu", async () => {
		const { fixture, person } = seed([{ chat: "telegram", text: "Đừng chuyển tiếp" }]);
		renderMessaging(fixture, `/p/${person}`);
		const log = await timeline();
		await waitFor(() => expect(bubbles(log)).toHaveLength(1), LONG);
		const bubble = bubbles(log)[0];
		if (bubble === undefined) throw new Error("no message");
		expect(within(bubble).queryByRole("button", { name: "Chuyển tiếp" })).toBeNull();
		fireEvent.contextMenu(bubble, { clientX: 10, clientY: 10 });
		const menu = await screen.findByRole("menu", {}, LONG);
		const entries = within(menu)
			.getAllByRole("menuitem")
			.map((item) => item.textContent ?? "");
		expect(entries).toContain("Sao chép");
		for (const absent of ["Chuyển tiếp", "Lưu vào Cloud của tôi", "Xoá ở phía tôi", "Thu hồi", "Ghim", "Báo cáo"]) {
			expect(entries).not.toContain(absent);
		}
		// Reply goes through this screen's composer, in the message's own chat.
		expect(entries).toContain("Trả lời");
	});

	it("sends a reaction to the chat the message came from", async () => {
		const { fixture, person, telegramChat } = seed([
			{ chat: "chat", text: "Tin Chat" },
			{ chat: "telegram", text: "Tin Telegram" },
		]);
		renderMessaging(fixture, `/p/${person}`);
		const log = await timeline();
		await waitFor(() => expect(bubbles(log)).toHaveLength(2), LONG);
		const telegram = bubbles(log).find((row) => (row.textContent ?? "").includes("Tin Telegram"));
		if (telegram === undefined) throw new Error("no Telegram message");
		const seq = Number(telegram.dataset.seq);
		fireEvent.contextMenu(telegram, { clientX: 10, clientY: 10 });
		const picker = await screen.findByRole("group", { name: "Thả cảm xúc" }, LONG);
		const first = within(picker).getAllByRole("button")[0];
		if (first === undefined) throw new Error("no reaction");
		const emoji = first.textContent ?? "";
		await userEvent.click(first);
		await waitFor(() => expect(fixture.reactions).toContainEqual({ chatId: telegramChat, seq, emoji }), LONG);
	});

	it("marks each chat read only up to its newest message shown, never through live reading", async () => {
		const liveRead = vi.spyOn(ChatStore.prototype, "setLiveRead");
		// Telegram's 40 messages are all older than Chat's newest page: none of them is shown yet.
		const { fixture, person, lanChat, telegramChat } = seed([...numbered("telegram", 40, "Telegram"), ...numbered("chat", 40, "Chat")]);
		const reads: [number, number][] = [];
		renderWrapped(fixture, `/p/${person}`, (source) => ({
			...source,
			markRead: (chatId, maxSeq) => {
				reads.push([chatId, maxSeq]);
				return source.markRead(chatId, maxSeq);
			},
		}));
		const log = await timeline();
		await waitFor(() => expect(bubbles(log)).toHaveLength(30), LONG);
		const newest = Number(bubbles(log).at(-1)?.dataset.seq);
		await waitFor(() => expect(reads).toContainEqual([lanChat, newest]), LONG);
		await act(settle);
		expect(reads.filter(([chatId]) => chatId === telegramChat)).toEqual([]);
		expect(reads.every(([, seq]) => seq > 0 && seq <= newest)).toBe(true);
		expect(log.textContent).not.toContain("Telegram 40");
		expect(liveRead).not.toHaveBeenCalled();
	});

	it("says the person is not found, with a way back to the list", async () => {
		const { fixture } = seed([{ chat: "chat", text: "Xin chào" }]);
		renderMessaging(fixture, "/p/999");
		expect(await screen.findByText("Không tìm thấy người này", {}, LONG)).toBeTruthy();
		const back = screen.getAllByRole("button", { name: "Về danh sách chat" }).find((button) => button.classList.contains("btn"));
		if (back === undefined) throw new Error("no way back");
		await userEvent.click(back);
		await waitFor(() => expect(window.location.pathname).toBe("/"), LONG);
	});
});

describe("the way in from a private chat", () => {
	it("opens the merged timeline from the info column of a chat whose peer is in a person", async () => {
		const { fixture, person, lanChat } = seed([{ chat: "chat", text: "Chào bạn" }]);
		renderMessaging(fixture, `/c/${lanChat}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		const open = await within(info).findByRole("button", { name: "Xem dòng thời gian gộp" }, LONG);
		await userEvent.click(open);
		await waitFor(() => expect(window.location.pathname).toBe(`/p/${person}`), LONG);
		expect(await timeline()).toBeTruthy();
	});

	it("is not offered for a chat whose peer is in no person", async () => {
		const { fixture, minhChat } = seed([{ chat: "chat", text: "Chào bạn" }]);
		renderMessaging(fixture, `/c/${minhChat}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		await within(info).findByRole("button", { name: "Nối với…" }, LONG);
		expect(within(info).queryByRole("button", { name: "Xem dòng thời gian gộp" })).toBeNull();
	});
});

describe("the person route", () => {
	it("matches /p/<id> and nothing else under /p", () => {
		expect(matchRoute("/p/12")).toEqual({ name: "person", personId: 12 });
		expect(matchRoute("/p/12/")).toEqual({ name: "person", personId: 12 });
		for (const bad of ["/p", "/p/0", "/p/abc", "/p/-1", "/p/12/x", "/p/1.5"]) expect(matchRoute(bad)).toBeNull();
	});

	it("sends an unknown person path home", async () => {
		const { fixture } = seed([{ chat: "chat", text: "Xin chào" }]);
		renderMessaging(fixture, "/p/abc");
		await waitFor(() => expect(window.location.pathname).toBe("/"), LONG);
	});
});

describe("the read marker of the merged timeline", () => {
	it("sends only growing positive seqs, at most once per interval, and again after a failure", async () => {
		vi.useFakeTimers();
		const calls: [number, number][] = [];
		let fail = false;
		const errors: unknown[] = [];
		const marker = new MergedReadMarker(
			(chatId, seq) => {
				calls.push([chatId, seq]);
				return fail ? Promise.reject(new Error("offline")) : Promise.resolve();
			},
			(error) => errors.push(error),
			1000,
		);
		marker.note(new Map([[1, 5], [2, 0]]));
		expect(calls).toEqual([[1, 5]]);
		marker.note(new Map([[1, 5]]));
		marker.note(new Map([[1, 7], [2, 3]]));
		expect(calls).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(calls).toEqual([
			[1, 5],
			[1, 7],
			[2, 3],
		]);
		fail = true;
		marker.note(new Map([[1, 9]]));
		vi.advanceTimersByTime(1000);
		await vi.runAllTimersAsync();
		expect(errors).toHaveLength(1);
		fail = false;
		// The failed seq is sent again.
		marker.note(new Map([[1, 9]]));
		vi.advanceTimersByTime(1000);
		expect(calls.at(-1)).toEqual([1, 9]);
		marker.dispose();
		marker.note(new Map([[1, 20]]));
		vi.advanceTimersByTime(1000);
		expect(calls.at(-1)).toEqual([1, 9]);
	});
});
