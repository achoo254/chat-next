// The assistant bot for an account that existed before it: Hạnh signs in on
// two devices while the assistant is off (the e2e stack's switch,
// server/cmd/e2e-stack/assistant_switch.go), so both hold a synced list with
// only "Cloud của tôi". Then the assistant is released: the next app start
// on one device creates the chat, and the other device, still running, gets
// it live. Both name the bot in the list (never "Chat đã xoá") and open it
// on the bot's profile with "Bắt đầu".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { launch, scenario, signIn, type Person } from "./people.ts";

/** The api of the e2e stack, where its switches live (Vite does not proxy them). */
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? "http://127.0.0.1:4600";
const brand = JSON.parse(readFileSync(new URL("../../../../brand.config.json", import.meta.url), "utf8")) as { shortName: string };
const ASSISTANT = `${brand.shortName} Trợ lý`;

let browser: Browser;
let hanh: Person;
let hanhPhone: Person;

async function assistant(state: "off" | "on"): Promise<void> {
	const response = await fetch(`${API_ORIGIN}/e2e/assistant?state=${state}`, { method: "POST" });
	assert.equal(response.status, 204, `assistant ${state}`);
}

before(async () => {
	browser = await launch();
	await assistant("off");
	hanh = await signIn(browser, "hanh");
	hanhPhone = await signIn(browser, "hanh");
});
after(async () => {
	await assistant("on").catch(() => undefined);
	await browser.close();
});

async function expectAssistantChat(person: Person): Promise<void> {
	const list = person.page.getByRole("list", { name: "Danh sách chat" });
	const row = list.getByRole("link").filter({ hasText: ASSISTANT });
	await row.waitFor();
	assert.equal(await list.getByText("Chat đã xoá").count(), 0, `${person.key}: a nameless chat in the list`);
	await row.click();
	await person.page.getByRole("button", { name: "Bắt đầu", exact: true }).waitFor();
	await person.page.locator(".convo-head").getByText(ASSISTANT).first().waitFor();
	assert.equal(await person.page.getByText("Chat đã xoá").count(), 0, `${person.key}: a nameless chat`);
}

scenario("an existing account gets the assistant on its next start and live on its other device", () => [hanh, hanhPhone], async () => {
	for (const person of [hanh, hanhPhone]) {
		const rows = person.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link");
		await rows.nth(0).filter({ hasText: "Cloud của tôi" }).waitFor();
		assert.equal(await rows.filter({ hasText: ASSISTANT }).count(), 0, `${person.key}: the assistant before its release`);
	}

	await assistant("on");
	await hanh.page.reload();
	await hanh.page.getByRole("searchbox", { name: /Tìm/ }).first().waitFor();

	await expectAssistantChat(hanh);
	await expectAssistantChat(hanhPhone);
});
