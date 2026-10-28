// Settings > Tài khoản end to end. An asks for a personal data export,
// waits for the background build and downloads the ZIP from the media host
// (JSON, the offline HTML index and the message files). Khoa, who wrote to
// Bình, deletes the chat account: a fresh IdP sign-in, the typed username,
// then every device is signed out; signing in again within the grace period
// offers only "Huỷ xoá tài khoản", which brings everything back. Khoa
// deletes it again, the stack fast-forwards the 30 days (POST /e2e/privacy),
// and Bình still has Khoa's message, now from "Tài khoản đã xoá".
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
});

/** Deletes the account from the open Tài khoản tab, through the reauth sign-in. */
async function deleteAccount(person: Person): Promise<void> {
	const { page } = person;
	await page.getByRole("button", { name: "Xoá tài khoản chat" }).click();
	const reauth = page.getByRole("dialog", { name: "Đăng nhập lại để tiếp tục" });
	await reauth.getByRole("link", { name: "Đăng nhập lại" }).click();
	await page.getByRole("link", { name: `Đăng nhập là ${person.name} @${person.username}` }).click();
	// Back on the tab, the confirmation opens; it deletes only from its own button.
	const confirm = page.getByRole("dialog", { name: "Xoá tài khoản chat?" });
	await confirm.waitFor();
	const submit = confirm.getByRole("button", { name: "Xoá tài khoản" });
	assert.equal(await submit.isDisabled(), true);
	await confirm.getByRole("textbox", { name: `Gõ ${person.username} để xác nhận` }).fill(person.username);
	await submit.click();
	await page.getByRole("link", { name: "Đăng nhập bằng hoandat.com" }).waitFor();
}

async function signInAgain(person: Person): Promise<void> {
	const { page } = person;
	await page.getByRole("link", { name: "Đăng nhập bằng hoandat.com" }).click();
	await page.getByRole("link", { name: `Đăng nhập là ${person.name} @${person.username}` }).click();
}

scenario("delete the chat account, cancel within the grace period, delete again", () => [khoa, binh], async () => {
	const { page } = khoa;
	await startPrivateChat(khoa, "binh");
	await send(khoa, "Chào Bình, mình là Khoa");
	await openAccount(page);
	await deleteAccount(khoa);

	// Signing in again within 30 days: only the way back.
	await signInAgain(khoa);
	await page.getByRole("heading", { name: "Tài khoản chat đang chờ xoá" }).waitFor();
	await noSideScroll(page);
	await page.getByRole("button", { name: "Huỷ xoá tài khoản" }).click();
	await page.getByRole("searchbox", { name: /Tìm/ }).first().waitFor();
	await openChat(khoa, "Bình");
	await message(khoa, "Chào Bình, mình là Khoa").waitFor();

	await openAccount(page);
	await deleteAccount(khoa);
	const purge = await fetch(`${API_ORIGIN}/e2e/privacy?action=purge`, { method: "POST" });
	assert.equal(purge.status, 204);

	// Bình keeps the message, from a deleted account.
	await binh.page.goto(WEB_ORIGIN + "/");
	await binh.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link", { name: "Tài khoản đã xoá" }).first().click();
	await message(binh, "Chào Bình, mình là Khoa").waitFor();
	await binh.page.getByText("Không nhắn tin được cho tài khoản đã xoá.").waitFor();

	// Signing in again now makes a new, empty account named after the IdP.
	await signInAgain(khoa);
	await page.getByRole("searchbox", { name: /Tìm/ }).first().waitFor();
	assert.equal(await page.getByRole("heading", { name: "Tài khoản chat đang chờ xoá" }).count(), 0);
});
