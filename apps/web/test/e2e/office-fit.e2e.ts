// How the bodies sit in the 3D office, measured on the drawn skeletons (the test API's `probe`): on the real scene of the
// visual harness, for the staff and the director, who have different proportions. Feet reach the floor when standing,
// the body rests on the seat under it when sitting (the seat's height comes from its furniture's socket, the contact from
// the model's own skin), and someone lying down rests on the mattress and stays within the bed.
//
//   node --test test/e2e/office-fit.e2e.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { isSeatedPose, type Pose } from "../../src/office-3d/character/anim-groups.ts";
import type { OfficeTestReadout } from "../../src/office-3d/world-support.ts";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
/** Apart from the other specs' ports (4600-4630, 5173-5183). */
const PORT = 5185;
const FLAGS_3D = "office3d=force&office3d-quality=medium&office3d-test";
const TIME_ZONE = "Asia/Ho_Chi_Minh";
const OFFICE_HOURS = "2026-11-16T10:00:00+07:00";
const BEDTIME = "2026-11-16T23:30:00+07:00";
const AFTER_WORK = "2026-11-16T18:00:00+07:00";
const LAYOUT = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/machines/office/office-layout.json", import.meta.url)), "utf8")) as { anchors: { id: string; seat?: number }[] };
/** How far the resting skin may be from the seat's height (m). */
const MAX_OFF_SEAT_HEIGHT = 0.02;
/** How far a seated pelvis may be from the seat's centre across the floor (m). */
const MAX_PELVIS_OFF_SEAT = 0.05;
/** A bed is 0.95 m wide; arms and legs may reach this far beyond it (m). */
const MAX_BODY_WIDTH_ON_BED = 1.12;

type Person = OfficeTestReadout["people"][number];
type TestWindow = Window & { __office?: { read(): OfficeTestReadout }; __fakeOffice?: { pause(): void; step(): void } };

let server: ViteDevServer;
let browser: Browser;

before(async () => {
	server = await createServer({ root: HARNESS, configFile: `${HARNESS}vite.config.ts`, publicDir: PUBLIC, logLevel: "warn", server: { port: PORT, strictPort: true } });
	await server.listen();
	browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11"] });
});

after(async () => {
	await browser?.close();
	await server?.close();
});

/** The people drawn on the plan after `steps` of the fake office's script and, when given, the page clock set to `at`. */
async function peopleOn(steps: number, at: string | null): Promise<readonly Person[]> {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1280, height: 800 }, timezoneId: TIME_ZONE });
	try {
		await context.clock.install({ time: new Date(OFFICE_HOURS) });
		await context.addInitScript(
			([key, value]) => {
				window.localStorage.setItem(key, value);
				window.localStorage.setItem("ai:office:sound", "off");
			},
			["ai:office:3d-flags", FLAGS_3D] as const,
		);
		const page = await context.newPage();
		await page.goto(`http://localhost:${PORT}/?at=machine-chat&office`);
		await page.waitForFunction(() => (window as TestWindow).__fakeOffice !== undefined, null, { timeout: 30_000 });
		await page.evaluate(() => (window as TestWindow).__fakeOffice?.pause());
		await page.locator("[data-id=session-mode-office]").click();
		await page.locator("[data-id=office] .of3d[data-ready='true']").waitFor({ timeout: 60_000 });
		// A desktop window opens on the whole plan, so every place measured is in view; the framing button is never pressed.
		const framing = page.locator("[data-id=office] [data-id=office-framing]");
		assert.equal(await framing.getAttribute("data-framing"), "overview", "the office opens on the whole plan");
		for (let i = 0; i <= steps; i += 1) {
			await page.evaluate(() => (window as TestWindow).__fakeOffice?.step());
			await page.waitForTimeout(200);
		}
		await page.waitForTimeout(8000);
		if (at !== null) {
			await context.clock.setSystemTime(new Date(at));
			await page.waitForTimeout(3000);
		}
		await page.waitForTimeout(22_000);
		assert.equal(await framing.getAttribute("data-framing"), "overview", "the office stays on the whole plan");
		const read = await page.evaluate(() => (window as TestWindow).__office?.read());
		assert.ok(read, "the test API is there");
		return read.people.filter((p) => p.probe !== null);
	} finally {
		await context.close();
	}
}

const rel = (p: Person, y: number): number => y - (p.probe?.root.y ?? 0);

/** Everyone sitting: over the seat's centre, resting on the seat's height (not sunk into it, not floating), no leg through the floor. */
function assertSeated(label: string, seated: readonly Person[]): void {
	for (const p of seated) {
		const probe = p.probe;
		assert.ok(probe?.pelvis && probe.seatBottom !== null, `${label}: ${p.key} has a pelvis and resting skin`);
		const off = Math.hypot(probe.pelvis.x - probe.root.x, probe.pelvis.z - probe.root.z);
		assert.ok(off < MAX_PELVIS_OFF_SEAT, `${label}: ${p.key} sits over the seat (pelvis ${off.toFixed(3)} m from its centre)`);
		const seat = LAYOUT.anchors.find((a) => a.id === p.target)?.seat;
		assert.ok(seat !== undefined, `${label}: ${p.key}'s seat ${p.target} has a height`);
		const rest = rel(p, probe.seatBottom);
		assert.ok(Math.abs(rest - seat) < MAX_OFF_SEAT_HEIGHT, `${label}: ${p.key} rests on ${p.target} (skin at ${rest.toFixed(3)} m, seat ${seat} m, pelvis ${rel(p, probe.pelvis.y).toFixed(3)} m)`);
		assert.ok(rel(p, probe.min.y) > -0.02, `${label}: ${p.key}'s legs stay above the floor (${rel(p, probe.min.y).toFixed(3)} m)`);
	}
}

test("everyone seated rests on the seat under them, over its centre: at their desks in office hours (the director and the advisor too)", async () => {
	const people = await peopleOn(0, null);
	const seated = people.filter((p) => isSeatedPose(p.pose as Pose));
	assert.ok(seated.length >= 10, `most of the cast sits at their seats in office hours (${seated.length})`);
	assert.ok(seated.some((p) => p.key === "director") && seated.some((p) => p.key === "advisor"), "the director and the advisor sit at their own seats");
	assertSeated("office hours", seated);
});

test("everyone seated after work rests on the sofa, the armchairs, the beanbags or the dining chairs", async () => {
	const people = await peopleOn(21, AFTER_WORK);
	const seated = people.filter((p) => isSeatedPose(p.pose as Pose));
	assert.ok(seated.length >= 1, `someone sits in the lounge after work (${seated.length})`);
	assertSeated("after work", seated);
});

test("everyone on a bed rests on the mattress and stays within the bed: asleep at night, lying back after work (the director too)", async () => {
	for (const [label, at, pose] of [
		["asleep", BEDTIME, "sleep"],
		["lying back", AFTER_WORK, "lounge"],
	] as const) {
		const people = await peopleOn(21, at);
		const lying = people.filter((p) => p.pose === pose);
		assert.ok(lying.length >= 3, `${label}: several people lie on beds (${lying.length})`);
		for (const p of lying) {
			const probe = p.probe;
			assert.ok(probe);
			assert.ok(Math.abs(rel(p, probe.min.y)) < 0.04, `${label}: ${p.key} rests on the mattress (lowest point ${rel(p, probe.min.y).toFixed(3)} m from it)`);
			// The beds lie along x with the head to the wall (some across it): the body's short side is its width on the bed.
			const width = Math.min(probe.max.x - probe.min.x, probe.max.z - probe.min.z);
			assert.ok(width <= MAX_BODY_WIDTH_ON_BED, `${label}: ${p.key} stays within the bed (${width.toFixed(2)} m wide)`);
		}
	}
});

test("standing and walking people have their feet on the floor (the director sits at his chair and only stands on his round)", async () => {
	const people = await peopleOn(9, null);
	const standing = people.filter((p) => p.pose.startsWith("stand") || p.pose === "walk");
	assert.ok(standing.length > 0, "someone stands or walks somewhere");
	for (const p of standing) assert.ok(Math.abs(rel(p, p.probe?.min.y ?? NaN)) < 0.04, `${p.key} (${p.pose}) feet at the floor: ${rel(p, p.probe?.min.y ?? NaN).toFixed(3)}`);
});
