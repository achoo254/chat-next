// The camera at run time: it opens on the framing asked for, glides to the
// other one when the viewer presses the button (at once with reduced motion),
// and a touch mid-glide hands control back to the viewer. Babylon's
// NullEngine stands in for the GPU.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { framingUser } from "../../src/office-3d/scene/fit-office-camera.ts";
import { createOfficeCamera } from "../../src/office-3d/scene/office-camera.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { cameraPlan } from "../../src/office-3d/world-support.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

const engines: NullEngine[] = [];
afterEach(() => {
	for (const engine of engines.splice(0)) engine.dispose();
});

/** A portrait phone's canvas, CSS px. */
const W = 372;
const H = 658;

function setup(framing: "work" | "overview", reducedMotion: boolean) {
	const engine = new NullEngine();
	engines.push(engine);
	const scene = new Scene(engine);
	const canvas = document.createElement("canvas");
	const plan = cameraPlan(layout(), SCENE_LAYOUT.footprint);
	return { camera: createOfficeCamera(scene, canvas, plan, framing, reducedMotion), canvas, overview: framingUser(plan, W / H, "overview") };
}

describe("office camera", () => {
	it("opens on the framing asked for, without a glide", () => {
		const { camera, overview } = setup("overview", false);
		camera.update(W, H, 0);
		expect(camera.user.zoom).toBeCloseTo(overview.zoom);
		expect(camera.user.panZ).toBeCloseTo(overview.panZ);
		camera.dispose();
	});

	it("glides to the overview and back to work when asked, and never moves on its own", () => {
		const { camera, overview } = setup("work", false);
		camera.update(W, H, 0);
		expect(camera.user.zoom).toBe(1);
		camera.update(W, H, 5_000);
		expect(camera.user.zoom).toBe(1);
		camera.setFraming("overview");
		camera.update(W, H, 5_350);
		expect(camera.user.zoom).toBeLessThan(1);
		expect(camera.user.zoom).toBeGreaterThan(overview.zoom);
		camera.update(W, H, 6_000);
		expect(camera.user.zoom).toBeCloseTo(overview.zoom);
		camera.setFraming("work");
		camera.update(W, H, 7_000);
		expect(camera.user).toEqual({ zoom: 1, yaw: 0, panX: 0, panZ: 0 });
		camera.dispose();
	});

	it("cuts at once with reduced motion", () => {
		const { camera, overview } = setup("work", true);
		camera.update(W, H, 0);
		camera.setFraming("overview");
		camera.update(W, H, 16);
		expect(camera.user.zoom).toBeCloseTo(overview.zoom);
		camera.dispose();
	});

	it("stops the glide where it is when the viewer zooms", () => {
		const { camera, canvas, overview } = setup("work", false);
		camera.update(W, H, 0);
		camera.setFraming("overview");
		camera.update(W, H, 300);
		const mid = camera.user.zoom;
		canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 0, cancelable: true }));
		camera.update(W, H, 2_000);
		expect(camera.user.zoom).toBeCloseTo(mid);
		expect(camera.user.zoom).toBeGreaterThan(overview.zoom + 0.01);
		camera.dispose();
	});
});
