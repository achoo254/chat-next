// Sending from a person's merged screen (ADR 0025): a message goes to every
// chat chosen on the target row, one message in each; the first time only
// the app of the newest message is chosen, then the choice is kept per
// person; one chat that can send shows a label, not a row; a question before
// the first send to several apps, never again after "Không hỏi lại"; a reply
// or an edit goes to the message's own chat only, the typed text along, and
// the row comes back afterwards; a chat that takes nothing says why while
// the others get the message, and a failed send can be tried again.
import { BridgeAccountStatus, BridgeDirection, BridgeSyncState } from "@achoo254/chat-proto/bridge";
import { ChatType } from "@achoo254/chat-proto/chats";
import { cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlbumItemInput } from "@achoo254/chat-core";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { App } from "../src/app.tsx";
import type { MessagingConnector } from "../src/messaging/data/connector.ts";
import type { ChatSource } from "../src/messaging/data/source.ts";
import { ChatFixture, fixtureConnector } from "./support/fake-chat.ts";
import { boxValue } from "./support/plain-text-box.ts";
import { routerFetch } from "./support/router-fetch.ts";

const LONG = { timeout: 8000 };

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type App3 = "chat" | "telegram" | "zalo";

interface Seeded {
	fixture: ChatFixture;
	person: number;
	chats: Record<App3, number>;
}

/**
 * Lan Anh on Chat and Telegram (two-way), and on Zalo when `zalo` says how:
 * "readOnly" a read-only copy, "twoWay" a chat that sends on. `messages`
 * lists who writes where, a minute apart, oldest first.
 */
function seed(messages: readonly { chat: App3; text: string; mine?: boolean }[], zalo: "none" | "readOnly" | "twoWay" = "none"): Seeded {
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan Anh");
	const lanTelegram = fixture.addUser("Lan Anh");
	const lanZalo = fixture.addUser("Lan Anh");
	const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	const telegram = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanTelegram], { externalApp: "telegram" });
	const zaloChat =
		zalo === "none"
			? 0
			: fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanZalo], zalo === "readOnly" ? { externalSource: "zalo" } : { externalApp: "zalo" });
	const chats: Record<App3, number> = { chat, telegram, zalo: zaloChat };
	const peers: Record<App3, number> = { chat: lan, telegram: lanTelegram, zalo: lanZalo };
	const start = Date.now() - (messages.length + 10) * 60_000;
	vi.useFakeTimers({ toFake: ["Date"] });
	messages.forEach(({ chat: where, text, mine }, minute) => {
		vi.setSystemTime(start + minute * 60_000);
		fixture.send(mine === true ? fixture.selfId : peers[where], chats[where], text);
	});
	vi.useRealTimers();
	const person = fixture.people.link(zalo === "none" ? [lan, lanTelegram] : [lan, lanTelegram, lanZalo]);
	return { fixture, person: person.id, chats };
}

/** Keeps the person's chosen chats and, unless `ask`, that the question was answered for good. */
function remember(fixture: ChatFixture, person: number, chatIds: readonly number[], ask = false): void {
	window.localStorage.setItem(`chat:person-targets:${fixture.selfId}:${person}`, JSON.stringify(chatIds));
	if (!ask) window.localStorage.setItem(`chat:person-send-confirmed:${fixture.selfId}`, "1");
}

interface Calls {
	text: { chatId: number; text: string; randomId: number | undefined }[];
	media: { chatId: number; file: Blob; randomId: number | undefined }[];
	album: { chatId: number; items: readonly AlbumItemInput[] }[];
	edits: { chatId: number; seq: number; text: string }[];
}

/** Renders the person's screen with the data source's sends recorded, and `failText` deciding which text sends throw. */
function open(fixture: ChatFixture, person: number, failText: (chatId: number) => boolean = () => false): { calls: Calls; view: RenderResult } {
	window.history.replaceState(null, "", `/p/${person}`);
	const calls: Calls = { text: [], media: [], album: [], edits: [] };
	const base = fixtureConnector(fixture, async () => new MemorySqlFactory());
	const connector: MessagingConnector = async (options) => {
		const client = await base(options);
		const source: ChatSource = {
			...client.source,
			sendText: (chatId, text, options) => {
				calls.text.push({ chatId, text, randomId: options?.randomId });
				if (failText(chatId)) return Promise.reject(new Error("outbox unavailable"));
				return client.source.sendText(chatId, text, options);
			},
			sendMedia: (chatId, file, media, options) => {
				calls.media.push({ chatId, file, randomId: options?.randomId });
				return client.source.sendMedia(chatId, file, media, options);
			},
			sendAlbum: (chatId, items, options) => {
				calls.album.push({ chatId, items });
				return client.source.sendAlbum(chatId, items, options);
			},
			editText: (chatId, seq, text, entities) => {
				calls.edits.push({ chatId, seq, text });
				return client.source.editText(chatId, seq, text, entities);
			},
		};
		return { ...client, source };
	};
	const view = render(<App rpcFetch={routerFetch((router) => fixture.routes(router))} messagingConnector={connector} />);
	return { calls, view };
}

async function box(): Promise<HTMLElement> {
	return screen.findByRole("textbox", { name: "Tin nhắn tới Lan Anh" }, LONG);
}

async function row(): Promise<HTMLElement> {
	return screen.findByRole("group", { name: "Gửi qua" }, LONG);
}

/** The apps pressed on the target row, in row order. */
function pressed(group: HTMLElement): string[] {
	return within(group)
		.getAllByRole("button")
		.filter((button) => button.getAttribute("aria-pressed") === "true")
		.map((button) => button.textContent ?? "");
}

/** What the server got, as [chat, text] pairs. */
function sentTo(fixture: ChatFixture, text: string): number[] {
	return fixture.sent.filter((sent) => sent.text === text).map((sent) => sent.chatId);
}

async function bubbleOf(text: string): Promise<HTMLElement> {
	const log = await screen.findByRole("log", { name: "Tin nhắn với Lan Anh" }, LONG);
	return waitFor(() => {
		const found = [...log.querySelectorAll<HTMLElement>(".msg")].find((row) => (row.textContent ?? "").includes(text));
		if (found === undefined) throw new Error(`no message "${text}"`);
		return found;
	}, LONG);
}

async function menuItem(text: string, item: string): Promise<void> {
	fireEvent.contextMenu(await bubbleOf(text), { clientX: 10, clientY: 10 });
	const menu = await screen.findByRole("menu", {}, LONG);
	await userEvent.click(within(menu).getByRole("menuitem", { name: item }));
}

describe("the target row", () => {
	it("first selects only the app of the newest message, of either side", async () => {
		const telegramNewest = seed([
			{ chat: "chat", text: "Cũ ở Chat" },
			{ chat: "telegram", text: "Mới ở Telegram", mine: true },
		]);
		open(telegramNewest.fixture, telegramNewest.person);
		await waitFor(async () => expect(pressed(await row())).toEqual(["Telegram"]), LONG);
		cleanup();

		const chatNewest = seed([
			{ chat: "telegram", text: "Cũ ở Telegram" },
			{ chat: "chat", text: "Mới ở Chat" },
		]);
		open(chatNewest.fixture, chatNewest.person);
		await waitFor(async () => expect(pressed(await row())).toEqual(["Chat"]), LONG);
	});

	it("toggles each app, always keeping one, and remembers the choice for the person", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Xin chào" }]);
		open(fixture, person);
		const group = await row();
		await waitFor(() => expect(pressed(group)).toEqual(["Telegram"]), LONG);
		// The only app selected stays selected.
		await userEvent.click(within(group).getByRole("button", { name: /Telegram/ }));
		expect(pressed(group)).toEqual(["Telegram"]);
		await userEvent.click(within(group).getByRole("button", { name: /Chat/ }));
		expect(pressed(group)).toEqual(["Chat", "Telegram"]);
		await userEvent.click(within(group).getByRole("button", { name: /Telegram/ }));
		expect(pressed(group)).toEqual(["Chat"]);
		cleanup();

		// Opened again, the person's choice is back although the newest message is on Telegram.
		open(fixture, person);
		const again = await row();
		await waitFor(() => expect(pressed(again)).toEqual(["Chat"]), LONG);
		expect(JSON.parse(window.localStorage.getItem(`chat:person-targets:${fixture.selfId}:${person}`) ?? "[]")).toEqual([chats.chat]);
	});

	it("shows only a label when a single chat can send, the read-only one aside", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan Anh");
		const lanZalo = fixture.addUser("Lan Anh");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		const zalo = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanZalo], { externalSource: "zalo" });
		fixture.send(lanZalo, zalo, "Tin Zalo");
		const person = fixture.people.link([lan, lanZalo]).id;
		const chats = { chat };
		open(fixture, person);
		await box();
		expect(await screen.findByText("Gửi qua Chat", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Gửi qua" })).toBeNull();
		await userEvent.type(await box(), "Chào{Enter}");
		await waitFor(() => expect(sentTo(fixture, "Chào")).toEqual([chats.chat]), LONG);
	});
});

describe("sending to several apps", () => {
	it("asks once before the first send to two apps, then sends one message to each chat", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Xin chào" }]);
		remember(fixture, person, [chats.chat, chats.telegram], true);
		open(fixture, person);
		await userEvent.type(await box(), "Chào cả hai{Enter}");
		const dialog = await screen.findByRole("dialog", { name: "Gửi tới nhiều app" }, LONG);
		expect(dialog.textContent).toContain("Tin sẽ được gửi riêng tới Chat và Telegram");
		expect(within(dialog).getByRole("checkbox", { name: "Không hỏi lại" })).toHaveProperty("checked", true);
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi" }));
		await waitFor(() => expect(sentTo(fixture, "Chào cả hai").sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		// Each chat's message shows in the merged list with its app.
		await waitFor(async () => {
			const log = await screen.findByRole("log", { name: "Tin nhắn với Lan Anh" });
			const apps = [...log.querySelectorAll(".msg")].filter((row) => (row.textContent ?? "").includes("Chào cả hai")).map((row) => row.querySelector(".msg-app")?.textContent);
			expect(apps.sort()).toEqual(["Chat", "Telegram"]);
		}, LONG);

		await userEvent.type(await box(), "Lần hai{Enter}");
		await waitFor(() => expect(sentTo(fixture, "Lần hai")).toHaveLength(2), LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
		cleanup();

		// Never again, on any later visit (the outbox of this second page is not followed here, only what it was handed).
		const { calls } = open(fixture, person);
		await userEvent.type(await box(), "Lần ba{Enter}");
		await waitFor(() => expect(calls.text.map((call) => call.chatId).sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("sends nothing and keeps the text when the question is cancelled", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Xin chào" }]);
		remember(fixture, person, [chats.chat, chats.telegram], true);
		open(fixture, person);
		const field = await box();
		await userEvent.type(field, "Thôi đừng gửi{Enter}");
		const dialog = await screen.findByRole("dialog", { name: "Gửi tới nhiều app" }, LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
		await waitFor(() => expect(boxValue(field)).toBe("Thôi đừng gửi"), LONG);
		await waitFor(() => expect(document.querySelector(".toast")?.textContent ?? "").toContain("Đã huỷ, tin chưa được gửi"), LONG);
		expect(sentTo(fixture, "Thôi đừng gửi")).toEqual([]);
	});

	it("sends a file to each selected chat, each with its own upload", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Gửi mình file nhé" }]);
		fixture.enableMedia();
		remember(fixture, person, [chats.chat, chats.telegram]);
		const { calls } = open(fixture, person);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		const pdf = new File([new Uint8Array(3000)], "bao-cao.pdf", { type: "application/pdf" });
		fireEvent.change(screen.getByTestId("pick-files"), { target: { files: [pdf] } });
		await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		await userEvent.type(await box(), "Báo cáo{Enter}");
		await waitFor(() => expect(calls.media.map((call) => call.chatId).sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		expect(calls.media.every((call) => call.file === pdf)).toBe(true);
		// The composer's chat keeps the send's random_id; the other chat's outbox picks its own.
		expect(calls.media.filter((call) => call.randomId !== undefined)).toHaveLength(1);
		const log = await screen.findByRole("log", { name: "Tin nhắn với Lan Anh" });
		await waitFor(() => expect(within(log).getAllByRole("button", { name: "Tải xuống bao-cao.pdf" })).toHaveLength(2), LONG);
	});

	it("sends an album to each selected chat", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Ảnh đâu" }]);
		fixture.enableMedia();
		remember(fixture, person, [chats.chat, chats.telegram]);
		const { calls } = open(fixture, person);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		const files = [new File([new Uint8Array(3000)], "a.zip", { type: "application/zip" }), new File([new Uint8Array(4000)], "b.zip", { type: "application/zip" })];
		fireEvent.change(screen.getByTestId("pick-files"), { target: { files } });
		await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		await waitFor(() => expect(calls.album.map((call) => call.chatId).sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		const [first, second] = calls.album;
		expect(first?.items.map((item) => item.file)).toEqual(files);
		expect(second?.items.map((item) => item.file)).toEqual(files);
	});

	it("tells why a read-only chat got nothing while the other chats got the message", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Xin chào" }], "readOnly");
		remember(fixture, person, [chats.chat, chats.telegram, chats.zalo]);
		open(fixture, person);
		const group = await row();
		// The app's name as the bridge gives it until it has a name of its own.
		const zalo = await within(group).findByRole("button", { name: /zalo/i }, LONG);
		await waitFor(() => expect(zalo.textContent).toContain("chỉ đọc"), LONG);
		expect(zalo.classList.contains("dim")).toBe(true);
		await userEvent.type(await box(), "Gửi hết{Enter}");
		await waitFor(() => expect(sentTo(fixture, "Gửi hết").sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		expect(await screen.findByText(/^zalo: không gửi được \(chỉ đọc\)$/i, {}, LONG)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /^Ẩn thông báo zalo$/i }));
		expect(screen.queryByText(/không gửi được/)).toBeNull();
	});

	it("still sends to a chat whose account needs a login, saying the message waits", async () => {
		const { fixture, person, chats } = seed([{ chat: "zalo", text: "Xin chào" }], "twoWay");
		fixture.bridge.accounts = [
			{
				$typeName: "app.v1.BridgeAccount",
				id: 1n,
				source: "telegram",
				status: BridgeAccountStatus.NEEDS_LOGIN,
				syncState: BridgeSyncState.LIVE,
				lastError: "",
				chats: [
					{ $typeName: "app.v1.BridgeSyncedChat", conversationId: "user:7", chatId: BigInt(chats.telegram), caughtUp: true, historyWindow: 2000, title: "Lan Anh", direction: BridgeDirection.BOTH, topicsSplit: false },
				],
			},
		];
		remember(fixture, person, [chats.chat, chats.telegram, chats.zalo]);
		open(fixture, person);
		const group = await row();
		await waitFor(() => expect(within(group).getByRole("button", { name: /Telegram/ }).textContent).toContain("tài khoản cần đăng nhập lại"), LONG);
		await userEvent.type(await box(), "Chờ cũng được{Enter}");
		await waitFor(() => expect(sentTo(fixture, "Chờ cũng được").sort()).toEqual([chats.chat, chats.telegram, chats.zalo].sort()), LONG);
		expect(await screen.findByText("Telegram: tin đang chờ (tài khoản cần đăng nhập lại)", {}, LONG)).toBeTruthy();
	});

	it("offers a retry for a chat whose send failed, the other chat sent all the same", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Xin chào" }]);
		remember(fixture, person, [chats.chat, chats.telegram]);
		let failing = true;
		open(fixture, person, (chatId) => failing && chatId === chats.telegram);
		await userEvent.type(await box(), "Thử lần nữa{Enter}");
		const alert = await screen.findByRole("alert", {}, LONG);
		expect(alert.textContent).toContain("Telegram: lỗi, thử lại");
		await waitFor(() => expect(sentTo(fixture, "Thử lần nữa")).toEqual([chats.chat]), LONG);
		failing = false;
		await userEvent.click(within(alert).getByRole("button", { name: "Thử lại" }));
		await waitFor(() => expect(sentTo(fixture, "Thử lần nữa").sort()).toEqual([chats.chat, chats.telegram].sort()), LONG);
		await waitFor(() => expect(screen.queryByText("Telegram: lỗi, thử lại")).toBeNull(), LONG);
	});
});

describe("replying and editing", () => {
	it("replies only in the message's chat, with the typed text, and brings the row back", async () => {
		const { fixture, person, chats } = seed([
			{ chat: "chat", text: "Tin Chat" },
			{ chat: "telegram", text: "Hỏi qua Telegram" },
		]);
		remember(fixture, person, [chats.chat, chats.telegram]);
		open(fixture, person);
		const field = await box();
		await row();
		await userEvent.type(field, "Đang gõ dở");
		const seq = Number((await bubbleOf("Hỏi qua Telegram")).dataset.seq);
		await menuItem("Hỏi qua Telegram", "Trả lời");
		expect(await screen.findByText("Đang trả lời qua Telegram", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Gửi qua" })).toBeNull();
		const replyBox = await box();
		await waitFor(() => expect(boxValue(replyBox)).toBe("Đang gõ dở"), LONG);
		await userEvent.type(replyBox, " xong{Enter}");
		await waitFor(() => expect(fixture.sent.filter((sent) => sent.text === "Đang gõ dở xong")).toEqual([{ chatId: chats.telegram, text: "Đang gõ dở xong", replyToSeq: seq, topicId: 0 }]), LONG);
		// The row is back as it was.
		const group = await row();
		expect(pressed(group)).toEqual(["Chat", "Telegram"]);
		expect(screen.queryByText("Đang trả lời qua Telegram")).toBeNull();
	});

	it("keeps the typed text when a reply is cancelled, the row back as before", async () => {
		const { fixture, person, chats } = seed([{ chat: "telegram", text: "Hỏi qua Telegram" }]);
		remember(fixture, person, [chats.chat, chats.telegram]);
		open(fixture, person);
		await row();
		await userEvent.type(await box(), "Chưa xong");
		await menuItem("Hỏi qua Telegram", "Trả lời");
		await screen.findByText("Đang trả lời qua Telegram", {}, LONG);
		await userEvent.keyboard("{Escape}");
		const group = await row();
		expect(pressed(group)).toEqual(["Chat", "Telegram"]);
		await waitFor(async () => expect(boxValue(await box())).toBe("Chưa xong"), LONG);
	});

	it("edits a message in its own chat", async () => {
		const { fixture, person, chats } = seed([
			{ chat: "chat", text: "Tin Chat" },
			{ chat: "telegram", text: "Tin cũ của tôi", mine: true },
		]);
		remember(fixture, person, [chats.chat, chats.telegram]);
		const { calls } = open(fixture, person);
		await row();
		const seq = Number((await bubbleOf("Tin cũ của tôi")).dataset.seq);
		await menuItem("Tin cũ của tôi", "Sửa");
		expect(await screen.findByText("Đang sửa qua Telegram", {}, LONG)).toBeTruthy();
		const field = await box();
		await waitFor(() => expect(boxValue(field)).toBe("Tin cũ của tôi"), LONG);
		await userEvent.type(field, " đã sửa{Enter}");
		await waitFor(() => expect(calls.edits).toEqual([{ chatId: chats.telegram, seq, text: "Tin cũ của tôi đã sửa" }]), LONG);
		expect(calls.text).toEqual([]);
		await row();
	});
});
