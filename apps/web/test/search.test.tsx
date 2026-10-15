// Message search (release R4, mockups/search.html): local hits at once, the
// server's merged in after a pause, filters, failures and the in-chat bar.
import { Code } from "@connectrpc/connect";
import { ChatType } from "@app/proto-ts/chats";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => {
	window.localStorage.clear();
});

/**
 * A group whose older messages are not on the device (only each chat's
 * newest message is synced until the chat is opened) and a private chat.
 */
function seed() {
	const f = new ChatFixture();
	const lan = f.addUser("Lan Anh", { username: "lananh" });
	const minh = f.addUser("Minh", { username: "minh" });
	const design = f.createChat(ChatType.GROUP, "Thiết kế", [f.selfId, lan, minh]);
	f.send(lan, design, "Gửi bộ thiết kế icon, đẹp và nhẹ hơn bản cũ");
	f.send(minh, design, "Đôi dép thiết kế lạ quá");
	for (let i = 1; i <= 3; i++) f.send(minh, design, `Tin thường số ${i}`);
	const lanChat = f.createChat(ChatType.PRIVATE, "", [f.selfId, lan]);
	f.send(lan, lanChat, "Mình gửi file thiết kế rồi nhé");
	return { f, lan, minh, design, lanChat };
}

async function openSearch(f: ChatFixture): Promise<HTMLInputElement> {
	renderMessaging(f);
	await within(await screen.findByRole("list", { name: "Danh sách chat" }, LONG)).findByText("Thiết kế", {}, LONG);
	return screen.getByRole("searchbox", { name: "Tìm chat và tin nhắn" });
}

function messageHits(): HTMLElement {
	return screen.getByRole("list", { name: "Kết quả tìm kiếm" });
}

describe("global search", () => {
	it("shows device hits at once, then merges the server's without moving them", async () => {
		const { f } = seed();
		const box = await openSearch(f);
		await userEvent.type(box, "thiet ke");

		// The device has only the private chat's message; the server adds the group's older ones.
		await screen.findByText("Kết quả trong máy · đang lấy thêm từ server…", {}, LONG);
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);
		const hits = within(messageHits()).getAllByRole("button");
		expect(hits[0]?.textContent).toContain("Mình gửi file thiết kế rồi nhé");
		expect(hits[0]?.textContent).not.toContain("từ server");
		expect(hits.slice(1).map((hit) => hit.textContent)).toEqual([
			expect.stringContaining("Đôi dép thiết kế lạ quá"),
			expect.stringContaining("Gửi bộ thiết kế icon"),
		]);
		expect(hits.slice(1).every((hit) => hit.textContent?.includes("từ server"))).toBe(true);
		// Accent-insensitive highlight on the original text.
		expect([...messageHits().querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(expect.arrayContaining(["thiết", "kế"]));
		// The server was asked once, after the pause.
		expect(f.searchRequests.filter((r) => r.chatId === 0).map((r) => r.query)).toEqual(["thiet ke"]);
	});

	it("keeps device hits when the server fails and merges after Thử lại", async () => {
		const { f } = seed();
		f.searchFailure = Code.Unavailable;
		const box = await openSearch(f);
		await userEvent.type(box, "thiet ke");

		const banner = await screen.findByRole("alert", {}, LONG);
		expect(banner.textContent).toContain("Không lấy được kết quả từ server.");
		expect(screen.getByText("Đang hiện kết quả trong máy. Có thể còn tin cũ hơn trên server.")).toBeTruthy();
		expect(within(messageHits()).getAllByRole("button")).toHaveLength(1);

		f.searchFailure = null;
		await userEvent.click(within(banner).getByRole("button", { name: "Thử lại" }));
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("filters by type and sender, and offers to remove a filter when nothing matches", async () => {
		const { f } = seed();
		const box = await openSearch(f);
		await userEvent.type(box, "thiet ke");
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Loại" }));
		const types = await screen.findByRole("dialog", { name: "Loại" });
		await userEvent.click(within(types).getByRole("button", { name: "File" }));
		expect(screen.queryByRole("dialog", { name: "Loại" })).toBeNull();
		const empty = (await screen.findByText("Không có kết quả cho “thiet ke”", {}, LONG)).closest(".empty");
		if (!(empty instanceof HTMLElement)) throw new Error("no empty state");
		// Contacts and groups are hidden while a filter is on.
		expect(screen.queryByRole("heading", { name: "Nhóm và kênh" })).toBeNull();
		await userEvent.click(within(empty).getByRole("button", { name: "Bỏ lọc loại File" }));
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Người gửi" }));
		const senders = await screen.findByRole("dialog", { name: "Người gửi" });
		await userEvent.click(await within(senders).findByRole("button", { name: "Lan Anh" }, LONG));
		expect(screen.getByRole("button", { name: "Bỏ lọc người gửi Lan Anh" })).toBeTruthy();
		await waitFor(() => expect(within(messageHits()).getAllByRole("button")).toHaveLength(2), LONG);
		expect(within(messageHits()).queryByText(/Đôi dép/)).toBeNull();
	});

	it("filters by a date range picked in the calendar", async () => {
		const { f } = seed();
		const box = await openSearch(f);
		await userEvent.type(box, "thiet ke");
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Ngày" }));
		const picker = await screen.findByRole("dialog", { name: "Chọn khoảng ngày" });
		expect(within(picker).getByRole("button", { name: "Áp dụng" }).hasAttribute("disabled")).toBe(true);
		await userEvent.click(within(picker).getByRole("button", { name: "7 ngày" }));
		await userEvent.click(within(picker).getByRole("button", { name: "Áp dụng" }));
		expect(screen.getByRole("button", { name: "Bỏ lọc ngày" })).toBeTruthy();
		// Today's messages are inside the range.
		await screen.findByText("Đã gộp kết quả từ server · 3 tin", {}, LONG);
	});

	it("moves through results with the arrow keys and opens one with Enter", async () => {
		const { f, design } = seed();
		const box = await openSearch(f);
		await userEvent.type(box, "thiet ke");
		await screen.findByRole("heading", { name: "Nhóm và kênh" }, LONG);
		fireEvent.keyDown(box, { key: "ArrowDown" });
		await waitFor(() => expect(document.querySelector('.hit[aria-current="true"]')?.textContent).toContain("Thiết kế"));
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${design}`), LONG);
	});
});

describe("search in a chat", () => {
	it("steps through hits newest first, loading history around each, and closes with Esc", async () => {
		const { f, design } = seed();
		renderMessaging(f, `/c/${design}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("Tin thường số 3", {}, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Tìm trong chat" }));
		const box = await screen.findByRole("searchbox", { name: "Tìm trong Thiết kế" }, LONG);
		expect(document.activeElement).toBe(box);
		await userEvent.type(box, "thiet ke");
		await screen.findByText("1/2", {}, LONG);
		await waitFor(() => expect(f.searchRequests.some((r) => r.chatId === design && r.query === "thiet ke")).toBe(true), LONG);

		await userEvent.keyboard("{Enter}");
		await screen.findByText("2/2", {}, LONG);
		await within(log).findByText("Gửi bộ thiết kế icon, đẹp và nhẹ hơn bản cũ", {}, LONG);
		expect(screen.getByRole("button", { name: "Kết quả cũ hơn (Enter)" }).hasAttribute("disabled")).toBe(true);
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await screen.findByText("1/2", {}, LONG);

		// Only one sender's messages.
		await userEvent.click(screen.getByRole("button", { name: "Lọc theo người gửi" }));
		const senders = await screen.findByRole("dialog", { name: "Người gửi" });
		await userEvent.click(await within(senders).findByRole("button", { name: "Lan Anh" }, LONG));
		await screen.findByText("1/1", {}, LONG);

		await userEvent.click(box);
		await userEvent.keyboard("{Escape}");
		expect(await screen.findByRole("button", { name: "Tìm trong chat" })).toBeTruthy();
	});

	it("says when nothing matches", async () => {
		const { f, design } = seed();
		renderMessaging(f, `/c/${design}`);
		await within(await screen.findByRole("log", { name: "Tin nhắn" }, LONG)).findByText("Tin thường số 3", {}, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Tìm trong chat" }));
		await userEvent.type(await screen.findByRole("searchbox", { name: "Tìm trong Thiết kế" }, LONG), "khongcotu");
		await screen.findByText("Không có kết quả", {}, LONG);
		expect(screen.getByRole("button", { name: "Kết quả mới hơn (Shift+Enter)" }).hasAttribute("disabled")).toBe(true);
	});
});
