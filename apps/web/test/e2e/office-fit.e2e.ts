// How the bodies sit in the 3D office, measured on the drawn skeletons (the test API's `probe`): on the real scene of the
// visual harness, for the staff and the director, who have different proportions. Feet reach the floor when standing,
// the pelvis lands on the seat when sitting, and someone lying down rests on the mattress and stays within the bed.
//
//   node --test test/e2e/office-fit.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
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
/** Where a seated pelvis rests over the floor (SEAT_PELVIS_HEIGHT in skinned-character.ts). */
const SEAT_PELVIS = 0.5;
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

test("the director sits like the staff: pelvis on the seat, feet clear of the floor", async () => {
	const people = await peopleOn(0, null);
	const director = people.find((p) => p.key === "director");
	assert.ok(director?.probe, "the director is drawn");
	assert.equal(director.pose, "sit-think");
	assert.ok(Math.abs(rel(director, director.probe.pelvis?.y ?? NaN) - SEAT_PELVIS) < 0.02, `pelvis ${rel(director, director.probe.pelvis?.y ?? NaN)}`);
	assert.ok(rel(director, director.probe.min.y) > 0.1, "legs hang above the floor on a doll's seat, none through it");
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
