// "Hiệu quả" in a real browser (Chromium) against the fake machine of the
// visual harness (test/support/remote-machine-demo.ts, whose usage side is
// test/support/fake-usage.ts): opened from the project's menu in the AI Agent
// column, it shows the totals, the context against the baseline and the
// suggestions; switching the experimental rule off drops its suggestion;
// deleting the ledger asks in the page first and then shows an empty report.
// On a phone the page fits the width. Starts its own Vite dev server of the
// harness, so it needs no backend:
//
//   node --test test/e2e/usage.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { viMachines } from "../../src/machines/copy-vi.ts";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports, the harness preview (5174) and the other harness e2e (5175 to 5177). */
const PORT = 5178;
const u = viMachines.usage;

let server: ViteDevServer;
let browser: Browser;

before(async () => {
	server = await createServer({ root: HARNESS, configFile: `${HARNESS}vite.config.ts`, logLevel: "warn", server: { port: PORT, strictPort: true } });
	await server.listen();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

type Fake = { seen: string[]; deleted: boolean };

async function until(page: Page, what: string, check: () => boolean, timeout = 15_000): Promise<void> {
	await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(`timed out waiting for ${what}`));
}

test("opened from the project's menu: totals, baseline, suggestions, a rule off, the ledger deleted after asking", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1333, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	page.on("dialog", (dialog) => {
		errors.push(`browser dialog: ${dialog.message()}`);
		void dialog.dismiss();
	});
	await page.goto(`http://localhost:${PORT}/?at=machine-home`);
	const menu = page.getByRole("button", { name: viMachines.agent.projects.menu("chat-next") });
	await menu.waitFor({ timeout: 30_000 });
	await menu.click();
	await page.getByRole("menuitem", { name: u.open }).click();
	await page.waitForURL((url) => url.pathname === `/ai/1/usage/${encodeURIComponent("local:chat-next")}`);

	const region = page.getByRole("region", { name: u.title });
	const totals = region.getByRole("table");
	await totals.waitFor();
	assert.deepEqual(await totals.getByRole("row", { name: new RegExp(`^${u.mainTurns}`) }).getByRole("cell").allTextContents(), ["65", "125"]);
	const context30 = region.getByRole("region", { name: u.contextTitle });
	// 30 days: (60 × 300K + 40 × 260K + 25 × 240K) / 125 = 275.2K against 380K before.
	assert.match(await context30.textContent() ?? "", new RegExp(u.contextChange(-28)));
	assert.match(await region.getByRole("region", { name: u.appShareTitle }).textContent() ?? "", /38%/);
	const hints = region.getByRole("region", { name: u.hintsTitle });
	assert.deepEqual(await hints.locator("li b").allTextContents(), [u.rules.mechanical.name, u.rules.context.name]);
	assert.match(await hints.locator("li").first().textContent() ?? "", new RegExp(u.experimental));

	// The experimental rule off: the machine is told, and its suggestion leaves the list.
	const rules = region.getByRole("region", { name: u.settingsTitle });
	const mechanical = rules.getByRole("checkbox", { name: new RegExp(u.rules.mechanical.name) });
	assert.equal(await mechanical.isChecked(), true);
	await mechanical.click();
	await until(page, "the switch on the machine", () => (window as unknown as { __fakeUsage: Fake }).__fakeUsage.seen.includes("usageSettingsSet"));
	await page.waitForFunction(() => document.querySelectorAll("[data-id=usage-hints] li").length === 1);
	assert.equal(await mechanical.isChecked(), false);

	// Deleting asks in the page; "Huỷ" sends nothing.
	const remove = region.getByRole("region", { name: u.deleteTitle });
	await remove.getByRole("button", { name: u.delete }).click();
	await remove.getByText(u.deleteAsk).waitFor();
	await remove.getByRole("button", { name: u.cancel }).click();
	assert.equal(await remove.getByText(u.deleteAsk).count(), 0);
	assert.equal(await page.evaluate(() => (window as unknown as { __fakeUsage: Fake }).__fakeUsage.deleted), false);
	await remove.getByRole("button", { name: u.delete }).click();
	await remove.getByRole("button", { name: u.deleteYes, exact: true }).click();
	await remove.getByText(u.deleted).waitFor();
	await region.getByText(u.empty).waitFor();
	assert.equal(await page.evaluate(() => (window as unknown as { __fakeUsage: Fake }).__fakeUsage.deleted), true);

	assert.deepEqual(errors, []);
	await context.close();
});

test("on a phone the page fits the width", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-usage`);
	await page.getByRole("region", { name: u.title }).getByRole("table").waitFor({ timeout: 30_000 });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
	assert.deepEqual(errors, []);
	await context.close();
});
