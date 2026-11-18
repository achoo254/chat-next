// A tap on the 3D canvas against a drag of the camera, and finding the name tag
// under a tap: only one pointer, the primary button, no shift and hardly any
// movement is a tap (a pan, a turn, a pinch and a wheel never choose anyone or
// close the panel); a tap lands on the nearest tag, a small one (the dot of an
// idle person) counting as a finger-sized target.
import { describe, expect, it } from "vitest";
import { MIN_TARGET_PX, tagAt, type TagBox } from "../../src/office-3d/pick-tag.ts";
import { isTap, TAP_SLOP_PX, type PointerGesture } from "../../src/office-3d/scene/office-camera.ts";

const tap: PointerGesture = { maxPointers: 1, button: 0, shift: false, travel: 0 };

describe("a tap against a drag", () => {
	it("is one pointer, the primary button, no shift, hardly moved", () => {
		expect(isTap(tap)).toBe(true);
		expect(isTap({ ...tap, travel: TAP_SLOP_PX - 1 })).toBe(true);
	});

	it("is not a pan: a left drag that moved far enough", () => {
		expect(isTap({ ...tap, travel: TAP_SLOP_PX })).toBe(false);
		expect(isTap({ ...tap, travel: 120 })).toBe(false);
	});

	it("is not a turn (right button, or shift) and not a pinch (two pointers, even when one lifts first)", () => {
		expect(isTap({ ...tap, button: 2 })).toBe(false);
		expect(isTap({ ...tap, shift: true })).toBe(false);
		expect(isTap({ ...tap, maxPointers: 2 })).toBe(false);
	});
});

const box = (key: string, left: number, top: number, w: number, h: number): TagBox => ({ key, left, top, right: left + w, bottom: top + h });

describe("the tag under a tap", () => {
	it("finds the tag a tap lands in and nothing where there is none", () => {
		const tags = [box("a", 100, 100, 80, 24), box("b", 300, 100, 80, 24)];
		expect(tagAt(tags, 140, 112)).toBe("a");
		expect(tagAt(tags, 340, 112)).toBe("b");
		expect(tagAt(tags, 220, 112)).toBeNull();
		expect(tagAt([], 10, 10)).toBeNull();
	});

	it("widens a small tag (an idle person's dot) to a finger-sized target", () => {
		const dot = box("dot", 200, 200, 12, 12);
		expect(tagAt([dot], 206 + MIN_TARGET_PX / 2 - 1, 206)).toBe("dot");
		expect(tagAt([dot], 206 + MIN_TARGET_PX / 2 + 2, 206)).toBeNull();
	});

	it("picks the nearest centre when widened boxes overlap", () => {
		const left = box("left", 100, 100, 10, 10);
		const right = box("right", 118, 100, 10, 10);
		expect(tagAt([left, right], 104, 105)).toBe("left");
		expect(tagAt([left, right], 123, 105)).toBe("right");
	});
});
