import { describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { projectPoint } from "../../src/machines/office/office-geometry.ts";
import {
	baseFraming,
	clampPan,
	clampUser,
	dragToPan,
	frameOffice,
	NO_USER,
	screenOffset,
	YAW_RANGE,
	ZOOM_MAX,
	ZOOM_MIN,
} from "../../src/office-3d/scene/fit-office-camera.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { phoneDeskFocus } from "../../src/office-3d/world-support.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

const RAD = Math.PI / 180;

/** Where a point lands on a frame, in percent like projectPoint. */
function onFrame(frame: ReturnType<typeof frameOffice>, x: number, y: number, z: number): [number, number] {
	const o = screenOffset(frame.yaw, frame.pitch, x - frame.target.x, y - frame.target.y, z - frame.target.z);
	return [50 + (50 * o.right) / frame.halfWidth, 50 - (50 * o.up) / frame.halfHeight];
}

describe("fit office camera", () => {
	const l = layout();
	const focus = phoneDeskFocus(l);

	it("frames a desktop-shaped canvas exactly like the desktop picture of the 2D view", () => {
		const view = l.camera.views.desktop;
		const frame = frameOffice(l.camera, view.aspect, baseFraming(l.camera, view.aspect, focus), NO_USER);
		for (const a of l.floors[0]?.anchors ?? []) {
			const [px, py] = projectPoint(l.camera, view, a.x, 0, a.z);
			const [fx, fy] = onFrame(frame, a.x, 0, a.z);
			expect(fx).toBeCloseTo(px, 6);
			expect(fy).toBeCloseTo(py, 6);
		}
	});

	it("keeps every anchor of every floor in view on wide and squarish canvases", () => {
		for (const aspect of [1, 1.33, 1.6, 2.2]) {
			const frame = frameOffice(l.camera, aspect, baseFraming(l.camera, aspect, focus), NO_USER);
			for (const floor of l.floors) {
				for (const a of floor.anchors) {
					const [x, y] = onFrame(frame, a.x, 0, a.z);
					expect(x, `${a.id} at aspect ${aspect}`).toBeGreaterThanOrEqual(0);
					expect(x).toBeLessThanOrEqual(100);
					expect(y).toBeGreaterThanOrEqual(0);
					expect(y).toBeLessThanOrEqual(100);
				}
			}
		}
	});

	it("starts a portrait phone on the six phone desks, all in view and larger than the whole floor would be", () => {
		const aspect = 390 / 700;
		const base = baseFraming(l.camera, aspect, focus);
		const frame = frameOffice(l.camera, aspect, base, NO_USER);
		const first = l.floors[0];
		for (const id of first?.phoneDeskOrder ?? []) {
			const desk = first?.anchors.find((a) => a.id === id);
			if (desk === undefined) throw new Error(id);
			const [x, y] = onFrame(frame, desk.x, 0, desk.z);
			expect(x, id).toBeGreaterThan(0);
			expect(x).toBeLessThan(100);
			expect(y).toBeGreaterThan(0);
			expect(y).toBeLessThan(100);
		}
		expect(base.orthoHeight).toBeLessThan(baseFraming(l.camera, aspect, null).orthoHeight);
	});

	it("limits zoom and turn, and treats broken numbers as the default", () => {
		expect(clampUser({ zoom: 99, yaw: 5, panX: 0, panZ: 0 })).toMatchObject({ zoom: ZOOM_MAX, yaw: YAW_RANGE });
		expect(clampUser({ zoom: 0.01, yaw: -5, panX: 0, panZ: 0 })).toMatchObject({ zoom: ZOOM_MIN, yaw: -YAW_RANGE });
		expect(clampUser({ zoom: Number.NaN, yaw: Number.NaN, panX: Number.NaN, panZ: 1 })).toEqual({ zoom: 1, yaw: 0, panX: 0, panZ: 1 });
		const zoomed = frameOffice(l.camera, 1.6, baseFraming(l.camera, 1.6, null), { ...NO_USER, zoom: 2 });
		const plain = frameOffice(l.camera, 1.6, baseFraming(l.camera, 1.6, null), NO_USER);
		expect(zoomed.halfHeight).toBeCloseTo(plain.halfHeight / 2);
	});

	it("keeps the panned target inside the floor", () => {
		const base = baseFraming(l.camera, 1.6, null);
		const far = clampPan(base, { ...NO_USER, panX: 500, panZ: -500 }, SCENE_LAYOUT.footprint);
		expect(base.target.x + far.panX).toBeCloseTo(SCENE_LAYOUT.footprint[2]);
		expect(base.target.z + far.panZ).toBeCloseTo(SCENE_LAYOUT.footprint[1]);
	});

	it("moves the building with the finger: a drag right shifts the target left on screen", () => {
		const frame = frameOffice(l.camera, 1.6, baseFraming(l.camera, 1.6, null), NO_USER);
		const d = dragToPan(frame, 800, 100, 0);
		const o = screenOffset(frame.yaw, frame.pitch, d.x, 0, d.z);
		expect(o.right).toBeLessThan(0);
		expect(Math.abs(o.up)).toBeLessThan(1e-9);
		const down = dragToPan(frame, 800, 0, 100);
		expect(screenOffset(frame.yaw, frame.pitch, down.x, 0, down.z).up).toBeGreaterThan(0);
	});

	it("puts the camera above and in front of the target at the layout's angles", () => {
		const frame = frameOffice(l.camera, 1.6, baseFraming(l.camera, 1.6, null), NO_USER);
		expect(frame.yaw).toBeCloseTo(l.camera.yaw * RAD);
		expect(frame.position.y).toBeGreaterThan(frame.target.y);
		const dx = frame.target.x - frame.position.x;
		const dz = frame.target.z - frame.position.z;
		expect(Math.atan2(dx, dz)).toBeCloseTo(frame.yaw);
	});
});
