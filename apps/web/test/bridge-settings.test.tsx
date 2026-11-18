// Settings > Kết nối ứng dụng (Chat Bridge): the sign-in steps, picking
// conversations with a history window, the progress of what is synced, and
// disconnecting. The server is a fake BridgeService.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchRoute } from "../src/router.tsx";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

// A batch stopped by an old sign-in is kept in the tab's session storage: one test must not start another's.
beforeEach(() => window.sessionStorage.clear());

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
		// The banner is the only message: the card does not add a second, misleading error.
		expect(screen.queryByText("Chưa làm được, thử lại sau.")).toBeNull();
	});

	it("brings the sign-in banner into view when starting a sync is refused, far below the banner", async () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		const row = within(picker).getByText("Anh Đô CEO").closest("[data-id=bridge-conversation]") as HTMLElement;
		await userEvent.click(within(row).getByRole("checkbox"));
		fixture.bridge.reauth = true;
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		expect(await screen.findByRole("link", { name: "Đăng nhập lại" }, LONG)).toBeTruthy();
		await waitFor(() => expect(scrolled).toHaveBeenCalled());
		expect(fixture.bridge.calls.some((c) => c.startsWith("enable:"))).toBe(false);
	});

	it("says so when the server has the bridge off", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.disabled = true;
		renderMessaging(fixture, "/settings/bridge");
		expect(await screen.findByText("Máy chủ này chưa bật tính năng kết nối ứng dụng.", {}, LONG)).toBeTruthy();
	});
});

describe("choosing conversations", () => {
	it("syncs one with a chosen history window, sending both ways by default, and removes it", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		const row = within(picker).getByText("Anh Đô CEO").closest("[data-id=bridge-conversation]") as HTMLElement;
		await userEvent.click(within(row).getByRole("checkbox"));
		expect(screen.getByText(/không đổi được: Chat không tải thêm được lịch sử cũ hơn/)).toBeTruthy();
		// Sending from Chat is on for a new chat, and says what it means.
		expect((screen.getByRole("checkbox", { name: "Gửi tin từ Chat sang Telegram" }) as HTMLInputElement).checked).toBe(true);
		expect(screen.getByText(/Tin bạn gõ trong các chat này cũng được gửi sang ứng dụng kia/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "500" }));
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("enable:user:7:500:BOTH"));
		const synced = (await screen.findByText("500 tin gần nhất", { exact: false }, LONG)).closest("[data-id=bridge-chat]") as HTMLElement;
		expect(within(synced).getByText("Anh Đô CEO")).toBeTruthy();
		expect(within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ }).getAttribute("aria-checked")).toBe("true");
		// Every chat sends on, so there is nothing to warn about being read-only.
		expect(screen.queryByText(/chỉ để đọc: bạn không gửi tin vào đó được/)).toBeNull();
		await userEvent.click(within(synced).getByRole("button", { name: "Xoá bản sao" }));
		await userEvent.click(within(synced).getByRole("button", { name: "Xoá" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("remove:user:7"));
	});

	it("leaves a chat read-only when sending from Chat is unticked, and switches it on later", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Anh Đô CEO/ }));
		await userEvent.click(screen.getByRole("checkbox", { name: "Gửi tin từ Chat sang Telegram" }));
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("enable:user:7:2000:IN"));
		const synced = (await screen.findByText("2.000 tin gần nhất", { exact: false }, LONG)).closest("[data-id=bridge-chat]") as HTMLElement;
		const toggle = within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText(/chỉ để đọc: bạn không gửi tin vào đó được/)).toBeTruthy();
		await userEvent.click(toggle);
		await waitFor(() => expect(fixture.bridge.calls).toContain("direction:user:7:BOTH"));
		await waitFor(() => expect(within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ }).getAttribute("aria-checked")).toBe("true"));
		expect(screen.queryByText(/chỉ để đọc: bạn không gửi tin vào đó được/)).toBeNull();
		await userEvent.click(within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("direction:user:7:IN"));
	});

	it("says so, without asking to sign in again, when the app cannot be written to", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Anh Đô CEO/ }));
		await userEvent.click(screen.getByRole("checkbox", { name: "Gửi tin từ Chat sang Telegram" }));
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		const synced = (await screen.findByText("2.000 tin gần nhất", { exact: false }, LONG)).closest("[data-id=bridge-chat]") as HTMLElement;
		fixture.bridge.sendUnsupported = true;
		await userEvent.click(within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ }));
		expect(await screen.findByText("Ứng dụng này chưa cho gửi tin từ Chat.", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Đăng nhập lại" })).toBeNull();
		expect(within(synced).getByRole("switch", { name: /Gửi tin từ Chat/ }).getAttribute("aria-checked")).toBe("false");
	});
});

describe("choosing several conversations at once", () => {
	it("syncs every ticked chat with one history choice and one click; an old sign-in stops it and keeps the choice", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Anh Đô CEO/ }));
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Nhóm dự án/ }));
		expect(screen.getByText("Đã chọn 2 chat")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "500" }));
		// The sign-in is too old: nothing starts, and the choice is still there to finish after signing in again.
		fixture.bridge.reauth = true;
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ 2 chat" }));
		expect(await screen.findByRole("link", { name: "Đăng nhập lại" }, LONG)).toBeTruthy();
		expect(fixture.bridge.calls.filter((c) => c.startsWith("enable:"))).toEqual([]);
		expect(screen.getByText("Đã chọn 2 chat")).toBeTruthy();
		fixture.bridge.reauth = false;
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ 2 chat" }));
		await waitFor(() => expect(fixture.bridge.calls.filter((c) => c.startsWith("enable:"))).toEqual(["enable:user:7:500:BOTH", "enable:chat:3:500:BOTH"]));
		await waitFor(() => expect(screen.queryByText("Đã chọn 2 chat")).toBeNull());
		// The two are marked synced in the list now, and cannot be ticked again.
		await waitFor(() => expect(within(picker).queryAllByText("Đã đồng bộ")).toHaveLength(2));
		expect(within(picker).queryAllByRole("checkbox")).toHaveLength(0);
	});
});

describe("selecting what the list shows", () => {
	it("ticks every chat the search shows in one click, and unticks them in another", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		const total = within(picker).getAllByRole("checkbox").length;
		await userEvent.click(within(picker).getByRole("button", { name: `Chọn tất cả ${total} chat đang hiện` }));
		expect(screen.getByText(`Đã chọn ${total} chat`)).toBeTruthy();
		expect(within(picker).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
		await userEvent.click(within(picker).getByRole("button", { name: "Bỏ chọn các chat đang hiện" }));
		expect(screen.queryByText(`Đã chọn ${total} chat`)).toBeNull();
	});
});

describe("a batch stopped by an old sign-in", () => {
	it("carries on by itself, with the same history choice, when the page opens again after signing in", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Anh Đô CEO/ }));
		await userEvent.click(within(picker).getByRole("checkbox", { name: /Nhóm dự án/ }));
		await userEvent.click(screen.getByRole("button", { name: "500" }));
		fixture.bridge.reauth = true;
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ 2 chat" }));
		expect(await screen.findByText("Đăng nhập lại xong, 2 chat sẽ tự đồng bộ tiếp.", {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls.filter((c) => c.startsWith("enable:"))).toEqual([]);
		// The user signs in again: the page is left and opened anew, with a fresh sign-in.
		cleanup();
		fixture.bridge.reauth = false;
		await openPage(fixture);
		await waitFor(() => expect(fixture.bridge.calls.filter((c) => c.startsWith("enable:"))).toEqual(["enable:user:7:500:BOTH", "enable:chat:3:500:BOTH"]), LONG);
		// It ran once: nothing is left waiting, and a new visit does not start anything again.
		expect(window.sessionStorage.getItem("chat.bridge.pending")).toBeNull();
	});

	it("does not start a batch that waited too long for the sign-in", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		window.sessionStorage.setItem("chat.bridge.pending", JSON.stringify({ account: 1, ids: ["user:7"], window: 500, at: Date.now() - 20 * 60 * 1000 }));
		cleanup();
		await openPage(fixture);
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG);
		expect(fixture.bridge.calls.filter((c) => c.startsWith("enable:"))).toEqual([]);
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
