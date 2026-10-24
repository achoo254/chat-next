// Settings › Góp ý (mockups/settings.html#feedback): feedback for the team
// in two clicks from anywhere, filed into the moderation queue; and the
// error reporter that counts uncaught errors without personal data.
import { FeedbackKind, FeedbackSource, FeedbackStatus } from "@achoo254/chat-proto/moderation";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

describe("Settings › Góp ý", () => {
	it("sends an idea or a bug report from a dialog over the current tab", async () => {
		const fixture = new ChatFixture();
		renderMessaging(fixture, "/settings/privacy");
		await userEvent.click(await screen.findByRole("button", { name: "Góp ý" }, LONG));
		const dialog = await screen.findByRole("dialog", { name: "Góp ý cho đội ngũ" }, LONG);
		const send = within(dialog).getByRole("button", { name: "Gửi góp ý" });
		expect(send.hasAttribute("disabled")).toBe(true);
		expect(within(dialog).getByRole("button", { name: "Góp ý" }).getAttribute("aria-pressed")).toBe("true");

		await userEvent.click(within(dialog).getByRole("button", { name: "Báo lỗi" }));
		const box = within(dialog).getByRole("textbox", { name: "Nội dung" });
		expect(box.getAttribute("placeholder")).toBe("Bạn gặp lỗi gì? Bạn đang làm gì và điều gì xảy ra?");
		await userEvent.type(box, "  Ảnh không tải được  ");
		expect(within(dialog).getByText("22/2000")).toBeTruthy();
		await userEvent.click(send);

		await waitFor(() => expect(toastText()).toBe("Đã gửi góp ý. Cảm ơn bạn!"), LONG);
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Góp ý cho đội ngũ" })).toBeNull(), LONG);
		expect(fixture.feedbackQueue).toEqual([
			expect.objectContaining({ kind: FeedbackKind.BUG, text: "Ảnh không tải được", status: FeedbackStatus.OPEN, source: FeedbackSource.SETTINGS }),
		]);
		// The tab underneath stayed.
		expect(window.location.pathname).toBe("/settings/privacy");
	});

	it("keeps the text and says so when sent too fast", async () => {
		const fixture = new ChatFixture();
		fixture.feedbackRateLimited = true;
		renderMessaging(fixture, "/settings/profile");
		await userEvent.click(await screen.findByRole("button", { name: "Góp ý" }, LONG));
		const dialog = await screen.findByRole("dialog", { name: "Góp ý cho đội ngũ" }, LONG);
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Nội dung" }), "Thêm chế độ tối");
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi góp ý" }));
		await waitFor(() => expect(toastText()).toBe("Bạn gửi hơi nhanh, thử lại sau ít phút nhé."), LONG);
		expect(within(dialog).getByRole("textbox", { name: "Nội dung" })).toHaveProperty("value", "Thêm chế độ tối");
		expect(fixture.feedbackQueue).toEqual([]);
		await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Góp ý cho đội ngũ" })).toBeNull());
	});
});

describe("error reporter", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	async function loadReporter() {
		const sent: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init: RequestInit) => {
				expect(url).toBe("/rpc/app.v1.FeedbackService/ReportClientError");
				sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return Promise.resolve(new Response("{}"));
			}),
		);
		vi.resetModules();
		const reporter = await import("../src/error-reporter.ts");
		return { reporter, sent };
	}

	it("sends a compact report: no URLs, our own top frame, the route's name", async () => {
		const { reporter, sent } = await loadReporter();
		window.history.replaceState(null, "", "/c/12345?token=abc");
		const error = new TypeError("cannot open https://chat.hoandat.com/join/AbCdEf?x=1");
		error.stack = [
			"TypeError: cannot open",
			"    at f (https://cdn.example.com/lib.js:1:10)",
			`    at g (${location.origin}/assets/index-Bx1.js?v=2:3:456)`,
		].join("\n");
		reporter.reportClientError("error", error);
		expect(sent).toEqual([
			expect.objectContaining({
				kind: "CLIENT_ERROR_KIND_ERROR",
				message: "TypeError: cannot open [url]",
				location: "assets/index-Bx1.js:3:456",
				route: "chat",
			}),
		]);
		expect(JSON.stringify(sent)).not.toMatch(/12345|token|AbCdEf/);
	});

	it("reports each error once and at most five per page load", async () => {
		const { reporter, sent } = await loadReporter();
		const same = new Error("boom");
		for (let i = 0; i < 3; i++) reporter.reportClientError("rejection", same);
		expect(sent).toHaveLength(1);
		for (let i = 0; i < 10; i++) reporter.reportClientError("error", new Error(`failure ${i}`));
		expect(sent).toHaveLength(reporter.REPORTS_MAX);
	});

	it("listens to uncaught errors and rejections, not to errors without an Error", async () => {
		const { reporter, sent } = await loadReporter();
		reporter.installErrorReporter();
		window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
		expect(sent).toHaveLength(0);
		window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("too far"), message: "too far" }));
		const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
		rejection.reason = "network down";
		window.dispatchEvent(rejection);
		expect(sent.map((body) => [body.kind, body.message])).toEqual([
			["CLIENT_ERROR_KIND_ERROR", "RangeError: too far"],
			["CLIENT_ERROR_KIND_UNHANDLED_REJECTION", "network down"],
		]);
	});
});
