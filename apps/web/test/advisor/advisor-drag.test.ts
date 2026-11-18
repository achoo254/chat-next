// Docking the Advisor mascot: the nearer side edge, a height inside the band
// clear of headers and composers, a tap told from a drag; the dock is kept
// per device.
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BAND_BOTTOM,
	BAND_TOP,
	bandOf,
	BUBBLE_MAX_HEIGHT,
	BUBBLE_WIDTH,
	bubblePlacement,
	placementStyle,
	dockFor,
	isDrag,
	MASCOT_SIZE,
	MENU_ROOM,
	menuPlacement,
	PANEL_GAP,
	VIEW_MARGIN,
	type Placement,
	useMascotDrag,
} from "../../src/advisor/advisor-drag.ts";
import { AdvisorStore, DEFAULT_DOCK } from "../../src/advisor/advisor-store.ts";

const desktop = { width: 1366, height: 768 };
const phone = { width: 390, height: 844 };

describe("docking", () => {
	it("snaps to the nearer side edge", () => {
		expect(dockFor(100, 400, desktop).side).toBe("left");
		expect(dockFor(1300, 400, desktop).side).toBe("right");
		expect(dockFor(194, 400, phone).side).toBe("left");
		expect(dockFor(196, 400, phone).side).toBe("right");
	});

	it("goes down to the bottom edge (a composer too, if the user puts it there), never over the header", () => {
		const band = bandOf({ width: 1376, height: 1450 });
		// Let go at the very bottom: its bottom a hair off the edge.
		const dock = dockFor(1370, 1449, { width: 1376, height: 1450 });
		expect(dock).toEqual({ side: "right", y: 1 });
		expect(band.bottom + MASCOT_SIZE).toBe(1450 - BAND_BOTTOM);
		expect(BAND_BOTTOM).toBeLessThanOrEqual(8);
	});

	it("keeps the mascot inside the band: never over the header", () => {
		const band = bandOf(desktop);
		expect(band).toEqual({ top: BAND_TOP, bottom: desktop.height - BAND_BOTTOM - MASCOT_SIZE });
		// Let go over the header: the top of the band; over the composer: its bottom.
		expect(dockFor(1300, 0, desktop).y).toBe(0);
		expect(dockFor(1300, desktop.height, desktop).y).toBe(1);
		// Half way down the band stays half way.
		const middle = (band.top + band.bottom) / 2 + MASCOT_SIZE / 2;
		expect(dockFor(10, middle, desktop).y).toBeCloseTo(0.5, 5);
	});

	it("still docks on a screen too short for a band", () => {
		expect(bandOf({ width: 300, height: 120 })).toEqual({ top: BAND_TOP, bottom: BAND_TOP });
		expect(dockFor(10, 100, { width: 300, height: 120 })).toEqual({ side: "left", y: 0 });
	});

	it("tells a tap from a drag", () => {
		expect(isDrag(3, 4)).toBe(false);
		expect(isDrag(5, 5)).toBe(true);
		expect(isDrag(0, -7)).toBe(true);
	});
});

describe("the dock per device", () => {
	beforeEach(() => window.localStorage.clear());

	it("starts on the right edge and keeps where the user left it", () => {
		expect(new AdvisorStore().snapshot().dock).toEqual(DEFAULT_DOCK);
		new AdvisorStore().setDock({ side: "left", y: 0.25 });
		expect(new AdvisorStore().snapshot().dock).toEqual({ side: "left", y: 0.25 });
	});

	it("ignores a stored dock it cannot read", () => {
		window.localStorage.setItem("advisor:dock", JSON.stringify({ side: "top", y: 3 }));
		expect(new AdvisorStore().snapshot().dock).toEqual(DEFAULT_DOCK);
		window.localStorage.setItem("advisor:dock", "{oops");
		expect(new AdvisorStore().snapshot().dock).toEqual(DEFAULT_DOCK);
		window.localStorage.setItem("advisor:dock", JSON.stringify({ side: "left", y: 7 }));
		expect(new AdvisorStore().snapshot().dock).toEqual({ side: "left", y: 1 });
	});

	it("hides on this device only, and shows again", () => {
		const store = new AdvisorStore();
		store.setOpen(true);
		store.setHidden(true);
		expect(store.snapshot()).toMatchObject({ hidden: true, open: false });
		expect(new AdvisorStore().snapshot().hidden).toBe(true);
		store.setHidden(false);
		expect(new AdvisorStore().snapshot().hidden).toBe(false);
	});
});

describe("pressing the mascot", () => {
	function Mascot({ onTap, onDock }: { onTap: () => void; onDock: () => void }) {
		const drag = useMascotDrag(onTap, onDock);
		return createElement("button", { type: "button", ...drag.handlers }, "mascot");
	}
	const pointer = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });

	it("a touch drag (no click after it) does not swallow the next tap", () => {
		const onTap = vi.fn();
		const onDock = vi.fn();
		render(createElement(Mascot, { onTap, onDock }));
		const button = screen.getByRole("button");
		fireEvent(button, pointer("pointerdown", 100, 100));
		fireEvent(button, pointer("pointermove", 160, 180));
		fireEvent(button, pointer("pointerup", 160, 180));
		expect(onDock).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
		// The next tap: pointerdown, pointerup, click.
		fireEvent(button, pointer("pointerdown", 160, 180));
		fireEvent(button, pointer("pointerup", 160, 180));
		fireEvent.click(button);
		expect(onTap).toHaveBeenCalledTimes(1);
	});

	it("the click that follows a mouse drag is no tap", () => {
		const onTap = vi.fn();
		render(createElement(Mascot, { onTap, onDock: () => undefined }));
		const button = screen.getByRole("button");
		fireEvent(button, pointer("pointerdown", 100, 100));
		fireEvent(button, pointer("pointermove", 160, 180));
		fireEvent(button, pointer("pointerup", 160, 180));
		fireEvent.click(button);
		expect(onTap).not.toHaveBeenCalled();
	});
});

/** The panel's box once laid out with `height` (at most its cap). */
function boxOf(p: Placement, height: number, viewHeight: number): { left: number; right: number; top: number; bottom: number } {
	const h = Math.min(height, p.maxHeight);
	const top = p.top ?? viewHeight - (p.bottom ?? 0) - h;
	return { left: p.left, right: p.left + p.width, top, bottom: top + h };
}

describe("the bubble beside the mascot", () => {
	const view = { width: 1376, height: 1450 };
	const inView = (b: { left: number; right: number; top: number; bottom: number }, v: { width: number; height: number }) =>
		b.left >= VIEW_MARGIN && b.right <= v.width - VIEW_MARGIN && b.top >= VIEW_MARGIN && b.bottom <= v.height - VIEW_MARGIN;

	it("a mascot in the bottom right corner: the bubble opens up from its bottom, on its left", () => {
		const mascot = { left: 1332, top: 1386, width: 56, height: 56 };
		const p = bubblePlacement(mascot, view, "right");
		expect(p.top).toBeUndefined();
		expect(p.width).toBe(BUBBLE_WIDTH);
		const b = boxOf(p, 480, view.height);
		expect(b.right).toBe(mascot.left - PANEL_GAP);
		expect(view.height - b.bottom).toBe(VIEW_MARGIN);
		expect(inView(b, view)).toBe(true);
	});

	it("a mascot high on the left: the bubble opens down from its top, on its right", () => {
		const mascot = { left: -12, top: 120, width: 56, height: 56 };
		const p = bubblePlacement(mascot, { width: 1376, height: 900 }, "left");
		expect(p.top).toBe(120);
		expect(p.left).toBe(mascot.left + mascot.width + PANEL_GAP);
		expect(p.maxHeight).toBe(BUBBLE_MAX_HEIGHT);
		expect(inView(boxOf(p, 600, 900), { width: 1376, height: 900 })).toBe(true);
	});

	it("stays whole on a short or narrow screen", () => {
		const small = { width: 420, height: 300 };
		const p = bubblePlacement({ left: 380, top: 250, width: 56, height: 56 }, small, "right");
		expect(p.width).toBe(420 - 2 * VIEW_MARGIN);
		expect(inView(boxOf(p, 1000, small.height), small)).toBe(true);
	});
});

describe("the bubble's menu", () => {
	it("opens under its button, its right edge on the button's, whole on screen", () => {
		const view = { width: 1376, height: 900 };
		const button = { left: 1030, top: 300, width: 36, height: 36 };
		const p = menuPlacement(button, view, 280);
		expect(p.top).toBe(336 + PANEL_GAP);
		expect(p.left + p.width).toBe(1066);
		expect(p.maxHeight).toBeGreaterThanOrEqual(MENU_ROOM);
	});

	it("opens above a button near the bottom, and never past the left edge", () => {
		const view = { width: 390, height: 844 };
		const button = { left: 20, top: 800, width: 36, height: 36 };
		const p = menuPlacement(button, view, 280);
		expect(p.top).toBeUndefined();
		expect(p.bottom).toBe(844 - 800 + PANEL_GAP);
		expect(p.left).toBe(VIEW_MARGIN);
		const top = 844 - (p.bottom ?? 0) - Math.min(200, p.maxHeight);
		expect(top).toBeGreaterThanOrEqual(VIEW_MARGIN);
	});
});

describe("placementStyle", () => {
	it("frees the edge it does not use, so a panel placed by its top is not stretched to the stylesheet's bottom", () => {
		const view = { width: 1376, height: 900 };
		const up = placementStyle(bubblePlacement({ left: 1300, top: 120, width: 56, height: 56 }, view, "right"));
		expect(up.top).not.toBe("auto");
		expect(up.bottom).toBe("auto");
		const down = placementStyle(bubblePlacement({ left: 1300, top: 700, width: 56, height: 56 }, view, "right"));
		expect(down.bottom).not.toBe("auto");
		expect(down.top).toBe("auto");
	});
});
