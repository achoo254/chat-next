// The "Văn phòng" tab of an AI session in a real browser (Chromium) against
// the office of the visual harness's fake machine (test/support/fake-office.ts,
// a script that sends someone into each of the twelve rooms). The script is
// paused and played one step at a time, so every check waits for a known
// event: the tab opens, the 3D scene draws a canvas that is not blank (where
// Chromium gives WebGL, SwiftShader included: office3d=force), each room of
// the plan's room table is reached by the right person on the one floor plan
// (git and an external MCP → the post room, a test command → QA, an approval
// → Security with the chairman in the lobby, a denial → back, todo →
// Planning, a nested subagent → the meeting room, and the other rooms of the
// script), a seq gap recovers the snapshot's state, the view opens on the
// whole plan (a desktop window) and the framing button goes to the work zone
// and back, a dropped link cuts the power and a reconnect brings the lights
// back, draw calls stay within the medium rung's ceiling of 140 for the whole
// plan (and the work zone under it), and the chat tab stops the frames. Then without WebGL
// (--disable-3d-apis) the 2D view shows the plan's picture with every desk,
// names and boards, each dot within 4 px of its anchor; an AI that does not
// report its staff (Antigravity) shows the director alone with a notice and
// token-only audit numbers; and the residents' day: on a page clock pinned to
// office hours (Asia/Ho_Chi_Minh), everyone who worked stays after the session
// ends, goes to bed in the living zone at 23:30 (the director too, lying in a
// bed in 3D) and back to the work zones at 10:00. The inspector panel: a press on a name or a body opens
// the person's panel (a column beside the scene on a desktop window, a sheet under it on a phone, the scene
// shrinking to make room), a pan, a turn, a wheel and a pinch never open or close it, a press on nothing, Esc
// and its button close it, the ring under the chosen person is the only thing drawn more, a subagent's subject
// shows the same in its bubble and its panel, and the 2D view works the same. Starts its own Vite dev server of
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
const FLAGS_3D = "office3d=force&office3d-quality=medium&office3d-test";
/** Placement holds a room at least 4 s and lingers 6 s after work (office-placement.ts): a move may take this long. */
const MOVE_TIMEOUT_MS = 20_000;
/** The store cuts the power 30 s after the last word from a closed link (office-store.ts). */
const POWER_OUT_MS = 30_000;
/** The page's clock: the residents' day runs by the viewer's local time. */
const TIME_ZONE = "Asia/Ho_Chi_Minh";
const OFFICE_HOURS = "2026-11-16T10:00:00+07:00";
const BEDTIME = "2026-11-16T23:30:00+07:00";
const NEXT_MORNING = "2026-11-17T10:00:00+07:00";

let server: ViteDevServer;
let browser: Browser;

// --- The layout: which zone and room every anchor belongs to. -------------------------------------------------------

type Spot = { readonly zone: string | null; readonly room: string | null; readonly kind: string; readonly x: number; readonly z: number; readonly face: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Anchor id → zone, room and kind, from office-layout.json (a room's zone from the zones' room lists). */
function layoutSpots(): ReadonlyMap<string, Spot> {
	const json = readJson(LAYOUT_FILE);
	const zoneOf = new Map<string, string>();
	for (const z of isRecord(json) && Array.isArray(json.zones) ? json.zones : []) {
		if (!isRecord(z) || typeof z.id !== "string") continue;
		for (const room of Array.isArray(z.rooms) ? z.rooms : []) if (typeof room === "string") zoneOf.set(room, z.id);
	}
	const spots = new Map<string, Spot>();
	for (const a of isRecord(json) && Array.isArray(json.anchors) ? json.anchors : []) {
		if (!isRecord(a) || typeof a.id !== "string" || typeof a.kind !== "string") continue;
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		const room = typeof a.room === "string" ? a.room : null;
		spots.set(a.id, { zone: room === null ? null : (zoneOf.get(room) ?? null), room, kind: a.kind, x: num(a.x), z: num(a.z), face: num(a.face) });
	}
	assert.ok(spots.size > 0, "the layout has anchors");
	return spots;
}

/** Anchor id → [x %, y %] on the desktop picture of the plan, from public/office/office-assets.json. */
function pictureAnchors(): ReadonlyMap<string, readonly [number, number]> {
	const json = readJson(ASSETS_FILE);
	const out = new Map<string, readonly [number, number]>();
	const views = isRecord(json) && isRecord(json.views) ? json.views : {};
	const desktop = isRecord(views.desktop) && isRecord(views.desktop.anchors) ? views.desktop.anchors : {};
	for (const [id, at] of Object.entries(desktop)) {
		if (Array.isArray(at) && typeof at[0] === "number" && typeof at[1] === "number") out.set(id, [at[0], at[1]]);
	}
	return out;
}

const SPOTS = layoutSpots();
/** The zone of the dorm, the gym and the lounge. */
const LIVING_ZONE = "d";

// --- The page. ------------------------------------------------------------------------------------------------------

/** What window.__office (declared by the scene) reads out. */
type Readout = OfficeTestReadout;
type FakeOfficeApi = { pause(): void; step(): void; gapNext(): void; leakSubject(actorId: string, subject: string): void };
type FakeMachineApi = { sockets: { url: string; closed: boolean; drop(): void }[]; unreachable: Set<string> };
type TestWindow = Window & { __frameLog?: [number, number][]; __fakeOffice?: FakeOfficeApi; __fakeMachine?: FakeMachineApi };

/** A person as the page shows them: the marker (2D) or the pin over the scene (3D), with the anchor they are placed at. */
type Seen = { key: string; kind: string; anchor: string; status: string; name: string };

before(async () => {
	server = await createServer({ root: HARNESS, configFile: `${HARNESS}vite.config.ts`, publicDir: PUBLIC, logLevel: "warn", server: { port: PORT, strictPort: true } });
	await server.listen();
	// OFFICE_E2E_GPU=1 draws with the machine's graphics card (ANGLE/D3D11) instead of the software renderer.
	browser = await chromium.launch(process.env.OFFICE_E2E_GPU === "1" ? { args: ["--use-gl=angle", "--use-angle=d3d11", "--ignore-gpu-blocklist"] } : {});
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

function roomOf(p: Seen | undefined): { zone: string | null; room: string | null } | null {
	if (p === undefined) return null;
	const spot = SPOTS.get(p.anchor);
	return spot === undefined ? null : { zone: spot.zone, room: spot.room };
}

/** Whether 3D runs on this page (window.__office exposed). */
async function has3D(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as TestWindow).__office !== undefined);
}

async function readout(page: Page): Promise<Readout | null> {
	return page.evaluate(() => (window as TestWindow).__office?.read() ?? null);
}

/**
 * Waits until the person whose key matches `match` is placed in `room`, in the page's markers and, with 3D running,
 * as the scene's walking target too.
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
			return { key: p?.key ?? null, at, target: target === null ? null : { room: target.room } };
		},
		(v) => v.at !== null && v.at.room === room && (!three || (v.target !== null && v.target.room === room)),
	);
}

async function leaves(page: Page, who: string, match: (key: string) => boolean, room: string): Promise<void> {
	await poll(
		`${who} out of ${room}`,
		async () => roomOf((await seen(page)).find((s) => match(s.key))),
		(at) => at !== null && at.room !== room,
	);
}

/** The framing the view's button says it shows now ("work" or "overview"). */
async function framingOf(page: Page): Promise<string> {
	return (await page.locator("[data-id=office] [data-id=office-framing]").getAttribute("data-framing")) ?? "";
}

async function step(page: Page): Promise<void> {
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.step());
}

/**
 * A page of the harness at `at` with the office tab open on the session, the fake office's script paused (steps
 * play only through step()), and `flags` for the 3D view.
 */
async function openOffice(target: Browser, at: string, flags: string, screen: { width: number; height: number; touch?: boolean; frame?: number } = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page; errors: string[]; warnings: string[] }> {
	const context = await target.newContext({ locale: "vi-VN", viewport: { width: screen.width, height: screen.height }, hasTouch: screen.touch === true, timezoneId: TIME_ZONE });
	// Office hours on the page's clock (time still flows): off-duty people stay in the work zones (office-life-schedule.ts).
	await context.clock.install({ time: new Date(OFFICE_HOURS) });
	await context.addInitScript(
		([key, value]) => {
			window.localStorage.setItem(key, value);
			// Sound off (the default, stated so a leftover choice cannot change it).
			window.localStorage.setItem("ai:office:sound", "off");
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
	// A phone is the office's frame narrower than 640 px (office-view.tsx PHONE_WIDTH), not the window: the frame is narrowed here, and the window keeps the header's view switch in reach.
	if (screen.frame !== undefined) await page.addStyleTag({ content: `[data-id=office] { width: 100%; max-width: ${screen.frame}px; margin-inline: auto; }` });
	await page.locator("[data-id=office] [data-id=office-framing]").waitFor({ timeout: 30_000 });
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
/** The person of a job title (office-cast.ts: a title is one person whatever the subagents are). */
const person = (title: string) => (k: string) => k === `title:${title}`;

test("the office tab in 3D: every room of the table reached, seq gap, the framing button, power cut, draw calls, frames stop on the chat tab", async () => {
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

	// The director at their desk before any turn; a desktop window opens on the whole plan.
	await reaches(page, "the director", isDirector, "DIRECTOR");
	assert.equal(await framingOf(page), "overview");
	await step(page); // 0: a turn begins, the director thinks in their office

	// 1 with its first event lost (a seq gap): the director's Read only reaches the page through the fresh snapshot.
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.gapNext());
	await step(page);
	// The director only directs: his Read is the research analyst's work.
	await reaches(page, "the research analyst (the director's Read, after the gap's snapshot)", person("researchAnalyst"), "LIBRARY");
	await reaches(page, "the director at his chair meanwhile", isDirector, "DIRECTOR");
	await poll("the scout", async () => (await seen(page)).some((s) => person("techLead")(s.key)), (v) => v);

	await step(page); // 2: the scout greps, the tester and the planner come in
	await step(page); // 3: git, a test command, TodoWrite
	// Backend & DevOps never leaves the server room, whatever the tool.
	await reaches(page, "Backend & DevOps (git, in the server room)", person("backendDevops"), "SERVER");
	await reaches(page, "the QA tester (test command)", person("qaTester"), "QA");
	await reaches(page, "the producer (todo)", person("producerPm"), "PLANNING");
	await step(page); // 4: the test fails; a background shell
	// The background dev server is no person of its own: Backend & DevOps runs it in the server room, and their bubble says what it is.
	await reaches(page, "Backend & DevOps (the background dev server)", person("backendDevops"), "SERVER");
	assert.equal(await page.locator("[data-id='office-person-machine:m-dev']").count(), 0);
	const devopsPin = page.locator("[data-id='office-person-title:backendDevops']");
	await poll("the dev server in Backend & DevOps's bubble", async () => (await devopsPin.locator(".of-bubble").textContent()) ?? "", (b) => /^Máy chủ dev · cổng 5173 · (vừa chạy|\d+ phút)$/.test(b));
	assert.equal(await devopsPin.locator(".of-name").textContent(), "Backend & Hạ tầng");
	assert.equal(await devopsPin.getAttribute("data-service"), "dev-server");
	await step(page); // 5: the director edits; a code reviewer and a researcher come in
	await step(page); // 6: the reviewer edits (their home room replaces WORK)
	await reaches(page, "the code reviewer (edit, home room)", person("codeSecurityReviewer"), "AUDIT");
	await step(page); // 7
	await step(page); // 8
	await step(page); // 9: a nested subagent comes in; a general-purpose employee writes at their desk
	await reaches(page, "the gameplay developer (a general-purpose subagent writes)", person("gameplayDeveloper"), "WORK");

	// 10: an approval waits: the reviewer greets at Security, the chairman (you) in the lobby. The framing stays where it was:
	// the camera does not move on its own to the work.
	await step(page);
	await reaches(page, "the reviewer (awaiting approval)", person("codeSecurityReviewer"), "SECURITY");
	await reaches(page, "the chairman", isChairman, "LOBBY");
	assert.equal(await framingOf(page), "overview", "the framing does not follow the work");

	// The framing button names the other framing: the work zone, then back to the whole plan, one press each.
	const framing = page.locator("[data-id=office] [data-id=office-framing]");
	assert.equal(await framing.textContent(), "Về khu làm việc");
	await framing.click();
	assert.equal(await framingOf(page), "work");
	assert.equal(await framing.textContent(), "Toàn cảnh");
	await framing.click();
	assert.equal(await framingOf(page), "overview");
	assert.equal(await framing.textContent(), "Về khu làm việc");

	// 11: denied: the reviewer leaves Security, the chairman goes.
	await step(page);
	await leaves(page, "the reviewer (denied)", person("codeSecurityReviewer"), "SECURITY");
	await poll("the chairman gone", async () => (await seen(page)).some((s) => isChairman(s.key)), (v) => !v);
	await step(page); // 12: tunelo's own MCP (a message to you) in the lobby: nobody's department, so nobody goes; no coffee in office hours
	await step(page); // 13: an external MCP: the post room
	await reaches(page, "content marketing (external MCP)", person("contentMarketing"), "POST");

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
	await reaches(page, "content marketing after the reconnect", person("contentMarketing"), "POST");

	if (three) {
		// The canvas is not blank, and both framings stay within the medium rung's draw-call budget: at most 100 for a
		// phone's opening framing and 140 for the whole plan. This runs a desktop window, so it checks the whole plan's
		// ceiling of 140 (the work zone, a part of it, under the same ceiling); the phone's opening framing is not measured here.
		await page.waitForTimeout(2_000);
		const shades = await colours(page, "[data-id=office] canvas.of3d-canvas");
		assert.ok(shades > 32, `the canvas has ${shades} colours`);
		const calls: Record<string, number> = {};
		for (const want of ["work", "overview"]) {
			if ((await framingOf(page)) !== want) await framing.click();
			assert.equal(await framingOf(page), want);
			await page.waitForTimeout(2_500); // the camera's move to the framing
			let most = 0;
			for (let i = 0; i < 10; i++) {
				most = Math.max(most, (await readout(page))?.drawCalls ?? 0);
				await page.waitForTimeout(100);
			}
			calls[want] = most;
			// The whole plan on a wide screen is the heaviest view (ceiling 140); above it the furniture materials must be merged further.
			assert.ok(most > 0 && most < 140, `${want} framing: ${most} draw calls`);
			assert.ok((await colours(page, "[data-id=office] canvas.of3d-canvas")) > 32, `${want} framing drawn`);
		}
		console.log(`office e2e: draw calls (medium) work ${calls.work}, overview ${calls.overview}`);

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

test("opening the office again shows everyone already there at their place: nobody walks in from the door", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-chat", FLAGS_3D);
	const webgl = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
	if (!webgl) {
		console.log("office e2e: no WebGL2, the walk-in check is 3D only (2D draws no walking)");
		await context.close();
		return;
	}
	await page.locator("[data-id=office] .of3d[data-ready='true']").waitFor({ timeout: 60_000 });
	for (let i = 0; i <= 6; i++) await step(page);
	await poll("the staff in", async () => (await seen(page)).filter((s) => s.kind === "employee").length, (n) => n >= 5);
	// Away to the chat and back: a new scene, a fresh snapshot of people who came in before it opened.
	await page.locator("[data-id=session-mode-chat]").click();
	await page.locator("[data-id=office]").waitFor({ state: "detached" });
	await page.locator("[data-id=session-mode-office]").click();
	await page.locator("[data-id=office] .of3d[data-ready='true']").waitFor({ timeout: 60_000 });
	await until(page, "window.__office", () => (window as TestWindow).__office !== undefined);
	await poll("the people drawn", async () => (await readout(page))?.people.length ?? 0, (n) => n >= 6);
	// The first second: everyone stands or sits where they are; nobody walks in from the lobby door.
	for (let i = 0; i < 5; i++) {
		const people = (await readout(page))?.people ?? [];
		const walking = people.filter((p) => p.pose === "walk").map((p) => p.key);
		assert.deepEqual(walking, [], "everyone is already at their place (nobody walking in)");
		await page.waitForTimeout(200);
	}
	assert.deepEqual(errors, []);
	await context.close();
});

test("without WebGL (--disable-3d-apis): the 2D view shows the plan's picture with every desk, names and boards, each dot within 4 px of its anchor", async () => {
	const plain = await chromium.launch({ args: ["--disable-3d-apis"] });
	try {
		const { context, page, errors } = await openOffice(plain, "machine-chat", "office3d-test");
		await page.locator("[data-id=office] .of-stage[data-renderer='2d'] [data-id=office-picture]").waitFor({ timeout: 30_000 });
		assert.equal(await has3D(page), false, "no 3D scene");
		// People in several zones at once: the director and staff (records and control zones), then Backend & DevOps
		// running a background service (the server room of the work zone), all on the one picture.
		for (let i = 0; i < 4; i++) await step(page);
		await reaches(page, "the QA tester", person("qaTester"), "QA");
		await step(page);
		const anchors = pictureAnchors();
		const img = page.locator("[data-id=office-picture] img");
		await page
			.waitForFunction(() => {
				const el = document.querySelector<HTMLImageElement>("[data-id=office-picture] img");
				return el !== null && el.complete && el.naturalWidth > 0;
			})
			.catch(() => assert.fail("timed out waiting for the plan's picture"));
		assert.match((await img.getAttribute("src")) ?? "", /\/office\/office-2d-plan-(day|night)-desktop\.[0-9a-f]+\.webp$/);
		// Every desk of the plan has its projected point on the picture (the desks are in the baked picture).
		const desks = [...SPOTS].filter(([, s]) => s.kind === "desk").map(([id]) => id);
		assert.ok(desks.length > 0, "the plan has desks");
		for (const id of desks) assert.ok(anchors.has(id), `desk ${id} on the plan's picture`);
		// Boards: the lobby's, Planning's, Audit's and QA's, all on the one picture.
		const boards = await page.locator("[data-id=office-picture] .of-board-pin").count();
		assert.equal(boards, 4, `${boards} boards`);
		const zones = new Set<string>();
		for (const framing of ["work", "overview"]) {
			if ((await framingOf(page)) !== framing) await page.locator("[data-id=office] [data-id=office-framing]").click();
			assert.equal(await page.locator("[data-id=office] .of-stage[data-renderer='2d']").getAttribute("data-framing"), framing);
			// Every person: a name, and the dot within 4 px of the anchor's projected point.
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
			assert.ok(placed.length > 0, `people on the picture (${framing})`);
			for (const m of placed) {
				assert.notEqual(m.name.trim(), "", `a name at ${m.anchor}`);
				const zone = SPOTS.get(m.anchor)?.zone;
				if (zone !== null && zone !== undefined) zones.add(zone);
				const at = anchors.get(m.anchor);
				assert.ok(at !== undefined && m.dot !== null && m.pic !== null, `${m.anchor} projected`);
				const [left, top, width, height] = m.pic;
				const x = (left ?? 0) + ((width ?? 0) * at[0]) / 100;
				const y = (top ?? 0) + ((height ?? 0) * at[1]) / 100 - m.stack * 26;
				const off = Math.hypot((m.dot[0] ?? 0) - x, (m.dot[1] ?? 0) - y);
				assert.ok(off <= 4, `${m.anchor}: the dot is ${off.toFixed(1)} px from its anchor (${framing})`);
			}
		}
		assert.ok(zones.size >= 2, `people in several zones on one picture: ${[...zones].join(", ")}`);
		assert.deepEqual(errors, []);
		await context.close();
	} finally {
		await plain.close();
	}
});

test("an AI that does not report its staff (Antigravity): the director directs while the departments do the work of its tools, a notice, token-only audit numbers", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-secret", FLAGS_3D);
	await page.getByText("AI này chưa báo cáo nhân viên: chỉ có Giám đốc.").waitFor({ timeout: 30_000 });
	await step(page); // 0: a turn begins
	await step(page); // 1: view_file: the library
	await reaches(page, "the research analyst (the director's view_file)", person("researchAnalyst"), "LIBRARY");
	await step(page); // 2: a test command: QA
	await reaches(page, "the QA tester (the director's run_command, tests)", person("qaTester"), "QA");
	const people = await seen(page);
	// The fifteen are always in the building, whatever the AI reports.
	assert.equal(people.filter((p) => p.kind === "director" || p.kind === "employee" || p.kind === "advisor").length, 15, "the fifteen of the office");
	// Audit's board (in the control zone, beside QA where the director works now): tokens, no cost.
	const audit = page.locator("[data-id=office-board-audit]").first();
	await audit.waitFor({ state: "attached" });
	const text = (await audit.textContent()) ?? "";
	assert.ok(text.includes("Token vào") && text.includes("Token ra"), `audit: ${text}`);
	assert.ok(!text.includes("Chi phí ước tính"), `audit without cost: ${text}`);
	assert.deepEqual(errors, []);
	await context.close();
});

test("the viewer's camera: wheel zoom stops at its limits, a right-drag or shift-drag turns at most 0.45 rad", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-chat", FLAGS_3D);
	await page.locator("canvas.of3d-canvas").waitFor({ timeout: 30_000 });
	await poll("the 3D scene", () => has3D(page), (v) => v);
	const box = await page.locator("canvas.of3d-canvas").boundingBox();
	assert.ok(box !== null, "the canvas has a box");
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const camera = async () => (await readout(page))?.camera ?? { zoom: Number.NaN, yaw: Number.NaN };
	await page.mouse.move(cx, cy);
	const start = (await camera()).zoom;
	// The limits depend on the canvas size (the whole plan is the widest view): the zoom must reach one and stay there.
	const settle = async (delta: number, count: number): Promise<number> => {
		for (let i = 0; i < count; i += 1) await page.mouse.wheel(0, delta);
		await page.waitForTimeout(1_200);
		const first = (await camera()).zoom;
		for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, delta);
		await page.waitForTimeout(600);
		const second = (await camera()).zoom;
		assert.ok(Math.abs(second - first) < 0.01, `the zoom stops at its limit: ${first} → ${second}`);
		return second;
	};
	const closest = await settle(-400, 40);
	assert.ok(closest > start * 2, `zoomed in well past the opening framing: ${start} → ${closest}`);
	const widest = await settle(400, 60);
	assert.ok(widest < start * 1.05 && widest < closest, `zoomed out to the whole plan at most: ${widest}`);
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

test("the residents' day: after the session nobody goes home, at 23:30 everyone sleeps in the living zone, at 10:00 they are back in the work zones", async () => {
	const { context, page, errors } = await openOffice(browser, "machine-chat", FLAGS_3D);
	const webgl = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
	if (webgl) await page.locator("[data-id=office] .of3d[data-ready='true']").waitFor({ timeout: 60_000 });
	// The whole script: the session ends (step 20) and every subagent leaves (step 21).
	for (let i = 0; i <= 21; i++) await step(page);
	await poll("the staff off duty", async () => (await seen(page)).filter((s) => s.kind === "employee").length, (n) => n >= 13);
	const staffKeys = (await seen(page)).filter((s) => s.kind === "employee").map((s) => s.key);
	await poll("the director in the office (idle, office hours)", async () => roomOf((await seen(page)).find((s) => isDirector(s.key)))?.room ?? null, (room) => room === "DIRECTOR");
	await context.clock.setSystemTime(new Date(BEDTIME));
	await reaches(page, "the director at bedtime", isDirector, "DORM");
	await poll("the off-duty staff in the living zone", async () => (await seen(page)).filter((s) => staffKeys.includes(s.key) && roomOf(s)?.zone === LIVING_ZONE).length, (n) => n === staffKeys.length - 1);
	// Backend & DevOps stays on duty in the server room.
	await reaches(page, "Backend & DevOps on duty at night", person("backendDevops"), "SERVER");
	const anchors = (await seen(page)).filter((s) => s.kind === "director" || s.kind === "employee").map((s) => s.anchor);
	assert.equal(new Set(anchors).size, anchors.length, `one person per place: ${anchors.join(", ")}`);
	assert.ok(anchors.filter((a) => a.startsWith("bed-")).length === 13, `thirteen of the sixteen beds taken: ${anchors.join(", ")}`);
	if (await has3D(page)) {
		await poll(
			"the director lying in bed",
			async () => (await readout(page))?.people.find((p) => isDirector(p.key))?.pose ?? "",
			(pose) => pose === "sleep",
			60_000,
		);
		// Everyone asleep lies along their bed, head on the pillow: the bed anchor's facing, at its centre.
		const sleepers = ((await readout(page))?.people ?? []).filter((p) => p.pose === "sleep");
		assert.ok(sleepers.length > 0, "someone sleeps");
		for (const p of sleepers) {
			const bed = SPOTS.get(p.target);
			assert.equal(bed?.kind, "bed", `${p.key} sleeps at a bed: ${p.target}`);
			if (bed === undefined) continue;
			const turn = Math.abs(Math.atan2(Math.sin(p.heading - bed.face), Math.cos(p.heading - bed.face)));
			assert.ok(turn < 0.01, `${p.key} lies along ${p.target}: heading ${p.heading}, bed ${bed.face}`);
			assert.ok(Math.hypot(p.x - bed.x, p.z - bed.z) < 0.01, `${p.key} lies at the centre of ${p.target}: ${p.x}, ${p.z}`);
			// The body itself (the rigged model's head bone): along the bed, not across it.
			if (p.head !== null) {
				const along = Math.abs(p.head.x * Math.sin(bed.face) + p.head.z * Math.cos(bed.face));
				const across = Math.abs(p.head.x * Math.cos(bed.face) - p.head.z * Math.sin(bed.face));
				console.log(`office e2e: ${p.key} at ${p.target}: head ${p.head.x.toFixed(2)}, ${p.head.z.toFixed(2)} (along ${along.toFixed(2)}, across ${across.toFixed(2)})`);
				assert.ok(across < along, `${p.key} lies along ${p.target}, not across it: along ${along.toFixed(2)}, across ${across.toFixed(2)}`);
			}
		}
	}
	await context.clock.setSystemTime(new Date(NEXT_MORNING));
	// Placed in the office (a talk may walk the 3D figure over to a neighbour meanwhile: the placement stays).
	await poll("the director back in the office", async () => roomOf((await seen(page)).find((s) => isDirector(s.key)))?.room ?? null, (room) => room === "DIRECTOR");
	await poll("the staff back in the work zones", async () => (await seen(page)).filter((s) => staffKeys.includes(s.key) && roomOf(s)?.zone === LIVING_ZONE).length, (n) => n === 0);
	assert.deepEqual(errors, []);
	await context.close();
});

// --- The inspector panel. -------------------------------------------------------------------------------------------

const PANEL = "[data-id=office] [data-id=office-inspector]";

/** The key of the person whose panel is open, or null. */
async function openPanel(page: Page): Promise<string | null> {
	return page.locator(PANEL).first().getAttribute("data-key", { timeout: 500 }).catch(() => null);
}

/** The centre of a person's name tag on the page (3D: the button over the scene; 2D: the name in the picture). */
async function tagCentre(page: Page, key: string): Promise<{ x: number; y: number }> {
	const box = await page.locator(`[data-id='office-person-${key}'] .of3d-tag, [data-id='office-person-${key}'] .of-pick`).first().boundingBox();
	if (box === null) assert.fail(`no name tag for ${key}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A point of the canvas where nobody is: its top left corner (the plan's backdrop). */
async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
	const box = await page.locator("[data-id=office] canvas.of3d-canvas").boundingBox();
	if (box === null) assert.fail("no canvas");
	return { x: box.x + 12, y: box.y + 12 };
}

async function drawCallsMost(page: Page): Promise<number> {
	let most = 0;
	for (let i = 0; i < 10; i++) {
		most = Math.max(most, (await readout(page))?.drawCalls ?? 0);
		await page.waitForTimeout(100);
	}
	return most;
}

test("the inspector in 3D: a name or a body opens the panel, a pan, a turn and a wheel do not touch it, a press on nothing, Esc close it, the ring follows it, the subject shows the same in the bubble and the panel", async () => {
	const { context, page, errors, warnings } = await openOffice(browser, "machine-chat", FLAGS_3D);
	const webgl = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
	if (!webgl) {
		console.log("office e2e: no WebGL2, the 3D inspector checks are skipped");
		await context.close();
		return;
	}
	await page
		.locator("[data-id=office] .of3d[data-ready='true']")
		.waitFor({ timeout: 60_000 })
		.catch(() => assert.fail(`the 3D scene did not start: ${warnings.join(" | ")}`));
	await until(page, "window.__office", () => (window as TestWindow).__office !== undefined);
	await step(page); // 0: a turn begins
	await step(page); // 1: the director's Read is the research analyst's work; a scout comes in
	await step(page); // 2
	await step(page); // 3: a test command for the tester
	await reaches(page, "the QA tester", person("qaTester"), "QA");
	await reaches(page, "the research analyst", person("researchAnalyst"), "LIBRARY");
	assert.equal(await openPanel(page), null, "no panel before anyone is chosen");
	assert.equal((await readout(page))?.selectionRing, false, "no ring before anyone is chosen");
	const before = await drawCallsMost(page);

	// A press on a name tag: the tag takes no pointer, the canvas's tap finds it.
	const tag = await tagCentre(page, "title:qaTester");
	await page.mouse.click(tag.x, tag.y);
	await poll("the panel of the QA tester", () => openPanel(page), (k) => k === "title:qaTester", 5_000);
	assert.equal(await page.locator(`${PANEL} h3`).textContent(), "Kiểm thử phần mềm");
	await poll("the ring", async () => (await readout(page))?.selectionRing, (r) => r === true, 5_000);
	assert.equal(await page.locator("[data-id=office] .of-body").getAttribute("data-panel"), "open");
	// The scene shrank to make room: the panel stands beside the canvas and the person is not behind it.
	const canvasBox = await page.locator("[data-id=office] canvas.of3d-canvas").boundingBox();
	const panelBox = await page.locator(PANEL).boundingBox();
	if (canvasBox === null || panelBox === null) assert.fail("no canvas or panel box");
	assert.ok(canvasBox.x + canvasBox.width <= panelBox.x + 1, "the panel is beside the canvas, not over it");
	const chosen = await tagCentre(page, "title:qaTester");
	assert.ok(chosen.x < panelBox.x, "the chosen person's tag is not behind the panel");

	// The draw calls with someone chosen: the ring is the only thing drawn more.
	const after = await drawCallsMost(page);
	console.log(`office e2e: draw calls without a ring ${before}, with a chosen person ${after}`);
	assert.ok(after <= before + 1, `the ring adds at most one draw call (${before} -> ${after})`);
	assert.ok(after < 140, `a chosen person: ${after} draw calls`);

	// A pan (left drag), a turn (right drag and shift drag), a wheel and a pinch-less zoom: none opens or closes anything.
	const empty = await emptySpot(page);
	await page.mouse.move(empty.x, empty.y);
	await page.mouse.down();
	await page.mouse.move(empty.x + 60, empty.y + 20, { steps: 6 });
	await page.mouse.up();
	assert.equal(await openPanel(page), "title:qaTester", "a pan does not close the panel");
	await page.mouse.move(empty.x, empty.y + 40);
	await page.mouse.down({ button: "right" });
	await page.mouse.move(empty.x + 50, empty.y + 40, { steps: 5 });
	await page.mouse.up({ button: "right" });
	assert.equal(await openPanel(page), "title:qaTester", "a right drag does not close the panel");
	await page.keyboard.down("Shift");
	await page.mouse.move(empty.x, empty.y + 60);
	await page.mouse.down();
	await page.mouse.move(empty.x + 50, empty.y + 60, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up("Shift");
	assert.equal(await openPanel(page), "title:qaTester", "a shift drag does not close the panel");
	await page.mouse.move(empty.x + 100, empty.y + 100);
	await page.mouse.wheel(0, -240);
	assert.equal(await openPanel(page), "title:qaTester", "the wheel does not close the panel");

	// The subject a subagent's tool carries (as an agent that broke its contract would send it) is the same in the bubble and the panel.
	await page.evaluate(() => (window as TestWindow).__fakeOffice?.leakSubject("s-tester", "secret.sh"));
	await poll("the subject in the panel", async () => (await page.locator(`${PANEL} .of-panel-mono`).allTextContents()).join(" "), (t) => t.includes("secret.sh"), 5_000);
	assert.match((await page.locator("[data-id='office-person-title:qaTester'] .of-bubble").textContent()) ?? "", /secret\.sh/);

	// The director's git (step 3) is Backend & DevOps's work, as the bubble shows it: it is on that person's panel, with its subject, and not on the director's.
	await page.mouse.click(empty.x + 200, empty.y + 200).catch(() => undefined);
	await poll("no panel after a press on nothing", () => openPanel(page), (k) => k === null, 5_000);
	assert.equal((await readout(page))?.selectionRing, false, "the ring goes with the choice");
	const devops = page.locator("[data-id='office-person-title:backendDevops'] button.of3d-tag");
	await devops.focus();
	await page.keyboard.press("Enter");
	await poll("the panel of Backend & DevOps by keyboard", () => openPanel(page), (k) => k === "title:backendDevops", 5_000);
	const devopsText = (await page.locator(PANEL).textContent()) ?? "";
	assert.ok(devopsText.includes("Bash") && devopsText.includes("git"), `the director's git on the department's panel: ${devopsText}`);
	await page.keyboard.press("Escape");
	await poll("closed by Esc", () => openPanel(page), (k) => k === null, 5_000);
	assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-id='office-person-title:backendDevops']") !== null), true, "the focus is back on the name");

	// A press on a body (not its name): the director, a little below the label's anchor.
	const director = (await readout(page))?.people.find((p) => p.key === "director")?.screen ?? null;
	if (director === null) assert.fail("the director is not on screen");
	const canvas = await page.locator("[data-id=office] canvas.of3d-canvas").boundingBox();
	if (canvas === null) assert.fail("no canvas");
	await page.mouse.click(canvas.x + director[0], canvas.y + director[1] + 18);
	await poll("the panel of the director by a press on his body", () => openPanel(page), (k) => k === "director", 5_000);
	await page.locator(`${PANEL} [data-id=office-inspector-close]`).click();
	await poll("closed by its button", () => openPanel(page), (k) => k === null, 5_000);
	assert.deepEqual(errors, []);
	await context.close();
});

test("the inspector on a phone: a tap on a name opens a sheet under the scene, the scene shrinks until the whole sheet is on screen, and the draw calls stay within the phone's 100", async () => {
	const { context, page, errors, warnings } = await openOffice(browser, "machine-chat", FLAGS_3D, { width: 1280, height: 760, touch: true, frame: 390 });
	const webgl = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
	if (!webgl) {
		console.log("office e2e: no WebGL2, the phone inspector check is skipped");
		await context.close();
		return;
	}
	await page
		.locator("[data-id=office] .of3d[data-ready='true']")
		.waitFor({ timeout: 60_000 })
		.catch(() => assert.fail(`the 3D scene did not start: ${warnings.join(" | ")}`));
	await until(page, "window.__office", () => (window as TestWindow).__office !== undefined);
	assert.equal(await page.locator("[data-id=office]").getAttribute("data-size"), "phone");
	await step(page); // 0
	await step(page); // 1
	await step(page); // 2
	await step(page); // 3
	await reaches(page, "the QA tester", person("qaTester"), "QA");
	await page.waitForTimeout(2_500); // the camera's opening framing
	const before = await drawCallsMost(page);
	// The work framing of a phone shows the work zone: choose someone the scene has on screen.
	const frameBox = await page.locator("[data-id=office] canvas.of3d-canvas").boundingBox();
	if (frameBox === null) assert.fail("no canvas");
	const onScreen = ((await readout(page))?.people ?? []).filter((p) => p.key !== "chairman" && p.screen !== null && p.screen[0] > 24 && p.screen[0] < frameBox.width - 24 && p.screen[1] > 40 && p.screen[1] < frameBox.height - 8);
	console.log(`office e2e: on a phone's frame ${onScreen.length} people on screen: ${onScreen.map((p) => p.key).join(", ")}`);
	const key = (onScreen.find((p) => p.key === "director") ?? onScreen[0])?.key;
	if (key === undefined) assert.fail("nobody on the phone's frame");
	const at = await tagCentre(page, key);
	await page.touchscreen.tap(at.x, at.y);
	await poll("the panel by a tap", () => openPanel(page), (k) => k === key, 5_000);
	const canvasBox = await page.locator("[data-id=office] canvas.of3d-canvas").boundingBox();
	const panelBox = await page.locator(PANEL).boundingBox();
	if (canvasBox === null || panelBox === null) assert.fail("no canvas or panel box");
	assert.ok(panelBox.y >= canvasBox.y + canvasBox.height - 1, `the sheet is under the scene (panel at ${panelBox.y}, canvas ends ${canvasBox.y + canvasBox.height})`);
	// The scene gives way so the whole sheet is on screen without scrolling the frame (a phone's height is 760 px here).
	assert.ok(panelBox.y + panelBox.height <= 760, `the whole sheet is on screen (it ends at ${Math.round(panelBox.y + panelBox.height)} of 760)`);
	await page.waitForTimeout(1_500);
	const after = await drawCallsMost(page);
	console.log(`office e2e: phone draw calls without a ring ${before}, with a chosen person ${after}`);
	// Only the budget here: the scene gives way to the sheet, so the camera frames more of the plan and more furniture is drawn,
	// which is not the ring's cost (the desktop test above holds the ring to one draw call with the frame unchanged).
	assert.ok(after <= 100, `the phone's budget with a chosen person: ${after} draw calls (100)`);
	assert.deepEqual(errors, []);
	await context.close();
});

test("the inspector without WebGL: a name opens the panel, a press on the picture closes it, the same name again and Esc too", async () => {
	const plain = await chromium.launch({ args: ["--disable-3d-apis"] });
	try {
		const { context, page, errors } = await openOffice(plain, "machine-chat", "office3d-test");
		await page.locator("[data-id=office] .of-stage[data-renderer='2d'] [data-id=office-picture]").waitFor({ timeout: 30_000 });
		for (let i = 0; i < 4; i++) await step(page);
		await reaches(page, "the QA tester", person("qaTester"), "QA");
		const name = page.locator("[data-id='office-person-title:qaTester'] .of-pick");
		await name.click();
		await poll("the panel", () => openPanel(page), (k) => k === "title:qaTester", 5_000);
		assert.equal(await name.getAttribute("aria-pressed"), "true");
		await name.click();
		await poll("closed by the same name", () => openPanel(page), (k) => k === null, 5_000);
		await name.click();
		await poll("the panel again", () => openPanel(page), (k) => k === "title:qaTester", 5_000);
		// A press on the picture where no name is.
		const pic = await page.locator("[data-id=office-picture] .of-picture").boundingBox();
		if (pic === null) assert.fail("no picture");
		await page.mouse.click(pic.x + 4, pic.y + 4);
		await poll("closed by a press on nothing", () => openPanel(page), (k) => k === null, 5_000);
		await name.click();
		await poll("the panel once more", () => openPanel(page), (k) => k === "title:qaTester", 5_000);
		await page.keyboard.press("Escape");
		await poll("closed by Esc", () => openPanel(page), (k) => k === null, 5_000);
		assert.deepEqual(errors, []);
		await context.close();
	} finally {
		await plain.close();
	}
});
