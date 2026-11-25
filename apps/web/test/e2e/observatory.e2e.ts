// The Live Map of a Claude Code session in a real browser (Chromium, WebGL
// through SwiftShader): the real view (LiveMapView with its PixiJS stage,
// station drawer, event detail and replay bar, on the app's styles and the
// AI-drawn plate of public/observatory/) watching a fake machine. The
// signed-in app has no machine that serves Observatory (the e2e stack has no
// machine; the visual harness's demo machine runs an older tunelo), so a
// harness page (observatory-harness.tsx) mounts the view with a link that
// answers its requests in the page, served by the app's own Vite config. The
// way to the view (the session's "Quan sát" switch and its routes) is
// covered by the component tests (session-observe.test.tsx).
//
// Checks: the scene is drawn and a live event changes the files station's
// tag; a click on a station opens its drawer with the machine's numbers; the
// replay bar plays and scrubs, the scene follows the replayed moment, and
// "Trực tiếp" comes back to now; "Ẩn chi tiết" hides the names and an event
// opened then is shown without asking the machine for its content; the
// activity card names the call; a click on a district focuses the camera; the
// scene draws no frame while nothing happens under reduced motion and at most
// 20 a second otherwise; on a phone the drawer is a
// sheet from the bottom, the bar compact, and nothing scrolls sideways.
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
	browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
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
const tagText = (page: Page, place: string): Promise<string> => page.locator(`[data-id=observe-tag-${place}]`).innerText();

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
	assert.equal(await page.locator("[data-id=observe-stage]").getAttribute("data-renderer"), "webgl");
	assert.deepEqual((await requests(page)).slice(0, 1), ["observatoryWatch on"], "the view watches the session");
	assert.match(await tagText(page, "files"), /2 lượt/);
	assert.match(await tagText(page, "files"), /src\/view\.tsx/, "the tag names the last file");
	assert.equal(await page.locator("[data-id=observe-map]").getAttribute("data-core"), "idle");

	// Idle: the scene draws nothing once its first frames are out.
	const still = await settled(page);
	assert.ok(still > 0, "the scene drew");
	await page.waitForTimeout(2_000);
	assert.equal(await frames(page), still, "no frame while idle");

	await page.evaluate(() => window.__observeHarness?.push());
	await page.waitForFunction(() => /3 lượt/.test(document.querySelector("[data-id=observe-tag-files]")?.textContent ?? ""), null, { timeout: WAIT_MS });
	assert.match(await tagText(page, "files"), /src\/new-file\.ts/);
	const log = await page.evaluate(() => (window.__liveMap?.animationLog() ?? []).map((e) => ({ eventId: e.eventId })));
	assert.ok(
		log.some((e) => e.eventId === "tool:t6"),
		`the live event played: ${JSON.stringify(log.map((e) => e.eventId))}`,
	);
	assert.ok((await settled(page)) > still, "the event was drawn, then the scene went still again");
	await shot(page, "observatory-desktop-live");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("the activity card names the last call, a click on a district focuses the camera, and idle motion stays at 20 frames a second at most", async () => {
	const { page, errors } = await open(1280, 900, false, "no-preference");
	assert.match(await page.locator("[data-id=observe-card]").innerText(), /pnpm test|Bash/);
	assert.equal(await page.locator("[data-id=observe-stage]").getAttribute("data-camera"), "auto");
	await page.locator("[data-id=observe-place-testing]").click();
	await page.waitForFunction(() => document.querySelector("[data-id=observe-stage]")?.getAttribute("data-camera") === "focus", null, { timeout: WAIT_MS });
	await page.locator("[data-id=observe-board-testing]").waitFor({ timeout: WAIT_MS });
	// The camera eases in (about 2.5 s), then only the idle motion is left.
	await page.waitForTimeout(4_000);
	const start = await frames(page);
	await page.waitForTimeout(2_000);
	const idle = (await frames(page)) - start;
	assert.ok(idle <= 2 * 20 + 2, `at most 20 frames a second while idle: ${idle} in 2 s`);
	await shot(page, "observatory-desktop-focus");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("a station's drawer shows its numbers, and the replay bar plays, scrubs and comes back live", async () => {
	const { page, errors } = await open(1280, 900);
	await page.locator("[data-id=observe-place-files]").click();
	const drawer = page.locator("[data-id=lmd-drawer]");
	await drawer.waitFor();
	assert.equal(await drawer.getAttribute("data-station"), "FILES");
	const numbers = page.locator("[data-id=lmd-numbers]");
	await numbers.waitFor({ timeout: WAIT_MS });
	const tiles = await numbers.innerText();
	assert.match(tiles, /Số lần gọi\s+3/);
	assert.match(tiles, /40 ms \/ 120 ms/);
	assert.ok((await requests(page)).includes("observatoryStation FILES@0"), "the numbers of the whole session were asked");
	await shot(page, "observatory-desktop-drawer");

	const bar = page.locator("[data-id=lmd-replay]");
	assert.equal(await bar.getAttribute("data-state"), "live");
	// Play starts at the session's start: no file read yet there.
	await page.locator("[data-id=lmd-play]").click();
	assert.equal(await bar.getAttribute("data-state"), "replay");
	assert.doesNotMatch(await tagText(page, "files"), /lượt/, "the scene is at the session's start");
	const position = await page.locator("[data-id=lmd-position]").innerText();
	await page.waitForFunction((before) => document.querySelector("[data-id=lmd-position]")?.textContent !== before, position, { timeout: WAIT_MS });
	await page.locator("[data-id=lmd-play]").click();

	// Scrub to 30 s in: the two file calls before it, the test run after it not yet.
	const slider = page.locator("[data-id=lmd-slider]");
	const min = Number(await slider.getAttribute("min"));
	await slider.fill(String(min + 30_000));
	await page.waitForFunction(() => /2 lượt/.test(document.querySelector("[data-id=observe-tag-files]")?.textContent ?? ""), null, { timeout: WAIT_MS });
	assert.doesNotMatch(await tagText(page, "testing"), /lượt/, "the test run comes later");
	// The drawer asks its numbers up to the replayed moment.
	await page.waitForFunction(() => /đến mốc tua/.test(document.querySelector("[data-id=lmd-drawer] .lmd-head")?.textContent ?? ""), null, { timeout: WAIT_MS });
	assert.ok(
		(await requests(page)).some((r) => /^observatoryStation FILES@[1-9]/.test(r)),
		"the numbers were asked up to the replayed moment",
	);
	await numbers.waitFor({ timeout: WAIT_MS });
	await shot(page, "observatory-desktop-replay");

	await page.locator("[data-id=lmd-live]").click();
	assert.equal(await bar.getAttribute("data-state"), "live");
	assert.match(await tagText(page, "testing"), /1 lượt/, "live again: the test run is back");
	assert.match(await tagText(page, "files"), /2 lượt/);
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("with little room beside the map (a side panel open) the drawer goes below it and the map keeps its width", async () => {
	const { page, errors } = await open(1280, 900);
	// The room the view really has, as when the file panel and the session list take most of the window.
	await page.locator(".lmd-wrap").evaluate((el) => {
		(el as HTMLElement).style.width = "520px";
	});
	await page.locator("[data-id=observe-place-files]").click();
	const drawer = page.locator("[data-id=lmd-drawer]");
	await drawer.waitFor();
	const frame = await page.locator(".lm-frame").boundingBox();
	const panel = await drawer.boundingBox();
	assert.ok(frame && panel, "the map and the drawer are laid out");
	assert.ok(frame.width >= 480, `the map keeps its width (${Math.round(frame.width)} px)`);
	assert.ok(panel.y >= frame.y + frame.height - 1, "the drawer is below the map, not beside it");
	assert.deepEqual(errors, [], "no page error");
});

test("hiding details hides the names, and an event opened then does not ask for its content", async () => {
	const { page, errors } = await open(1280, 900);
	assert.ok((await page.locator("[data-id=observe-detail]").count()) > 0, "names show at first");
	await page.locator("[data-id=observe-hide-details]").check();
	assert.equal(await page.locator("[data-id=observe-detail]").count(), 0, "no name on any tag");
	assert.doesNotMatch(await page.locator("[data-id=observe-stage]").innerText(), /src\/view\.tsx/);

	await page.locator("[data-id=observe-place-files]").click();
	await page.locator("[data-id=lmd-recent]").waitFor({ timeout: WAIT_MS });
	assert.doesNotMatch(await page.locator("[data-id=lmd-drawer]").innerText(), /src\/(app\.ts|view\.tsx)/, "the drawer names no file");
	await page.locator('[data-id="lmd-event-tool:t1"]').click();
	await page.locator("[data-id=lmd-hidden]").waitFor();
	assert.equal(await page.locator("[data-id=lmd-labels]").count(), 0);
	await page.waitForTimeout(500);
	assert.ok(!(await requests(page)).some((r) => r.startsWith("observatoryContent")), "the content was not asked");

	// Shown again: the same event asks for its content and shows it.
	await page.locator("[data-id=observe-hide-details]").uncheck();
	await page.locator("[data-id=lmd-content]").waitFor({ timeout: WAIT_MS });
	assert.equal(await page.locator("[data-id=lmd-content]").innerText(), "content of tool:t1");
	// The detail's event, and the files board's last result (the focused district shows its newest ended call's output).
	assert.deepEqual(
		[...new Set((await requests(page)).filter((r) => r.startsWith("observatoryContent")))].sort(),
		["observatoryContent tool:t1", "observatoryContent tool:t2"],
	);
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});

test("on a phone the drawer is a sheet from the bottom, the bar compact, and nothing scrolls sideways", async () => {
	const { page, errors } = await open(390, 844, true);
	const sideways = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.equal(await sideways(), 0, "no horizontal scroll");
	assert.equal(await page.locator(".lmd-bar-title").isVisible(), false, "the bar drops its title");
	const bar = await page.locator("[data-id=lmd-replay]").boundingBox();
	assert.ok(bar !== null && bar.width <= 390, `the bar fits the screen: ${JSON.stringify(bar)}`);
	await shot(page, "observatory-phone-map");

	await page.locator("[data-id=observe-place-files]").click();
	const drawer = page.locator("[data-id=lmd-drawer]");
	await page.locator("[data-id=lmd-numbers]").waitFor({ timeout: WAIT_MS });
	const sheet = await drawer.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { position: getComputedStyle(el).position, left: r.left, width: r.width, bottom: r.bottom, top: r.top };
	});
	assert.equal(sheet.position, "fixed");
	assert.equal(Math.round(sheet.left), 0);
	assert.equal(Math.round(sheet.width), 390, "the sheet spans the screen");
	assert.equal(Math.round(sheet.bottom), 844, "the sheet sits on the bottom edge");
	assert.ok(sheet.top >= 844 * 0.4 - 1, `the sheet takes at most 60% of the height: top ${sheet.top}`);
	assert.equal(await sideways(), 0, "still no horizontal scroll with the sheet open");
	await shot(page, "observatory-phone-drawer");
	assert.deepEqual(errors, [], "no page error");
	await page.context().close();
});
