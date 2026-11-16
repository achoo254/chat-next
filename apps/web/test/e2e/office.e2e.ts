// The "Văn phòng" tab of an AI session in a real browser (Chromium) against
// the office of the visual harness's fake machine (test/support/fake-office.ts,
// a script that sends someone into each of the twelve rooms). The script is
// paused and played one step at a time, so every check waits for a known
// event: the tab opens, the 3D scene draws a canvas that is not blank (where
// Chromium gives WebGL, SwiftShader included: office3d=force), each room of
// the plan's room table is reached by the right person on the right floor
// (git and an external MCP → the post room, a test command → QA, an approval
// → Security with the chairman in the lobby, a denial → back, todo →
// Planning, a nested subagent → the meeting room, and the other rooms of the
// script), a seq gap recovers the snapshot's state, following moves between
// floors and stops once a floor is picked, a dropped link cuts the power and
// a reconnect brings the lights back, draw calls stay under 100 at the medium
// rung on every floor, and the chat tab stops the frames. Then without WebGL
// (--disable-3d-apis) the 2D view shows the three floors with their pictures,
// desks, names and boards, each dot within 4 px of its anchor; and an AI
// that does not report its staff (Antigravity) shows the director alone with
// a notice and token-only audit numbers. Starts its own Vite dev server of
// the harness (with the app's public/ for the baked office files), so it
// needs no backend:
//
//   node --test test/e2e/office.e2e.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import type { OfficeTestReadout } from "../../src/office-3d/world-support.ts";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const LAYOUT_FILE = fileURLToPath(new URL("../../src/machines/office/office-layout.json", import.meta.url));
const ASSETS_FILE = fileURLToPath(new URL("../../public/office/office-assets.json", import.meta.url));
/** Apart from the e2e stack's ports (4600, 4610, 4630, 5173), the harness preview (5174) and the other specs' dev servers (5175-5179). */
const PORT = 5180;
/** Address switches of the 3D office (office-flags.ts), kept in localStorage because the session's tabs rewrite the address. */
const FLAGS_KEY = "ai:office:3d-flags";
/** How long a floor the user picked holds before following resumes (USER_PAUSE_MS of office-floor-tabs.tsx, a .tsx this node test cannot import). */
const USER_PAUSE_MS = 30_000;
const FLAGS_3D = "office3d=force&office3d-quality=medium&office3d-test";
/** Placement holds a room at least 4 s and lingers 6 s after work (office-placement.ts): a move may take this long. */
const MOVE_TIMEOUT_MS = 20_000;
/** The store cuts the power 30 s after the last word from a closed link (office-store.ts). */
const POWER_OUT_MS = 30_000;

let server: ViteDevServer;
let browser: Browser;

// --- The layout: which floor and room every anchor belongs to. ------------------------------------------------------

type Spot = { readonly floor: number; readonly room: string | null; readonly kind: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Anchor id → floor, room and kind, from office-layout.json. */
function layoutSpots(): ReadonlyMap<string, Spot> {
	const json = readJson(LAYOUT_FILE);
	const spots = new Map<string, Spot>();
	const floors = isRecord(json) && Array.isArray(json.floors) ? json.floors : [];
	for (const floor of floors) {
		if (!isRecord(floor) || typeof floor.level !== "number" || !Array.isArray(floor.anchors)) continue;
		for (const a of floor.anchors) {
			if (!isRecord(a) || typeof a.id !== "string" || typeof a.kind !== "string") continue;
			spots.set(a.id, { floor: floor.level, room: typeof a.room === "string" ? a.room : null, kind: a.kind });
		}
	}
	assert.ok(spots.size > 0, "the layout has anchors");
	return spots;
}

/** Floor → anchor id → [x %, y %] on the desktop picture, from public/office/office-assets.json. */
function pictureAnchors(): ReadonlyMap<number, ReadonlyMap<string, readonly [number, number]>> {
	const json = readJson(ASSETS_FILE);
	const out = new Map<number, Map<string, readonly [number, number]>>();
	const floors = isRecord(json) && Array.isArray(json.floors) ? json.floors : [];
	for (const floor of floors) {
		if (!isRecord(floor) || typeof floor.level !== "number" || !isRecord(floor.views) || !isRecord(floor.views.desktop) || !isRecord(floor.views.desktop.anchors)) continue;
		const anchors = new Map<string, readonly [number, number]>();
		for (const [id, at] of Object.entries(floor.views.desktop.anchors)) {
			if (Array.isArray(at) && typeof at[0] === "number" && typeof at[1] === "number") anchors.set(id, [at[0], at[1]]);
		}
		out.set(floor.level, anchors);
	}
	return out;
}

const SPOTS = layoutSpots();

// --- The page. ------------------------------------------------------------------------------------------------------

/** What window.__office (declared by the scene) reads out. */
type Readout = OfficeTestReadout;
type FakeOfficeApi = { pause(): void; step(): void; gapNext(): void };
type FakeMachineApi = { sockets: { url: string; closed: boolean; drop(): void }[]; unreachable: Set<string> };
type TestWindow = Window & { __frameLog?: [number, number][]; __fakeOffice?: FakeOfficeApi; __fakeMachine?: FakeMachineApi; __floorsSeen?: number[] };

/** A person as the page shows them: the marker (2D) or the pin over the scene (3D), with the anchor they are placed at. */
type Seen = { key: string; kind: string; anchor: string; status: string; name: string };

before(async () => {
	server = await createServer({ root: HARNESS, configFile: `${HARNESS}vite.config.ts`, publicDir: PUBLIC, logLevel: "warn", server: { port: PORT, strictPort: true } });
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

/** Polls `read` until `ok` holds; returns the last value or fails with `what` and it. */
async function poll<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeout = MOVE_TIMEOUT_MS): Promise<T> {
	const end = Date.now() + timeout;
	let last = await read();
	while (!ok(last)) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
		last = await read();
	}
	return last;
}

async function seen(page: Page): Promise<Seen[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>("[data-id='office'] [data-id^='office-person-']")].map((el) => ({
			key: (el.dataset.id ?? "").slice("office-person-".length),
			kind: el.dataset.kind ?? "",
			anchor: el.dataset.anchor ?? "",
			status: el.dataset.status ?? "",
			name: el.querySelector(".of-name")?.textContent ?? "",
		})),
	);
}

function roomOf(p: Seen | undefined): { floor: number; room: string | null } | null {
	if (p === undefined) return null;
	const spot = SPOTS.get(p.anchor);
	return spot === undefined ? null : { floor: spot.floor, room: spot.room };
}

/** Whether 3D runs on this page (window.__office exposed). */
async function has3D(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as TestWindow).__office !== undefined);
}

async function readout(page: Page): Promise<Readout | null> {
	return page.evaluate(() => (window as TestWindow).__office?.read() ?? null);
}

/**
 * Waits until the person whose key matches `match` is placed in `room` (and on that room's floor), in the page's
 * markers and, with 3D running, as the scene's walking target too.
 */
async function reaches(page: Page, who: string, match: (key: string) => boolean, room: string): Promise<void> {
	const three = await has3D(page);
	await poll(
		`${who} in ${room}`,
		async () => {
			const p = (await seen(page)).find((s) => match(s.key));
			const at = roomOf(p);
			const r = three ? await readout(page) : null;
			const person = r?.people.find((x) => match(x.key));
			const target = person === undefined ? null : (SPOTS.get(person.target) ?? null);
			return { key: p?.key ?? null, at, target: target === null ? null : { floor: person?.floor ?? 0, room: target.room, targetFloor: target.floor } };
		},
		(v) => v.at !== null && v.at.room === room && SPOTS.get(firstAnchor(room))?.floor === v.at.floor && (!three || (v.target !== null && v.target.room === room)),
	);
}

/** Any anchor of `room` (to know the room's floor). */
function firstAnchor(room: string): string {
	for (const [id, spot] of SPOTS) if (spot.room === room) return id;
	return assert.fail(`no anchor in room ${room}`);
}

async function leaves(page: Page, who: string, match: (key: string) => boolean, room: string): Promise<void> {
	await poll(
		`${who} out of ${room}`,
		async () => roomOf((await seen(page)).find((s) => match(s.key))),
		(at) => at !== null && at.room !== room,
	);
}

async function pressedFloor(page: Page): Promise<number> {
	return page.evaluate(() => {
		const id = document.querySelector("[data-id^='office-floor-'][aria-pressed='true']")?.getAttribute("data-id") ?? "";
		return Number(id.slice("office-floor-".length));
	});
}

async function step(page: Page): Promise<void> {
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.step());
}

/**
 * A page of the harness at `at` with the office tab open on the session, the fake office's script paused (steps
 * play only through step()), and `flags` for the 3D view.
 */
async function openOffice(target: Browser, at: string, flags: string): Promise<{ context: BrowserContext; page: Page; errors: string[]; warnings: string[] }> {
	const context = await target.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 } });
	await context.addInitScript(
		([key, value]) => {
			window.localStorage.setItem(key, value);
			// Sound off, following on (the defaults, stated so a leftover choice cannot change them).
			window.localStorage.setItem("ai:office:sound", "off");
			window.localStorage.setItem("ai:office:follow", "on");
		},
		[FLAGS_KEY, flags] as const,
	);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	const warnings: string[] = [];
	page.on("console", (msg) => {
		if (msg.text().startsWith("office:")) warnings.push(msg.text());
	});
	await page.goto(`http://localhost:${PORT}/?at=${at}&office`);
	await until(page, "the fake office", () => (window as TestWindow).__fakeOffice !== undefined, 30_000);
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.pause());
	const tab = page.locator("[data-id=session-mode-office]");
	await tab.waitFor({ timeout: 30_000 });
	await tab.click();
	await page.locator("[data-id=office] [data-id=office-floors]").waitFor({ timeout: 30_000 });
	await page.locator("[data-id=office] .of-stage").waitFor({ timeout: 30_000 });
	return { context, page, errors, warnings };
}

/** How many distinct colours a screenshot of `selector` has (a blank canvas has one or two). */
async function colours(page: Page, selector: string): Promise<number> {
	const png = await page.locator(selector).screenshot();
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const ctx = c.getContext("2d");
		if (ctx === null) return 0;
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, c.width, c.height).data;
		const set = new Set<number>();
		for (let i = 0; i < data.length; i += 4 * 7) set.add(((data[i] ?? 0) >> 3) * 1024 + ((data[i + 1] ?? 0) >> 3) * 32 + ((data[i + 2] ?? 0) >> 3));
		return set.size;
	}, png.toString("base64"));
}

// --- The scenarios. -------------------------------------------------------------------------------------------------

const isDirector = (k: string) => k === "director";
const isChairman = (k: string) => k === "chairman";
const typeIs = (type: string) => (k: string) => k.startsWith(`${type}#`);

test("the office tab in 3D: every room of the table reached, seq gap, following floors, power cut, draw calls, frames stop on the chat tab", async () => {
	const { context, page, errors, warnings } = await openOffice(browser, "machine-chat", FLAGS_3D);
	// 3D wherever Chromium gives WebGL2 (SwiftShader included, office3d=force); the 2D view only where it has none.
	const webgl = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
	if (webgl) {
		await page
			.locator("[data-id=office] .of3d[data-ready='true']")
			.waitFor({ timeout: 60_000 })
			.catch(() => assert.fail(`the 3D scene did not start: ${warnings.join(" | ")}`));
		await until(page, "window.__office", () => (window as TestWindow).__office !== undefined);
	}
	const three = await has3D(page);
	console.log(`office e2e: renderer ${three ? "3d" : "2d (no WebGL2 in this Chromium: the scene's checks are skipped)"}`);
	if (three) {
		const r = await readout(page);
		console.log(`office e2e: backend ${r?.backend ?? "?"}, quality ${r?.quality ?? "?"}`);
		assert.equal(r?.quality, "medium", "the pinned medium rung");
		assert.equal(await page.locator("[data-id=office] canvas.of3d-canvas").count(), 1);
	}

	// The director at their desk before any turn; following records every floor it shows.
	await reaches(page, "the director", isDirector, "DIRECTOR");
	await page.evaluate(() => {
		const w = window as TestWindow;
		w.__floorsSeen = [];
		window.setInterval(() => {
			const id = document.querySelector("[data-id^='office-floor-'][aria-pressed='true']")?.getAttribute("data-id") ?? "";
			const floor = Number(id.slice("office-floor-".length));
			if (w.__floorsSeen !== undefined && w.__floorsSeen.at(-1) !== floor) w.__floorsSeen.push(floor);
		}, 100);
	});
	await step(page); // 0: a turn begins, the director thinks in their office

	// 1 with its first event lost (a seq gap): the director's Read only reaches the page through the fresh snapshot.
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.gapNext());
	await step(page);
	await reaches(page, "the director (Read, after the gap's snapshot)", isDirector, "LIBRARY");
	await poll("the scout", async () => (await seen(page)).some((s) => typeIs("scout")(s.key)), (v) => v);
	await poll("following to floor 2", () => pressedFloor(page), (f) => f === 2);

	await step(page); // 2: the scout greps, the tester and the planner come in
	await step(page); // 3: git, a test command, TodoWrite
	await reaches(page, "the director (git)", isDirector, "POST");
	await reaches(page, "the tester (test command)", typeIs("tester"), "QA");
	await reaches(page, "the planner (todo)", typeIs("planner"), "PLANNING");
	await step(page); // 4: the test fails; a background shell
	await reaches(page, "the background machine", (k) => k === "machine:m-dev", "SERVER");
	await step(page); // 5: the director edits; a code reviewer and a researcher come in
	await step(page); // 6: the reviewer edits (their home room replaces WORK)
	await reaches(page, "the code reviewer (edit, home room)", typeIs("code-reviewer"), "AUDIT");
	await step(page); // 7
	await step(page); // 8
	await step(page); // 9: a nested subagent comes in; a general-purpose employee writes at their desk
	await reaches(page, "the first general-purpose employee (Write)", typeIs("general-purpose"), "WORK");

	// 10: an approval waits: the director to Security, the chairman (you) in the lobby, following to floor 3.
	await step(page);
	await reaches(page, "the director (awaiting approval)", isDirector, "SECURITY");
	await reaches(page, "the chairman", isChairman, "LOBBY");
	await poll("following to floor 3", () => pressedFloor(page), (f) => f === 3);
	const floorsSeen = await page.evaluate(() => (window as TestWindow).__floorsSeen ?? []);
	assert.ok(floorsSeen.includes(2) && floorsSeen.includes(3), `floors followed: ${floorsSeen.join(",")}`);

	// The user picks floor 1: following holds back while work begins elsewhere.
	await page.locator("[data-id=office-floor-1]").click();
	const pickedAt = Date.now();
	assert.equal(await pressedFloor(page), 1);
	if (three) await poll("the scene on floor 1", async () => (await readout(page))?.floor ?? 0, (f) => f === 1);

	// 11: denied: the director leaves Security, the chairman goes.
	await step(page);
	await leaves(page, "the director (denied)", isDirector, "SECURITY");
	// The nested subagent, between its tools: the meeting room.
	await reaches(page, "the nested subagent", (k) => k.startsWith("~"), "MEETING");
	await poll("the chairman gone", async () => (await seen(page)).some((s) => isChairman(s.key)), (v) => !v);
	await step(page); // 12: tunelo's own MCP (a message to you) in the lobby; a coffee in the pantry
	await reaches(page, "the director (tunelo MCP)", isDirector, "LOBBY");
	await reaches(page, "the second general-purpose employee (coffee)", (k) => k === "general-purpose#2", "PANTRY");
	await step(page); // 13: an external MCP: the post room (floor 2), newer work than anything on floor 1
	await reaches(page, "the docs manager (external MCP)", typeIs("docs-manager"), "POST");
	await page.waitForTimeout(7_000); // past the 6 s a followed floor holds
	// Following comes back USER_PAUSE_MS after the pick: the check means something only inside that pause (a slow CI run must not flake).
	const sincePick = Date.now() - pickedAt;
	if (sincePick < USER_PAUSE_MS - 1_000) assert.equal(await pressedFloor(page), 1, "following stays off after a floor was picked");
	else console.log(`office e2e: floor pin check skipped, ${sincePick} ms since the pick (pause ${USER_PAUSE_MS} ms)`);

	// The link drops and stays down: 30 s later the power goes out; a reconnect brings the lights back.
	await page.evaluate(() => {
		const m = (window as TestWindow).__fakeMachine;
		if (m === undefined) return;
		for (const s of m.sockets) {
			m.unreachable.add(s.url);
			s.drop();
		}
	});
	await until(page, "the power out", () => document.querySelector("[data-id=office] .of-stage")?.getAttribute("data-power") === "out", POWER_OUT_MS + 15_000);
	await page.getByText("Mất điện: chưa nghe tin từ máy hơn 30 giây.", { exact: false }).waitFor();
	await page.evaluate(() => {
		(window as TestWindow).__fakeMachine?.unreachable.clear();
		window.dispatchEvent(new Event("online"));
	});
	await until(page, "the lights back", () => document.querySelector("[data-id=office] .of-stage")?.getAttribute("data-power") === "on", 30_000);
	assert.equal(await page.getByText("Mất điện", { exact: false }).count(), 0);
	// The fresh snapshot keeps everyone where the script left them.
	await reaches(page, "the docs manager after the reconnect", typeIs("docs-manager"), "POST");

	if (three) {
		// The canvas is not blank, and every floor keeps under 100 draw calls at the medium rung.
		await page.waitForTimeout(2_000);
		const shades = await colours(page, "[data-id=office] canvas.of3d-canvas");
		assert.ok(shades > 32, `the canvas has ${shades} colours`);
		const calls: Record<number, number> = {};
		for (const level of [1, 2, 3]) {
			await page.locator(`[data-id=office-floor-${level}]`).click();
			await poll(`the scene on floor ${level}`, async () => (await readout(page))?.floor ?? 0, (f) => f === level);
			await page.waitForTimeout(2_500);
			let most = 0;
			for (let i = 0; i < 10; i++) {
				most = Math.max(most, (await readout(page))?.drawCalls ?? 0);
				await page.waitForTimeout(100);
			}
			calls[level] = most;
			assert.ok(most > 0 && most < 100, `floor ${level}: ${most} draw calls`);
			assert.ok((await colours(page, "[data-id=office] canvas.of3d-canvas")) > 32, `floor ${level} drawn`);
		}
		console.log(`office e2e: draw calls (medium) T1 ${calls[1]}, T2 ${calls[2]}, T3 ${calls[3]}`);

		// The chat tab: the render loop stops within a second. A sampler logs the frame count every 50 ms for as long as
		// the read-out exists (the scene takes it away when it is disposed).
		await page.evaluate(() => {
			const w = window as TestWindow;
			w.__frameLog = [];
			const timer = window.setInterval(() => {
				const api = w.__office;
				if (api === undefined) return window.clearInterval(timer);
				w.__frameLog?.push([performance.now(), api.read().frames]);
			}, 50);
		});
		await page.waitForTimeout(500);
		const clickedAt = await page.evaluate(() => performance.now());
		await page.locator("[data-id=session-mode-chat]").click();
		await page.locator("[data-id=office]").waitFor({ state: "detached" });
		await page.waitForTimeout(2_000);
		const log = await page.evaluate(() => (window as TestWindow).__frameLog ?? []);
		const before = log.filter(([t]) => t < clickedAt);
		assert.ok((before.at(-1)?.[1] ?? 0) > (before[0]?.[1] ?? 0), "frames run while the office shows");
		let lastGrowth = 0;
		for (let i = 1; i < log.length; i++) if ((log[i]?.[1] ?? 0) > (log[i - 1]?.[1] ?? 0)) lastGrowth = log[i]?.[0] ?? 0;
		assert.ok(lastGrowth - clickedAt < 1_000, `frames grew ${Math.round(lastGrowth - clickedAt)} ms after the chat tab was picked`);
		assert.equal(await has3D(page), false, "the scene and its read-out are gone");
		assert.equal(await page.locator("canvas.of3d-canvas").count(), 0, "no canvas left");
	}
	assert.deepEqual(errors, []);
	await context.close();
});

test("without WebGL (--disable-3d-apis): the 2D view shows three floors with pictures, desks, names and boards, each dot within 4 px of its anchor", async () => {
	const plain = await chromium.launch({ args: ["--disable-3d-apis"] });
	try {
		const { context, page, errors } = await openOffice(plain, "machine-chat", "office3d-test");
		await page.locator("[data-id=office] .of-stage[data-renderer='2d'] [data-id=office-picture]").waitFor({ timeout: 30_000 });
		assert.equal(await has3D(page), false, "no 3D scene");
		// People on every floor: the director and staff (floors 2 and 3), then a background machine (floor 1). The 2D
		// picture shows one floor's people: the tester's test command is looked for on floor 3.
		for (let i = 0; i < 3; i++) await step(page);
		await page.locator("[data-id=office-floor-3]").click();
		await step(page);
		await reaches(page, "the tester", typeIs("tester"), "QA");
		await step(page);
		const pictures = pictureAnchors();
		for (const level of [1, 2, 3]) {
			await page.locator(`[data-id=office-floor-${level}]`).click();
			assert.equal(await pressedFloor(page), level);
			const img = page.locator("[data-id=office-picture] img");
			await page
				.waitForFunction((n) => {
					const el = document.querySelector<HTMLImageElement>("[data-id=office-picture] img");
					return el !== null && el.complete && el.naturalWidth > 0 && (el.getAttribute("src") ?? "").includes(`floor-${n}-`);
				}, level)
				.catch(() => assert.fail(`timed out waiting for the floor ${level} picture`));
			assert.ok((await img.getAttribute("src"))?.includes(`office-2d-floor-${level}-`));
			// Every desk of the floor has its projected point on the picture (the desks are in the baked picture).
			const anchors = pictures.get(level);
			assert.ok(anchors !== undefined, `floor ${level} in the asset file`);
			const desks = [...SPOTS].filter(([, s]) => s.floor === level && s.kind === "desk").map(([id]) => id);
			for (const id of desks) assert.ok(anchors.has(id), `desk ${id} on the floor ${level} picture`);
			// Boards: the lobby's on floor 1, Planning's on 2, Audit's and QA's on 3.
			const boards = await page.locator("[data-id=office-picture] .of-board-pin").count();
			assert.ok(boards >= 1, `floor ${level}: ${boards} boards`);
			// Every person on the floor: a name, and the dot within 4 px of the anchor's projected point.
			const placed = await page.evaluate(() => {
				const pic = document.querySelector("[data-id=office-picture] .of-picture")?.getBoundingClientRect();
				return [...document.querySelectorAll<HTMLElement>("[data-id=office-picture] .of-marker")].map((el) => {
					const dot = el.querySelector(".of-dot")?.getBoundingClientRect();
					return {
						anchor: el.dataset.anchor ?? "",
						name: el.querySelector(".of-name")?.textContent ?? "",
						stack: Number(el.style.getPropertyValue("--of-stack") || "0"),
						dot: dot === undefined ? null : [dot.left + dot.width / 2, dot.top + dot.height / 2],
						pic: pic === undefined ? null : [pic.left, pic.top, pic.width, pic.height],
					};
				});
			});
			assert.ok(placed.length > 0, `floor ${level} has people`);
			for (const m of placed) {
				assert.notEqual(m.name.trim(), "", `a name at ${m.anchor}`);
				assert.equal(SPOTS.get(m.anchor)?.floor, level, `${m.anchor} belongs to floor ${level}`);
				const at = anchors.get(m.anchor);
				assert.ok(at !== undefined && m.dot !== null && m.pic !== null, `${m.anchor} projected`);
				const [left, top, width, height] = m.pic;
				const x = (left ?? 0) + ((width ?? 0) * at[0]) / 100;
				const y = (top ?? 0) + ((height ?? 0) * at[1]) / 100 - m.stack * 26;
				const off = Math.hypot((m.dot[0] ?? 0) - x, (m.dot[1] ?? 0) - y);
				assert.ok(off <= 4, `${m.anchor}: the dot is ${off.toFixed(1)} px from its anchor`);
			}
		}
		assert.deepEqual(errors, []);
		await context.close();
	} finally {
		await plain.close();
	}
});

test("an AI that does not report its staff (Antigravity): the director alone walks to the rooms of its tools, a notice, token-only audit numbers", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-secret", FLAGS_3D);
	await page.getByText("AI này chưa báo cáo nhân viên: chỉ có Giám đốc.").waitFor({ timeout: 30_000 });
	await step(page); // 0: a turn begins
	await step(page); // 1: view_file: the library
	await reaches(page, "the director (view_file)", isDirector, "LIBRARY");
	await step(page); // 2: a test command: QA
	await reaches(page, "the director (run_command, tests)", isDirector, "QA");
	const people = await seen(page);
	assert.deepEqual(
		people.map((p) => p.kind),
		["director"],
		"the director alone",
	);
	// Audit's board (on floor 3, the floor the director works on now): tokens, no cost.
	await page.locator("[data-id=office-floor-3]").click();
	const audit = page.locator("[data-id=office-board-audit]").first();
	await audit.waitFor({ state: "attached" });
	const text = (await audit.textContent()) ?? "";
	assert.ok(text.includes("Token vào") && text.includes("Token ra"), `audit: ${text}`);
	assert.ok(!text.includes("Chi phí ước tính"), `audit without cost: ${text}`);
	assert.deepEqual(errors, []);
	await context.close();
});

test("the viewer's camera: wheel zoom stops at 0.8 and 3.2, a right-drag or shift-drag turns at most 0.45 rad", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-chat", FLAGS_3D);
	await page.locator("canvas.of3d-canvas").waitFor({ timeout: 30_000 });
	await poll("the 3D scene", () => has3D(page), (v) => v);
	const box = await page.locator("canvas.of3d-canvas").boundingBox();
	assert.ok(box !== null, "the canvas has a box");
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const camera = async () => (await readout(page))?.camera ?? { zoom: Number.NaN, yaw: Number.NaN };
	await page.mouse.move(cx, cy);
	for (let i = 0; i < 30; i += 1) await page.mouse.wheel(0, -400);
	await poll("zoomed in to the limit", async () => (await camera()).zoom, (z) => Math.abs(z - 3.2) < 0.01);
	for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 400);
	await poll("zoomed out to the limit", async () => (await camera()).zoom, (z) => Math.abs(z - 0.8) < 0.01);
	await page.mouse.down({ button: "right" });
	await page.mouse.move(cx + 600, cy, { steps: 20 });
	await page.mouse.up({ button: "right" });
	const turned = (await camera()).yaw;
	assert.ok(Math.abs(turned) > 0.1 && Math.abs(turned) <= 0.45 + 1e-6, `a long right-drag turns, capped at 0.45 rad: ${turned}`);
	await page.keyboard.down("Shift");
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx - 30, cy, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up("Shift");
	const shifted = (await camera()).yaw;
	assert.ok(Math.abs(shifted - turned) > 0.05, `shift-drag turns too: ${turned} → ${shifted}`);
	assert.deepEqual(errors, []);
	await context.close();
});
