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

scenario("switching chats keeps the place the reader left, as Telegram does; a chat left at its newest message opens there", () => [hanh, giang], async () => {
	// Their chat is there from the scenarios above.
	await openChat(hanh, "Giang");
	for (let i = 1; i <= 40; i++) await send(hanh, `cuộn ${i}`);
	await openChat(giang, "Hạnh");
	const log = giang.page.getByRole("log", { name: "Tin nhắn" });
	await message(giang, "cuộn 40").waitFor();
	// The first message whose row is at the list's top, and how far its top sits above it.
	const top = () =>
		log.evaluate((list) => {
			const rows = [...list.querySelectorAll<HTMLElement>("[data-key][data-seq]")];
			const first = rows.find((row) => row.offsetTop + row.offsetHeight > list.scrollTop);
			return { seq: first?.dataset.seq ?? "", offset: Math.round((first?.offsetTop ?? 0) - list.scrollTop), bottom: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
		});
	// Scrolled up to the middle, then another chat, then back: the same message at the same place.
	await log.evaluate((list) => {
		list.scrollTop = Math.round((list.scrollHeight - list.clientHeight) / 2);
		list.dispatchEvent(new Event("scroll"));
	});
	const left = await top();
	assert.ok(left.bottom > 200, "scrolled away from the newest message");
	await startPrivateChat(giang, "chi");
	await openChat(giang, "Hạnh");
	await message(giang, "cuộn 40").waitFor({ state: "attached" });
	await giang.page.waitForTimeout(300);
	const back = await top();
	assert.equal(back.seq, left.seq);
	assert.ok(Math.abs(back.offset - left.offset) <= 2, `offset ${back.offset} vs ${left.offset}`);
	// Back at the newest message and away again: it opens at the newest.
	await log.evaluate((list) => {
		list.scrollTop = list.scrollHeight;
		list.dispatchEvent(new Event("scroll"));
	});
	await startPrivateChat(giang, "chi");
	await openChat(giang, "Hạnh");
	await giang.page.waitForTimeout(300);
	assert.ok((await top()).bottom < 40, "opened at the newest message");
});
