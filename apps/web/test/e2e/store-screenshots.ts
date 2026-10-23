// App Store and Google Play screenshots of the real web app on the e2e stack
// (server/cmd/e2e-stack: fresh database, fake IdP, test accounts with made-up
// names, no personal data). Run it through the e2e runner, which starts and
// stops the stack:
//
//   pnpm store:screenshots      (= node apps/web/test/e2e/run.ts --store-screenshots)
//
// The other people (Bình, Chi, Giang) seed the chats from desktop windows;
// An is then signed in once per store size and photographed on each screen.
// Output: docs/store/screenshots/{ios-6.9,ios-6.5,android}/NN-<screen>.png.
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import {
	WEB_ORIGIN,
	chatInfo,
	composer,
	launch,
	message,
	messageMenu,
	messages,
	send,
	signIn,
	startPrivateChat,
	type AccountKey,
	type Person,
	type Screen,
} from "./people.ts";

const OUT_DIR = fileURLToPath(new URL("../../../../docs/store/screenshots/", import.meta.url));

/** Store sizes: CSS viewport × device scale = the pixels the stores ask for. */
const DEVICES: readonly { readonly dir: string; readonly screen: Screen }[] = [
	// App Store 6.9" (iPhone 16/17 Pro Max): 1320 × 2868.
	{ dir: "ios-6.9", screen: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
	// App Store 6.5" (iPhone 11 Pro Max class): 1284 × 2778.
	{ dir: "ios-6.5", screen: { viewport: { width: 428, height: 926 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
	// Google Play phone, 9:16: 1080 × 1920.
	{ dir: "android", screen: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
];

const GROUP = "Đà Lạt cuối tuần";
const CHANNEL = "Bản tin Chat";
const PHOTO_CAPTION = "Hoàng hôn ở hồ Tuyền Lâm chiều nay 🌅";
const PIN = "Lịch trình: 6h sáng thứ Bảy tập trung ở bến xe, trưa tới Đà Lạt";
const SEARCH = "da lat";

/** A made-up landscape (sky, sun, hills, lake) drawn in the browser: a photo with nobody's data in it. */
async function landscape(browser: Browser): Promise<Buffer> {
	const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
	try {
		await page.setContent(`<body style="margin:0;width:1600px;height:1200px;position:relative;overflow:hidden;
background:linear-gradient(#2b2d6e 0%,#8a4f9e 38%,#f08a5d 62%,#f9c784 72%)">
<div style="position:absolute;left:980px;top:560px;width:220px;height:220px;border-radius:50%;background:radial-gradient(#fff6d5,#ffd27a 60%,#f9a65a)"></div>
<div style="position:absolute;left:-200px;top:640px;width:1100px;height:500px;border-radius:50%;background:#3b2f5c"></div>
<div style="position:absolute;left:600px;top:690px;width:1400px;height:520px;border-radius:50%;background:#2a2347"></div>
<div style="position:absolute;left:0;top:840px;width:1600px;height:360px;background:linear-gradient(#f3a16b,#6b4a7e 45%,#2a2347)"></div>
<div style="position:absolute;left:1010px;top:860px;width:160px;height:300px;background:linear-gradient(rgba(255,230,170,.75),transparent);filter:blur(6px)"></div>
</body>`);
		return await page.screenshot({ type: "jpeg", quality: 88 });
	} finally {
		await page.close();
	}
}

/** Sends a photo with a caption in the open chat and waits until it is delivered. */
async function sendPhoto(person: Person, name: string, photo: Buffer, caption: string): Promise<void> {
	await person.page.getByTestId("pick-files").setInputFiles({ name, mimeType: "image/jpeg", buffer: photo });
	await person.page.getByRole("group", { name: "File sắp gửi" }).waitFor();
	const box = composer(person);
	await box.fill(caption);
	await box.press("Enter");
	await message(person, caption).waitFor();
	await message(person, caption).getByRole("img", { name: "Đang gửi" }).waitFor({ state: "detached" });
}

/** The invite link of the open group or channel, from its info column (created when there is none). */
async function inviteLink(person: Person, infoName: string | RegExp): Promise<string> {
	const info = await chatInfo(person, infoName);
	const create = info.getByRole("button", { name: "Tạo link mời" });
	if ((await create.count()) > 0) await create.click();
	const shown = await info.locator(".mid-trunc[title]").first().getAttribute("title");
	if (shown === null) throw new Error("store screenshots: no invite link shown");
	return new URL(shown.startsWith("http") ? shown : `http://${shown}`).pathname;
}

async function joinWithInvite(person: Person, invitePath: string, dialogName: string, button: string): Promise<void> {
	await person.page.goto(WEB_ORIGIN + invitePath);
	const dialog = person.page.getByRole("dialog", { name: dialogName });
	await dialog.getByRole("button", { name: button }).click();
	await dialog.waitFor({ state: "detached" });
}

const chatList = (person: Person) => person.page.getByRole("list", { name: "Danh sách chat" });

/**
 * Opens the chat titled `title` (started with the account `start` when given, else from the chat
 * list, matching the title exactly: previews like "An: …" must not match) and waits for its own
 * composer, not the one of the chat open before.
 */
async function chatWith(person: Person, title: string, start?: AccountKey): Promise<void> {
	if (start !== undefined) await startPrivateChat(person, start);
	else await chatList(person).getByRole("link").filter({ has: person.page.getByText(title, { exact: true }) }).first().click();
	await person.page.getByRole("textbox", { name: `Tin nhắn tới ${title}`, exact: true }).waitFor();
}

/** The chats An sees: a private chat with a photo, a group with a pinned plan, a channel, unread messages. */
async function seed(browser: Browser, photo: Buffer): Promise<void> {
	const binh = await signIn(browser, "binh");
	const chi = await signIn(browser, "chi");
	const giang = await signIn(browser, "giang");
	const an = await signIn(browser, "an");

	// The channel An runs.
	await an.page.getByRole("button", { name: "Tạo chat mới" }).first().click();
	await an.page.getByRole("dialog", { name: "Chat mới" }).getByRole("button", { name: "Tạo kênh" }).click();
	const channelDialog = an.page.getByRole("dialog", { name: "Tạo kênh" });
	await channelDialog.getByLabel("Tên kênh").fill(CHANNEL);
	await channelDialog.getByLabel("Mô tả").fill("Tin mới về app: tính năng, mẹo dùng và lịch bảo trì.");
	await channelDialog.getByRole("button", { name: "Tạo kênh" }).click();
	const post = an.page.getByRole("textbox", { name: "Bài đăng" });
	await post.fill("Mẹo: tìm tin nhắn không cần gõ dấu, ví dụ “da lat” vẫn ra “Đà Lạt”.");
	await post.press("Enter");
	await message(an, "Mẹo: tìm tin nhắn không cần gõ dấu").waitFor();
	const channelInvite = await inviteLink(an, "Thông tin kênh");
	for (const person of [binh, chi, giang]) await joinWithInvite(person, channelInvite, CHANNEL, "Tham gia kênh");

	// The group: An creates it, the others join with the invite link.
	await an.page.getByRole("button", { name: "Tạo chat mới" }).first().click();
	await an.page.getByRole("dialog", { name: "Chat mới" }).getByRole("button", { name: "Tạo nhóm" }).click();
	const groupDialog = an.page.getByRole("dialog", { name: "Tạo nhóm" });
	await groupDialog.getByLabel(/Tên nhóm/).fill(GROUP);
	await groupDialog.getByRole("button", { name: /^Tạo nhóm/ }).click();
	const invite = an.page.getByRole("dialog", { name: `Mời đồng đội vào ${GROUP}` });
	await invite.waitFor();
	await an.page.keyboard.press("Escape");
	await invite.waitFor({ state: "detached" });
	await composer(an).waitFor();
	const groupInvite = await inviteLink(an, "Thông tin nhóm");
	for (const person of [binh, chi, giang]) {
		await joinWithInvite(person, groupInvite, GROUP, "Tham gia nhóm");
		await composer(person).waitFor();
	}

	await send(an, "Chốt lịch đi Đà Lạt nha cả nhà!");
	await send(an, PIN);
	const menu = await messageMenu(an, PIN);
	await menu.getByRole("menuitem", { name: "Ghim" }).click();
	await an.page.getByRole("dialog", { name: "Ghim tin này?" }).getByRole("button", { name: "Ghim", exact: true }).click();
	await an.page.locator(".pinned", { hasText: "Lịch trình" }).first().waitFor();
	await send(chi, "Mình đặt homestay rồi nha, 3 phòng view đồi thông");
	await send(giang, "Ai mang loa không? Tối đốt lửa trại 🔥");
	await sendPhoto(binh, "ho-tuyen-lam.jpg", photo, "Thời tiết thứ Bảy: 18°C, nắng nhẹ, đẹp y như hôm trước");
	await send(chi, "Tuyệt vời 😍");
	await message(an, "Tuyệt vời 😍").waitFor();

	// Private chats An starts (the others' usernames are unique; "an" is a prefix of other accounts).
	await chatWith(an, "Chi", "chi");
	await send(an, "Chi ơi, tối nay họp nhóm mấy giờ nhỉ?");
	await chatWith(an, "Giang", "giang");
	await send(an, "Giang nhận được tài liệu chưa?");
	await chatWith(an, "Bình", "binh");
	await send(an, "Bình ơi, ảnh hôm qua đâu rồi?");

	// With Bình: a photo, a reaction and replies.
	await chatWith(binh, "An");
	await send(binh, "An ơi, xem ảnh này nè");
	await sendPhoto(binh, "hoang-hon.jpg", photo, PHOTO_CAPTION);
	await message(an, PHOTO_CAPTION).waitFor();
	await messageMenu(an, PHOTO_CAPTION);
	await an.page.getByRole("group", { name: "Thả cảm xúc" }).getByRole("button", { name: "Yêu thích", exact: true }).click();
	await message(binh, PHOTO_CAPTION).getByRole("button", { name: /❤️ 1 người/ }).waitFor();
	await send(an, "Đẹp quá! Cuối tuần mình lên đó luôn nhé");
	await send(binh, "Ok, nhóm chốt lịch rồi đó 👍");
	await message(an, "Ok, nhóm chốt lịch rồi đó 👍").waitFor();

	// Answers An has not read yet, so the list shows unread counts.
	await an.page.goto(WEB_ORIGIN + "/");
	await chatList(an).getByRole("link", { name: GROUP }).first().waitFor();
	await chatWith(chi, "An");
	await send(chi, "8h tối nha An, link họp mình gửi trong nhóm");
	await send(chi, "Nhớ mang theo kế hoạch tháng 11 nhé");
	await chatWith(giang, "An");
	await send(giang, "Nhận rồi, cảm ơn An nhiều!");
	await chatList(an).getByText("Nhận rồi, cảm ơn An nhiều!").waitFor();

	for (const person of [binh, chi, giang, an]) await person.context.close();
}

/** Waits for every image on the page to finish decoding, so no photo is a grey box. */
async function settle(page: Page): Promise<void> {
	await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	await page.waitForTimeout(400);
}

/** Scrolls the open conversation to its latest message (a chat with unread messages opens at the first unread one). */
async function scrollToLatest(person: Person): Promise<void> {
	await person.page.getByRole("log", { name: "Tin nhắn" }).evaluate((log) => {
		for (let el: HTMLElement | null = log as HTMLElement; el !== null; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "visible") {
				el.scrollTop = el.scrollHeight;
				return;
			}
		}
	});
}

interface Shot {
	readonly name: string;
	/** Puts An's page on the screen to photograph. */
	readonly open: (an: Person) => Promise<void>;
}

const SHOTS: readonly Shot[] = [
	{
		name: "01-chats",
		open: async (an) => {
			await an.page.goto(WEB_ORIGIN + "/");
			await chatList(an).getByRole("link", { name: GROUP }).first().waitFor();
		},
	},
	{
		name: "02-conversation",
		open: async (an) => {
			await an.page.goto(WEB_ORIGIN + "/");
			await chatWith(an, "Bình");
			await message(an, "Ok, nhóm chốt lịch rồi đó 👍").waitFor();
			await messages(an).locator("img").first().waitFor();
			await scrollToLatest(an);
		},
	},
	{
		name: "03-group",
		open: async (an) => {
			await an.page.goto(WEB_ORIGIN + "/");
			await chatWith(an, GROUP);
			await message(an, "Tuyệt vời 😍").waitFor();
			await an.page.locator(".pinned", { hasText: "Lịch trình" }).first().waitFor();
			await scrollToLatest(an);
		},
	},
	{
		name: "04-search",
		open: async (an) => {
			await an.page.goto(WEB_ORIGIN + "/");
			await an.page.getByRole("searchbox", { name: "Tìm chat và tin nhắn" }).fill(SEARCH);
			await an.page.locator(".sx-status", { hasText: "Đã gộp kết quả từ server" }).waitFor();
			await an.page.getByRole("list", { name: "Kết quả tìm kiếm" }).locator("mark").first().waitFor();
			await an.page.getByRole("searchbox", { name: "Tìm chat và tin nhắn" }).blur();
		},
	},
	{
		name: "05-privacy",
		open: async (an) => {
			await an.page.goto(WEB_ORIGIN + "/settings/privacy");
			await an.page.getByRole("heading", { name: "Quyền riêng tư" }).first().waitFor();
		},
	},
];

/** On failure: every open page to E2E_SHOTS_DIR (default <tmp>/chat-e2e-shots), as the e2e scenarios do. */
async function saveFailureShots(browser: Browser): Promise<void> {
	const dir = process.env.E2E_SHOTS_DIR ?? join(tmpdir(), "chat-e2e-shots");
	await mkdir(dir, { recursive: true });
	let n = 0;
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			const path = join(dir, `store-screenshots-${++n}.png`);
			await page.screenshot({ path }).then(
				() => console.error(`store screenshots: page at failure ${path}`),
				() => {},
			);
		}
	}
}

async function main(): Promise<void> {
	const browser = await launch();
	try {
		await seed(browser, await landscape(browser));
		const people = await Promise.all(DEVICES.map((device) => signIn(browser, "an", device.screen)));
		await rm(OUT_DIR, { recursive: true, force: true });
		for (const device of DEVICES) await mkdir(join(OUT_DIR, device.dir), { recursive: true });
		// Screen by screen, so every size photographs the chat list before any of them reads the chats.
		for (const shot of SHOTS) {
			for (const [index, device] of DEVICES.entries()) {
				const an = people[index];
				if (an === undefined) throw new Error(`store screenshots: no browser for ${device.dir}`);
				await shot.open(an);
				await settle(an.page);
				const file = join(OUT_DIR, device.dir, `${shot.name}.png`);
				await an.page.screenshot({ path: file, animations: "disabled", caret: "hide" });
				console.log(`store screenshots: ${file}`);
			}
		}
	} catch (err) {
		await saveFailureShots(browser);
		throw err;
	} finally {
		await browser.close();
	}
}

await main();
