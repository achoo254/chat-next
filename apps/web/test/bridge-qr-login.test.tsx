// Settings > Kết nối ứng dụng: connecting Zalo by QR code. The server is the
// fake BridgeService with its Zalo-like QR login (support/fake-qr-login.ts):
// each poll waits until the test pushes the next answer or the page aborts it.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Code } from "@connectrpc/connect";
import { BridgeAccountStatus, BridgeSyncState } from "@achoo254/chat-proto/bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { FAKE_QR_PNG } from "./support/fake-qr-login.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const QR_ALT = "Mã QR đăng nhập Zalo";
const STATUS = {
	preparing: "Đang tạo mã QR…",
	scan: "Quét mã bằng điện thoại.",
	refreshing: "Mã đã hết hạn, đang tạo mã mới…",
	confirm: "Đã quét. Xác nhận đăng nhập trên điện thoại.",
	network: "Mất kết nối tới máy chủ. Kiểm tra mạng rồi thử lại.",
	declined: "Đăng nhập đã bị từ chối trên điện thoại.",
	limited: "Đã thử đăng nhập nhiều lần. Đợi một lát rồi thử lại.",
	failed: "Chưa đăng nhập được. Thử lại sau.",
};

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

function zaloFixture(): ChatFixture {
	const fixture = new ChatFixture();
	fixture.bridge.apps = ["telegram", "zalo"];
	return fixture;
}

async function openPage(fixture: ChatFixture) {
	const view = renderMessaging(fixture, "/settings/bridge");
	await screen.findByRole("heading", { name: "Ứng dụng có thể kết nối" }, LONG);
	return view;
}

/** The Connect button on the row of `app` in the list of apps. */
function connectButton(app: string): HTMLElement {
	const row = screen.getByText(app, { selector: "b" }).closest(".br-source");
	const button = row?.querySelector("button");
	if (!(button instanceof HTMLElement)) throw new Error(`no row for ${app}`);
	return button;
}

/** Opens the Zalo card, accepts the notice and waits for the QR step. */
async function startZalo(fixture: ChatFixture): Promise<void> {
	await userEvent.click(connectButton("Zalo"));
	await userEvent.click(await screen.findByRole("checkbox", { name: /Tôi đã hiểu/ }, LONG));
	await userEvent.click(screen.getByRole("button", { name: "Hiện mã QR" }));
	await waitFor(() => expect(fixture.bridge.qr.starts).toBe(1), LONG);
}

function statusLine(): Element | null {
	return document.querySelector('[data-id="bridge-qr-login-status"]');
}

async function expectStatus(text: string): Promise<void> {
	await waitFor(() => expect(statusLine()?.textContent).toContain(text), LONG);
}

/** Pushes the answer of the poll in flight, inside act. */
async function answer(fixture: ChatFixture, ...replies: Parameters<ChatFixture["bridge"]["qr"]["push"]>): Promise<void> {
	await waitFor(() => expect(fixture.bridge.qr.inFlight).toBe(1), LONG);
	await act(async () => fixture.bridge.qr.push(...replies));
}

describe("offering Zalo", () => {
	it("lists Zalo next to Telegram only when the server offers it", async () => {
		const plain = new ChatFixture();
		const view = await openPage(plain);
		expect(screen.queryByText("Zalo", { selector: "b" })).toBeNull();
		view.unmount();
		await openPage(zaloFixture());
		expect(connectButton("Telegram")).toBeTruthy();
		expect(connectButton("Zalo")).toBeTruthy();
	});

	it("makes no login call until the notice is accepted", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await userEvent.click(connectButton("Zalo"));
		expect(await screen.findByRole("heading", { name: "Trước khi kết nối Zalo" }, LONG)).toBeTruthy();
		// The same frame as the field login: the method under the title, the actions in its footer.
		const notice = screen.getByRole("region", { name: "Trước khi kết nối Zalo" });
		expect(within(notice).getByText("Đăng nhập bằng mã QR trên điện thoại")).toBeTruthy();
		expect(notice.querySelector(".br-signin-actions")).not.toBeNull();
		expect(screen.getByText(/trái với điều khoản sử dụng của Zalo/)).toBeTruthy();
		const go = screen.getByRole("button", { name: "Hiện mã QR" });
		expect(go).toHaveProperty("disabled", true);
		await userEvent.click(go);
		expect(fixture.bridge.calls).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		expect(fixture.bridge.calls).toEqual([]);
		expect(screen.getByRole("heading", { name: "Ứng dụng có thể kết nối" })).toBeTruthy();
	});
});

describe("the QR step", () => {
	it("says the code is being prepared, then shows it large and moves focus to the step", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await expectStatus(STATUS.preparing);
		const heading = screen.getByRole("heading", { name: "Quét mã QR để đăng nhập Zalo" });
		expect(document.activeElement).toBe(heading);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		const image = await screen.findByRole("img", { name: QR_ALT }, LONG);
		expect(image.getAttribute("src")).toBe(FAKE_QR_PNG);
		expect(image.getAttribute("width")).toBe("264");
		await expectStatus(STATUS.scan);
		expect(statusLine()?.getAttribute("role")).toBe("status");
		expect(statusLine()?.getAttribute("aria-live")).toBe("polite");
		expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toContain("Chạm biểu tượng quét mã QR ở thanh tìm kiếm.");
		// one long poll at a time
		await waitFor(() => expect(fixture.bridge.qr.inFlight).toBe(1), LONG);
		expect(fixture.bridge.qr.maxInFlight).toBe(1);
	});

	it.each([
		["an SVG", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
		["a link", "https://example.test/qr.png"],
		["script", "javascript:alert(1)"],
		["a PNG with markup", `${FAKE_QR_PNG}"><b>`],
		["an oversize PNG", `data:image/png;base64,${"A".repeat(400_000)}`],
	])("refuses %s as the code and does not render it", async (_name, image) => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image });
		await expectStatus(STATUS.failed);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		expect(document.querySelector("img[src^='data:image/svg'], img[src^='http'], img[src^='javascript']")).toBeNull();
		expect(screen.getByRole("button", { name: "Bắt đầu lại" })).toBeTruthy();
	});

	it("tells the user to confirm on the phone once scanned, and hides the code", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		await answer(fixture, { kind: "confirm" });
		await expectStatus(STATUS.confirm);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
	});

	it("says a new code is loading when the old one expired, then shows it", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		await answer(fixture, { kind: "qr", image: "" });
		await expectStatus(STATUS.refreshing);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		expect(await screen.findByRole("img", { name: QR_ALT }, LONG)).toBeTruthy();
		await expectStatus(STATUS.scan);
	});

	it("connects the account on confirmation and goes back to the list with it", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await answer(fixture, { kind: "confirm" });
		await answer(fixture, { kind: "done" });
		expect(await screen.findByText("Đã kết nối Zalo.", {}, LONG)).toBeTruthy();
		expect(await screen.findByRole("heading", { name: "Ứng dụng có thể kết nối" }, LONG)).toBeTruthy();
		expect(screen.getByText("Đang kết nối")).toBeTruthy();
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		expect(fixture.bridge.qr.inFlight).toBe(0);
	});

	it("promises only what Zalo does: new messages come in one way, nothing typed in Chat goes out", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await answer(fixture, { kind: "confirm" });
		await answer(fixture, { kind: "done" });
		const ask = await screen.findByRole("group", { name: "Nhận tin nhắn mới từ Zalo vào Chat?" }, LONG);
		expect(within(ask).getByText(/Chỉ một chiều/)).toBeTruthy();
		expect(screen.queryByText(/Đồng bộ toàn bộ tin nhắn Zalo/)).toBeNull();
		expect(within(ask).queryByText(/hai chiều|thời gian thực/)).toBeNull();
	});
});

describe("when the login does not go through", () => {
	it("says a decline on the phone ended it and offers to start again (once per double click)", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "error", code: Code.InvalidArgument, message: "wrong_input: qr_declined: the login was declined on the phone, start it again" });
		await expectStatus(STATUS.declined);
		const again = screen.getByRole("button", { name: "Bắt đầu lại" });
		await waitFor(() => expect(document.activeElement).toBe(again));
		expect(screen.queryByText(/wrong_input|qr_declined/)).toBeNull();
		await userEvent.dblClick(again);
		await waitFor(() => expect(fixture.bridge.qr.starts).toBe(2), LONG);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fixture.bridge.qr.starts).toBe(2);
	});

	it("asks the user to wait, with a countdown and no raw error, when the server limits logins", async () => {
		const fixture = zaloFixture();
		fixture.bridge.qr.start = { kind: "error", code: Code.ResourceExhausted, message: "too many sign-in attempts; try again later" };
		await openPage(fixture);
		await startZalo(fixture);
		await expectStatus(STATUS.limited);
		expect(screen.getByText(/Thử lại được sau khoảng \d+ giây\./)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Bắt đầu lại" })).toHaveProperty("disabled", true);
		expect(screen.queryByText(/too many sign-in attempts/)).toBeNull();
		expect(fixture.bridge.qr.polls).toBe(0);
	});

	it("never sends the user to sign in to Chat again: a refusal of that kind reads as a failed login that can start again", async () => {
		const fixture = zaloFixture();
		fixture.bridge.qr.start = { kind: "error", code: Code.FailedPrecondition, message: "reauth_required: sign in again (within the last 10 minutes) to do this" };
		await openPage(fixture);
		await startZalo(fixture);
		await expectStatus("Chưa đăng nhập được. Thử lại sau.");
		expect(screen.queryByRole("link", { name: "Đăng nhập lại" })).toBeNull();
		expect(screen.getByRole("button", { name: "Bắt đầu lại" })).toBeTruthy();
	});

	it("counts down the wait the server asks for, in minutes when it is long", async () => {
		const fixture = zaloFixture();
		fixture.bridge.qr.start = { kind: "error", code: Code.ResourceExhausted, message: "rate_limited: too many sign-in attempts; retry_after=600" };
		await openPage(fixture);
		await startZalo(fixture);
		await expectStatus(STATUS.limited);
		expect(screen.getByText("Thử lại được sau khoảng 10 phút.")).toBeTruthy();
		expect(screen.queryByText(/retry_after/)).toBeNull();
	});

	it("offers a retry of the same login after a network error", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		await answer(fixture, { kind: "error", code: Code.Unavailable, message: "upstream unavailable" });
		await expectStatus(STATUS.network);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		expect(await screen.findByRole("img", { name: QR_ALT }, LONG)).toBeTruthy();
		expect(fixture.bridge.qr.starts).toBe(1);
	});
});

describe("stopping", () => {
	it("cancel aborts the poll in flight, stops polling and forgets the code", async () => {
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		await waitFor(() => expect(fixture.bridge.qr.inFlight).toBe(1), LONG);
		const polls = fixture.bridge.qr.polls;
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		await waitFor(() => expect(fixture.bridge.qr.aborted).toBe(1), LONG);
		expect(screen.queryByRole("img", { name: QR_ALT })).toBeNull();
		expect(screen.getByRole("heading", { name: "Ứng dụng có thể kết nối" })).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fixture.bridge.qr.polls).toBe(polls);
		expect(fixture.bridge.qr.inFlight).toBe(0);
	});

	it("aborts the poll when the page goes away", async () => {
		const fixture = zaloFixture();
		const view = await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		await waitFor(() => expect(fixture.bridge.qr.inFlight).toBe(1), LONG);
		const polls = fixture.bridge.qr.polls;
		view.unmount();
		await waitFor(() => expect(fixture.bridge.qr.aborted).toBe(1), LONG);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fixture.bridge.qr.polls).toBe(polls);
	});
});

describe("privacy of the code", () => {
	it("keeps the code out of storage, the URL and the console", async () => {
		const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
		const fixture = zaloFixture();
		await openPage(fixture);
		await startZalo(fixture);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		await screen.findByRole("img", { name: QR_ALT }, LONG);
		const payload = FAKE_QR_PNG.slice("data:image/png;base64,".length);
		const stored = (storage: Storage) => Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i) ?? "") ?? "").join("\n");
		expect(stored(window.localStorage)).not.toContain(payload);
		expect(stored(window.sessionStorage)).not.toContain(payload);
		expect(window.location.href).not.toContain(payload);
		for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(payload);
	});
});

describe("signing in again", () => {
	it("reuses the notice and the QR flow for a Zalo account that needs a new login", async () => {
		const fixture = zaloFixture();
		fixture.bridge.accounts = [
			{ $typeName: "app.v1.BridgeAccount", id: 2n, source: "zalo", status: BridgeAccountStatus.NEEDS_LOGIN, syncState: BridgeSyncState.LIVE, lastError: "", chats: [], sendGated: true, sendEnabled: false },
		];
		await openPage(fixture);
		await userEvent.click(screen.getByRole("button", { name: "Kết nối lại" }));
		expect(await screen.findByRole("heading", { name: "Trước khi kết nối Zalo" }, LONG)).toBeTruthy();
		await userEvent.click(screen.getByRole("checkbox", { name: /Tôi đã hiểu/ }));
		await userEvent.click(screen.getByRole("button", { name: "Hiện mã QR" }));
		await waitFor(() => expect(fixture.bridge.calls[0]).toBe("start:zalo"), LONG);
		await answer(fixture, { kind: "qr", image: FAKE_QR_PNG });
		expect(await screen.findByRole("img", { name: QR_ALT }, LONG)).toBeTruthy();
	});
});
