// Reaction pills, Zalo placement (mockups/chat.html#rich-messages): the
// group floats over the bubble's bottom edge as its last child, faces in
// private chats and groups of at most 10 members ("+N" past three), the
// count elsewhere, your own reaction pressed, and the labels people hear.
import { ChatType } from "@achoo254/chat-proto/chats";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { pillContent, showsAvatars } from "../src/messaging/ui/reaction-pill.ts";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

describe("pill content", () => {
	it("shows faces in private chats and groups of up to 10, the count elsewhere", () => {
		const reaction = { count: 5, recentUserIds: [4, 5, 6] };
		expect(showsAvatars({ type: "private", memberCount: 2 })).toBe(true);
		expect(showsAvatars({ type: "group", memberCount: 10 })).toBe(true);
		expect(showsAvatars({ type: "group", memberCount: 11 })).toBe(false);
		expect(showsAvatars({ type: "channel", memberCount: 3 })).toBe(false);
		expect(pillContent({ type: "group", memberCount: 4 }, reaction)).toEqual({ kind: "avatars", ids: [4, 5, 6], more: 2 });
		expect(pillContent({ type: "group", memberCount: 12 }, reaction)).toEqual({ kind: "count", count: 5 });
		// The server sent no reactors (channels for non-admins): the count.
		expect(pillContent({ type: "private", memberCount: 2 }, { count: 2, recentUserIds: [] })).toEqual({ kind: "count", count: 2 });
	});
});

function messageOf(log: HTMLElement, text: string): HTMLElement {
	const message = within(log).getByText(text).closest<HTMLElement>(".msg");
	if (message === null) throw new Error(`no message ${text}`);
	return message;
}

describe("quick reaction bar", () => {
	it("reacts from the short row over the emoji button and takes the reaction back", async () => {
		const f = new ChatFixture();
		const lan = f.addUser("Lan Anh");
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, lan]);
		const seq = f.send(lan, chat, "Chiều nay review PR nhé?");
		renderMessaging(f, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("Chiều nay review PR nhé?", {}, LONG);
		const message = messageOf(log, "Chiều nay review PR nhé?");
		// The row loads once the pointer reaches the emoji button.
		expect(within(message).queryByRole("group", { name: "Thả nhanh cảm xúc" })).toBeNull();
		await userEvent.hover(within(message).getByRole("button", { name: "Thả cảm xúc" }));
		const bar = await within(message).findByRole("group", { name: "Thả nhanh cảm xúc" }, LONG);
		// It follows the emoji button, so the stylesheet shows it while that button is hovered.
		expect(bar.previousElementSibling?.classList.contains("msg-react")).toBe(true);
		expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual(["👍", "❤️", "😂", "😮", "🙏"]);
		await userEvent.click(within(bar).getByRole("button", { name: "Yêu thích" }));
		await within(log).findByRole("button", { name: "❤️ 1 người: bạn" }, LONG);
		const liked = within(messageOf(log, "Chiều nay review PR nhé?")).getByRole("button", { name: "Yêu thích" });
		expect(liked.getAttribute("aria-pressed")).toBe("true");
		// Your reaction again takes it back (an empty emoji to the server).
		await userEvent.click(liked);
		await waitFor(() => expect(f.reactions.at(-1)).toEqual({ chatId: chat, seq, emoji: "" }), LONG);
	});
});

describe("pills in the list", () => {
	it("floats faces on your short message in a private chat and toggles yours", async () => {
		const f = new ChatFixture();
		const lan = f.addUser("Lan Anh");
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, lan]);
		f.send(lan, chat, "Chiều nay review PR nhé?");
		const mine = f.send(f.selfId, chat, "c");
		f.react(lan, chat, mine, "❤️");
		renderMessaging(f, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const pill = await within(log).findByRole("button", { name: "❤️ 1 người: Lan Anh" }, LONG);
		const message = messageOf(log, "c");
		expect(message.classList.contains("mine")).toBe(true);
		// The group is the bubble's last child, so it floats over the bubble's bottom edge.
		const group = within(message).getByRole("group", { name: "Biểu cảm" });
		expect(group.parentElement?.classList.contains("bubble")).toBe(true);
		expect(group.parentElement?.lastElementChild).toBe(group);
		expect(pill.querySelectorAll(".r-avs .avatar")).toHaveLength(1);
		expect(pill.getAttribute("aria-pressed")).toBe("false");
		// The time stays on the text's line: reactions add no row inside the bubble.
		expect(message.querySelector(".bubble > p:last-of-type .stamp")).not.toBeNull();
		await userEvent.click(pill);
		await within(log).findByRole("button", { name: "❤️ 2 người: bạn, Lan Anh" }, LONG);
	});

	it("shows three faces and +N when more people reacted in a small group", async () => {
		const f = new ChatFixture();
		const people = ["Lan Anh", "Quang Huy", "Minh", "Thu Hà", "Bảo Ngọc"].map((name) => f.addUser(name));
		const group = f.createChat(ChatType.GROUP, "Nhóm nhỏ", [f.selfId, ...people]);
		const seq = f.send(people[0] ?? 0, group, "Ai đi ăn trưa?");
		for (const id of people) f.react(id, group, seq, "👍");
		renderMessaging(f, `/c/${group}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const pill = await within(log).findByRole("button", { name: "👍 5 người: Bảo Ngọc, Thu Hà, Minh và 2 người khác" }, LONG);
		expect(pill.querySelectorAll(".r-avs .avatar")).toHaveLength(3);
		expect(pill.textContent?.endsWith("+2")).toBe(true);
		expect(messageOf(log, "Ai đi ăn trưa?").classList.contains("mine")).toBe(false);
	});

	it("shows the count in a group of more than 10 and opens who reacted from the pill", async () => {
		const f = new ChatFixture();
		const people = Array.from({ length: 11 }, (_, index) => f.addUser(`Người ${index + 1}`));
		const group = f.createChat(ChatType.GROUP, "Nhóm lớn", [f.selfId, ...people]);
		const seq = f.send(people[0] ?? 0, group, "Họp lúc 3 giờ");
		f.react(people[1] ?? 0, group, seq, "👍");
		f.react(f.selfId, group, seq, "👍");
		renderMessaging(f, `/c/${group}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const pill = await within(log).findByRole("button", { name: "👍 2 người, gồm bạn" }, LONG);
		expect(pill.querySelector(".r-avs")).toBeNull();
		expect(pill.textContent).toBe("👍2");
		expect(pill.getAttribute("aria-pressed")).toBe("true");
		fireEvent.contextMenu(pill);
		expect(await screen.findByRole("dialog", { name: "Ai đã thả cảm xúc" }, LONG)).toBeTruthy();
	});
});
