// A bot end to end: An creates it in the Developer Console, gets its token
// after signing in again (the fake IdP answers the reauth with a fresh
// auth_time), and a script plays the bot over the real HTTP Bot API (long
// polling through the dev server's /bot/ proxy). An opens the bot's deep link
// and starts it; the bot receives "/start hello", answers with an inline
// keyboard, An presses a button and sees the bot's callback answer, then
// taps the bot's reply keyboard. Then the bot moves to a webhook: a receiver
// on loopback (the e2e stack allows local webhook URLs) checks the secret
// and the HMAC signature and answers with a sendMessage the server runs; An
// sees the reply, reads the delivery state in the Developer Console and
// switches the bot back to long polling there. Last, the bot edits its
// message and inline keyboard, uploads a photo, and An uses its command menu
// in a group (screenshots of the menu when E2E_SHOTS_DIR is set), and opens
// the bot's Mini App from an inline button: docked in the info column's place,
// its "⋯" menu, minimized to the chip and back (the Mini App hears it) at
// 1280×720, 1366×768 and 390×844, with screenshots when E2E_SHOTS_DIR is set.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { verifyMiniAppInitData } from "../../../../sdk/ts/src/mini-app.ts";
import { composer, launch, message, scenario, send, signIn, WEB_ORIGIN, type Person } from "./people.ts";

let browser: Browser;
let an: Person;
/** The bot of the first scenario, for the webhook scenario. */
let echo: { bot: TestBot; botId: number; chatId: number } | null = null;

before(async () => {
	browser = await launch();
	an = await signIn(browser, "an");
});
after(async () => {
	await browser.close();
});

interface Update {
	readonly update_id: number;
	readonly message?: {
		readonly chat: { readonly id: number };
		readonly text?: string;
		readonly web_app_data?: { readonly data: string; readonly button_text: string };
	};
	readonly callback?: { readonly id: string; readonly data: string };
	readonly member_changed?: { readonly chat: { readonly id: number }; readonly member: { readonly status: string } };
}

/** The bot's side: Bot API calls with its token. */
class TestBot {
	private offset = 0;
	private readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
		const form = body instanceof FormData;
		const response = await fetch(`${WEB_ORIGIN}/bot/v1${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined || form ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
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
	const botId = Number(new URL(page.url()).pathname.split("/")[2]);

	// The sign-in is older than 10 minutes as far as the server knows: sign in again at the fake IdP.
	await page.getByRole("button", { name: "Cấp token" }).click();
	const reauth = page.getByRole("dialog", { name: "Đăng nhập lại để tiếp tục" });
	await reauth.getByRole("link", { name: "Đăng nhập lại" }).click();
	await page.getByRole("link", { name: "Đăng nhập là An @an" }).click();
	// Back on the console, the token is issued only from the confirmation.
	const ask = page.getByRole("dialog", { name: "Cấp token cho Echo Bot?" });
	await ask.getByRole("button", { name: "Cấp token" }).click();
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
	await link.getByRole("button", { name: "Gửi /start" }).click();
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
	echo = { bot, botId, chatId };
});

const HOOK_SECRET = "e2e_hook-secret";

/** The bot's webhook: checks each request like a bot's server should and answers with a reply. */
function startReceiver(received: Update[]): Promise<Server> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const timestamp = String(req.headers["x-bot-timestamp"] ?? "");
			const signature = String(req.headers["x-bot-signature"] ?? "");
			const expected = "v1=" + createHmac("sha256", HOOK_SECRET).update(`${timestamp}.`).update(body).digest("hex");
			const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
			const signed = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
			if (req.headers["x-bot-api-secret-token"] !== HOOK_SECRET || !signed || !fresh) {
				res.writeHead(401).end();
				return;
			}
			const update = JSON.parse(body.toString("utf8")) as Update;
			received.push(update);
			const text = update.message?.text ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ method: "sendMessage", chat_id: update.message?.chat.id, text: `Webhook nhận: ${text}` }));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

scenario("the bot receives updates at a webhook and replies in its answer", () => [an], async () => {
	assert.ok(echo !== null, "the first scenario sets up the bot");
	const { bot, botId, chatId } = echo;
	const { page } = an;
	const received: Update[] = [];
	const receiver = await startReceiver(received);
	try {
		const port = (receiver.address() as AddressInfo).port;
		await bot.call("PUT", "/webhook", { url: `http://127.0.0.1:${port}/hook`, secret: HOOK_SECRET, allowed_updates: ["message"], drop_pending: true });
		// While the webhook is set, long polling is refused.
		await assert.rejects(bot.call("GET", "/updates"), /409/);

		await page.goto(`${WEB_ORIGIN}/c/${chatId}`);
		await send(an, "ping qua webhook");
		await message(an, "Webhook nhận: ping qua webhook").waitFor();
		assert.ok(received.some((update) => update.message?.text === "ping qua webhook"));

		// The owner sees the webhook working in the Developer Console.
		await page.goto(`${WEB_ORIGIN}/console/${botId}/updates`);
		const status = page.getByRole("region", { name: "Trạng thái webhook" });
		await status.getByText("Đang hoạt động").waitFor();
		const form = page.getByRole("form", { name: "Nhận update" });
		assert.equal(await form.getByLabel("URL webhook").inputValue(), `http://127.0.0.1:${port}/hook`);
		await page.getByRole("link", { name: "Số liệu" }).click();
		const stats = page.getByRole("region", { name: "Số liệu gửi · 24 giờ qua" });
		await stats.getByText("Đã giao", { exact: true }).waitFor();

		// Back to long polling from the Console.
		await page.getByRole("link", { name: "Nhận update" }).click();
		await form.getByRole("button", { name: "Long poll" }).click();
		await form.getByRole("button", { name: "Lưu" }).click();
		await page.locator(".toast", { hasText: "Đã lưu cách nhận update" }).waitFor();
		await page.getByRole("region", { name: "Trạng thái long poll" }).waitFor();
		const info = await bot.call<{ url: string }>("GET", "/webhook");
		assert.equal(info.url, "");
		await bot.call("GET", "/updates");
	} finally {
		await new Promise<void>((resolve) => receiver.close(() => resolve()));
	}
});

/** A 2×2 PNG, small enough to inline. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YRMFRAwQCgAoDgV5D3pylwAAAABJRU5ErkJggg==",
	"base64",
);

interface SentMessage {
	readonly seq: number;
	readonly edit_date?: number;
	readonly media?: { readonly kind: string; readonly file_id: string };
}

/** No horizontal scrolling in the page nor in the command menu. */
async function noSideScroll(person: Person): Promise<void> {
	const wide = await person.page.evaluate(() => {
		const root = document.scrollingElement;
		const menu = document.querySelector(".cmd-menu ul");
		return [root !== null && root.scrollWidth > root.clientWidth, menu !== null && menu.scrollWidth > menu.clientWidth];
	});
	assert.deepEqual(wide, [false, false], "something scrolls sideways");
}

scenario("the bot edits its message, sends a photo, and offers its commands in a group", () => [an], async () => {
	assert.ok(echo !== null, "the first scenario sets up the bot");
	const { bot, chatId } = echo;
	const { page } = an;
	await page.goto(`${WEB_ORIGIN}/c/${chatId}`);

	// Edit: new text and a new inline keyboard on the same message.
	const sent = await bot.call<SentMessage>("POST", "/messages", {
		chat_id: chatId,
		text: "Đang xử lý yêu cầu…",
		reply_markup: { inline_keyboard: [[{ text: "Huỷ", callback_data: "cancel" }]] },
	});
	await message(an, "Đang xử lý yêu cầu…").getByRole("button", { name: "Huỷ" }).waitFor();
	const edited = await bot.call<SentMessage>("POST", "/messages:edit", {
		chat_id: chatId,
		seq: sent.seq,
		text: "*Xong* rồi",
		parse_mode: "markdown",
		reply_markup: { inline_keyboard: [[{ text: "Xem kết quả", url: "https://docs.example.com/result" }]] },
	});
	assert.ok((edited.edit_date ?? 0) > 0);
	const done = message(an, "Xong rồi");
	await done.getByRole("link", { name: "Xem kết quả" }).waitFor();
	assert.equal(await message(an, "Đang xử lý yêu cầu…").count(), 0);
	assert.equal(await done.getByRole("button", { name: "Huỷ" }).count(), 0);

	// A photo uploaded with multipart, shown to An like any photo.
	const form = new FormData();
	form.set("chat_id", String(chatId));
	form.set("kind", "photo");
	form.set("text", "Ảnh từ bot");
	form.set("file", new Blob([PNG], { type: "image/png" }), "anh.png");
	const photo = await bot.call<SentMessage>("POST", "/messages:sendMedia", form);
	assert.equal(photo.media?.kind, "photo");
	await message(an, "Ảnh từ bot").locator("img").first().waitFor();
	const file = await bot.call<{ url: string; size: number }>("GET", `/files/${photo.media?.file_id ?? ""}`);
	assert.ok(file.size > 0);
	const download = await fetch(file.url);
	assert.equal(download.status, 200);

	// The group command menu: the bot's GROUP commands, picked as "/ping" (one bot).
	await bot.call("PUT", "/commands", {
		scope: "group",
		commands: [
			{ command: "ping", description: "Kiểm tra bot còn chạy" },
			{ command: "help", description: "Hướng dẫn dùng bot trong nhóm, các lệnh và cách gọi đúng bot khi nhóm có nhiều bot" },
		],
	});
	const group = "Nhóm có bot E2E";
	await page.getByRole("button", { name: "Tạo chat mới" }).first().click();
	await page.getByRole("dialog", { name: "Chat mới" }).getByRole("button", { name: "Tạo nhóm" }).click();
	const dialog = page.getByRole("dialog", { name: "Tạo nhóm" });
	await dialog.getByLabel(/Tên nhóm/).fill(group);
	await dialog.getByPlaceholder("Nhập tên, username hoặc email").fill("e2e_echo_bot");
	await dialog.getByRole("checkbox", { name: /Echo Bot/ }).click();
	await dialog.getByRole("button", { name: /^Tạo nhóm · / }).click();
	const box = composer(an);
	await box.waitFor();
	const joined = await bot.next((update) => update.member_changed?.member.status === "member");
	const groupId = joined.member_changed?.chat.id ?? 0;
	// The new group opens with its info column; close it so the chat fills the screen.
	const info = page.getByRole("complementary", { name: "Thông tin nhóm" });
	if (await info.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
		await page.getByRole("button", { name: "Thông tin chat" }).click();
	}
	await info.waitFor({ state: "detached" });
	await page.locator(".toast.show").waitFor({ state: "detached" });
	await page.setViewportSize({ width: 1333, height: 780 });
	await page.getByRole("button", { name: "Lệnh của bot" }).click();
	const list = page.getByRole("listbox", { name: "Lệnh của bot" });
	await list.getByRole("option", { name: /\/ping/ }).waitFor();
	assert.equal(await list.getByRole("option").count(), 2);
	await noSideScroll(an);
	const shots = process.env.E2E_SHOTS_DIR;
	if (shots !== undefined && shots !== "") {
		await page.screenshot({ path: join(shots, "group-command-menu-1333x780.png") });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await list.getByRole("option", { name: /\/help/ }).waitFor();
	await noSideScroll(an);
	if (shots !== undefined && shots !== "") {
		await page.screenshot({ path: join(shots, "group-command-menu-390x844.png") });
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	await box.press("p");
	await box.press("Enter");
	await message(an, "/ping").waitFor();
	const ping = await bot.next((update) => update.message?.text === "/ping");
	assert.equal(ping.message?.chat.id, groupId);
});

/** Nothing on the screen, the Mini App's header, its menu or chip scrolls sideways. */
async function noMiniAppSideScroll(person: Person): Promise<void> {
	const wide = await person.page.evaluate(() =>
		[document.scrollingElement, ...document.querySelectorAll(".mini-app:not([hidden]) .ma-head, .ma-head .menu, .ma-chip")]
			.filter((element) => element !== null)
			.filter((element) => element.scrollWidth > element.clientWidth)
			.map((element) => element.className || element.nodeName),
	);
	assert.deepEqual(wide, [], "something scrolls sideways");
}

/** The developer's Mini App: served by the browser context at an https origin of its own. */
const SHOP = "https://shop.example.com";
const SHOP_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Cửa hàng</title>
<script src="${SHOP}/sdk.js"></script>
<p id="init"></p>
<p id="events"></p>
<script>
	document.getElementById("init").textContent = ChatApp.initData;
	for (const type of ["deactivated", "activated"]) {
		ChatApp.onEvent(type, () => (document.getElementById("events").textContent += \`\${type}:\${ChatApp.isActive} \`));
	}
	ChatApp.MainButton.setText("Đặt hàng").show().onClick(() => ChatApp.sendData("order-42"));
	ChatApp.ready();
</script>`;

scenario("open a Mini App from a button, check its init data, send data to the bot", () => [an], async () => {
	assert.ok(echo !== null, "needs the bot of the first scenario");
	const { bot, botId, chatId } = echo;
	const { page } = an;
	const sdk = readFileSync(new URL("../../public/miniapp/sdk.js", import.meta.url), "utf8");
	await page.context().route(`${SHOP}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/sdk.js") return route.fulfill({ contentType: "text/javascript", body: sdk });
		if (path === "/app") return route.fulfill({ contentType: "text/html", body: SHOP_PAGE });
		return route.fulfill({ status: 404 });
	});

	// A Mini App URL on the app's own host is refused.
	await assert.rejects(
		bot.call("POST", "/messages", {
			chat_id: chatId,
			text: "Không được",
			reply_markup: { inline_keyboard: [[{ text: "Mở", web_app: { url: "https://localhost/app" } }]] },
		}),
	);
	await bot.call("POST", "/messages", {
		chat_id: chatId,
		text: "Mời bạn xem cửa hàng.",
		reply_markup: { inline_keyboard: [[{ text: "Mở cửa hàng", web_app: { url: `${SHOP}/app` } }]] },
	});
	await page.goto(`${WEB_ORIGIN}/c/${chatId}`);
	await message(an, "Mời bạn xem cửa hàng.").getByRole("button", { name: "Mở cửa hàng" }).click();

	const panel = page.getByRole("region", { name: "Mini App của Echo Bot" });
	await panel.getByText("shop.example.com").waitFor();
	const app = page.frameLocator('iframe[title="Mini App của Echo Bot"]');
	const initData = (await app.locator("#init").textContent()) ?? "";
	const { public_key: key } = await bot.call<{ public_key: string }>("GET", "/miniAppKey");
	const verified = verifyMiniAppInitData(initData, botId, key);
	assert.ok(verified !== null, "init data signed by the server");
	assert.equal(verified.chat_type, "private");
	assert.equal(verified.user.first_name, "An");
	assert.equal(verifyMiniAppInitData(initData.replace("chat_type=private", "chat_type=group"), botId, key), null);

	// Docked in the info column's place, its menu, minimized to the chip (or the pill when narrow) and back.
	const shots = process.env.E2E_SHOTS_DIR;
	const chipRestore = page.getByRole("button", { name: "Mở lại Echo Bot · Mini App" });
	const events = app.locator("#events");
	let expected = "";
	for (const [width, height] of [[1280, 720], [1366, 768], [390, 844]] as const) {
		await page.setViewportSize({ width, height });
		const size = `${width}x${height}`;
		await panel.waitFor();
		await noMiniAppSideScroll(an);
		if (width > 760) {
			// The chat column narrows beside it: the panel and the conversation do not overlap.
			const [panelBox, convoBox] = await Promise.all([panel.boundingBox(), page.locator(".app > .convo").boundingBox()]);
			assert.ok(panelBox !== null && convoBox !== null);
			assert.ok(convoBox.x + convoBox.width <= panelBox.x + 1, `the Mini App covers the conversation at ${size}`);
		} else {
			const box = await panel.boundingBox();
			assert.deepEqual(box === null ? null : [box.width, box.height], [width, height], "full screen when narrow");
		}
		if (shots !== undefined && shots !== "") await page.screenshot({ path: join(shots, `mini-app-open-${size}.png`) });

		await panel.getByRole("button", { name: "Thêm thao tác" }).click();
		const menu = panel.getByRole("menu", { name: "Thao tác với Mini App" });
		assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Tải lại", "Thu nhỏ", "Hồ sơ bot", "Báo cáo bot"]);
		await noMiniAppSideScroll(an);
		if (shots !== undefined && shots !== "") await page.screenshot({ path: join(shots, `mini-app-menu-${size}.png`) });

		await menu.getByRole("menuitem", { name: "Thu nhỏ" }).click();
		await panel.waitFor({ state: "hidden" });
		await chipRestore.waitFor();
		// The frame is hidden now, still running: its page logged the event.
		expected += "deactivated:false ";
		await app.locator("#events", { hasText: expected }).waitFor({ state: "attached" });
		await noMiniAppSideScroll(an);
		if (shots !== undefined && shots !== "") await page.screenshot({ path: join(shots, `mini-app-minimized-${size}.png`) });
		if (width <= 760) {
			// The info column left open by the wide layout came back over the chat; back to the chat,
			// the pill floats just above the composer, clear of its send button.
			const back = page.getByRole("button", { name: "Về khung chat" });
			if (await back.isVisible()) await back.click();
			await page.getByRole("complementary", { name: "Thông tin bot" }).waitFor({ state: "detached" });
			const [pill, bar] = await Promise.all([page.locator(".ma-chip").boundingBox(), page.locator(".composer").boundingBox()]);
			assert.ok(pill !== null && bar !== null);
			assert.ok(pill.y + pill.height <= bar.y, "the pill covers the composer");
			await noMiniAppSideScroll(an);
			if (shots !== undefined && shots !== "") await page.screenshot({ path: join(shots, `mini-app-minimized-chat-${size}.png`) });
		}

		await chipRestore.click();
		await panel.waitFor();
		expected += "activated:true ";
		await app.locator("#events", { hasText: expected }).waitFor({ state: "attached" });
		// The frame kept running: same page, same init data.
		assert.equal(await app.locator("#init").textContent(), initData);
	}
	assert.equal(await events.textContent(), expected);
	await page.setViewportSize({ width: 1280, height: 800 });

	// The container draws the Mini App's main button; pressing it sends the data as An and closes the panel.
	const sent = bot.next((update) => update.message?.web_app_data !== undefined);
	await panel.getByRole("button", { name: "Đặt hàng" }).click();
	const update = await sent;
	assert.deepEqual(update.message?.web_app_data, { data: "order-42", button_text: "Mở cửa hàng" });
	assert.equal(update.message?.chat.id, chatId);
	await panel.waitFor({ state: "detached" });
	await page.getByRole("log", { name: "Tin nhắn" }).getByText("Đã gửi dữ liệu từ “Mở cửa hàng” tới bot").waitFor();
});
