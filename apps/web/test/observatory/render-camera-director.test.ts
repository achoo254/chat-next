// The Live Map's camera: auto follows actions, not events (twenty file reads
// in a row are one move; a short think between calls keeps the district; a
// think longer than 1.2 s after a call's END goes back to the core, the
// prototype's stuck-on-the-portal bug); idle goes back to the whole scene
// after 3 s; a drag or a zoom switches to free; focus locks on the
// selection; a district the keyboard is on is framed; reduced motion jumps
// instead of easing; the wake time is told.
import { describe, expect, it } from "vitest";
import { activityZone, CameraDirector, HOLD_MS, IDLE_MS, MAX_ZOOM, STABLE_MS, THINK_HOLD_MS, viewFor, type Activity } from "../../src/machines/observatory/render/camera-director.ts";
import type { PlaceId } from "../../src/machines/observatory/render/scene-table.ts";
import { fixtureScene } from "./render-fixtures.ts";

const scene = fixtureScene();
const exec = (place: PlaceId, testing = false): Activity => ({ mode: "exec", newestPlace: place, testing });
const THINK: Activity = { mode: "think", newestPlace: null, testing: false };
const IDLE: Activity = { mode: "idle", newestPlace: null, testing: false };
const WAIT: Activity = { mode: "wait", newestPlace: null, testing: false };

/** Steps the camera every 16 ms over [from, to). */
function run(cam: CameraDirector, activity: Activity, from: number, to: number, reduce = false): number {
	let t = from;
	for (; t < to; t += 16) cam.step(activity, t, reduce);
	return t;
}

describe("the activity zone", () => {
	it("is the lock while waiting, the newest call's district (tests with the terminal), the core while thinking, none while idle", () => {
		expect(activityZone(WAIT)).toBe("security");
		expect(activityZone(exec("files"))).toBe("files");
		expect(activityZone(exec("files", true))).toBe("testing");
		expect(activityZone(THINK)).toBe("core");
		expect(activityZone(IDLE)).toBeNull();
	});
});

describe("auto mode", () => {
	it("moves once for 20 file reads in a row with short thinks between them, and not again after reaching the files", () => {
		const cam = new CameraDirector(scene);
		// The prompt: the model thinks first.
		let t = run(cam, THINK, 0, 2_000);
		expect(cam.zone).toBe("core");
		const before = cam.switches;
		let reached: number | null = null;
		for (let i = 0; i < 20; i++) {
			t = run(cam, exec("files"), t, t + 300);
			// Thinking between two reads, shorter than THINK_HOLD_MS (some up to 1.1 s).
			t = run(cam, THINK, t, t + (i % 4 === 0 ? 1_100 : 400));
			if (reached === null && cam.zone === "files") reached = cam.switches;
		}
		expect(cam.zone).toBe("files");
		expect(cam.switches).toBe(before + 1);
		expect(cam.switches).toBe(reached);
	});

	it("goes back to the core 1.2 s after the call's END when the model keeps thinking (not stuck on the portal)", () => {
		const cam = new CameraDirector(scene);
		const end = run(cam, exec("external"), 0, 4_000);
		expect(cam.zone).toBe("external");
		const t = run(cam, THINK, end, end + THINK_HOLD_MS - 20);
		expect(cam.zone).toBe("external");
		run(cam, THINK, t, end + 1_500);
		expect(cam.zone).toBe("core");
		expect(cam.switches).toBe(2);
	});

	it("counts the hold from the end even when the call ran long", () => {
		const cam = new CameraDirector(scene);
		const end = run(cam, exec("sandbox"), 0, 30_000);
		run(cam, THINK, end, end + 600);
		// A hold counted from the call's start would have gone long ago.
		expect(cam.zone).toBe("sandbox");
	});

	it("needs a new zone stable for 500 ms and the view held 1.5 s", () => {
		const cam = new CameraDirector(scene);
		let t = run(cam, exec("files"), 0, STABLE_MS - 20);
		expect(cam.zone).toBeNull();
		t = run(cam, exec("files"), t, STABLE_MS + 40);
		expect(cam.zone).toBe("files");
		const since = t;
		// Another district right away: the view keeps files until it held HOLD_MS.
		t = run(cam, exec("mcp"), t, since + HOLD_MS - 40);
		expect(cam.zone).toBe("files");
		run(cam, exec("mcp"), t, since + HOLD_MS + 40);
		expect(cam.zone).toBe("mcp");
	});

	it("frames a test run with the terminal and a permission with the core", () => {
		const cam = new CameraDirector(scene);
		run(cam, exec("sandbox", true), 0, 2_000);
		expect(cam.zone).toBe("testing");
		const wait = new CameraDirector(scene);
		run(wait, WAIT, 0, 2_000);
		expect(wait.zone).toBe("security");
	});

	it("keeps the last view while idle for 3 s, then shows the whole scene", () => {
		const cam = new CameraDirector(scene);
		const t = run(cam, exec("git"), 0, 2_000, true);
		run(cam, IDLE, t, t + IDLE_MS - 50, true);
		expect(cam.zone).toBe("git");
		run(cam, IDLE, t + IDLE_MS - 50, t + IDLE_MS + 50, true);
		expect(cam.zone).toBeNull();
		expect(cam.view).toEqual(viewFor(scene, null, false));
	});

	it("tells when a pending move is due, so a still scene can be woken for it", () => {
		const cam = new CameraDirector(scene);
		expect(cam.step(exec("files"), 0, false).wakeAt).toBe(STABLE_MS);
		const end = 3_000;
		run(cam, exec("files"), 16, end);
		expect(cam.step(THINK, end, false).wakeAt).toBe(end + THINK_HOLD_MS);
	});

	it("eases toward the zone, and jumps there with reduced motion", () => {
		const eased = new CameraDirector(scene);
		run(eased, exec("files"), 0, STABLE_MS + 40);
		const target = viewFor(scene, "files", false);
		const first = eased.step(exec("files"), STABLE_MS + 56, false);
		expect(first.settled).toBe(false);
		expect(first.view).not.toEqual(target);
		const jumped = new CameraDirector(scene);
		run(jumped, exec("files"), 0, STABLE_MS + 40, true);
		const f = jumped.step(exec("files"), STABLE_MS + 56, true);
		expect(f.settled).toBe(true);
		expect(f.view).toEqual(target);
	});

	it("zooms lightly in auto (at most 1.32) and leans toward the zone", () => {
		const v = viewFor(scene, "files", false);
		expect(v.s).toBeGreaterThanOrEqual(1);
		expect(v.s).toBeLessThanOrEqual(1.32);
		const strong = viewFor(scene, "files", true);
		expect(strong.s).toBeGreaterThanOrEqual(v.s);
	});
});

describe("free and focus", () => {
	it("a drag pans and switches to free; auto stops moving", () => {
		const cam = new CameraDirector(scene);
		run(cam, exec("files"), 0, 1_000);
		const before = cam.view;
		cam.pan(-100, 0);
		expect(cam.mode).toBe("free");
		expect(cam.view.x).not.toBe(before.x);
		const after = cam.view;
		run(cam, exec("mcp"), 1_000, 5_000);
		expect(cam.view).toEqual(after);
		expect(cam.switches).toBe(1);
	});

	it("a zoom switches to free, keeps the pointer's point and stays within 1 to 2.5", () => {
		const cam = new CameraDirector(scene);
		cam.zoomAt(1.5, 600, 400);
		expect(cam.mode).toBe("free");
		expect(cam.view.s).toBeCloseTo(1.5);
		cam.zoomAt(10, 600, 400);
		expect(cam.view.s).toBe(MAX_ZOOM);
		cam.zoomAt(0.01, 600, 400);
		expect(cam.view.s).toBe(1);
	});

	it("focus locks on the selected place, zoomed closer; back to auto it finds its zone again", () => {
		const cam = new CameraDirector(scene);
		cam.select("testing");
		cam.setMode("focus");
		run(cam, exec("files"), 0, 1_000, true);
		expect(cam.view).toEqual(viewFor(scene, "testing", true));
		expect(cam.switches).toBe(0);
		cam.setMode("auto");
		run(cam, exec("files"), 1_000, 2_000, true);
		expect(cam.zone).toBe("files");
	});
});

describe("a district the keyboard is on", () => {
	it("is framed in auto and in focus, not in free, and the mode's own target comes back once it goes", () => {
		const cam = new CameraDirector(scene);
		cam.peek("git");
		expect(cam.peeked).toBe("git");
		run(cam, IDLE, 0, 3_000, true);
		expect(cam.view).toEqual(viewFor(scene, "git", false));
		// Auto's own zone does not move meanwhile: the person's focus only leans the view.
		expect(cam.zone).toBeNull();
		cam.peek(null);
		run(cam, IDLE, 3_000, 3_100, true);
		expect(cam.view).toEqual(viewFor(scene, null, false));
		cam.select("files");
		cam.setMode("focus");
		cam.peek("git");
		run(cam, IDLE, 3_100, 3_200, true);
		expect(cam.view).toEqual(viewFor(scene, "git", true));
		cam.pan(10, 0);
		const free = cam.view;
		run(cam, IDLE, 3_200, 3_300, true);
		expect(cam.view).toEqual(free);
	});
});
