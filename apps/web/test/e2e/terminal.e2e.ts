// The machine's terminal screen in a real browser (Chromium) against the
// fake machine of the visual harness (test/support/remote-machine-demo.ts):
// the dock opens a shell on the relay (the fake gives a real browser's offer
// no direct path) and says so in the pill, typed text reaches the machine
// and its echo reaches xterm's screen, a split adds a second terminal, and
// Alt+Shift+T a second tab. A session opened in its terminal (the
// "Trò chuyện | Terminal" switch) asks the machine for its AI by the thread
// alone, shows the path pill in the session header, and every split pane
// closes on its own; the split icons keep their 14x12 glyph; the column has
// no Terminal entry. The column speaks of projects only: the demo machine's
// folders become projects, a workspace shows its branch and state, no
// machine's name shows. The real direct path is checked against the real
// terminal process at acceptance. Starts its own Vite dev server of the
// harness, so it needs no backend:
//
//   node --test test/e2e/terminal.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports (4600, 4610, 4630, 5173) and the harness preview (5174). */
const PORT = 5175;

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

/** Waits until `check` is true in the page (or fails with `what`). */
async function until(page: Page, what: string, check: () => boolean, timeout = 15_000): Promise<void> {
	await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(`timed out waiting for ${what}`));
}

test("a terminal on the relay: typing reaches the machine, the echo reaches the screen, splits and tabs", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 } });
	// The diagnostic probe lets the test read what xterm shows.
	await context.addInitScript(() => window.localStorage.setItem("terminal:probe", "1"));
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-terminal`);
	await page.locator("[data-id=terminal-dock]").waitFor({ timeout: 30_000 });
	await page.locator(".tx-pane .xterm").first().waitFor();
	const pill = page.locator("[data-id=terminal-path]");
	await until(page, "the relay pill", () => /^Qua relay/.test(document.querySelector("[data-id=terminal-path]")?.textContent ?? ""));
	type Probe = { text(session: number): string };
	type Fake = { keystrokes: { text: string }[] };
	await until(page, "the prompt", () => ((window as unknown as { __terminalProbe?: Probe }).__terminalProbe?.text(1) ?? "").includes("dieuvy@laptop ~ %"));

	await page.locator(".tx-pane .xterm").first().click();
	await page.keyboard.type("echo xin chào");
	await until(page, "keystrokes on the machine", () =>
		((window as unknown as { __fakeTerminal?: Fake }).__fakeTerminal?.keystrokes ?? []).map((k) => k.text).join("") === "echo xin chào",
	);
	await until(page, "the echo on screen", () => ((window as unknown as { __terminalProbe?: Probe }).__terminalProbe?.text(1) ?? "").includes("dieuvy@laptop ~ % echo xin chào"));

	await page.getByRole("button", { name: "Chia sang phải" }).click();
	await page.locator(".tx-pane .xterm").nth(1).waitFor();
	assert.equal(await page.locator(".tx-tab-body:not([hidden]) .tx-pane").count(), 2);

	await page.keyboard.press("Alt+Shift+KeyT");
	await until(page, "a second tab", () => document.querySelectorAll(".tx-tabs [role=tab]").length === 2);
	assert.match((await pill.textContent()) ?? "", /^Qua relay/);
	assert.deepEqual(errors, []);
	await context.close();
});

test("a session in its terminal: the switch, the pill in the header, a close button on every pane, unstretched split icons", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-session-terminal`);
	await page.locator("[data-id=terminal-dock]").waitFor({ timeout: 30_000 });
	await page.locator(".tx-pane .xterm").first().waitFor();
	type Fake = { aiThreads: Map<number, string>; exit(session: number, code: number): void; sessions: Map<number, unknown> };
	await until(page, "the AI opened by its thread", () => ((window as unknown as { __fakeTerminal?: Fake }).__fakeTerminal?.aiThreads.size ?? 0) === 1);

	const terminalMode = page.locator("[data-id=session-mode-terminal]");
	assert.equal(await terminalMode.getAttribute("aria-pressed"), "true");
	const switchBox = await page.locator(".mx-view-switch").first().boundingBox();
	assert.equal(Math.round(switchBox?.height ?? 0), 40);
	await until(page, "the path pill in the header", () => document.querySelector(".mx-head [data-id=terminal-path]") !== null);
	assert.equal(await page.locator(".tx-head [data-id=terminal-path]").count(), 0);

	// The dock fills the session's whole content area.
	const widths = await page.evaluate(() => ({ dock: document.querySelector("[data-id=terminal-dock]")?.getBoundingClientRect().width ?? 0, body: document.querySelector(".mx-chat-body")?.getBoundingClientRect().width ?? 0 }));
	assert.ok(widths.dock >= widths.body - 1, `dock ${widths.dock} px of ${widths.body} px`);

	for (const cls of ["to-right", "to-below"]) {
		const box = await page.locator(`.tx-split-ico.${cls}`).boundingBox();
		assert.deepEqual([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)], [14, 12], cls);
	}

	await page.getByRole("button", { name: "Chia sang phải" }).click();
	await page.locator(".tx-pane .xterm").nth(1).waitFor();
	const panes = page.locator(".tx-tab-body:not([hidden]) .tx-pane");
	assert.equal(await panes.count(), 2);
	assert.equal(await page.locator(".tx-tab-body:not([hidden]) .tx-pane-x").count(), 2);
	// The close button sits in the pane's gutter: 44px tall to hit, never over the terminal's text.
	const x = page.locator(".tx-tab-body:not([hidden]) .tx-pane-x").nth(1);
	await panes.nth(1).hover();
	const hit = await x.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const before = getComputedStyle(el, "::before");
		const screen = el.parentElement?.querySelector(".xterm-screen")?.getBoundingClientRect();
		return { h: r.height - parseFloat(before.top) - parseFloat(before.bottom), left: r.left + parseFloat(before.left), textRight: screen?.right ?? Number.POSITIVE_INFINITY };
	});
	assert.equal(Math.round(hit.h), 44);
	assert.ok(hit.left >= hit.textRight - 0.5, `the close button's hit area starts at ${hit.left}, the text ends at ${hit.textRight}`);
	await x.click();
	await until(page, "one pane left", () => document.querySelectorAll(".tx-tab-body:not([hidden]) .tx-pane").length === 1);

	// Its hidden input takes keystrokes, never a credential: no password manager offers to fill it.
	const helper = await page.locator(".tx-tab-body:not([hidden]) .xterm-helper-textarea").first().evaluate((el) =>
		["autocomplete", "name", "data-1p-ignore", "data-lpignore", "data-bwignore", "data-form-type"].map((n) => el.getAttribute(n)),
	);
	assert.deepEqual(helper, ["off", "terminal-keys", "", "true", "", "other"]);

	// The session's program ends: the bar above the screen takes real clicks (nothing of xterm covers it).
	const live = await page.evaluate(() => [...((window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.sessions.keys())]);
	const first = live[0] ?? 1;
	await page.evaluate((s) => (window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.exit(s, 1), first);
	await page.getByText("Tiến trình đã thoát (mã 1).").waitFor();
	const before = await page.evaluate(() => (window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.sessions.size);
	await page.getByRole("button", { name: "Mở lại trong terminal" }).click();
	await until(page, "the AI again", () => document.querySelectorAll(".tx-ended").length === 0);
	assert.ok((await page.evaluate(() => (window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.sessions.size)) >= before);
	const again = await page.evaluate(() => [...((window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.sessions.keys())].at(-1) ?? 0);
	await page.evaluate((s) => (window as unknown as { __fakeTerminal: Fake }).__fakeTerminal.exit(s, 1), again);
	await page.getByRole("button", { name: "Đóng ô" }).click();
	await until(page, "the pane closed", () => document.querySelectorAll(".tx-ended").length === 0);

	// No Terminal entry in the column; the one toggle is there.
	assert.equal(await page.locator(".mx-list a", { hasText: /^Terminal$/ }).count(), 0);
	assert.equal(await page.locator("[data-id=sidebar-attention]").count(), 1);
	assert.deepEqual(errors, []);
	await context.close();
});

test("the column speaks of projects only: the machine's folders became projects, workspaces with branch and state, each naming its machine", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	const list = page.locator(".mx-list");
	// The demo machine keeps three folders; the column records them as projects on first connect.
	await until(page, "three projects", () => document.querySelectorAll(".mx-list .mx-project-toggle").length === 3, 30_000);
	const names = await list.locator(".mx-project-toggle b").allTextContents();
	assert.deepEqual([...names].sort(), ["auth-next", "chat-next", "localman-next"]);
	// The open session's project is open: its workspace titled by the branch (the folder is the project's name, so not repeated), the "needs you" glyph, the session inside with a glyph, the AI and its live line.
	const chat = list.locator(".mx-project", { has: page.locator(".mx-project-toggle b", { hasText: /^chat-next$/ }) });
	assert.equal(await chat.locator(".mx-project-toggle").getAttribute("aria-expanded"), "true");
	assert.equal(await chat.locator(".mx-ws-title b").first().textContent(), "main");
	assert.equal(await chat.locator(".mx-ws-sub").count(), 0);
	assert.equal(await chat.locator(".mx-ws-head .mx-glyph.need").count(), 1);
	const session = chat.locator(".mx-srow", { hasText: "Sửa giao diện Máy của tôi" });
	assert.equal(await session.count(), 1);
	assert.equal(await session.locator(".mx-glyph.need").count(), 1);
	assert.equal(await chat.locator(".mx-srow .mx-glyph.running").count(), 1);
	// Every workspace names its machine with a short chip at the end of its title line, after the title, never over it.
	const chip = chat.locator(".mx-ws-host").first();
	assert.equal(await chip.textContent(), "DIEUVY-LAPTOP");
	const [chipBox, titleBox] = await Promise.all([chip.boundingBox(), chat.locator(".mx-ws-title b").first().boundingBox()]);
	assert.ok(chipBox !== null && titleBox !== null);
	assert.ok(titleBox.x + titleBox.width <= chipBox.x + 0.5, "the title ends before the chip starts");
	assert.ok(Math.abs(titleBox.y + titleBox.height / 2 - (chipBox.y + chipBox.height / 2)) < 4, "the chip is on the title line");
	// The keyboard: one row in the tab order, the arrows move, focus shows.
	assert.equal(await list.locator(".mx-groups [data-row][tabindex='0']").count(), 1);
	await chat.locator(".mx-project-toggle").focus();
	await page.keyboard.press("ArrowDown");
	const outline = await page.evaluate(() => (document.activeElement === null ? "" : getComputedStyle(document.activeElement).outlineStyle));
	assert.equal(outline, "solid");
	const text = (await list.textContent()) ?? "";
	for (const machineName of ["Mac mini", "Máy nhà"]) assert.ok(!text.includes(machineName), machineName);
	// The workspace's "+" and menu are real buttons, 44 px high where the row allows it.
	const plus = chat.getByRole("button", { name: "Phiên mới trong chat-next" });
	assert.equal(await plus.count(), 1);
	const toggleBox = await chat.locator(".mx-project-toggle").boundingBox();
	assert.ok((toggleBox?.height ?? 0) >= 44, `project row ${toggleBox?.height}`);
	// "Thêm dự án": a name, an optional repository, or a folder on the machine.
	await page.locator(".mx-nav-top [data-id=add-project]").click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: "Tên dự án" }).waitFor();
	assert.equal(await dialog.getByRole("textbox", { name: "Repo git (tuỳ chọn)" }).count(), 1);
	assert.equal(await dialog.getByRole("button", { name: "Chọn thư mục trên máy" }).count(), 1);
	assert.deepEqual(errors, []);
	await context.close();
});

/** iOS's keyboard, as far as a page sees it: the visual viewport shrinks while the page stays tall. */
async function phone(): Promise<{ page: Page; keyboard: (height: number) => Promise<void>; shot: (name: string) => Promise<void>; close: () => Promise<void> }> {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
	await context.addInitScript(() => {
		class FakeViewport extends EventTarget {
			height = window.innerHeight;
			offsetTop = 0;
			offsetLeft = 0;
			pageTop = 0;
			pageLeft = 0;
			width = window.innerWidth;
			scale = 1;
			onresize = null;
			onscroll = null;
			onscrollend = null;
		}
		const viewport = new FakeViewport();
		Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
		(window as unknown as { __keyboard: (h: number) => void }).__keyboard = (h: number) => {
			viewport.height = window.innerHeight - h;
			viewport.dispatchEvent(new Event("resize"));
		};
	});
	const page = await context.newPage();
	return {
		page,
		keyboard: (height) => page.evaluate((h) => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(h), height),
		shot: async (name) => {
			const dir = process.env.E2E_SHOTS;
			if (dir !== undefined && dir !== "") await page.screenshot({ path: join(dir, `${name}.png`) });
		},
		close: () => context.close(),
	};
}

test("a phone, keyboard up: the session keeps to what is left (header on top, composer right above the keyboard)", async () => {
	const p = await phone();
	const errors: string[] = [];
	p.page.on("pageerror", (err) => errors.push(String(err)));
	await p.page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	const chat = p.page.locator(".mx-chat");
	await chat.waitFor({ timeout: 30_000 });
	await p.page.locator(".mx-chat [data-composer]").waitFor();
	await p.shot("phone-chat-keyboard-closed");
	await p.keyboard(336);
	await until(p.page, "the session keeps to the visible box", () => document.querySelector(".mx-chat")?.hasAttribute("data-keyboard") === true);
	const box = await p.page.evaluate(() => {
		const r = (s: string) => document.querySelector(s)?.getBoundingClientRect();
		return { head: r(".mx-chat .mx-head")?.top ?? -1, composer: r(".mx-chat .mx-composer")?.bottom ?? -1, font: getComputedStyle(document.querySelector(".mx-chat [data-composer]") ?? document.body).fontSize, locked: document.documentElement.classList.contains("keyboard-open") };
	});
	assert.equal(Math.round(box.head), 0);
	assert.ok(Math.abs(box.composer - (844 - 336)) <= 1, `composer ends at ${box.composer}`);
	assert.equal(box.font, "16px", "no zoom on focus");
	assert.equal(box.locked, true);
	await p.shot("phone-chat-keyboard-open");
	await p.keyboard(0);
	await until(p.page, "back to the page", () => !document.documentElement.classList.contains("keyboard-open"));
	assert.deepEqual(errors, []);
	await p.close();
});

test("a phone, the session in its terminal: the key row (44 px keys, the AI's first) above the keyboard, the header kept", async () => {
	const p = await phone();
	const errors: string[] = [];
	p.page.on("pageerror", (err) => errors.push(String(err)));
	await p.page.goto(`http://localhost:${PORT}/?at=machine-session-terminal`);
	const bar = p.page.getByRole("toolbar", { name: "Phím phụ" });
	await bar.waitFor({ timeout: 30_000 });
	const first = await bar.getByRole("button").evaluateAll((els) => els.slice(0, 5).map((e) => e.getAttribute("aria-label")));
	assert.deepEqual(first, ["Esc", "Tab", "Shift+Tab", "Ctrl", "Alt"]);
	// Under the keys while the keyboard is down: the live input that brings it up.
	await p.page.locator("[data-id=terminal-live-input]").waitFor();
	const heights = await bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
	assert.ok(heights.every((h) => h >= 44), `key heights ${heights.join(",")}`);
	await p.shot("phone-terminal-keyboard-closed");
	await p.keyboard(336);
	await until(p.page, "the session keeps to the visible box", () => document.querySelector(".mx-chat")?.hasAttribute("data-keyboard") === true);
	const box = await p.page.evaluate(() => ({
		head: document.querySelector(".mx-chat .mx-head")?.getBoundingClientRect().top ?? -1,
		bar: document.querySelector(".tx-keys")?.getBoundingClientRect().bottom ?? -1,
		dock: document.querySelector("[data-id=terminal-dock]")?.getBoundingClientRect().height ?? 0,
	}));
	assert.equal(Math.round(box.head), 0);
	assert.ok(Math.abs(box.bar - (844 - 336)) <= 1, `key row ends at ${box.bar}`);
	assert.ok(box.dock > 200, `terminal ${box.dock} px tall`);
	await p.shot("phone-terminal-keyboard-open");
	await p.keyboard(0);
	assert.deepEqual(errors, []);
	await p.close();
});

test("an iPhone (WebKit, touch): a tap on the terminal or on the live input leaves the focus in the dock's input, so the phone keyboard comes up", async () => {
	const safari = await webkit.launch();
	const context = await safari.newContext({ locale: "vi-VN", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-session-terminal`);
	await page.locator(".tx-pane .xterm-screen").first().waitFor({ timeout: 30_000 });
	const inInput = () => page.evaluate(() => document.activeElement?.classList.contains("tx-ime") === true);
	// xterm's emulated mousedown once took the focus for its own read-only field.
	const screen = await page.locator(".tx-pane .xterm-screen").first().boundingBox();
	assert.ok(screen !== null);
	await page.touchscreen.tap(screen.x + 100, screen.y + 100);
	await page.waitForTimeout(300);
	assert.equal(await inInput(), true, "a tap on the terminal focuses the input");
	// A key of the row keeps the focus where it is.
	await page.getByRole("button", { name: "Esc" }).tap();
	assert.equal(await inInput(), true, "Esc keeps the focus");
	// The key that hides the keyboard, then the live input that brings it back.
	await page.getByRole("button", { name: "Ẩn bàn phím" }).tap();
	await page.waitForTimeout(200);
	assert.equal(await inInput(), false, "hiding the keyboard lets go of the input");
	await page.locator("[data-id=terminal-live-input]").tap();
	await page.waitForTimeout(200);
	assert.equal(await inInput(), true, "the live input takes the input again");
	assert.deepEqual(errors, []);
	await context.close();
	await safari.close();
});
