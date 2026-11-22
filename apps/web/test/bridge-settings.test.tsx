// Settings > Kết nối ứng dụng (Chat Bridge): the sign-in steps, the one switch that
// syncs every conversation (ADR 0024) with its progress and live state, what did not go
// through, and disconnecting. The server is a fake BridgeService.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BridgeSyncState } from "@achoo254/chat-proto/bridge";
import { beforeEach, describe, expect, it } from "vitest";
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

	it("draws the field login in the shared sign-in frame, with no sign-in-again banner on the page", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
		await screen.findByLabelText(/Số điện thoại/, {}, LONG);
		const form = screen.getByRole("form", { name: "Đăng nhập Telegram" });
		expect(within(form).getByText("Đăng nhập bằng số điện thoại và mã xác nhận")).toBeTruthy();
		expect(within(form).getByRole("button", { name: "Tiếp tục" }).className).toContain("btn-primary");
		expect(form.querySelector(".br-signin-actions")).not.toBeNull();
		expect(screen.queryByText("Thao tác này cần đăng nhập trong 10 phút gần đây.")).toBeNull();
	});

	it("says so when the server has the bridge off", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.disabled = true;
		renderMessaging(fixture, "/settings/bridge");
		expect(await screen.findByText("Máy chủ này chưa bật tính năng kết nối ứng dụng.", {}, LONG)).toBeTruthy();
	});
});

describe("the one switch", () => {
	it("asks once after signing in, syncs everything with one click and shows the progress, then the live state", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		const ask = await screen.findByRole("group", { name: "Đồng bộ toàn bộ tin nhắn Telegram vào Chat?" }, LONG);
		// nothing to choose: no chat list, no history size, no feature table
		expect(screen.queryByText("Chọn chat để đồng bộ")).toBeNull();
		expect(screen.queryByRole("button", { name: "Tính năng" })).toBeNull();
		await userEvent.click(within(ask).getByRole("button", { name: "Đồng bộ" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("sync:1"), LONG);
		expect(await screen.findByText("1/3 cuộc trò chuyện · 500/4.000 tin", {}, LONG)).toBeTruthy();
		expect(screen.getByRole("progressbar", { name: "Đang đồng bộ" })).toBeTruthy();
		// the page reads the progress again while the first import runs, and shows the live state once done
		const account = fixture.bridge.accounts[0];
		if (account?.progress === undefined) throw new Error("no account");
		account.syncState = BridgeSyncState.LIVE;
		account.progress = { ...account.progress, conversationsDone: 3, messages: 3800n, messagesExpected: 3800n };
		expect(await screen.findByText("Đang đồng bộ trực tiếp", {}, { timeout: 10000 })).toBeTruthy();
		expect(screen.getByText("3 cuộc trò chuyện, mọi thay đổi đi hai chiều.")).toBeTruthy();
	}, 20000);

	it("can be left for later, and started from the account afterwards", async () => {
		const fixture = new ChatFixture();
		await openPage(fixture);
		await signIn();
		const ask = await screen.findByRole("group", { name: "Đồng bộ toàn bộ tin nhắn Telegram vào Chat?" }, LONG);
		await userEvent.click(within(ask).getByRole("button", { name: "Để sau" }));
		expect(screen.queryByRole("group", { name: "Đồng bộ toàn bộ tin nhắn Telegram vào Chat?" })).toBeNull();
		expect(fixture.bridge.calls.some((c) => c.startsWith("sync:"))).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: "Đồng bộ tin nhắn Telegram" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("sync:1"), LONG);
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

describe("what did not go through", () => {
	it("lists what did not go through for any feature, and retries or gives it up", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.seedDemo();
		fixture.bridge.problems = [
			{ $typeName: "app.v1.BridgeProblem", id: 5n, chatId: 9n, chatTitle: "Work", feature: "pins", op: "pin_message", seq: 3n, status: "failed", lastError: "not_allowed", attempts: 3, atUnix: 1n },
			{ $typeName: "app.v1.BridgeProblem", id: 6n, chatId: 9n, chatTitle: "Work", feature: "messages", op: "send", seq: 4n, status: "unknown", lastError: "", attempts: 1, atUnix: 2n },
		];
		await openPage(fixture);
		expect(await screen.findByText("Lỗi đồng bộ (2)", {}, LONG)).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Bỏ qua" })).toHaveLength(1); // a send is given up by deleting the message
		await userEvent.click(screen.getByRole("button", { name: "Bỏ qua" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("problem:dismiss:5"), LONG);
		await userEvent.click(await screen.findByRole("button", { name: "Thử lại" }, LONG));
		await waitFor(() => expect(fixture.bridge.calls).toContain("problem:retry:6"), LONG);
	});
});
