// Links, e-mails, @mentions and #hashtags in message text: detected on
// messages stored without entities (the same rules as the server), shown
// as controls, and what tapping each one does.
import { ChatType } from "@achoo254/chat-proto/chats";
import { EntityType } from "@achoo254/chat-proto/messages";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entity } from "./support/demo-data.ts";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const TEXT = "🎬 Hỏi @minh_nv hoặc @khong_ai_ca về #ĐàLạt, xem hoandat.com/abc hay gửi an@hoandat.vn";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

/** A group where Minh posted TEXT as plain text (no entities), opened; `more` posts more first. */
async function openChat(more: (fixture: ChatFixture, from: number, chat: number) => void = () => undefined) {
	const fixture = new ChatFixture();
	const minh = fixture.addUser("Minh Nguyễn", { username: "minh_nv" });
	const chat = fixture.createChat(ChatType.GROUP, "Nhóm du lịch", [fixture.selfId, minh]);
	more(fixture, minh, chat);
	fixture.send(minh, chat, TEXT);
	renderMessaging(fixture, `/c/${chat}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByRole("button", { name: "@minh_nv" }, LONG);
	return { log };
}

describe("detected entities", () => {
	it("shows the link, mention, hashtag and e-mail of a plain message", async () => {
		const { log } = await openChat();
		const link = within(log).getByRole("link", { name: "hoandat.com/abc" });
		expect(link.getAttribute("href")).toBe("https://hoandat.com/abc");
		expect(within(log).getByRole("button", { name: "@minh_nv" }).className).toContain("mention");
		expect(within(log).getByRole("button", { name: "#ĐàLạt" }).className).toContain("hashtag");
		expect(within(log).getByRole("button", { name: "an@hoandat.vn" }).getAttribute("aria-haspopup")).toBe("menu");
		// The text around them is unchanged.
		expect(log.querySelector(".bubble p")?.textContent).toContain(TEXT);
	});

	it("opens the profile of a mentioned user and says when a username is unknown", async () => {
		const { log } = await openChat();
		await userEvent.click(within(log).getByRole("button", { name: "@minh_nv" }));
		expect(await screen.findByRole("dialog", { name: "Thông tin · Minh Nguyễn" }, LONG)).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), LONG);

		await userEvent.click(within(log).getByRole("button", { name: "@khong_ai_ca" }));
		await waitFor(() => expect(toastText()).toContain("Không tìm thấy @khong_ai_ca"), LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("searches the chat for a tapped hashtag", async () => {
		const { log } = await openChat();
		await userEvent.click(within(log).getByRole("button", { name: "#ĐàLạt" }));
		const box = await screen.findByRole("searchbox", { name: "Tìm trong Nhóm du lịch" }, LONG);
		expect((box as HTMLInputElement).value).toBe("#ĐàLạt");
	});

	it("offers to copy an e-mail address or write to it, instead of opening mail at once", async () => {
		const written: string[] = [];
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
		const opened = vi.spyOn(window, "open").mockReturnValue(null);
		const { log } = await openChat();
		const address = within(log).getByRole("button", { name: "an@hoandat.vn" });

		await userEvent.click(address);
		expect(await screen.findByRole("menu", { name: "Email an@hoandat.vn" })).toBeTruthy();
		expect(address.getAttribute("aria-expanded")).toBe("true");
		expect(opened).not.toHaveBeenCalled();
		// Pressing the address again closes the menu instead of reopening it.
		await userEvent.click(address);
		expect(screen.queryByRole("menu")).toBeNull();
		await userEvent.click(address);
		let menu = await screen.findByRole("menu", { name: "Email an@hoandat.vn" });
		// Focus starts on the first item; Esc closes the menu and returns to the address.
		expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Sao chép" }));
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(address);

		await userEvent.click(address);
		menu = await screen.findByRole("menu", { name: "Email an@hoandat.vn" });
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Sao chép" }));
		await waitFor(() => expect(toastText()).toContain("Đã sao chép email"), LONG);
		expect(written).toEqual(["an@hoandat.vn"]);
		expect(screen.queryByRole("menu")).toBeNull();

		// "Gửi mail" is a plain mailto: link, as mail links are everywhere in the app.
		await userEvent.click(address);
		menu = await screen.findByRole("menu", { name: "Email an@hoandat.vn" });
		const send = within(menu).getByRole("menuitem", { name: "Gửi mail" });
		expect(send.getAttribute("href")).toBe("mailto:an@hoandat.vn");
		const stayHere = (event: Event) => event.preventDefault();
		document.addEventListener("click", stayHere, { capture: true, once: true });
		await userEvent.click(send);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(opened).not.toHaveBeenCalled();
	});

	it("never nests a control in a link, and keeps a hidden spoiler's links out of reach", async () => {
		const linked = "Hỏi @minh_nv nhé";
		const hidden = "Bí mật #ĐàLạt";
		const { log } = await openChat((fixture, from, chat) => {
			// A sender may nest a mention in a link; it shows as a mention but is no button inside the link.
			fixture.send(from, chat, linked, {
				entities: [entity(EntityType.TEXT_LINK, linked, linked, { url: "https://hoandat.com/x" }), entity(EntityType.MENTION, linked, "@minh_nv")],
			});
			fixture.send(from, chat, hidden, { entities: [entity(EntityType.SPOILER, hidden, hidden)] });
		});
		const link = await within(log).findByRole("link", { name: linked }, LONG);
		expect(link.querySelector("button")).toBeNull();
		expect(link.querySelector(".mention")?.textContent).toBe("@minh_nv");
		const spoiler = within(log).getByRole("button", { name: "Nội dung ẩn, bấm để hiện" });
		expect(spoiler.querySelector("[inert]")?.textContent).toBe(hidden);
		await userEvent.click(spoiler);
		// Revealed, its hashtag works like any other.
		await waitFor(() => expect(log.querySelector(".spoiler.revealed button.hashtag")?.textContent).toBe("#ĐàLạt"));
	});
});
