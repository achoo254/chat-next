import { describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { projectPoint } from "../../src/machines/office/office-geometry.ts";
import {
	baseFraming,
	blendUser,
	clampPan,
	clampUser,
	dragToPan,
	frameOffice,
	framingUser,
	MIN_VIEW_HEIGHT,
	NO_USER,
	pixelsPerMetre,
	screenOffset,
	YAW_RANGE,
	zoomLimits,
	type CameraPlan,
	type CameraUser,
} from "../../src/office-3d/scene/fit-office-camera.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { FAR_PIXELS_PER_METRE, nextFar } from "../../src/office-3d/scene/zoom-detail.ts";
import { cameraPlan, phoneDeskFocus, portraitReach, workZoneRect } from "../../src/office-3d/world-support.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

const RAD = Math.PI / 180;
/** The canvases the plan was measured on (CSS px): a desktop browser's office tab and a portrait phone's. */
const DESKTOP = { width: 992, height: 762 };
const PHONE = { width: 372, height: 658 };

/** Where a point lands on a frame, in percent like projectPoint. */
function onFrame(frame: ReturnType<typeof frameOffice>, x: number, y: number, z: number): [number, number] {
	const o = screenOffset(frame.yaw, frame.pitch, x - frame.target.x, y - frame.target.y, z - frame.target.z);
	return [50 + (50 * o.right) / frame.halfWidth, 50 - (50 * o.up) / frame.halfHeight];
}

/** The frame a canvas shows for a viewer state, as the camera computes it each frame. */
function frameFor(plan: CameraPlan, aspect: number, user: CameraUser): ReturnType<typeof frameOffice> {
	const base = baseFraming(plan, aspect, "work");
	return frameOffice(plan.camera, aspect, base, clampPan(base, clampUser(user, zoomLimits(plan, aspect)), plan.footprint));
}

function inFrame(frame: ReturnType<typeof frameOffice>, x: number, z: number): boolean {
	const [px, py] = onFrame(frame, x, 0, z);
	return px >= 0 && px <= 100 && py >= 0 && py <= 100;
}

describe("fit office camera", () => {
	const l = layout();
	const plan = cameraPlan(l, SCENE_LAYOUT.footprint);
	const zoneOf = (id: string) => l.zones.find((z) => z.id === id);
	const zoneOfAnchor = (a: OfficeLayout["anchors"][number]) => l.rooms.find((r) => r.room === a.room)?.zone;

	it("frames a desktop-shaped canvas's overview exactly like the desktop picture of the 2D view", () => {
		const view = l.camera.views.desktop;
		const frame = frameOffice(l.camera, view.aspect, baseFraming(plan, view.aspect, "overview"), NO_USER);
		for (const a of l.anchors) {
			const [px, py] = projectPoint(l.camera, view, a.x, 0, a.z);
			const [fx, fy] = onFrame(frame, a.x, 0, a.z);
			expect(fx).toBeCloseTo(px, 6);
			expect(fy).toBeCloseTo(py, 6);
		}
	});

	it("shows wide and squarish canvases the whole plan in the overview and the work zone, larger, in work", () => {
		const work = zoneOf("a");
		if (work === undefined) throw new Error("no work zone");
		expect(workZoneRect(l)).toEqual(work.rect);
		for (const aspect of [1, 1.33, 1.6, 2.2]) {
			const overview = framingUser(plan, aspect, "overview");
			const whole = frameFor(plan, aspect, overview);
			for (const a of l.anchors) expect(inFrame(whole, a.x, a.z), `${a.id} at aspect ${aspect}`).toBe(true);
			// The two framings differ: work zooms in on the work zone.
			expect(overview.zoom).toBeLessThan(0.8);
			const zone = frameFor(plan, aspect, framingUser(plan, aspect, "work"));
			for (const a of l.anchors.filter((x) => zoneOfAnchor(x) === "a")) expect(inFrame(zone, a.x, a.z), `${a.id} at aspect ${aspect}`).toBe(true);
			// Every corner of the zone fits, with a margin left on the binding side.
			const corners = [0, 2].flatMap((i) => [1, 3].map((j) => onFrame(zone, work.rect[i] ?? 0, 0, work.rect[j] ?? 0)));
			for (const [px, py] of corners) {
				expect(px).toBeGreaterThan(0);
				expect(px).toBeLessThan(100);
				expect(py).toBeGreaterThan(0);
				expect(py).toBeLessThan(100);
			}
			// Some anchors of the other zones fall outside.
			expect(l.anchors.some((a) => zoneOfAnchor(a) !== "a" && !inFrame(zone, a.x, a.z))).toBe(true);
		}
	});

	it("opens a portrait phone on the six phone desks, all in view and larger than the overview shows them", () => {
		const aspect = PHONE.width / PHONE.height;
		const frame = frameFor(plan, aspect, framingUser(plan, aspect, "work"));
		for (const id of l.phoneDeskOrder) {
			const desk = l.anchors.find((a) => a.id === id);
			if (desk === undefined) throw new Error(id);
			expect(inFrame(frame, desk.x, desk.z), id).toBe(true);
		}
		expect(baseFraming(plan, aspect, "work").orthoHeight).toBeLessThan(baseFraming(plan, aspect, "overview").orthoHeight);
		// The phone's opening framing keeps the details (about 42 px a metre when measured).
		expect(nextFar(false, pixelsPerMetre(frame, PHONE.height))).toBe(false);
	});

	it("lets a portrait phone zoom out to the work zone and the zone behind it, no further", () => {
		const aspect = PHONE.width / PHONE.height;
		const reach = portraitReach(l);
		const work = zoneOf("a");
		const behind = zoneOf("b");
		if (reach === null || work === undefined || behind === undefined) throw new Error("no reach");
		expect(reach).toEqual([Math.min(work.rect[0], behind.rect[0]), Math.min(work.rect[1], behind.rect[1]), Math.max(work.rect[2], behind.rect[2]), Math.max(work.rect[3], behind.rect[3])]);
		const overview = framingUser(plan, aspect, "overview");
		const limits = zoomLimits(plan, aspect);
		expect(limits.min).toBeCloseTo(overview.zoom);
		// Measured on the merged plan: two stacked zones at about 0.28 of the phone's opening framing.
		expect(overview.zoom).toBeGreaterThan(0.23);
		expect(overview.zoom).toBeLessThan(0.33);
		const frame = frameFor(plan, aspect, overview);
		for (const a of l.anchors.filter((x) => zoneOfAnchor(x) === "a" || zoneOfAnchor(x) === "b")) expect(inFrame(frame, a.x, a.z), a.id).toBe(true);
		// Zooming out further stays at the limit.
		expect(frameFor(plan, aspect, { ...overview, zoom: 0.01 }).halfHeight).toBeCloseTo(frame.halfHeight);
		// Two zones on a phone drop the small details.
		expect(nextFar(false, pixelsPerMetre(frame, PHONE.height))).toBe(true);
	});

	it("lets a desktop zoom out a little past the whole plan, which drops the small details", () => {
		const aspect = DESKTOP.width / DESKTOP.height;
		const limits = zoomLimits(plan, aspect);
		const overview = framingUser(plan, aspect, "overview");
		expect(limits.min).toBeLessThan(overview.zoom);
		const frame = frameFor(plan, aspect, overview);
		const px = pixelsPerMetre(frame, DESKTOP.height);
		// Measured: about 20 px a metre.
		expect(px).toBeGreaterThan(17);
		expect(px).toBeLessThan(FAR_PIXELS_PER_METRE);
		// The work zone's framing brings the details back.
		expect(nextFar(true, pixelsPerMetre(frameFor(plan, aspect, NO_USER), DESKTOP.height))).toBe(false);
	});

	it("limits zoom and turn, and treats broken numbers as the default", () => {
		const limits = { min: 0.3, max: 4 };
		expect(clampUser({ zoom: 99, yaw: 5, panX: 0, panZ: 0 }, limits)).toMatchObject({ zoom: 4, yaw: YAW_RANGE });
		expect(clampUser({ zoom: 0.01, yaw: -5, panX: 0, panZ: 0 }, limits)).toMatchObject({ zoom: 0.3, yaw: -YAW_RANGE });
		expect(clampUser({ zoom: Number.NaN, yaw: Number.NaN, panX: Number.NaN, panZ: 1 }, limits)).toEqual({ zoom: 1, yaw: 0, panX: 0, panZ: 1 });
		// Zooming in stops at MIN_VIEW_HEIGHT metres of plan on any canvas.
		for (const aspect of [PHONE.width / PHONE.height, DESKTOP.width / DESKTOP.height]) {
			const close = frameFor(plan, aspect, { ...NO_USER, zoom: 1000 });
			expect(2 * close.halfHeight).toBeCloseTo(MIN_VIEW_HEIGHT);
		}
		const zoomed = frameOffice(l.camera, 1.6, baseFraming(plan, 1.6, "work"), { ...NO_USER, zoom: 2 });
		const plain = frameOffice(l.camera, 1.6, baseFraming(plan, 1.6, "work"), NO_USER);
		expect(zoomed.halfHeight).toBeCloseTo(plain.halfHeight / 2);
	});

	it("keeps the panned target inside the plan", () => {
		const base = baseFraming(plan, 1.6, "work");
		const far = clampPan(base, { ...NO_USER, panX: 500, panZ: -500 }, SCENE_LAYOUT.footprint);
		expect(base.target.x + far.panX).toBeCloseTo(SCENE_LAYOUT.footprint[2]);
		expect(base.target.z + far.panZ).toBeCloseTo(SCENE_LAYOUT.footprint[1]);
		// A phone can pan to the far corner zone (the living rooms) from its opening framing.
		const phone = baseFraming(plan, PHONE.width / PHONE.height, "work");
		const corner = clampPan(phone, { ...NO_USER, panX: 500, panZ: 500 }, SCENE_LAYOUT.footprint);
		expect([phone.target.x + corner.panX, phone.target.z + corner.panZ]).toEqual([SCENE_LAYOUT.footprint[2], SCENE_LAYOUT.footprint[3]]);
	});

	it("glides between two viewer states, the zoom evenly on a log scale", () => {
		const from: CameraUser = { zoom: 1, yaw: 0.2, panX: 0, panZ: 0 };
		const to: CameraUser = { zoom: 0.25, yaw: 0, panX: 4, panZ: 10 };
		expect(blendUser(from, to, 0)).toEqual(from);
		expect(blendUser(from, to, 1)).toEqual(to);
		const mid = blendUser(from, to, 0.5);
		expect(mid.zoom).toBeCloseTo(0.5);
		expect(mid).toMatchObject({ yaw: 0.1, panX: 2, panZ: 5 });
		expect(blendUser(from, to, 7)).toEqual(to);
	});

	it("knows the phone desks as a rectangle of the work room", () => {
		const focus = phoneDeskFocus(l);
		const work = l.rooms.find((r) => r.room === "WORK");
		if (focus === null || work === undefined) throw new Error("no focus");
		expect(focus[0]).toBeGreaterThanOrEqual(work.rect[0] - 1.2);
		expect(focus[2]).toBeLessThanOrEqual(work.rect[2] + 1.2);
	});

	it("moves the building with the finger: a drag right shifts the target left on screen", () => {
		const frame = frameOffice(l.camera, 1.6, baseFraming(plan, 1.6, "work"), NO_USER);
		const d = dragToPan(frame, 800, 100, 0);
		const o = screenOffset(frame.yaw, frame.pitch, d.x, 0, d.z);
		expect(o.right).toBeLessThan(0);
		expect(Math.abs(o.up)).toBeLessThan(1e-9);
		const down = dragToPan(frame, 800, 0, 100);
		expect(screenOffset(frame.yaw, frame.pitch, down.x, 0, down.z).up).toBeGreaterThan(0);
	});

	it("puts the camera above and in front of the target at the layout's angles", () => {
		const frame = frameOffice(l.camera, 1.6, baseFraming(plan, 1.6, "work"), NO_USER);
		expect(frame.yaw).toBeCloseTo(l.camera.yaw * RAD);
		expect(frame.position.y).toBeGreaterThan(frame.target.y);
		const dx = frame.target.x - frame.position.x;
		const dz = frame.target.z - frame.position.z;
		expect(Math.atan2(dx, dz)).toBeCloseTo(frame.yaw);
	});
});
