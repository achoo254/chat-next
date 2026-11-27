// The region dragged over the shared screen, as pixels of that screen:
// any drag direction, clamped to the picture, scaled from how it is shown,
// with even edges (video frames crop only on even pixels).
import { describe, expect, it } from "vitest";
import { evenRect, toSourceRect } from "../src/messaging/media/screen-capture.ts";

/** A 2560 × 1440 screen shown at half size, 100 px from the page's left and 50 px from its top. */
const shown = { x: 100, y: 50, width: 1280, height: 720 };

describe("toSourceRect", () => {
	it("scales a drag on the shown picture to the screen's pixels", () => {
		expect(toSourceRect({ x: 200, y: 150 }, { x: 500, y: 350 }, shown, 2560, 1440)).toEqual({ x: 200, y: 200, width: 600, height: 400 });
	});

	it("takes a drag in any direction", () => {
		expect(toSourceRect({ x: 500, y: 350 }, { x: 200, y: 150 }, shown, 2560, 1440)).toEqual({ x: 200, y: 200, width: 600, height: 400 });
	});

	it("keeps a drag that leaves the picture inside it", () => {
		expect(toSourceRect({ x: 0, y: 0 }, { x: 2000, y: 2000 }, shown, 2560, 1440)).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
	});

	it("is no region for a click or a tiny drag", () => {
		expect(toSourceRect({ x: 300, y: 300 }, { x: 303, y: 340 }, shown, 2560, 1440)).toBeNull();
		expect(toSourceRect({ x: 300, y: 300 }, { x: 300, y: 300 }, shown, 2560, 1440)).toBeNull();
	});
});

describe("evenRect", () => {
	it("rounds to even pixels inside the frame", () => {
		expect(evenRect({ x: 3.7, y: 5, width: 101, height: 77.9 }, 1920, 1080)).toEqual({ x: 2, y: 4, width: 100, height: 76 });
	});

	it("shrinks a region that runs past a smaller frame", () => {
		expect(evenRect({ x: 1000, y: 500, width: 1000, height: 800 }, 1280, 720)).toEqual({ x: 1000, y: 500, width: 280, height: 220 });
	});
});
