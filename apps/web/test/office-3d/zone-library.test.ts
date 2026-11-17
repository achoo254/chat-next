// The plan's four zones in the scene, before any asset arrives: every zone
// built at once in placeholder blocks, all of them on, furniture under each
// zone and every small prop under the one node zooming far out hides; and the
// HTML labels over the scene, idle ones shrunk to their dot when far. Babylon's
// NullEngine stands in for the GPU.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/instancedMesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, ZONE_IDS, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import type { PersonView } from "../../src/office-3d/character/office-people.ts";
import { createOfficeOverlay } from "../../src/office-3d/office-overlay.ts";
import { createBlockKit } from "../../src/office-3d/scene/block-kit.ts";
import { createPropLibrary } from "../../src/office-3d/scene/prop-library.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { createZoneLibrary } from "../../src/office-3d/scene/zone-library.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

const engines: NullEngine[] = [];
afterEach(() => {
	for (const engine of engines.splice(0)) engine.dispose();
});

function scene(): Scene {
	const engine = new NullEngine();
	engines.push(engine);
	return new Scene(engine);
}

describe("zone library", () => {
	it("builds every zone at once, all on, with furniture per zone and the small props of the whole plan under one node", () => {
		const s = scene();
		const kit = createBlockKit(s);
		const props = createPropLibrary(s, kit);
		const zones = createZoneLibrary(s, kit, props, SCENE_LAYOUT, layout().zones, new AbortController().signal);
		for (const id of ZONE_IDS) {
			const root = s.getTransformNodeByName(`zone-${id}`);
			expect(root?.isEnabled(), id).toBe(true);
			expect(s.getTransformNodeByName(`zone-blocks-${id}`)?.parent).toBe(root);
		}
		const small = s.getTransformNodeByName("small-props");
		if (small === null) throw new Error("no small-props node");
		const smallHolders = small.getChildTransformNodes(true);
		expect(smallHolders).toHaveLength(SCENE_LAYOUT.smallProps.length);
		const furniture = ZONE_IDS.flatMap((id) => s.getTransformNodeByName(`zone-${id}`)?.getChildTransformNodes(true).filter((n) => n.name.startsWith("prop-")) ?? []);
		expect(furniture).toHaveLength(SCENE_LAYOUT.props.length);

		zones.setSmallProps(false);
		expect(small.isEnabled()).toBe(false);
		expect(smallHolders.every((h) => !h.isEnabled())).toBe(true);
		zones.setSmallProps(true);
		expect(small.isEnabled()).toBe(true);
		zones.dispose();
		props.dispose();
		kit.dispose();
		expect(s.getTransformNodeByName("small-props")).toBeNull();
	});
});

describe("labels zoomed far out", () => {
	const person = (key: string, x: number): PersonView => ({
		key,
		x,
		z: 0,
		visible: true,
		smoking: false,
		working: false,
		deskAnchor: null,
		target: "desk-0",
		pose: "stand-idle",
		dozing: false,
		labelHeight: 0,
		model: "block",
		heading: 0,
	});

	it("shrinks idle people's labels to their dot when far and counts them, keeping those at work whole", () => {
		const s = scene();
		// An identity view and projection: plan x is the canvas's -1..1.
		s.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
		const overlay = createOfficeOverlay();
		const idle = document.createElement("div");
		idle.setAttribute("data-idle", "");
		const busy = document.createElement("div");
		overlay.bind("person:idle", idle);
		overlay.bind("person:busy", busy);
		const people = [person("idle", -0.5), person("busy", 0.5)];
		overlay.update(s, 400, 300, people, [], true);
		expect(overlay.dots).toBe(1);
		expect(idle.hasAttribute("data-dot")).toBe(true);
		expect(busy.hasAttribute("data-dot")).toBe(false);
		overlay.update(s, 400, 300, people, [], false);
		expect(overlay.dots).toBe(0);
		expect(idle.hasAttribute("data-dot")).toBe(false);
		// Off the canvas: neither shown nor counted.
		overlay.update(s, 400, 300, [person("idle", 5)], [], true);
		expect(overlay.dots).toBe(0);
		expect(idle.hidden).toBe(true);
		overlay.dispose();
	});
});
