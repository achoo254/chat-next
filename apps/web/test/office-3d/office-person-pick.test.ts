// Choosing a person from the 3D scene: which body a tap lands on (screen-space
// capsules, nearest to the camera first), the camera reporting a tap only for a
// real tap, and the ring under the chosen person (one translucent unlit mesh,
// made when first needed, off when none is chosen).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";
import { createOfficeCamera } from "../../src/office-3d/scene/office-camera.ts";
import { BODY_MIN_HALF_WIDTH_PX, BODY_PAD_PX, bodyAt, type ProjectedBody } from "../../src/office-3d/scene/person-hit.ts";
import { createSelectionRing } from "../../src/office-3d/scene/selection-ring.ts";
import { SCENE_LAYOUT } from "../../src/office-3d/scene/scene-layout.ts";
import { cameraPlan } from "../../src/office-3d/world-support.ts";

const body = (key: string, footX: number, footY: number, height: number): ProjectedBody => ({ key, footX, footY, headY: footY - height });

describe("the body under a tap", () => {
	it("finds the person whose body holds the point, head to feet, and nobody beside or above", () => {
		const bodies = [body("a", 100, 300, 80)];
		expect(bodyAt(bodies, 100, 260)).toBe("a");
		expect(bodyAt(bodies, 100, 300 + BODY_PAD_PX)).toBe("a");
		expect(bodyAt(bodies, 100, 300 + BODY_PAD_PX + 2)).toBeNull();
		expect(bodyAt(bodies, 100, 220 - BODY_PAD_PX - 2)).toBeNull();
		expect(bodyAt(bodies, 100 + 80 * 0.3 + 2, 260)).toBeNull();
		expect(bodyAt([], 100, 260)).toBeNull();
	});

	it("keeps a far away, tiny person a target of at least the narrowest width", () => {
		const far = [body("far", 200, 120, 10)];
		expect(bodyAt(far, 200 + BODY_MIN_HALF_WIDTH_PX - 1, 115)).toBe("far");
		expect(bodyAt(far, 200 + BODY_MIN_HALF_WIDTH_PX + 1, 115)).toBeNull();
	});

	it("chooses the person nearer the camera (lower on screen) when bodies overlap", () => {
		const behind = body("behind", 100, 280, 80);
		const front = body("front", 110, 320, 80);
		expect(bodyAt([behind, front], 105, 275)).toBe("front");
		expect(bodyAt([front, behind], 105, 275)).toBe("front");
		expect(bodyAt([behind, front], 100, 215)).toBe("behind");
	});
});

const engines: NullEngine[] = [];
afterEach(() => {
	for (const engine of engines.splice(0)) engine.dispose();
});

function newScene(): Scene {
	const engine = new NullEngine();
	engines.push(engine);
	return new Scene(engine);
}

describe("the camera reporting a tap", () => {
	function setup() {
		const scene = newScene();
		const canvas = document.createElement("canvas");
		canvas.setPointerCapture = () => undefined;
		if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
		const onTap = vi.fn();
		createOfficeCamera(scene, canvas, cameraPlan(OFFICE_LAYOUT.value, SCENE_LAYOUT.footprint), "overview", true, onTap);
		const fire = (type: string, init: PointerEventInit & { id?: number }): void => {
			canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: init.id ?? 1, button: 0, ...init }));
		};
		return { onTap, fire };
	}

	it("reports a press that did not move, at the point it ended", () => {
		const { onTap, fire } = setup();
		fire("pointerdown", { clientX: 50, clientY: 60 });
		fire("pointerup", { clientX: 50, clientY: 60 });
		expect(onTap).toHaveBeenCalledWith(50, 60);
	});

	it("does not report a pan (a left drag), a turn (right button or shift) or a pinch", () => {
		const { onTap, fire } = setup();
		fire("pointerdown", { clientX: 50, clientY: 60 });
		fire("pointermove", { clientX: 90, clientY: 60 });
		fire("pointerup", { clientX: 90, clientY: 60 });
		fire("pointerdown", { clientX: 50, clientY: 60, button: 2 });
		fire("pointerup", { clientX: 50, clientY: 60, button: 2 });
		fire("pointerdown", { clientX: 50, clientY: 60, shiftKey: true });
		fire("pointerup", { clientX: 50, clientY: 60, shiftKey: true });
		// Two fingers down, the first lifts, then the second lifts without moving: still not a tap.
		fire("pointerdown", { clientX: 50, clientY: 60, id: 1 });
		fire("pointerdown", { clientX: 80, clientY: 60, id: 2 });
		fire("pointerup", { clientX: 50, clientY: 60, id: 1 });
		fire("pointerup", { clientX: 80, clientY: 60, id: 2 });
		expect(onTap).not.toHaveBeenCalled();
	});

	it("does not report a cancelled press, and the next press still counts", () => {
		const { onTap, fire } = setup();
		fire("pointerdown", { clientX: 50, clientY: 60 });
		fire("pointercancel", { clientX: 50, clientY: 60 });
		expect(onTap).not.toHaveBeenCalled();
		fire("pointerdown", { clientX: 70, clientY: 80 });
		fire("pointerup", { clientX: 70, clientY: 80 });
		expect(onTap).toHaveBeenCalledWith(70, 80);
	});
});

describe("the ring under the chosen person", () => {
	it("costs nothing until someone is chosen, then is one translucent unlit mesh under them, and goes off with the choice", () => {
		const scene = newScene();
		const ring = createSelectionRing(scene);
		const before = scene.meshes.length;
		expect(ring.visible).toBe(false);
		ring.hide();
		expect(scene.meshes.length).toBe(before);
		ring.show(3, 4);
		expect(ring.visible).toBe(true);
		const mesh = scene.getMeshByName("selection-ring");
		expect(scene.meshes.length).toBe(before + 1);
		expect(mesh?.position.x).toBe(3);
		expect(mesh?.position.z).toBe(4);
		expect(mesh?.isPickable).toBe(false);
		// Translucent: the depth-of-field depth pass skips it, so it is not drawn twice.
		expect(mesh?.material?.alpha).toBeLessThan(1);
		ring.show(5, 6);
		expect(scene.meshes.length).toBe(before + 1);
		expect(mesh?.position.x).toBe(5);
		ring.hide();
		expect(ring.visible).toBe(false);
		expect(mesh?.isEnabled()).toBe(false);
		ring.dispose();
		expect(scene.getMeshByName("selection-ring")).toBeNull();
	});
});
