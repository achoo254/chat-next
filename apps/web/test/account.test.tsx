// Settings > Tài khoản (mockups/settings.html#export-delete): the data
// export, the one line leading to the IdP's account page (the only place an
// account is deleted, ADR 0016), and how a deleted account shows to others.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { parseGetSelf } from "../src/api/get-self.ts";
import { matchRoute } from "../src/router.tsx";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

describe("account route and GetSelf", () => {
	it("routes the tab and reads the photo of GetSelf", () => {
		expect(matchRoute("/settings/account")).toEqual({ name: "settings", tab: "account" });
		const base = { user: { id: "42", username: "thang_dt", name: "Thắng" } };
		expect(parseGetSelf(base).photoId).toBeUndefined();
		expect(parseGetSelf({ user: { ...base.user, photo: { fileId: "AbC123", kind: "MEDIA_KIND_PHOTO" } } }).photoId).toBe("AbC123");
	});
});

describe("data export", () => {
	it("requests an export, shows its progress, then downloads it; once per 7 days", async () => {
		const fixture = new ChatFixture();
		const fake = fixture.privacy;
		renderMessaging(fixture, "/settings/account");
		const card = (await screen.findByRole("heading", { name: "Xuất dữ liệu cá nhân" }, LONG)).closest(".card") as HTMLElement;
		expect(within(card).getByText("Mỗi 7 ngày một lần.")).toBeTruthy();
		await userEvent.click(within(card).getByRole("button", { name: "Yêu cầu" }));
		await waitFor(() => expect(toastText()).toBe("Đã yêu cầu bản xuất, tiến độ hiện ở đây"));
		expect(fake.calls).toEqual(["RequestDataExport"]);
		expect(await within(card).findByText("Đang chờ tạo bản xuất…")).toBeTruthy();
		expect(within(card).getByRole("button", { name: "Yêu cầu" }).hasAttribute("disabled")).toBe(true);
		expect(within(card).getByText(/^Mỗi 7 ngày một lần\. Lần sau: /)).toBeTruthy();

		fake.advance(42);
		expect(await within(card).findByText("Đang tạo bản xuất… 42%", {}, LONG)).toBeTruthy();
		expect(within(card).getByRole("progressbar", { name: "Tiến độ bản xuất" }).getAttribute("value")).toBe("42");

		fake.advance("ready");
		const download = await within(card).findByRole("button", { name: "Tải xuống" }, LONG);
		expect(within(card).getByText("chat-export-ductrung-20261016.zip")).toBeTruthy();
		expect(within(card).getByText(/^248 MB · sẵn sàng · hết hạn \d{2}\/\d{2}\/\d{4}$/)).toBeTruthy();
		const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		await userEvent.click(download);
		await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
		const anchor = clicked.mock.contexts[0] as HTMLAnchorElement;
		expect(anchor.href).toBe("https://media.example.test/f/export/token-1");
		clicked.mockRestore();
		expect(fake.urls).toEqual([1]);
	});

	it("says when the server keeps no exports", async () => {
		const fixture = new ChatFixture();
		fixture.privacy.available = false;
		renderMessaging(fixture, "/settings/account");
		const card = (await screen.findByRole("heading", { name: "Xuất dữ liệu cá nhân" }, LONG)).closest(".card") as HTMLElement;
		expect(within(card).getByText("Máy chủ này chưa bật xuất dữ liệu.")).toBeTruthy();
		expect(within(card).getByRole("button", { name: "Yêu cầu" }).hasAttribute("disabled")).toBe(true);
	});
});

describe("deleting the account", () => {
	it("has no deletion of its own, only a link to the IdP's account page", async () => {
		const fixture = new ChatFixture();
		renderMessaging(fixture, "/settings/account");
		const link = await screen.findByRole("link", { name: /^Xoá tài khoản hoandat\.com ở auth\.hoandat\.com\/account/ }, LONG);
		expect(link.getAttribute("href")).toBe("https://auth.hoandat.com/account#account-delete");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(screen.getByText(/^Dữ liệu chat bị xoá cùng tài khoản hoandat\.com/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Xoá tài khoản/ })).toBeNull();
		expect(screen.queryByRole("group", { name: /Tự xoá/ })).toBeNull();
		expect(fixture.privacy.calls).toEqual([]);
	});
});

describe("a deleted account", () => {
	it("shows as Tài khoản đã xoá in the chat list", async () => {
		const fixture = new ChatFixture();
		const gone = fixture.addUser("", { username: "", deleted: true });
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, gone]);
		fixture.send(gone, chatId, "tin cũ");
		renderMessaging(fixture, "/");
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		expect(await within(list).findByText("Tài khoản đã xoá", {}, LONG)).toBeTruthy();
		// Opened: the history stays, the composer gives way to a note.
		await userEvent.click(within(list).getByRole("link", { name: /Tài khoản đã xoá/ }));
		expect((await screen.findAllByText("tin cũ", {}, LONG)).length).toBeGreaterThan(0);
		expect(await screen.findByText("Không nhắn tin được cho tài khoản đã xoá.", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: /^Tin nhắn tới / })).toBeNull();
	});
});
