// A bot end to end: An creates it in the Developer Console, gets its token
// after signing in again (the fake IdP answers the reauth with a fresh
// auth_time), and a script plays the bot over the real HTTP Bot API (long
// polling through the dev server's /bot/ proxy). An opens the bot's deep link
// and starts it; the bot receives "/start hello", answers with an inline
// keyboard, An presses a button and sees the bot's callback answer, then
// taps the bot's reply keyboard.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { launch, message, scenario, signIn, WEB_ORIGIN, type Person } from "./people.ts";

let browser: Browser;
let an: Person;

before(async () => {
	browser = await launch();
	an = await signIn(browser, "an");
});
after(async () => {
	await browser.close();
});

interface Update {
	readonly update_id: number;
	readonly message?: { readonly chat: { readonly id: number }; readonly text?: string };
	readonly callback?: { readonly id: string; readonly data: string };
}

/** The bot's side: Bot API calls with its token. */
class TestBot {
	private offset = 0;
	private readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${WEB_ORIGIN}/bot/v1${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const envelope = (await response.json()) as { ok: boolean; result?: T; error?: { code: string; description: string } };
		if (!envelope.ok || envelope.result === undefined) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(envelope.error)}`);
		return envelope.result;
	}

	/** Long-polls until an update matching `pick` arrives (acknowledging the ones before it). */
	async next(pick: (update: Update) => boolean, deadlineMs = 30_000): Promise<Update> {
		const end = Date.now() + deadlineMs;
		while (Date.now() < end) {
			const updates = await this.call<Update[]>("GET", `/updates?offset=${this.offset}&timeout=10`);
			for (const update of updates) {
				this.offset = update.update_id + 1;
				if (pick(update)) return update;
			}
		}
		throw new Error("no matching update in time");
	}
}

scenario("create a bot, start it from a link, press its buttons", () => [an], async () => {
	const { page } = an;
	await page.getByRole("link", { name: "Cài đặt" }).first().click();
	await page.getByRole("link", { name: "Developer Console" }).click();
	await page.getByText("Bạn chưa có bot nào").waitFor();
	await page.getByRole("link", { name: "Tạo bot đầu tiên" }).click();

	const form = page.getByRole("form", { name: "Bot mới" });
	await form.getByRole("textbox", { name: "Tên hiển thị" }).fill("Echo Bot");
	await form.getByRole("textbox", { name: "Username" }).fill("e2e_echo_bot");
	await form.getByText("Dùng được").waitFor();
	await form.getByRole("textbox", { name: "Mô tả" }).fill("Bot thử nghiệm: lặp lại lệnh của bạn.");
	await form.getByRole("button", { name: "Tạo bot" }).click();
	await page.waitForURL(/\/console\/\d+\/token$/);

	// The sign-in is older than 10 minutes as far as the server knows: sign in again at the fake IdP.
	await page.getByRole("button", { name: "Cấp token" }).click();
	const reauth = page.getByRole("dialog", { name: "Đăng nhập lại để tiếp tục" });
	await reauth.getByRole("link", { name: "Đăng nhập lại" }).click();
	await page.getByRole("link", { name: "Đăng nhập là An @an" }).click();
	const tokenText = (await page.getByTestId("bot-token").textContent()) ?? "";
	assert.match(tokenText, /^\d+:\S{20,}$/);
	await page.getByRole("button", { name: "Tôi đã lưu token" }).click();
	await page.getByTestId("bot-token").waitFor({ state: "detached" });

	const bot = new TestBot(tokenText);
	const me = await bot.call<{ username: string; is_bot: boolean }>("GET", "/me");
	assert.equal(me.username, "e2e_echo_bot");
	assert.equal(me.is_bot, true);

	// The deep link asks first, then sends "/start hello" and opens the chat.
	await page.goto(`${WEB_ORIGIN}/b/e2e_echo_bot?start=hello`);
	const link = page.getByRole("dialog", { name: "Mở Echo Bot" });
	await link.getByText("Gửi /start hello cho Echo Bot?").waitFor();
	await link.getByRole("button", { name: "Gửi /start hello" }).click();
	await message(an, "/start hello").waitFor();
	const start = await bot.next((update) => update.message?.text === "/start hello");
	const chatId = start.message?.chat.id ?? 0;
	assert.ok(chatId > 0);

	await bot.call("POST", "/messages", {
		chat_id: chatId,
		text: "Chào An. Bấm nút để thử.",
		reply_markup: { inline_keyboard: [[{ text: "Bấm thử", callback_data: "press-1" }, { text: "Mở tài liệu", url: "https://docs.example.com/bot" }]] },
	});
	const button = message(an, "Chào An. Bấm nút để thử.").getByRole("button", { name: "Bấm thử" });
	await button.waitFor();
	const pressed = bot.next((update) => update.callback !== undefined);
	await button.click();
	const callback = await pressed;
	assert.equal(callback.callback?.data, "press-1");
	await bot.call("POST", `/callbacks/${encodeURIComponent(callback.callback?.id ?? "")}:answer`, { text: "Đã nhận lệnh press-1" });
	await page.locator(".toast", { hasText: "Đã nhận lệnh press-1" }).waitFor();

	// A one-time reply keyboard: tapping a key sends its text as An's message.
	await bot.call("POST", "/messages", {
		chat_id: chatId,
		text: "Chọn môi trường.",
		reply_markup: { keyboard: [[{ text: "staging" }, { text: "production" }]], one_time: true },
	});
	const pad = page.getByRole("group", { name: "Bàn phím của Echo Bot" });
	await pad.getByRole("button", { name: "staging" }).click();
	await message(an, "staging").waitFor();
	await pad.waitFor({ state: "detached" });
	const tapped = await bot.next((update) => update.message?.text === "staging");
	assert.equal(tapped.message?.chat.id, chatId);
});
