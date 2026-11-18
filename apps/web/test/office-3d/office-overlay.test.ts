import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { createOfficeOverlay, stackLabels, type OverlayPin } from "../../src/office-3d/office-overlay.ts";

describe("stackLabels", () => {
	it("leaves labels that do not touch where they are", () => {
		const labels = [
			{ key: "a", x: 100, y: 300, w: 150, h: 26 },
			{ key: "b", x: 400, y: 300, w: 150, h: 26 },
			{ key: "c", x: 100, y: 200, w: 150, h: 26 },
		];
		expect(stackLabels(labels)).toEqual(expect.arrayContaining(labels));
	});

	it("sets the label further back just above the one in front", () => {
		const out = stackLabels([
			{ key: "back", x: 210, y: 300, w: 150, h: 26 },
			{ key: "front", x: 200, y: 310, w: 150, h: 44 },
		]);
		expect(out.find((l) => l.key === "front")?.y).toBe(310);
		expect(out.find((l) => l.key === "back")?.y).toBe(310 - 44 - 2);
	});

	it("counts each label's own width: wide bubbles further apart still lift", () => {
		const out = stackLabels([
			{ key: "back", x: 380, y: 300, w: 200, h: 44 },
			{ key: "front", x: 200, y: 310, w: 200, h: 44 },
		]);
		expect(out.find((l) => l.key === "back")?.y).toBe(310 - 44 - 2);
		const narrow = stackLabels([
			{ key: "back", x: 380, y: 300, w: 120, h: 26 },
			{ key: "front", x: 200, y: 310, w: 120, h: 26 },
		]);
		expect(narrow.find((l) => l.key === "back")?.y).toBe(300);
	});

	it("stacks a crowd so no two labels overlap", () => {
		const out = stackLabels([0, 1, 2, 3].map((i) => ({ key: String(i), x: 200 + i * 10, y: 300 - i * 3, w: 150, h: i % 2 === 0 ? 26 : 44 })));
		for (const a of out) {
			for (const b of out) {
				if (a === b) continue;
				const overlap = a.y > b.y - b.h && a.y - a.h < b.y;
				expect(overlap).toBe(false);
			}
		}
	});
});

describe("the pins over the canvas", () => {
	/** A scene whose projection is the identity: the plan's origin lands in the middle of the canvas. */
	const scene = { getTransformMatrix: () => Matrix.Identity() } as unknown as Scene;

	it("moves a pin to its point of the plan, at full size whether the view is far or near", () => {
		const overlay = createOfficeOverlay();
		const overflow = document.createElement("div");
		overlay.bind("board:overflow", overflow);
		const pins: OverlayPin[] = [{ id: "overflow", x: 0.5, y: 0, z: 0 }];
		overlay.update(scene, 800, 600, [], pins, false);
		expect(overflow.style.transform).toBe("translate3d(600.0px, 300.0px, 0)");
		overlay.update(scene, 800, 600, [], pins, true);
		expect(overflow.style.transform).toBe("translate3d(600.0px, 300.0px, 0)");
		overlay.dispose();
	});
});
