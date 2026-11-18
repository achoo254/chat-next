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

describe("turning sending on or off for every synced chat", () => {
	it("asks once before turning it on for all, and turns it off for all without asking", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		await openPage(fixture);
		const first = (await screen.findAllByRole("switch", { name: /Gửi tin từ Chat/ }, LONG)) as HTMLElement[];
		// The demo has one chat that sends on and one that does not.
		expect(first.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false"]);
		await userEvent.click(screen.getByRole("button", { name: "Bật gửi cho tất cả (1)" }));
		expect(await screen.findByText(/Bật “?"?Gửi tin từ Chat”?"? cho 1 chat\?/, {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls.filter((c) => c.startsWith("direction:"))).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Bật cho tất cả" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("direction:chat:9:BOTH"), LONG);
		await waitFor(() => expect(screen.getAllByRole("switch", { name: /Gửi tin từ Chat/ }).map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "true"]), LONG);
		// Everything sends on now: the only offer left is to turn it all off, and that asks nothing.
		expect(screen.queryByRole("button", { name: /Bật gửi cho tất cả/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Tắt gửi cho tất cả" }));
		await waitFor(() => expect(screen.getAllByRole("switch", { name: /Gửi tin từ Chat/ }).map((el) => el.getAttribute("aria-checked"))).toEqual(["false", "false"]), LONG);
		expect(fixture.bridge.calls.filter((c) => c.startsWith("direction:"))).toEqual(["direction:chat:9:BOTH", "direction:user:7:IN", "direction:chat:9:IN"]);
	});

	it("stops at the first chat the app cannot send into and says so", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		fixture.bridge.sendUnsupported = true;
		await openPage(fixture);
		await userEvent.click(await screen.findByRole("button", { name: "Bật gửi cho tất cả (1)" }, LONG));
		await userEvent.click(screen.getByRole("button", { name: "Bật cho tất cả" }));
		expect(await screen.findByText("Ứng dụng này chưa cho gửi tin từ Chat.", {}, LONG)).toBeTruthy();
	});
});

describe("forums and their topics", () => {
	async function openList(fixture: ChatFixture): Promise<HTMLElement> {
		await openPage(fixture);
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		return (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
	}

	function rowOf(picker: HTMLElement, title: string): HTMLElement {
		return within(picker).getByText(title).closest("[data-id=bridge-conversation]") as HTMLElement;
	}

	it("tells which conversations have topics, and a forum enabled now is split into them", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		await userEvent.click(await screen.findByRole("button", { name: "Hiện danh sách chat" }, LONG));
		const picker = (await screen.findByRole("heading", { name: "Chọn chat để đồng bộ" }, LONG)).parentElement as HTMLElement;
		expect(within(rowOf(picker, "Diễn đàn nhóm")).getByText("Nhóm có chủ đề")).toBeTruthy();
		expect(within(rowOf(picker, "Nhóm dự án")).queryByText("Nhóm có chủ đề")).toBeNull();
		await userEvent.click(within(rowOf(picker, "Diễn đàn nhóm")).getByRole("checkbox"));
		await userEvent.click(screen.getByRole("button", { name: "Bắt đầu đồng bộ" }));
		await waitFor(() => expect(fixture.bridge.calls.some((c) => c.startsWith("enable:forum:1"))).toBe(true));
		await waitFor(() => expect(within(rowOf(picker, "Diễn đàn nhóm")).getByText("Đã tách theo chủ đề")).toBeTruthy());
		const synced = await waitFor(() => {
			const el = document.querySelector<HTMLElement>("[data-id=bridge-chat]");
			if (el === null) throw new Error("no synced chat yet");
			return el;
		}, LONG);
		expect(within(synced).getByText("Diễn đàn nhóm")).toBeTruthy();
		expect(within(synced).getByText("Có chủ đề")).toBeTruthy();
	});

	it("offers to sync a forum copied flat again by topic, and asks first", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const picker = await openList(fixture);
		const row = rowOf(picker, "Work - OneDash Audit Logs");
		expect(within(row).getByText("Chưa tách theo chủ đề")).toBeTruthy();
		// A conversation that is not a forum offers nothing of the kind.
		expect(within(rowOf(picker, "Anh Đô CEO")).queryByRole("button", { name: "Đồng bộ lại theo chủ đề" })).toBeNull();
		await userEvent.click(within(row).getByRole("button", { name: "Đồng bộ lại theo chủ đề" }));
		expect(await screen.findByText(/Xoá bản sao này rồi đồng bộ lại để tin vào đúng chủ đề/, {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		expect(screen.queryByText(/Xoá bản sao này rồi đồng bộ lại/)).toBeNull();
		expect(fixture.bridge.calls.filter((c) => c.startsWith("remove:"))).toEqual([]);

		await userEvent.click(within(row).getByRole("button", { name: "Đồng bộ lại theo chủ đề" }));
		await userEvent.click(await screen.findByRole("button", { name: "Xoá và đồng bộ lại" }, LONG));
		await waitFor(() => expect(fixture.bridge.calls).toContain("enable:chat:9:500:IN"), LONG);
		// Removed, then enabled again with the same window and direction.
		const order = fixture.bridge.calls.filter((c) => c.startsWith("remove:") || c.startsWith("enable:"));
		expect(order).toEqual(["remove:chat:9", "enable:chat:9:500:IN"]);
		await waitFor(() => expect(within(rowOf(picker, "Work - OneDash Audit Logs")).getByText("Đã tách theo chủ đề")).toBeTruthy(), LONG);
		expect(within(rowOf(picker, "Work - OneDash Audit Logs")).queryByRole("button", { name: "Đồng bộ lại theo chủ đề" })).toBeNull();
	});

	it("says so when the copy was deleted but could not be turned on again", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const picker = await openList(fixture);
		await userEvent.click(within(rowOf(picker, "Work - OneDash Audit Logs")).getByRole("button", { name: "Đồng bộ lại theo chủ đề" }));
		fixture.bridge.failEnable = true;
		await userEvent.click(await screen.findByRole("button", { name: "Xoá và đồng bộ lại" }, LONG));
		expect(await screen.findByText("Đã xoá bản sao nhưng chưa bật lại được. Bật lại từ danh sách chat.", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(within(rowOf(picker, "Work - OneDash Audit Logs")).queryByText("Đã đồng bộ")).toBeNull(), LONG);
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
		// Only the forum of the fake server is left to tick; the two synced chats have no checkbox.
		expect(within(picker).queryAllByRole("checkbox")).toHaveLength(1);
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

describe("what is synced for one chat, feature by feature", () => {
	async function openFeatures(fixture: ChatFixture): Promise<HTMLElement> {
		await openPage(fixture);
		const buttons = await screen.findAllByRole("button", { name: "Tính năng" }, LONG);
		await userEvent.click(buttons[0] as HTMLElement);
		return (await screen.findByRole("region", { name: /Đồng bộ gì cho/ }, LONG)) as HTMLElement;
	}

	it("lists what the app supports with the direction in effect, and sets one", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const panel = await openFeatures(fixture);
		expect(within(panel).getByText("Ghim tin nhắn")).toBeTruthy();
		expect(within(panel).queryByText("Thông báo và tắt tiếng")).toBeNull();
		const pins = within(panel).getByRole("group", { name: /Ghim tin nhắn/ });
		expect(within(pins).getByRole("button", { name: "Chỉ nhận" }).getAttribute("aria-pressed")).toBe("true");
		// read marks only come in: no "both ways" for them
		expect(within(within(panel).getByRole("group", { name: /Đã đọc/ })).queryByRole("button", { name: "Hai chiều" })).toBeNull();
		await userEvent.click(within(pins).getByRole("button", { name: "Hai chiều" }));
		await waitFor(() => expect(fixture.bridge.calls.some((c) => c.endsWith(":pins:both"))).toBe(true), LONG);
		await waitFor(() => expect(within(within(panel).getByRole("group", { name: /Ghim tin nhắn/ })).getByRole("button", { name: "Hai chiều" }).getAttribute("aria-pressed")).toBe("true"), LONG);
	});

	it("applies a quick level and never touches what acts on people", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const panel = await openFeatures(fixture);
		await userEvent.click(within(panel).getByRole("button", { name: "Đầy đủ" }));
		await waitFor(() => expect(fixture.bridge.calls.filter((c) => c.startsWith("feature:"))).toHaveLength(3), LONG);
		expect(fixture.bridge.calls.filter((c) => c.startsWith("feature:")).some((c) => c.includes(":members:"))).toBe(false);
	});

	it("asks before a feature that acts on people starts to send", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const panel = await openFeatures(fixture);
		const members = within(panel).getByRole("group", { name: /Thành viên và vai trò/ });
		await userEvent.click(within(members).getByRole("button", { name: "Hai chiều" }));
		expect(await within(panel).findByText(/tác động trực tiếp lên người và nhóm/, {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls.some((c) => c.includes(":members:"))).toBe(false);
		await userEvent.click(within(panel).getByRole("button", { name: "Bật" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("feature:user:7:members:both"), LONG);
	});

	it("says so when the app cannot do the change", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const panel = await openFeatures(fixture);
		fixture.bridge.features = fixture.bridge.features.filter((x) => x.feature !== "pins");
		await userEvent.click(within(within(panel).getByRole("group", { name: /Ghim tin nhắn/ })).getByRole("button", { name: "Hai chiều" }));
		expect(await within(panel).findByText("Ứng dụng này chưa làm được thao tác đó.", {}, LONG)).toBeTruthy();
	});

	async function turnOn(panel: HTMLElement, group: RegExp, button: string): Promise<void> {
		await userEvent.click(within(within(panel).getByRole("group", { name: group })).getByRole("button", { name: button }));
		const confirm = await within(panel).findByRole("button", { name: "Bật" }, LONG);
		await userEvent.click(confirm);
	}

	it("lists the links of the other app, and makes and revokes them only once the feature sends", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		fixture.bridge.invites = [{ $typeName: "app.v1.BridgeInvite", link: "https://t.me/+abc", title: "Nhóm dự án", revoked: false, usage: 4 }];
		const panel = await openFeatures(fixture);
		expect(await within(panel).findByText(/https:\/\/t\.me\/\+abc/, {}, LONG)).toBeTruthy();
		expect((within(panel).getByRole("button", { name: "Tạo link" }) as HTMLButtonElement).disabled).toBe(true);
		await turnOn(panel, /Link mời/, "Hai chiều");
		await waitFor(() => expect((within(panel).getByRole("button", { name: "Tạo link" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.type(within(panel).getByLabelText("Tên link (không bắt buộc)"), "mới");
		await userEvent.click(within(panel).getByRole("button", { name: "Tạo link" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("invite:create:mới"), LONG);
		await userEvent.click((await within(panel).findAllByRole("button", { name: "Thu hồi" }, LONG))[0] as HTMLElement);
		await waitFor(() => expect(fixture.bridge.calls).toContain("invite:revoke:https://t.me/+abc"), LONG);
	});

	it("adds a person the other app has shown, once members send", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		const panel = await openFeatures(fixture);
		expect(await within(panel).findByText("Giang", { selector: "option" }, LONG)).toBeTruthy();
		await turnOn(panel, /Thành viên và vai trò/, "Hai chiều");
		await userEvent.selectOptions(within(panel).getByLabelText("Chọn người"), "88");
		await waitFor(() => expect((within(panel).getByRole("button", { name: "Thêm" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(within(panel).getByRole("button", { name: "Thêm" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("member:add:88"), LONG);
	});

	it("leaves a group only with the name typed again, and deletes it only after a second confirmation that waits", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		fixture.bridge.chatName = "Anh Đô CEO";
		const panel = await openFeatures(fixture);
		await turnOn(panel, /Rời và xoá nhóm/, "Chỉ gửi");
		const leave = within(panel).getByRole("button", { name: "Rời nhóm" }) as HTMLButtonElement;
		await waitFor(() => expect(leave.disabled).toBe(true));
		await userEvent.type(within(panel).getByLabelText("Gõ lại tên nhóm"), "sai tên");
		await userEvent.click(within(panel).getByRole("button", { name: "Rời nhóm" }));
		expect(await within(panel).findByText("Tên chưa đúng.", {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls).not.toContain("group:leave");
		await userEvent.clear(within(panel).getByLabelText("Gõ lại tên nhóm"));
		await userEvent.type(within(panel).getByLabelText("Gõ lại tên nhóm"), "Anh Đô CEO");
		await userEvent.click(within(panel).getByRole("button", { name: "Xoá nhóm cho mọi người…" }));
		const confirm = await within(panel).findByRole("button", { name: /Chờ|Xoá vĩnh viễn/ }, LONG);
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		expect(fixture.bridge.calls).not.toContain("group:delete");
		await waitFor(() => expect((within(panel).getByRole("button", { name: "Xoá vĩnh viễn" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(within(panel).getByRole("button", { name: "Xoá vĩnh viễn" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("group:delete"), LONG);
	});
});
