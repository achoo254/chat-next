// Unread state between two people, with the reader on two devices: the
// "Tin chưa đọc" divider after the reader's own replies, reading in an open
// chat, and a read on one device clearing the badges on the other.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Browser, Locator } from "playwright";
import { launch, message, openChat, scenario, send, signIn, startPrivateChat, type Person } from "./people.ts";

let browser: Browser;
let hanh: Person;
let giang: Person;
let giangPhone: Person;

before(async () => {
	browser = await launch();
	hanh = await signIn(browser, "hanh");
	// One after the other: the first sign-in creates the account.
	giang = await signIn(browser, "giang");
	giangPhone = await signIn(browser, "giang");
});
after(async () => {
	await browser.close();
});

function hanhRow(person: Person): Locator {
	return person.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link", { name: /Hạnh/ });
}

scenario("the divider sits below the reader's own replies, at the first message they have not read", () => [hanh, giang, giangPhone], async () => {
	await startPrivateChat(hanh, "giang");
	for (const text of ["Giang ơi, tin một", "tin hai", "tin ba"]) await send(hanh, text);

	await hanhRow(giang).locator(".badge", { hasText: "3" }).waitFor();
	await openChat(giang, "Hạnh");
	const log = giang.page.getByRole("log", { name: "Tin nhắn" });
	await log.locator(".unread-div + *", { hasText: "Giang ơi, tin một" }).waitFor();
	await hanhRow(giang).locator(".badge").waitFor({ state: "detached" });

	// Giang answers, reads a new message in the open chat, answers again.
	await send(giang, "Giang trả lời lần một");
	await send(hanh, "tin năm");
	await message(giang, "tin năm").waitFor();
	await send(giang, "Giang trả lời lần hai");
	await hanhRow(giang).locator(".badge").waitFor({ state: "detached" });

	// Away from the chat, one more message arrives.
	await startPrivateChat(giang, "chi");
	await send(hanh, "tin bảy, chưa đọc");
	await hanhRow(giang).locator(".badge", { hasText: "1" }).waitFor();
	await hanhRow(giangPhone).locator(".badge", { hasText: "1" }).waitFor();

	// Back in the chat: the divider is above the one unread message, not
	// above the first message of the earlier opening.
	await openChat(giang, "Hạnh");
	await log.locator(".unread-div + *", { hasText: "tin bảy, chưa đọc" }).waitFor();
	assert.equal(await log.locator(".unread-div").count(), 1);
});

scenario("reading on one device clears the badges on the other", () => [hanh, giang, giangPhone], async () => {
	// Giang read "tin bảy" on the computer in the scenario above.
	await hanhRow(giangPhone).locator(".badge").waitFor({ state: "detached" });
	await giangPhone.page.waitForFunction(() => !document.title.startsWith("("));
	const rail = giangPhone.page.getByRole("navigation", { name: "Thư mục chat" });
	assert.equal(await rail.locator(".badge").count(), 0);

	// And the other way round: read on the phone, cleared on the computer.
	await startPrivateChat(giang, "chi");
	await send(hanh, "tin tám");
	await hanhRow(giang).locator(".badge", { hasText: "1" }).waitFor();
	await giang.page.waitForFunction(() => document.title.startsWith("(1)"));
	await openChat(giangPhone, "Hạnh");
	await message(giangPhone, "tin tám").waitFor();
	await hanhRow(giang).locator(".badge").waitFor({ state: "detached" });
	await giang.page.waitForFunction(() => !document.title.startsWith("("));
});
