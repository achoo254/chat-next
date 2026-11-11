// The compact window on the real client core: the button shows only where the
// browser has Document Picture-in-Picture; the window draws the open chat and
// a strip of unread chats; picking one moves the page's route.
import { ChatType } from "@achoo254/chat-proto/chats";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactWindow } from "../src/compact/compact-window-store.ts";
import { playTone } from "../src/messaging/data/sound.ts";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

vi.mock("../src/messaging/data/sound.ts", () => ({ playTone: vi.fn() }));

const LONG = { timeout: 8000 };
const OPEN_BUTTON = "Mở cửa sổ nhỏ luôn nổi";

/**
 * A picture-in-picture window with its own document and window: a real iframe
 * window, so queries and observers work in it. `close` fires the page-hide the
 * browser fires when the window goes.
 */
function installPictureInPicture(): { readonly document: Document; readonly close: () => void } {
	const frame = document.createElement("iframe");
	document.body.append(frame);
	const pip = frame.contentWindow;
	if (pip === null) throw new Error("no iframe window");
	Object.defineProperty(pip.document, "visibilityState", { get: () => "visible", configurable: true });
	const close = (): void => {
		pip.dispatchEvent(new Event("pagehide"));
	};
	Object.defineProperty(pip, "close", { value: close, configurable: true });
	Object.defineProperty(window, "documentPictureInPicture", {
		value: { requestWindow: vi.fn(async () => pip) },
		configurable: true,
	});
	frames.push(frame);
	return { document: pip.document, close };
}

const frames: HTMLIFrameElement[] = [];

/** The page's own message log, once it shows `text`. */
async function pageLog(text: string): Promise<HTMLElement> {
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText(text, {}, LONG);
	return log;
}

function twoChats(): { fixture: ChatFixture; open: number; other: number; ngan: number } {
	const fixture = new ChatFixture();
	const ngan = fixture.addUser("Ngân");
	const lan = fixture.addUser("Lan Anh");
	const open = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
	const other = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	fixture.send(ngan, open, "Tin của Ngân");
	fixture.send(lan, other, "Tin của Lan Anh");
	return { fixture, open, other, ngan };
}

/** The page goes behind another window (its tab is in the background). */
function hidePage(): void {
	Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

function readInbox(fixture: ChatFixture, chatId: number): number {
	return Number(fixture.server.dialog(chatId, fixture.selfId).readInboxMaxSeq);
}

async function openCompact(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
	await waitFor(() => expect(compactWindow.get()).not.toBeNull());
}

afterEach(() => {
	Reflect.deleteProperty(document, "visibilityState");
	vi.mocked(playTone).mockClear();
	compactWindow.close();
	for (const frame of frames.splice(0)) frame.remove();
	Reflect.deleteProperty(window, "documentPictureInPicture");
	window.localStorage.clear();
});

describe("compact window", () => {
	it("has no button where the browser lacks Document Picture-in-Picture", async () => {
		const { fixture, open } = twoChats();
		renderMessaging(fixture, `/c/${open}`);
		await pageLog("Tin của Ngân");
		expect(screen.queryByRole("button", { name: OPEN_BUTTON })).toBeNull();
	});

	it("opens with the open chat, a strip of unread chats, and no back or info buttons", async () => {
		const { fixture, open } = twoChats();
		const pip = installPictureInPicture();
		renderMessaging(fixture, `/c/${open}`);
		await pageLog("Tin của Ngân");

		fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
		await waitFor(() => expect(compactWindow.get()).not.toBeNull());

		const body = within(pip.document.body);
		const log = await body.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("Tin của Ngân", {}, LONG);
		const strip = body.getByRole("navigation", { name: "Chat chưa đọc" });
		expect(within(strip).getByRole("button", { name: /Lan Anh/ })).toBeTruthy();
		expect(body.queryByRole("button", { name: "Về danh sách chat" })).toBeNull();
		expect(body.queryByRole("button", { name: "Thông tin chat" })).toBeNull();
		expect(body.queryByRole("button", { name: OPEN_BUTTON })).toBeNull();
	});

	it("moves the page to the chat picked in the strip", async () => {
		const { fixture, open, other } = twoChats();
		const pip = installPictureInPicture();
		renderMessaging(fixture, `/c/${open}`);
		await pageLog("Tin của Ngân");
		fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
		await waitFor(() => expect(compactWindow.get()).not.toBeNull());

		const body = within(pip.document.body);
		const strip = await body.findByRole("navigation", { name: "Chat chưa đọc" }, LONG);
		fireEvent.click(within(strip).getByRole("button", { name: /Lan Anh/ }));

		await waitFor(() => expect(window.location.pathname).toBe(`/c/${other}`));
		const log = await body.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("Tin của Lan Anh", {}, LONG);
	});

	it("draws nothing once the window is closed", async () => {
		const { fixture, open } = twoChats();
		const pip = installPictureInPicture();
		renderMessaging(fixture, `/c/${open}`);
		await pageLog("Tin của Ngân");
		fireEvent.click(screen.getByRole("button", { name: OPEN_BUTTON }));
		await waitFor(() => expect(compactWindow.get()).not.toBeNull());
		await within(pip.document.body).findByRole("log", { name: "Tin nhắn" }, LONG);

		pip.close();
		await waitFor(() => expect(compactWindow.get()).toBeNull());
		await waitFor(() => expect(pip.document.body.querySelector(".compact")).toBeNull());
	});

	describe("while the page is hidden behind it", () => {
		it("marks a new message read when the window shows the chat", async () => {
			const { fixture, open, ngan } = twoChats();
			const pip = installPictureInPicture();
			renderMessaging(fixture, `/c/${open}`);
			await pageLog("Tin của Ngân");
			await openCompact();
			const compactLog = await within(pip.document.body).findByRole("log", { name: "Tin nhắn" }, LONG);
			await waitFor(() => expect(readInbox(fixture, open)).toBe(1), LONG);

			hidePage();
			fixture.send(ngan, open, "Tin mới khi trang chính ẩn");
			await within(compactLog).findByText("Tin mới khi trang chính ẩn", {}, LONG);
			await waitFor(() => expect(readInbox(fixture, open)).toBe(2), LONG);
		});

		it("leaves a new message unread when nothing shows the chat", async () => {
			const { fixture, open, ngan } = twoChats();
			renderMessaging(fixture, `/c/${open}`);
			const log = await pageLog("Tin của Ngân");
			await waitFor(() => expect(readInbox(fixture, open)).toBe(1), LONG);

			hidePage();
			fixture.send(ngan, open, "Tin mới khi không ai xem");
			await within(log).findByText("Tin mới khi không ai xem", {}, LONG);
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(readInbox(fixture, open)).toBe(1);
		});

		it("plays the tone once, from the window, and not from the page", async () => {
			const { fixture, open, ngan } = twoChats();
			window.localStorage.setItem(`chat:sound-in-chat:${fixture.selfId}`, "1");
			const pip = installPictureInPicture();
			renderMessaging(fixture, `/c/${open}`);
			await pageLog("Tin của Ngân");
			await openCompact();
			const compactLog = await within(pip.document.body).findByRole("log", { name: "Tin nhắn" }, LONG);
			await within(compactLog).findByText("Tin của Ngân", {}, LONG);

			hidePage();
			fixture.send(ngan, open, "Tin có âm báo");
			await within(compactLog).findByText("Tin có âm báo", {}, LONG);
			await waitFor(() => expect(playTone).toHaveBeenCalledTimes(1), LONG);
		});
	});

	it("plays the tone once, from the page, when the page and the window are both shown", async () => {
		const { fixture, open, ngan } = twoChats();
		window.localStorage.setItem(`chat:sound-in-chat:${fixture.selfId}`, "1");
		const pip = installPictureInPicture();
		renderMessaging(fixture, `/c/${open}`);
		const log = await pageLog("Tin của Ngân");
		await openCompact();
		const compactLog = await within(pip.document.body).findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(compactLog).findByText("Tin của Ngân", {}, LONG);

		fixture.send(ngan, open, "Tin cho cả hai cửa sổ");
		await within(log).findByText("Tin cho cả hai cửa sổ", {}, LONG);
		await within(compactLog).findByText("Tin cho cả hai cửa sổ", {}, LONG);
		await waitFor(() => expect(playTone).toHaveBeenCalledTimes(1), LONG);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(playTone).toHaveBeenCalledTimes(1);
	});
});
