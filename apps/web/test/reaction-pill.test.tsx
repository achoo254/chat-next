// Reaction pills, Zalo placement (mockups/chat.html#rich-messages): the
// group floats over the bubble's bottom edge as its last child, faces in
// private chats and groups of at most 10 members ("+N" past three), the
// count elsewhere, your own reaction pressed, and the labels people hear.
import { ChatType } from "@achoo254/chat-proto/chats";
import { fireEvent, screen, within } from "@testing-library/react";
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
