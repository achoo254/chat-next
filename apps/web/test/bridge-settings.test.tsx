// Settings > Kết nối ứng dụng (Chat Bridge): the sign-in steps, picking
// conversations with a history window, the progress of what is synced, and
// disconnecting. The server is a fake BridgeService.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { matchRoute } from "../src/router.tsx";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

async function openPage(fixture: ChatFixture): Promise<HTMLElement> {
	renderMessaging(fixture, "/settings/bridge");
	const card = (await screen.findByRole("heading", { name: "Ứng dụng có thể kết nối" }, LONG)).closest(".card") as HTMLElement;
	return card;
}

async function signIn(): Promise<void> {
	await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
	await userEvent.type(await screen.findByLabelText(/Số điện thoại/, {}, LONG), "+84900000000");
	await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
	await userEvent.type(await screen.findByLabelText(/Mã đăng nhập/, {}, LONG), "12345");
	await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
	await userEvent.type(await screen.findByLabelText(/Mật khẩu xác minh hai bước/, {}, LONG), "secret");
	await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
}

describe("route", () => {
	it("is a settings tab", () => {
		expect(matchRoute("/settings/bridge")).toEqual({ name: "settings", tab: "bridge" });
	});
});

describe("connecting an app", () => {
	it("signs in with phone, code and two-step password, then lists the account", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		expect(await screen.findByText("Đang kết nối", {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls).toEqual(["start:telegram", "continue:phone", "continue:code", "continue:password"]);
	});

	it("says a wrong code is wrong and keeps the step open", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
		await userEvent.type(await screen.findByLabelText(/Số điện thoại/, {}, LONG), "+84900000000");
		await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
		await userEvent.type(await screen.findByLabelText(/Mã đăng nhập/, {}, LONG), "00000");
		await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
		expect(await screen.findByText("Mã chưa đúng. Nhập lại.", {}, LONG)).toBeTruthy();
		expect(screen.getByLabelText(/Mã đăng nhập/)).toBeTruthy();
	});

	it("offers a way back when the sign-in is too old", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.reauth = true;
		await openPage(fixture);
		await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
		const link = await screen.findByRole("link", { name: "Đăng nhập lại" }, LONG);
		expect(link.getAttribute("href")).toContain("reauth");
	});

	it("says so when the server has the bridge off", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.disabled = true;
		renderMessaging(fixture, "/settings/bridge");
		expect(await screen.findByText("Máy chủ này chưa bật tính năng kết nối ứng dụng.", {}, LONG)).toBeTruthy();
	});
});

describe("choosing conversations", () => {
	it("syncs one with a chosen history window, says it is read-only, and removes it", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		const row = within(picker).getByText("Anh Đô CEO").closest(".row") as HTMLElement;
		await userEvent.click(within(row).getByRole("button", { name: "Đồng bộ" }));
		expect(screen.getByText(/không đổi được: Chat không tải thêm được lịch sử cũ hơn/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "500" }));
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("enable:user:7:500"));
		const synced = (await screen.findByText("500 tin gần nhất · Đã nhập xong, tin mới về trực tiếp", { exact: false }, LONG)).closest(".row") as HTMLElement;
		expect(within(synced).getByText("Anh Đô CEO")).toBeTruthy();
		expect(screen.getByText(/chỉ để đọc: bạn không gửi tin vào đó được/)).toBeTruthy();
		await userEvent.click(within(synced).getByRole("button", { name: "Xoá bản sao" }));
		await userEvent.click(within(synced).getByRole("button", { name: "Xoá" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("remove:user:7"));
	});
});

describe("disconnecting", () => {
	it("keeps the chats read-only or deletes them, as the user chooses", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Ngắt kết nối" }, LONG));
		await userEvent.click(screen.getByRole("button", { name: "Xoá hết chat và liên hệ đã nhập" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("disconnect:true"));
		expect(await screen.findByRole("heading", { name: "Ứng dụng có thể kết nối" }, LONG)).toBeTruthy();
	});
});
