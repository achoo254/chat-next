// Docking the Advisor mascot: the nearer side edge, a height inside the band
// clear of headers and composers, a tap told from a drag; the dock is kept
// per device.
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BAND_BOTTOM, BAND_TOP, bandOf, dockFor, isDrag, MASCOT_SIZE, useMascotDrag } from "../../src/advisor/advisor-drag.ts";
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

	it("keeps the mascot inside the band: never over the header nor the composer", () => {
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
		expect(bandOf({ width: 300, height: 200 })).toEqual({ top: BAND_TOP, bottom: BAND_TOP });
		expect(dockFor(10, 150, { width: 300, height: 200 })).toEqual({ side: "left", y: 0 });
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
