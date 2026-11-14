// The workspace panel in a real browser (Chromium) against the fake machine
// of the visual harness (test/support/remote-machine-demo.ts, whose project
// pr1 answers Ws* from test/support/fake-workspace.ts): Alt+Shift+E opens it
// beside the session (the header's button says so), the Explorer opens a
// folder and previews a file in the drawer (Esc closes it), Alt+Shift+G goes
// to Source Control, a file is staged and the staged files committed with
// the keyboard; dragging the edge widens the panel and the width and open
// state come back after a reload; on a phone the panel is a full-height
// sheet. Starts its own Vite dev server of the harness, so it needs no backend:
//
//   node --test test/e2e/workspace-panel.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports, the harness preview (5174) and the other harness e2e (5175, 5176). */
const PORT = 5177;

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

async function until(page: Page, what: string, check: () => boolean, timeout = 15_000): Promise<void> {
	await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(`timed out waiting for ${what}`));
}

type Fake = { entries: { path: string; area: number }[]; seen: { case: string; value: { message?: string } }[]; watching: boolean };

test("open with the keyboard, browse, preview, stage and commit; the width and open state are kept", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1333, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	const toggle = page.locator("[data-id=session-panel-toggle]");
	await toggle.waitFor({ timeout: 30_000 });
	assert.equal(await toggle.getAttribute("aria-expanded"), "false");

	await page.keyboard.press("Alt+Shift+KeyE");
	const panel = page.locator("[data-id=workspace-panel]");
	await panel.waitFor();
	assert.equal(await toggle.getAttribute("aria-expanded"), "true");
	await until(page, "the machine watches the workspace", () => (window as unknown as { __fakeWorkspace: Fake }).__fakeWorkspace.watching);

	const tree = page.getByRole("tree");
	await tree.getByRole("treeitem", { name: /^docs/ }).click();
	await tree.getByRole("treeitem", { name: /^guide\.md/ }).click();
	const viewer = page.locator("[data-id=workspace-viewer]");
	await viewer.getByRole("heading", { name: "Guide" }).waitFor();
	// The drawer covers the session's main area, beside the panel.
	const [drawer, side] = await Promise.all([viewer.boundingBox(), panel.boundingBox()]);
	assert.ok(drawer !== null && side !== null && Math.abs(drawer.x + drawer.width - side.x) <= 2, `drawer ends at ${(drawer?.x ?? 0) + (drawer?.width ?? 0)}, panel starts at ${side?.x}`);
	await page.keyboard.press("Escape");
	await viewer.waitFor({ state: "detached" });

	await page.keyboard.press("Alt+Shift+KeyG");
	await page.getByRole("tab", { name: /Quản lý mã nguồn/ }).waitFor();
	assert.equal(await page.getByRole("tab", { name: /Quản lý mã nguồn/ }).getAttribute("aria-selected"), "true");
	await page.getByRole("button", { name: "Stage package.json" }).click();
	await until(page, "package.json staged", () => (window as unknown as { __fakeWorkspace: Fake }).__fakeWorkspace.entries.some((e) => e.path === "package.json" && e.area === 1));
	const box = page.locator("[data-id=workspace-commit-message]");
	await box.fill("chore: bump the version");
	const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
	await box.press(mac ? "Meta+Enter" : "Control+Enter");
	await until(page, "the commit on the machine", () => (window as unknown as { __fakeWorkspace: Fake }).__fakeWorkspace.seen.some((b) => b.case === "wsGitCommit"));
	await page.getByText("chore: bump the version").first().waitFor();
	assert.equal(await box.inputValue(), "");

	// Drag the panel's edge 120 px to the left: it widens, and the width is kept.
	const before = (await panel.boundingBox())?.width ?? 0;
	const handle = page.getByRole("separator");
	const h = await handle.boundingBox();
	assert.ok(h !== null);
	await page.mouse.move(h.x + h.width / 2, h.y + 200);
	await page.mouse.down();
	await page.mouse.move(h.x + h.width / 2 - 120, h.y + 200, { steps: 6 });
	await page.mouse.up();
	const widened = (await panel.boundingBox())?.width ?? 0;
	assert.ok(Math.abs(widened - (before + 120)) <= 2, `width ${before} → ${widened}`);
	await page.reload();
	await panel.waitFor({ timeout: 30_000 });
	assert.ok(Math.abs(((await panel.boundingBox())?.width ?? 0) - widened) <= 2);
	assert.equal(await page.getByRole("tab", { name: /Quản lý mã nguồn/ }).getAttribute("aria-selected"), "true");

	// The header's button closes it, and the machine stops watching.
	await toggle.click();
	await panel.waitFor({ state: "detached" });
	await until(page, "watching off", () => !(window as unknown as { __fakeWorkspace: Fake }).__fakeWorkspace.watching);
	assert.deepEqual(errors, []);
	await context.close();
});

test("on a phone the panel is a full-height sheet with its own close button", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	// A phone's header has no room for the panel's button: it is an item of the "⋯" menu.
	const menu = page.getByRole("button", { name: "Tuỳ chọn phiên" });
	await menu.waitFor({ timeout: 30_000 });
	await menu.tap();
	await page.getByRole("menuitem", { name: "Tệp và git của workspace" }).tap();
	const panel = page.locator("[data-id=workspace-panel]");
	await page.getByRole("tree").getByRole("treeitem").first().waitFor();
	const box = await panel.boundingBox();
	assert.deepEqual([Math.round(box?.x ?? -1), Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)], [0, 390, 844]);
	// Rows are 44 px to hit on a touch screen.
	const row = await page.getByRole("tree").getByRole("treeitem").first().boundingBox();
	assert.ok((row?.height ?? 0) >= 44, `row ${row?.height} px`);
	await page.locator("[data-id=workspace-panel-close]").tap();
	await panel.waitFor({ state: "detached" });
	assert.deepEqual(errors, []);
	await context.close();
});
