// Settings > Tài khoản (mockups/settings.html#export-delete): the data
// export, auto-delete, deleting the chat account with the reauth round trip
// and the typed confirmation; the screen shown while the account waits for
// deletion; and how a deleted account shows to others.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { PrivacyService } from "@app/proto-ts/privacy";
import { AccountDeletionReason, UsersService } from "@app/proto-ts/users";
import { parseGetSelf } from "../src/api/get-self.ts";
import { matchRoute } from "../src/router.tsx";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderApp, SELF } from "./render-app.tsx";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

describe("account route and GetSelf", () => {
	it("routes the tab and reads the deletion of GetSelf", () => {
		expect(matchRoute("/settings/account")).toEqual({ name: "settings", tab: "account" });
		const base = { user: { id: "42", username: "thang_dt", name: "Thắng" } };
		expect(parseGetSelf(base).deletion).toBeUndefined();
		expect(parseGetSelf({ ...base, deletion: { purgeAt: "1800000000", reason: "ACCOUNT_DELETION_REASON_INACTIVE" } }).deletion).toEqual({
			purgeAt: 1_800_000_000,
			reason: "inactive",
		});
		expect(parseGetSelf({ ...base, deletion: { purgeAt: "1800000000", reason: "ACCOUNT_DELETION_REASON_USER" } }).deletion?.reason).toBe("user");
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

describe("auto-delete", () => {
	it("saves the chosen period", async () => {
		const fixture = new ChatFixture();
		renderMessaging(fixture, "/settings/account");
		const choice = await screen.findByRole("group", { name: "Tự xoá tài khoản chat nếu không dùng" }, LONG);
		expect(within(choice).getByRole("button", { name: "Tắt" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(within(choice).getByRole("button", { name: "12 tháng" }));
		await waitFor(() => expect(toastText()).toBe("Đã lưu cài đặt tự xoá"));
		expect(fixture.privacy.calls).toEqual(["SetAutoDelete 12"]);
		expect(within(choice).getByRole("button", { name: "12 tháng" }).getAttribute("aria-pressed")).toBe("true");
	});
});

describe("deleting the chat account", () => {
	it("is blocked while the user owns a group or channel, with links to them", async () => {
		const fixture = new ChatFixture();
		fixture.privacy.ownedChats = [
			{ chatId: 501, title: "Trực sự cố", isChannel: false, memberCount: 12 },
			{ chatId: 502, title: "Thông báo vận hành", isChannel: true, memberCount: 48 },
		];
		fixture.privacy.bots = [{ botId: 9, name: "Deploy Bot", username: "deploy_bot" }];
		renderMessaging(fixture, "/settings/account");
		expect(await screen.findByText("Bạn đang là chủ sở hữu 2 nhóm và kênh. Chuyển quyền sở hữu hoặc xoá chúng trước.", {}, LONG)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Mở nhóm" }).getAttribute("href")).toBe("/c/501/admin");
		expect(screen.getByRole("link", { name: "Mở kênh" }).getAttribute("href")).toBe("/c/502/admin");
		expect(screen.getByText(/^1 bot của bạn \(Deploy Bot\) ngừng chạy ngay/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Xoá tài khoản chat" }).hasAttribute("disabled")).toBe(true);
	});

	it("asks for a fresh sign-in first, then confirms once with the typed username and signs out", async () => {
		const fixture = new ChatFixture();
		const fake = fixture.privacy;
		fake.signedInAt = Math.floor(Date.now() / 1000) - 3600;
		const { unmount } = renderMessaging(fixture, "/settings/account");
		await userEvent.click(await screen.findByRole("button", { name: "Xoá tài khoản chat" }, LONG));
		const reauth = await screen.findByRole("dialog", { name: "Đăng nhập lại để tiếp tục" });
		expect(within(reauth).getByText("Xoá tài khoản chat cần đăng nhập trong 10 phút gần đây.")).toBeTruthy();
		expect(within(reauth).getByRole("link", { name: "Đăng nhập lại" }).getAttribute("href")).toBe(
			"/auth/login?reauth=1&locale=vi&return_to=%2Fsettings%2Faccount%3Fafter%3Ddelete",
		);
		expect(fake.calls).toEqual([]);
		unmount();

		// Back from the IdP: the confirmation opens once; nothing is deleted without its button.
		fake.signedInAt = Math.floor(Date.now() / 1000) - 30;
		renderMessaging(fixture, "/settings/account?after=delete");
		const dialog = await screen.findByRole("dialog", { name: "Xoá tài khoản chat?" }, LONG);
		await waitFor(() => expect(window.location.search).toBe(""));
		expect(within(dialog).getByText(/^Đã xác nhận lại ở .+ lúc \d{2}:\d{2}$/)).toBeTruthy();
		expect(fake.calls).toEqual([]);
		const submit = within(dialog).getByRole("button", { name: "Xoá tài khoản" });
		expect(submit.hasAttribute("disabled")).toBe(true);
		const field = within(dialog).getByRole("textbox", { name: "Gõ ductrung để xác nhận" });
		await userEvent.type(field, "ductrun");
		expect(submit.hasAttribute("disabled")).toBe(true);
		await userEvent.type(field, "g");
		expect(submit.hasAttribute("disabled")).toBe(false);
		await userEvent.click(submit);
		await waitFor(() => expect(fake.calls).toEqual(["DeleteAccount ductrung"]));
		// Every session ended: this device forgets the account and signs out.
		await waitFor(() => expect(window.localStorage.getItem("app:last-self")).toBeNull());
		expect(fake.deletedAt).toBeGreaterThan(0);
	});
});

describe("while the account waits for deletion", () => {
	it("shows only the way back, and cancelling starts the app", async () => {
		let pending = true;
		const cancelled: string[] = [];
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => ({
					user: SELF,
					...(pending ? { deletion: { purgeAt: 1_800_000_000n, reason: AccountDeletionReason.INACTIVE } } : {}),
				}),
			});
			router.service(PrivacyService, {
				cancelAccountDeletion: () => {
					cancelled.push("cancel");
					pending = false;
					return { user: SELF };
				},
			});
		});
		expect(await screen.findByRole("heading", { name: "Tài khoản chat đang chờ xoá" }, LONG)).toBeTruthy();
		expect(screen.getByText(/lâu không được dùng nên đã được lên lịch xoá theo cài đặt Tự xoá/)).toBeTruthy();
		expect(screen.getByText(/15\/01\/2027/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Đăng xuất" }).closest("form")?.getAttribute("action")).toBe("/auth/logout");
		await userEvent.click(screen.getByRole("button", { name: "Huỷ xoá tài khoản" }));
		await waitFor(() => expect(cancelled).toEqual(["cancel"]));
		expect((await screen.findAllByRole("link", { name: "Cài đặt" }, LONG)).length).toBeGreaterThan(0);
		expect(screen.queryByRole("heading", { name: "Tài khoản chat đang chờ xoá" })).toBeNull();
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
