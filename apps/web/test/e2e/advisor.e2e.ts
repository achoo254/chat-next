// Advisor's mascot in a real browser (Chromium) against the demo machine of
// the visual harness (test/support/remote-machine-demo.ts, whose Advisor
// threads answer from test/support/fake-advisor.ts): opened cold in a chat,
// the mascot is there, a copied chat message is offered with no id or name,
// and the question comes back answered; in a session, a failed push copied
// from Source Control goes with its failure_id, and "Gửi sang phiên" fills the
// session's composer; on a phone the mascot snaps to the edge it is dragged
// to, keeps it after a reload, and the bubble is a bottom sheet; the
// session's automatic verdict is a card with its options and its chips
// spent once the user wrote on, on a computer and a phone. Starts its
// own Vite dev server of the harness, so it needs no backend:
//
//   node --test test/e2e/advisor.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports and the other harness e2e (5174–5177). */
const PORT = 5178;
const PICK = "Rebase lên origin/main rồi push lại";
/** proto ERROR_REASON_GIT_DIVERGED. */
const GIT_DIVERGED = 79;

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

interface Sent {
	text: string;
	advisorAttachments: { text: string; context: Record<string, string> }[];
}
type FakeAdvisor = { sends: Sent[] };

async function until(page: Page, what: string, check: () => boolean, timeout = 15_000): Promise<void> {
	await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(`timed out waiting for ${what}`));
}

/** Selects the text of the first element matching `selector` and fires the copy event, as ⌘C / Ctrl+C would. */
async function copy(page: Page, selector: string): Promise<string> {
	return page.evaluate((sel) => {
		const element = document.querySelector(sel);
		if (element === null) throw new Error(`nothing matches ${sel}`);
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true }));
		return selection?.toString() ?? "";
	}, selector);
}

const sends = (page: Page) => page.evaluate(() => (window as unknown as { __fakeAdvisor: FakeAdvisor }).__fakeAdvisor.sends);

async function noSideScroll(page: Page): Promise<void> {
	const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
	assert.ok(scroll <= client + 1, `horizontal overflow: ${scroll}px in ${client}px`);
}

test("opened cold in a chat: the mascot is there, a chat copy goes with no id or name, and the answer comes back", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1366, height: 768 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-in-chat`);
	const mascot = page.locator("[data-id=advisor-mascot]");
	await mascot.waitFor({ timeout: 30_000 });
	await page.locator(".bubble").first().waitFor({ timeout: 30_000 });
	await noSideScroll(page);
	// The mascot keeps clear of the composer's send button.
	const [m, composer] = await Promise.all([mascot.boundingBox(), page.locator(".composer").first().boundingBox()]);
	assert.ok(m !== null && composer !== null && m.y + m.height <= composer.y, `mascot ${m?.y}+${m?.height} over the composer at ${composer?.y}`);

	const copied = await copy(page, ".bubble");
	assert.ok(copied.trim() !== "");
	await mascot.click();
	const bubble = page.getByRole("dialog", { name: "Cố vấn" });
	await bubble.waitFor();
	const chip = bubble.getByRole("button", { name: /Đính kèm đoạn vừa copy \(một tin nhắn chat\)/ });
	await chip.click();
	await bubble.getByRole("textbox", { name: "Bạn đang phân vân điều gì?" }).fill("Tin này nghĩa là gì?");
	await bubble.getByRole("button", { name: "Hỏi" }).click();
	await bubble.getByText(PICK).waitFor({ timeout: 15_000 });
	await bubble.getByText("82%").waitFor();
	const [sent] = await sends(page);
	assert.ok(sent !== undefined);
	assert.equal(sent.advisorAttachments.length, 1);
	const ctx = sent.advisorAttachments[0]?.context ?? {};
	// A chat copy says only that it was a chat message.
	assert.equal(ctx.screen, "chat");
	assert.deepEqual([ctx.threadId, ctx.dir, ctx.branch, ctx.failureId], ["", "", "", ""]);
	await noSideScroll(page);
	assert.deepEqual(errors, []);
	await context.close();
});

test("a failed push copied from Source Control goes with its failure_id; 'Gửi sang phiên' fills the composer", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1366, height: 768 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	await page.locator("[data-id=session-panel-toggle]").waitFor({ timeout: 30_000 });
	await page.keyboard.press("Alt+Shift+KeyE");
	await page.locator("[data-id=workspace-panel]").waitFor();
	await page.keyboard.press("Alt+Shift+KeyG");
	await page.getByRole("tab", { name: /Quản lý mã nguồn/ }).waitFor();
	await page.evaluate(
		(reason) =>
			(window as unknown as { __fakeWorkspace: { failures: Map<string, unknown> } }).__fakeWorkspace.failures.set("wsGitPush", { reason, subject: "1 1", failureId: "fail-e2e" }),
		GIT_DIVERGED,
	);
	await page.getByRole("button", { name: /^Push/ }).click();
	await page.locator(".ws-failure").waitFor();
	await copy(page, ".ws-failure-body p");

	await page.locator("[data-id=advisor-mascot]").click();
	const bubble = page.getByRole("dialog", { name: "Cố vấn" });
	await bubble.getByRole("button", { name: /Đính kèm đoạn vừa copy \(Quản lý mã nguồn · chat-next/ }).click();
	await bubble.getByRole("textbox", { name: "Bạn đang phân vân điều gì?" }).fill("Vì sao push hỏng?");
	await bubble.getByRole("button", { name: "Hỏi" }).click();
	await bubble.getByText(PICK).waitFor({ timeout: 15_000 });
	const [sent] = await sends(page);
	const ctx = sent?.advisorAttachments[0]?.context ?? {};
	assert.equal(ctx.panel, "scm");
	assert.equal(ctx.action, "push");
	assert.equal(ctx.errorCode, "GIT_DIVERGED");
	assert.equal(ctx.failureId, "fail-e2e");
	assert.equal(ctx.threadId, "demo-thread");

	await bubble.getByRole("button", { name: "Gửi sang phiên" }).click();
	await bubble.getByRole("button", { name: /Sửa giao diện Máy của tôi/ }).click();
	await bubble.waitFor({ state: "detached" });
	const box = page.getByRole("textbox", { name: "Tin nhắn" });
	await until(page, "the composer filled", () => document.querySelector('[role="textbox"][aria-label="Tin nhắn"]')?.textContent?.includes("Rebase lên origin/main") === true);
	assert.match((await box.textContent()) ?? "", /Rebase lên origin\/main rồi push lại/);
	// Nothing was sent to the session: the user sends it.
	assert.equal((await sends(page)).length, 1);
	assert.deepEqual(errors, []);
	await context.close();
});

for (const height of [900, 1450]) {
	test(`dragged to the bottom right corner (1376×${height}): it reaches the edge, the bubble opens beside it and its menu is whole`, async () => {
		const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1376, height } });
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(String(err)));
		await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
		const mascot = page.locator("[data-id=advisor-mascot]");
		await mascot.waitFor({ timeout: 30_000 });
		const start = await mascot.boundingBox();
		assert.ok(start !== null);
		await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
		await page.mouse.down();
		await page.mouse.move(1370, height - 2, { steps: 8 });
		await page.mouse.up();
		await page.mouse.move(400, 300);
		// It slides to the bottom edge (over the composer if the user wants it there).
		await until(page, "at the bottom edge", () => {
			const r = document.querySelector("[data-id=advisor-mascot]")?.getBoundingClientRect();
			return r !== undefined && r.bottom >= window.innerHeight - 10;
		});
		const m = await mascot.boundingBox();
		assert.ok(m !== null);
		assert.ok(m.x + m.width <= 1376 + 0.5, `the mascot is cut off at the right edge (ends at ${m.x + m.width})`);

		await mascot.click();
		const bubble = page.getByRole("dialog", { name: "Cố vấn" });
		await bubble.waitFor();
		await page.waitForTimeout(300);
		const b = await bubble.boundingBox();
		assert.ok(b !== null);
		// Beside the mascot, on its left, opening upward from its bottom; whole in the viewport.
		assert.ok(b.x + b.width <= m.x + 1, `bubble ends at ${b.x + b.width}, mascot starts at ${m.x}`);
		assert.ok(m.x - (b.x + b.width) <= 40, `bubble ${m.x - (b.x + b.width)} px away from the mascot`);
		assert.ok(Math.abs(b.y + b.height - (m.y + m.height)) <= 16, `bubble bottom ${b.y + b.height}, mascot bottom ${m.y + m.height}`);
		assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 1376 && b.y + b.height <= height);

		// The menu and close buttons sit at the far right of the head, the close button last.
		const close = await bubble.getByRole("button", { name: "Đóng" }).boundingBox();
		const more = await bubble.getByRole("button", { name: "Tuỳ chọn Cố vấn" }).boundingBox();
		assert.ok(close !== null && more !== null);
		assert.ok(b.x + b.width - (close.x + close.width) <= 16, `close button ${b.x + b.width - (close.x + close.width)} px from the bubble's right edge`);
		assert.ok(close.x - (more.x + more.width) <= 12, `menu button ${close.x - (more.x + more.width)} px left of the close button`);

		await bubble.getByRole("button", { name: "Tuỳ chọn Cố vấn" }).click();
		const menu = page.getByRole("group", { name: "Tuỳ chọn Cố vấn" });
		await menu.waitFor();
		const r = await menu.boundingBox();
		assert.ok(r !== null);
		assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1376 && r.y + r.height <= height, `menu at ${JSON.stringify(r)}`);
		// Nothing cuts it: each of its items is what the page shows at its own left edge.
		for (const name of ["Mở cài đặt Cố vấn", "Ẩn mascot"]) {
			const item = menu.getByRole("button", { name });
			const box = await item.boundingBox();
			assert.ok(box !== null);
			const hit = await page.evaluate(([x, y, label]) => document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim() === label, [box.x + 6, box.y + box.height / 2, name] as const);
			assert.ok(hit, `${name} is covered or cut`);
		}
		// Esc closes the menu only; the bubble stays.
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert.equal(await bubble.isVisible(), true);
		assert.deepEqual(errors, []);
		await context.close();
	});
}

test("on a phone the mascot snaps to the edge it is dragged to, keeps it, and the bubble is a bottom sheet", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-in-chat`);
	const mascot = page.locator("[data-id=advisor-mascot]");
	await mascot.waitFor({ timeout: 30_000 });
	assert.equal(await mascot.getAttribute("data-side"), "right");
	const start = await mascot.boundingBox();
	assert.ok(start !== null);
	// Drag it with the pointer to the left half, higher up.
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
	await page.mouse.down();
	await page.mouse.move(80, 300, { steps: 8 });
	await page.mouse.up();
	await until(page, "docked left", () => document.querySelector("[data-id=advisor-mascot]")?.getAttribute("data-side") === "left");
	// It slides to the edge (a short transition) and sits whole against it: none of it is cut off.
	await page.mouse.move(300, 700);
	await until(page, "at the left edge", () => (document.querySelector("[data-id=advisor-mascot]")?.getBoundingClientRect().x ?? 99) <= 1);
	const docked = await mascot.boundingBox();
	assert.ok(docked !== null && docked.x >= -0.5, "the mascot is cut off at the left edge");
	await page.reload();
	await mascot.waitFor({ timeout: 30_000 });
	assert.equal(await mascot.getAttribute("data-side"), "left");

	await mascot.tap();
	const bubble = page.getByRole("dialog", { name: "Cố vấn" });
	await bubble.waitFor();
	const sheet = await bubble.boundingBox();
	assert.deepEqual([Math.round(sheet?.x ?? -1), Math.round(sheet?.width ?? 0), Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))], [0, 390, 844]);
	await noSideScroll(page);
	assert.deepEqual(errors, []);
	await context.close();
});

for (const viewport of [
	{ width: 1366, height: 768 },
	{ width: 390, height: 844 },
]) {
	test(`the session's verdict card at ${viewport.width} px: what was sent, its shares, chips spent after the user's next message`, async () => {
		const context = await browser.newContext({ locale: "vi-VN", viewport });
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(String(err)));
		await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
		const card = page.locator("[data-id=advisor-verdict]");
		await card.waitFor({ timeout: 30_000 });
		await card.scrollIntoViewIfNeeded();
		assert.equal(await card.getAttribute("aria-label"), "Cố vấn nhận định");
		await card.getByText("Sau khi sửa CSS thẻ tool, làm gì tiếp?").waitFor();
		assert.match((await card.locator("li.top").textContent()) ?? "", /Build lại rồi chụp ảnh 375 px\s*74%/);
		// The user wrote their own message after it (the demo's second turn): the chips are spent, and a command is never one.
		const chips = card.getByRole("group", { name: "Gửi vào phiên" }).getByRole("button");
		assert.equal(await chips.count(), 2);
		for (const chip of await chips.all()) assert.equal(await chip.isDisabled(), true);
		await card.getByText("Đã có tin mới sau nhận định này.").waitFor();
		// The advisor_weigh call is the card: no tool row of it, never its raw input.
		const text = (await page.locator(".mx-messages").textContent()) ?? "";
		assert.ok(!text.includes("raw-input-not-shown") && !text.includes("advisor_weigh"), "the call's raw input shows");
		await noSideScroll(page);
		const box = await card.boundingBox();
		assert.ok(box !== null && box.x >= 0 && box.x + box.width <= viewport.width, `card ${box?.x}+${box?.width} outside ${viewport.width}`);
		assert.deepEqual(errors, []);
		await context.close();
	});
}
