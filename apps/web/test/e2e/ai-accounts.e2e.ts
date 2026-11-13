// "Tài khoản AI" in a real browser (Chromium) against the fake machine of the
// visual harness (test/support/remote-machine-demo.ts, which reports Claude
// Code and Antigravity, both keeping accounts): the machine's page links to
// it, it shows one block per AI (Claude with "Thêm tài khoản", Antigravity
// with "Lưu tài khoản đang đăng nhập"), both themes stay readable and a phone
// gets one column without horizontal scrolling; "Phiên mới" offers both AIs.
// Starts its own Vite dev server of the harness, so it needs no backend:
//
//   node --test test/e2e/ai-accounts.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports, the harness preview (5174) and the other harness e2e (5175 to 5178). */
const PORT = 5179;

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

async function open(path: string, viewport: { width: number; height: number }, colorScheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.newContext({ locale: "vi-VN", viewport, colorScheme });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/${path}`);
	return { page, errors };
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("the machine's page leads to Tài khoản AI, which has one block per AI with its own actions", async () => {
	const { page, errors } = await open("?at=machine-info", { width: 1366, height: 768 });
	const entry = page.locator("[data-id=machine-ai-accounts-open]");
	await entry.waitFor({ timeout: 30_000 });
	// The old Claude-only block is gone from the machine's page.
	assert.equal(await page.locator("[data-id=claude-profiles]").count(), 0);
	await entry.click();
	await page.locator("[data-id=ai-accounts]").waitFor();
	const claude = page.locator("[data-id=ai-accounts-claude]");
	const agy = page.locator("[data-id=ai-accounts-antigravity]");
	await claude.waitFor();
	await agy.waitFor();
	assert.match((await claude.textContent()) ?? "", /user\.max@example\.com/);
	assert.equal(await claude.locator("[data-id=ai-accounts-claude-add]").count(), 1);
	assert.equal(await claude.locator("[data-id=ai-accounts-claude-capture]").count(), 0);
	assert.match((await agy.textContent()) ?? "", /work@example\.com/);
	assert.equal(await agy.locator("[data-id=ai-accounts-antigravity-capture]").count(), 1);
	assert.equal(await agy.locator("[data-id=ai-accounts-antigravity-add]").count(), 0);
	// Claude's sign-in dialog opens from Claude's block, framed as every modal.
	await claude.locator("[data-id=ai-accounts-claude-add]").click();
	const dialog = page.getByRole("dialog", { name: "Thêm tài khoản Claude Code" });
	await dialog.waitFor();
	const fits = await dialog.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight && el.scrollWidth <= el.clientWidth);
	assert.ok(fits, "the sign-in dialog fits the viewport without horizontal scrolling");
	await page.keyboard.press("Escape");
	await agy.locator("[data-id=ai-accounts-antigravity-capture]").click();
	await agy.getByRole("status").waitFor();
	assert.ok(await noHorizontalScroll(page));
	assert.deepEqual(errors, []);
	await page.context().close();
});

test("on a phone in the dark theme the blocks stack in one column", async () => {
	const { page, errors } = await open("?at=machine-ai-accounts", { width: 390, height: 844 }, "dark");
	const claude = page.locator("[data-id=ai-accounts-claude]");
	const agy = page.locator("[data-id=ai-accounts-antigravity]");
	await claude.waitFor({ timeout: 30_000 });
	await agy.waitFor();
	const [a, b] = await Promise.all([claude.boundingBox(), agy.boundingBox()]);
	assert.ok(a !== null && b !== null);
	assert.ok(b.y >= a.y + a.height - 1, "Antigravity sits below Claude");
	assert.ok(Math.abs(a.x - b.x) < 2, "both blocks start at the same left edge");
	assert.ok(await noHorizontalScroll(page));
	// Text stays readable on the dark surface: not the page's background colour.
	const contrast = await claude.evaluate((el) => {
		const s = getComputedStyle(el);
		return s.color !== s.backgroundColor;
	});
	assert.ok(contrast);
	assert.deepEqual(errors, []);
	await page.context().close();
});

test("Phiên mới offers every signed-in AI of the machine", async () => {
	const { page, errors } = await open("?at=machine-sessions&open=new-session", { width: 1366, height: 768 });
	const pick = page.locator(".mx-ai-pick");
	await pick.waitFor({ timeout: 30_000 });
	const names = await pick.locator("label b").allTextContents();
	assert.deepEqual(names, ["Claude Code", "Antigravity"]);
	assert.ok(await pick.getByRole("radio", { name: /Claude Code/ }).isChecked());
	assert.deepEqual(errors, []);
	await page.context().close();
});
