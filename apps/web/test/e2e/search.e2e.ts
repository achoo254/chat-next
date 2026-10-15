// Message search across people (release R4): a message is found without
// accents by the person it was sent to, also by the inside of its words
// ("uần" in "tuần"), also from the server on a device that never synced it,
// and never by someone outside the chat.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { launch, message, scenario, send, signIn, startPrivateChat, type Person } from "./people.ts";

let browser: Browser;
let an: Person;
let binh: Person;
/** Bình on a second, brand-new device. */
let binhNew: Person | undefined;
let chi: Person | undefined;

const people = (): Person[] => [an, binh, binhNew, chi].filter((person): person is Person => person !== undefined);

before(async () => {
	browser = await launch();
	binh = await signIn(browser, "binh");
	an = await signIn(browser, "an");
});
after(async () => {
	await browser.close();
});

/** Types the query into the chat list search and returns the message results once the server's are merged. */
async function searchMessages(person: Person, query: string) {
	const box = person.page.getByRole("searchbox", { name: "Tìm chat và tin nhắn" });
	await box.fill(query);
	await person.page.locator(".sx-status", { hasText: "Đã gộp kết quả từ server" }).waitFor();
	return person.page.getByRole("list", { name: "Kết quả tìm kiếm" });
}

/** An's message exactly (the group scenario pins a longer one that starts the same way). */
const AN_MESSAGE = /Lịch trực tuần này$/;

scenario("Bình finds An's message without accents, also from the server on a new device; Chi, outside the chat, finds nothing", people, async () => {
	await startPrivateChat(an, "binh");
	await send(an, "Lịch trực tuần này");
	// A newer message: a new device syncs only the newest message of each chat.
	await send(an, "Nhớ xem nhé");

	const results = await searchMessages(binh, "lich truc");
	const hit = results.getByRole("button").filter({ hasText: AN_MESSAGE });
	await hit.waitFor();
	await hit.locator("mark", { hasText: "Lịch" }).waitFor();

	// Inside a word, highlighted where it matched.
	const inside = (await searchMessages(binh, "uần")).getByRole("button").filter({ hasText: AN_MESSAGE });
	await inside.waitFor();
	await inside.locator("mark", { hasText: /^uần$/ }).waitFor();

	binhNew = await signIn(browser, "binh");
	// Inside words, from the server: this device never synced the message.
	const insideFromServer = (await searchMessages(binhNew, "ruc tu")).getByRole("button").filter({ hasText: AN_MESSAGE });
	await insideFromServer.getByText("từ server").waitFor();
	await insideFromServer.locator("mark", { hasText: /^rực$/ }).waitFor();
	const fromServer = (await searchMessages(binhNew, "lich truc")).getByRole("button").filter({ hasText: AN_MESSAGE });
	await fromServer.getByText("từ server").waitFor();
	// Opening it jumps to the message in the chat.
	await fromServer.click();
	await message(binhNew, "Lịch trực tuần này").waitFor();

	// Chi is not in the chat (and was removed from the group of the group scenario).
	chi = await signIn(browser, "chi");
	await searchMessages(chi, "lich truc");
	await chi.page.getByText("Không có kết quả cho “lich truc”").waitFor();
	assert.equal(await chi.page.getByRole("list", { name: "Kết quả tìm kiếm" }).count(), 0, "Chi sees message results");
	await searchMessages(chi, "uần");
	await chi.page.getByText("Không có kết quả cho “uần”").waitFor();
	assert.equal(await chi.page.getByRole("list", { name: "Kết quả tìm kiếm" }).count(), 0, "Chi sees results inside words");
});
