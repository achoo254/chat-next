// The Live Map of a Claude Code session in a real browser (Chromium): the
// real view (LiveMapView with its activity card, the scene of the machine's
// interior on a 2D canvas, the session's gauges, the detail and the event
// list, on the app's styles) watching a fake machine. The
// signed-in app has no machine that serves Observatory (the e2e stack has no
// machine; the visual harness's demo machine runs an older tunelo), so a
// harness page (observatory-harness.tsx) mounts the view with a link that
// answers its requests in the page, served by the app's own Vite config. The
// way to the view (the session's "Quan sát" switch and its routes) is
// covered by the component tests (session-observe.test.tsx).
//
// Checks: the scene is drawn and a live event comes on top of the event
// list; there is no drawer and no replay bar; the activity card names the
// call; a click on a module focuses the camera and shows its detail from the
// session's own events; "Ẩn chi tiết" hides the names and an event opened
// then is shown without asking the machine for its content; the scene draws
// no frame while nothing happens under reduced motion and at most 20 a second
// otherwise; with little room the column goes under the scene; on a phone
// nothing scrolls sideways.
// Screenshots of the desktop and phone states go to $E2E_SHOTS when set.
//
//   node --test apps/web/test/e2e/observatory.e2e.ts    (on its own)
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS = "test/e2e/observatory-harness.html";
/** Not one of the e2e stack's ports (run.ts), nor sw-update's (4710) or the CSP check's (4711). */
const PORT = 4712;
const WAIT_MS = 30_000;
const SHOTS = process.env.E2E_SHOTS ?? "";

let server: ViteDevServer | null = null;
let browser: Browser | null = null;

before(async () => {
	server = await createServer({
		root: APP_DIR,
		configFile: join(APP_DIR, "vite.config.ts"),
		logLevel: "warn",
		// Crawl the harness up front, so no dependency found later reloads the page mid-test.
		optimizeDeps: { entries: [HARNESS] },
		server: { port: PORT, strictPort: true, host: "127.0.0.1" },
	});
	await server.listen();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

interface Opened {
	readonly page: Page;
	readonly errors: string[];
}

/** The harness at `width` x `height`, the scene drawn; the animation log on, the one-time notice already seen. */
/** Reduced motion by default: the idle scene then draws nothing, which the tests check. */
async function open(width: number, height: number, mobile = false, reducedMotion: "reduce" | "no-preference" = "reduce"): Promise<Opened> {
	if (browser === null) throw new Error("no browser");
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion });
	await context.addInitScript(() => {
		window.localStorage.setItem("observe.animationLog", "1");
		window.localStorage.setItem("observe.officeReplacedSeen", "1");
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.goto(`http://127.0.0.1:${PORT}/${HARNESS}`);
	await page.locator("[data-id=observe-stage][data-status=ready]").waitFor({ timeout: WAIT_MS });
	return { page, errors };
}

const requests = (page: Page): Promise<string[]> => page.evaluate(() => window.__observeHarness?.requests() ?? []);
const frames = (page: Page): Promise<number> => page.evaluate(() => window.__liveMap?.frames() ?? -1);
const feedCount = (page: Page): Promise<string> => page.locator("[data-id=observe-feed-count]").innerText();

async function shot(page: Page, name: string): Promise<void> {
	if (SHOTS === "") return;
	await mkdir(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Waits until the frame counter holds still for `quietMs`, and returns it (fails after WAIT_MS). */
async function settled(page: Page, quietMs = 1_500): Promise<number> {
	const until = Date.now() + WAIT_MS;
	let last = await frames(page);
	while (Date.now() < until) {
		await page.waitForTimeout(quietMs);
		const now = await frames(page);
		if (now === last) return now;
		last = now;
	}
	return assert.fail("the scene never went still");
}

test("draws the session, follows a live event and goes still when nothing happens", async () => {
	const { page, errors } = await open(1280, 900);
	assert.deepEqual((await requests(page)).slice(0, 1), ["observatoryWatch on"], "the view watches the session");
	assert.equal(await feedCount(page), "5");
	assert.match(await page.locator("[data-id=observe-feed]").innerText(), /Edit src\/view\.tsx/, "the events name the files");
	assert.equal(await page.locator("[data-id=observe-map]").getAttribute("data-core"), "idle");

	// Idle: the scene draws nothing once its first frames are out.
	const still = await settled(page);
	assert.ok(still > 0, "the scene drew");
	await page.waitForTimeout(2_000);
	assert.equal(await frames(page), still, "no frame while idle");

	await page.evaluate(() => window.__observeHarness?.push());
	await page.waitForFunction(() => document.querySelector("[data-id=observe-feed-count]")?.textContent === "6", null, { timeout: WAIT_MS });
	assert.match(await page.locator(".lm-feed li").first().innerText(), /Write src\/new-file\.ts/, "the newest event is on top");
	const log = await page.evaluate(() => (window.__liveMap?.animationLog() ?? []).map((e) => ({ eventId: e.eventId })));
	assert.ok(
		log.some((e) => e.eventId === "tool:t6"),
		`the live event played: ${JSON.stringify(log.map((e) => e.eventId))}`,
	);
	assert.ok((await settled(page)) > still, "the event was drawn, then the scene went still again");
	assert.equal(await page.locator("[data-id=lmd-replay], [data-id=lmd-drawer]").count(), 0, "no replay bar, no drawer");
	await shot(page, "observatory-desktop-live");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("the activity card names the last call, a click on a module focuses the camera and shows its detail, and idle motion stays at 20 frames a second at most", async () => {
	const { page, errors } = await open(1280, 900, false, "no-preference");
	assert.match(await page.locator("[data-id=observe-card]").innerText(), /pnpm test|Bash/);
	assert.equal(await page.locator("[data-id=observe-stage]").getAttribute("data-camera"), "auto");
	await page.locator("[data-id=observe-place-files]").click();
	await page.waitForFunction(() => document.querySelector("[data-id=observe-stage]")?.getAttribute("data-camera") === "focus", null, { timeout: WAIT_MS });
	const detail = await page.locator("[data-id=observe-detail-box]").innerText();
	assert.match(detail, /Kho tệp/i);
	assert.match(detail, /2 lần gọi/i);
	assert.match(detail, /p50 \/ p95 lịch sử\s+120 ms \/ 120 ms/, "p50 / p95 of the session's own calls");
	assert.ok(!(await requests(page)).some((r) => r.startsWith("observatoryStation")), "no station numbers asked of the machine");
	// The camera eases in, then only the idle motion is left.
	await page.waitForTimeout(4_000);
	const start = await frames(page);
	await page.waitForTimeout(2_000);
	const idle = (await frames(page)) - start;
	assert.ok(idle <= 2 * 20 + 2, `at most 20 frames a second while idle: ${idle} in 2 s`);
	await shot(page, "observatory-desktop-focus");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("hiding details hides the names, and an event opened then does not ask for its content", async () => {
	const { page, errors } = await open(1280, 900);
	assert.match(await page.locator("[data-id=observe-stage]").innerText(), /src\/view\.tsx/, "names show at first");
	await page.locator("[data-id=observe-hide-details]").check();
	assert.doesNotMatch(await page.locator("[data-id=observe-stage]").innerText(), /src\/(app\.ts|view\.tsx)/, "no file named anywhere");
	await page.locator('[data-id="observe-feed-tool:t1"] button').click();
	await page.locator("[data-id=observe-detail-output]").waitFor();
	assert.doesNotMatch(await page.locator("[data-id=observe-detail-box]").innerText(), /src\/app\.ts/);
	await page.waitForTimeout(500);
	assert.ok(!(await requests(page)).some((r) => r.startsWith("observatoryContent")), "the content was not asked");

	// Shown again: the same event asks for its content and shows it.
	await page.locator("[data-id=observe-hide-details]").uncheck();
	await page.waitForFunction(() => document.querySelector("[data-id=observe-detail-output]")?.textContent === "content of tool:t1", null, { timeout: WAIT_MS });
	assert.ok((await requests(page)).includes("observatoryContent tool:t1"));
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("with little room the column goes under the scene and the scene keeps the width", async () => {
	const { page, errors } = await open(1280, 900);
	await page.locator("[data-id=observe-stage]").evaluate((el) => {
		(el as HTMLElement).style.width = "720px";
	});
	await page.waitForTimeout(200);
	const board = await page.locator(".lm-board").boundingBox();
	const feed = await page.locator("[data-id=observe-feed]").boundingBox();
	assert.ok(board && feed, "the scene and the events are laid out");
	assert.ok(board.width >= 680, `the scene keeps the width (${Math.round(board.width)} px)`);
	assert.ok(feed.y >= board.y + board.height - 1, "the column is below the scene, not beside it");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("on a phone everything stacks and nothing scrolls sideways", async () => {
	const { page, errors } = await open(390, 844, true);
	const sideways = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.equal(await sideways(), 0, "no horizontal scroll");
	await shot(page, "observatory-phone-map");
	// The camera's buttons sit over the scene's bottom right: the module's left edge is clear of them.
	await page.locator("[data-id=observe-place-files]").click({ position: { x: 4, y: 4 } });
	await page.waitForFunction(() => /Kho tệp/.test(document.querySelector("[data-id=observe-detail-title]")?.textContent ?? ""), null, { timeout: WAIT_MS });
	assert.equal(await sideways(), 0, "still no horizontal scroll with a module picked");
	await shot(page, "observatory-phone-detail");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});
