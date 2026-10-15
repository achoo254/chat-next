// The Developer Console's delivery tabs (mockups/console.html #webhook,
// #dead-letter, #stats) through the real client and the fake bot services:
// setting a webhook with the server's refusals shown on the right field, the
// live status, going back to long poll, dead letters retried or dropped, and
// the 24-hour counters.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BotTier } from "@app/proto-ts/bot_admin";
import { BotError } from "../src/messaging/bots/api.ts";
import { newSecret, validSecret, webhookProblem, webhookUrlProblem } from "../src/messaging/bots/delivery.tsx";
import { matchRoute } from "../src/router.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

describe("delivery helpers", () => {
	it("route the delivery tabs", () => {
		expect(matchRoute("/console/7/updates")).toEqual({ name: "console", view: { page: "bot", botId: 7, tab: "updates" } });
		expect(matchRoute("/console/7/dead-letters")).toEqual({ name: "console", view: { page: "bot", botId: 7, tab: "dead-letters" } });
		expect(matchRoute("/console/7/stats")).toEqual({ name: "console", view: { page: "bot", botId: 7, tab: "stats" } });
	});

	it("check URLs and secrets as the server does, and read its refusal codes", () => {
		expect(webhookUrlProblem("")).toBe("empty");
		expect(webhookUrlProblem("http://example.com/hook")).toBe("scheme");
		expect(webhookUrlProblem("not a url")).toBe("invalid");
		expect(webhookUrlProblem("ftp://example.com")).toBe("invalid");
		expect(webhookUrlProblem("https://example.com:8443/hook?x=1")).toBeNull();
		expect(validSecret("abc_DEF-123")).toBe(true);
		expect(validSecret("")).toBe(false);
		expect(validSecret("has space")).toBe(false);
		expect(validSecret("x".repeat(257))).toBe(false);
		const secret = newSecret();
		expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(newSecret()).not.toBe(secret);
		expect(webhookProblem(new BotError("invalid", "url_blocked: private address"))).toBe("url_blocked");
		expect(webhookProblem(new BotError("invalid", "something else"))).toBeNull();
		expect(webhookProblem(new BotError("other", "url_blocked: x"))).toBeNull();
	});
});

describe("Developer Console delivery", () => {
	it("sets a webhook: flags an http URL, shows the server's refusals, needs a secret the first time, then saves", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Deploy Bot", "deployer_bot", { tokenSecret: "s", tokenIssuedAt: fake.now });
		renderMessaging(demo.fixture, `/console/${botId}/updates`);
		const form = await screen.findByRole("form", { name: "Nhận update" }, LONG);
		const mode = within(form).getByRole("group", { name: "Cách nhận update" });
		expect(within(mode).getByRole("button", { name: "Long poll" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("heading", { name: "Trạng thái long poll" })).toBeTruthy();
		await userEvent.click(within(mode).getByRole("button", { name: "Webhook" }));

		const url = within(form).getByLabelText("URL webhook");
		await userEvent.type(url, "http://deploy.example.com/hook");
		expect(within(form).getByText("URL phải bắt đầu bằng https://")).toBeTruthy();
		await userEvent.clear(url);
		await userEvent.type(url, "https://10.0.0.1/hook");
		const save = within(form).getByRole("button", { name: "Lưu" });
		await userEvent.click(save);
		// No secret yet: required before the request goes out.
		expect(await within(form).findByText("Cần secret khi đặt webhook lần đầu")).toBeTruthy();
		expect(fake.calls.some((c) => c.startsWith("SetBotWebhook"))).toBe(false);

		await userEvent.click(within(form).getByRole("button", { name: "Tạo mới" }));
		const secret = within(form).getByLabelText<HTMLInputElement>("Secret token");
		expect(secret.value).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(secret.type).toBe("text");
		const generated = secret.value;
		await userEvent.click(save);
		expect(await within(form).findByText("URL trỏ tới địa chỉ nội bộ", {}, LONG)).toBeTruthy();
		expect(url.getAttribute("aria-invalid")).toBe("true");

		await userEvent.clear(url);
		await userEvent.type(url, "https://deploy.example.com/hook");
		const kinds = within(form).getByRole("group", { name: "Loại update nhận" });
		await userEvent.click(within(kinds).getByRole("button", { name: "callback" }));
		await userEvent.click(within(kinds).getByRole("button", { name: "message" }));
		const max = within(form).getByLabelText<HTMLInputElement>("Số kết nối song song");
		expect(max.value).toBe("40");
		await userEvent.clear(max);
		await userEvent.type(max, "500");
		expect(within(form).getByText("Từ 1 đến 100")).toBeTruthy();
		await userEvent.clear(max);
		await userEvent.type(max, "5");
		await userEvent.click(save);
		await waitFor(() => expect(toastText()).toContain("Đã lưu cách nhận update"), LONG);
		const bot = fake.bots.get(botId);
		expect(bot).toMatchObject({
			webhookUrl: "https://deploy.example.com/hook",
			webhookSecret: generated,
			allowedUpdates: ["message", "callback"],
			maxConnections: 5,
		});
		// The form starts again from the saved webhook: the secret stays hidden and kept.
		const again = await screen.findByRole("form", { name: "Nhận update" }, LONG);
		expect(within(again).getByLabelText<HTMLInputElement>("Secret token").value).toBe("");
		expect(within(again).getByLabelText<HTMLInputElement>("Secret token").placeholder).toBe("Để trống để giữ secret đang dùng");
		expect(await screen.findByRole("heading", { name: "Trạng thái webhook" }, LONG)).toBeTruthy();
		expect(screen.getByText("Chưa giao update nào")).toBeTruthy();
		expect(screen.getByText("0 / 5")).toBeTruthy();

		// The list says the bot uses a webhook now.
		await userEvent.click(screen.getByRole("link", { name: "Về Bot của tôi" }));
		const table = await screen.findByRole("table", {}, LONG);
		expect(within(table).getByText("Webhook")).toBeTruthy();
	});

	it("shows a failing webhook's status, keeps the secret on save, and goes back to long poll dropping what is pending", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const at = new Date(2026, 9, 15, 9, 58).getTime() / 1000;
		const botId = fake.seed("Deploy Bot", "deployer_bot", {
			tokenSecret: "s",
			tokenIssuedAt: fake.now,
			webhookUrl: "https://deploy.example.com/hook",
			webhookSecret: "old_secret",
			maxConnections: 40,
			delivery: {
				pending: 12,
				lastError: "http_502",
				lastErrorAt: at,
				lastSuccessAt: at - 60,
				lastSuccessMs: 84,
				openConnections: 3,
				received: 0,
				delivered: 0,
				failed: 0,
				deadLettered: 0,
			},
			deadLetters: [{ updateId: 884213, kind: "message", chatId: 5, chatTitle: "Vận hành", lastError: "http_500", lastErrorAt: at, attempts: 10 }],
		});
		renderMessaging(demo.fixture, `/console/${botId}/updates`);
		const status = await screen.findByRole("region", { name: "Trạng thái webhook" }, LONG);
		expect(within(status).getByText("Đang lỗi, đang thử lại")).toBeTruthy();
		expect(within(status).getByText("HTTP 502")).toBeTruthy();
		expect(within(status).getByText("15/10 09:58")).toBeTruthy();
		expect(within(status).getByText("84 ms")).toBeTruthy();
		expect(within(status).getByText("3 / 40")).toBeTruthy();
		expect(within(status).getByText("12")).toBeTruthy();
		expect(within(status).getByRole("link", { name: "Xem 1 update" }).getAttribute("href")).toBe(`/console/${botId}/dead-letters`);

		const form = screen.getByRole("form", { name: "Nhận update" });
		const save = within(form).getByRole("button", { name: "Lưu" });
		expect(save.hasAttribute("disabled")).toBe(true);
		// A changed URL with the secret field left empty keeps the secret.
		const url = within(form).getByLabelText("URL webhook");
		await userEvent.clear(url);
		await userEvent.type(url, "https://deploy.example.com/v2");
		await userEvent.click(save);
		await waitFor(() => expect(fake.bots.get(botId)?.webhookUrl).toBe("https://deploy.example.com/v2"), LONG);
		expect(fake.bots.get(botId)?.webhookSecret).toBe("old_secret");

		const again = await screen.findByRole("form", { name: "Nhận update" }, LONG);
		await userEvent.click(within(again).getByRole("button", { name: "Long poll" }));
		expect(within(again).getByText(/Webhook đang đặt sẽ bị gỡ khi lưu/)).toBeTruthy();
		await userEvent.click(within(again).getByRole("switch", { name: "Bỏ update đang chờ khi lưu" }));
		expect(within(again).getByText("12 update đang chờ sẽ bị bỏ, không giao nữa.")).toBeTruthy();
		await userEvent.click(within(again).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(fake.calls).toContain(`DeleteBotWebhook ${botId} true`), LONG);
		expect(fake.bots.get(botId)?.webhookUrl).toBe("");
		expect(await screen.findByRole("heading", { name: "Trạng thái long poll" }, LONG)).toBeTruthy();
	});

	it("retries one dead letter and drops the rest, then shows the empty state", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const at = new Date(2026, 9, 15, 9, 31).getTime() / 1000;
		const botId = fake.seed("Deploy Bot", "deployer_bot", {
			deadLetters: [
				{ updateId: 884213, kind: "message", chatId: 5, chatTitle: "Vận hành hệ thống", lastError: "http_500", lastErrorAt: at, attempts: 10 },
				{ updateId: 884231, kind: "callback", chatId: 6, chatTitle: "Lan Anh", lastError: "timeout", lastErrorAt: at, attempts: 10 },
				{ updateId: 884245, kind: "message", chatId: 7, chatTitle: "Quang Huy", lastError: "tls", lastErrorAt: at, attempts: 10 },
			],
		});
		renderMessaging(demo.fixture, `/console/${botId}/dead-letters`);
		const page = await screen.findByRole("region", { name: "Update lỗi (3)" }, LONG);
		const table = within(page).getByRole("table");
		expect(within(table).getByText("HTTP 500")).toBeTruthy();
		expect(within(table).getByText("Hết thời gian chờ sau 10 giây")).toBeTruthy();
		expect(within(table).getByText("Lỗi TLS (chứng chỉ)")).toBeTruthy();
		expect(within(table).getByText("Vận hành hệ thống")).toBeTruthy();
		expect(within(table).getAllByText("15/10 09:31")).toHaveLength(3);

		await userEvent.click(within(table).getByRole("button", { name: "Thử lại update 884213" }));
		await waitFor(() => expect(within(table).queryByText("Vận hành hệ thống")).toBeNull(), LONG);
		expect(fake.calls).toContain(`RetryBotDeadLetters ${botId} 884213`);
		expect(toastText()).toContain("Đã cho thử lại update");

		await userEvent.click(within(page).getByRole("button", { name: "Bỏ tất cả" }));
		expect(await screen.findByText("Không có update nào bị kẹt", {}, LONG)).toBeTruthy();
		expect(fake.calls).toContain(`DiscardBotDeadLetters ${botId} 884231,884245`);
		expect(screen.queryByRole("button", { name: "Thử lại tất cả" })).toBeNull();
	});

	it("shows the counters of the last 24 hours and the bot's tier", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Deploy Bot", "deployer_bot", {
			tier: BotTier.VERIFIED,
			delivery: {
				pending: 0,
				lastError: "",
				lastErrorAt: 0,
				lastSuccessAt: 0,
				lastSuccessMs: 0,
				openConnections: 0,
				received: 12480,
				delivered: 12431,
				failed: 37,
				deadLettered: 4,
			},
		});
		renderMessaging(demo.fixture, `/console/${botId}/stats`);
		const page = await screen.findByRole("region", { name: "Số liệu gửi · 24 giờ qua" }, LONG);
		expect(within(page).getByText("12.480")).toBeTruthy();
		expect(within(page).getByText("12.431")).toBeTruthy();
		expect(within(page).getByText("37")).toBeTruthy();
		expect(within(page).getByText("Vào dead-letter")).toBeTruthy();
		expect(within(page).getByText("verified")).toBeTruthy();
		expect(within(page).getByText(/Bot đã xác minh/)).toBeTruthy();
	});

	it("points the token tab of a webhook bot to the delivery settings", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Deploy Bot", "deployer_bot", { tokenSecret: "s", tokenIssuedAt: fake.now, webhookUrl: "https://x.example/h", webhookSecret: "s" });
		renderMessaging(demo.fixture, `/console/${botId}/token`);
		expect(await screen.findByText("Bot nhận update qua webhook.", {}, LONG)).toBeTruthy();
		await userEvent.click(screen.getByRole("link", { name: "Cài đặt nhận update" }));
		expect(window.location.pathname).toBe(`/console/${botId}/updates`);
		expect(screen.queryByText("Bot chưa nhận update lần nào")).toBeNull();
	});
});
