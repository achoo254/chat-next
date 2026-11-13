// Settings > Tài khoản end to end. An asks for a personal data export,
// waits for the background build and downloads the ZIP from the media host
// (JSON, the offline HTML index and the message files); the tab has no
// deletion of its own, only a link to the IdP's account page. Khoa, who
// wrote to Bình, deletes the account at the IdP (the stack plays the IdP's
// signed event, POST /e2e/privacy): Khoa's device is signed out at once and
// Bình still has Khoa's message, now from "Tài khoản đã xoá".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before } from "node:test";
import type { Browser, Page } from "playwright";
import { launch, message, openChat, scenario, send, signIn, startPrivateChat, WEB_ORIGIN, type Person } from "./people.ts";

const API_ORIGIN = process.env.E2E_API_ORIGIN ?? "http://127.0.0.1:4600";

let browser: Browser;
let an: Person;
let binh: Person;
let khoa: Person;

before(async () => {
	browser = await launch();
	[an, binh, khoa] = await Promise.all([signIn(browser, "an"), signIn(browser, "binh"), signIn(browser, "khoa")]);
});
after(async () => {
	await browser.close();
});

async function openAccount(page: Page): Promise<void> {
	await page.getByRole("link", { name: "Cài đặt" }).first().click();
	await page.getByRole("link", { name: "Tài khoản" }).click();
	await page.getByRole("heading", { name: "Xuất dữ liệu cá nhân" }).waitFor();
}

/** No horizontal scrolling at the two reference sizes (Windows 150% laptop, phone). */
async function noSideScroll(page: Page): Promise<void> {
	for (const size of [
		{ width: 1333, height: 780 },
		{ width: 390, height: 844 },
	]) {
		await page.setViewportSize(size);
		const wide = await page.evaluate(() => {
			const root = document.scrollingElement;
			const main = document.querySelector(".set-main");
			return [root !== null && root.scrollWidth > root.clientWidth, main !== null && main.scrollWidth > main.clientWidth];
		});
		assert.deepEqual(wide, [false, false], `something scrolls sideways at ${size.width}x${size.height}`);
	}
	await page.setViewportSize({ width: 1280, height: 800 });
}

scenario("ask for a data export and download the ZIP", () => [an], async () => {
	const { page } = an;
	// A note in An's own Cloud: nothing another scenario's chats depend on.
	await openChat(an, "Cloud của tôi");
	await send(an, "Ghi chú để xuất dữ liệu");
	await openAccount(page);
	await noSideScroll(page);
	const card = page.locator(".card", { has: page.getByRole("heading", { name: "Xuất dữ liệu cá nhân" }) });
	await card.getByRole("button", { name: "Yêu cầu" }).click();
	await page.locator(".toast", { hasText: "Đã yêu cầu bản xuất" }).waitFor();
	const download = card.getByRole("button", { name: "Tải xuống" });
	await download.waitFor({ timeout: 60_000 });
	assert.equal(await card.getByRole("button", { name: "Yêu cầu" }).isDisabled(), true, "a second request within 7 days");
	const saved = page.waitForEvent("download");
	await download.click();
	const file = await saved;
	assert.match(file.suggestedFilename(), /^chat-export-an\d*-\d{8}\.zip$/);
	const path = await file.path();
	const zip = await readFile(path);
	assert.equal(zip.subarray(0, 4).toString("binary"), "PK\x03\x04", "a ZIP file");
	for (const name of ["README.txt", "profile.json", "chats.json", "index.html"]) {
		assert.ok(zip.includes(Buffer.from(name)), `the ZIP holds ${name}`);
	}
	const idp = page.getByRole("link", { name: /^Xoá tài khoản hoandat\.com ở / });
	assert.equal(await idp.getAttribute("href"), "https://auth.hoandat.com/account#account-delete");
	assert.equal(await page.getByRole("button", { name: /Xoá tài khoản/ }).count(), 0, "no deletion button in the app");
});

scenario("the account is deleted at the IdP: erased at once", () => [khoa, binh], async () => {
	const { page } = khoa;
	await startPrivateChat(khoa, "binh");
	await send(khoa, "Chào Bình, mình là Khoa");

	const deleted = await fetch(`${API_ORIGIN}/e2e/privacy?action=idp-delete&sub=acc_e2e_khoa`, { method: "POST" });
	assert.equal(deleted.status, 202);

	// Every session ended: Khoa's device is back at the sign-in screen.
	await page.getByRole("link", { name: "Đăng nhập bằng hoandat.com" }).waitFor();
	// Bình keeps the message, from a deleted account.
	await binh.page.goto(WEB_ORIGIN + "/");
	await binh.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link", { name: "Tài khoản đã xoá" }).first().click();
	await message(binh, "Chào Bình, mình là Khoa").waitFor();
	await binh.page.getByText("Không nhắn tin được cho tài khoản đã xoá.").waitFor();
});
