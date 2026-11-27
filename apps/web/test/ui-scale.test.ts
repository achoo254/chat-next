import { afterEach, describe, expect, it } from "vitest";
import { applyStoredAppearance, SCALE_DEFAULT, SCALE_MAX, SCALE_MIN, setUiScale, storedUiScale } from "../src/appearance.ts";

afterEach(() => {
	window.localStorage.clear();
	document.documentElement.style.removeProperty("font-size");
});

describe("interface size", () => {
	it("defaults to 110% when nothing is stored", () => {
		expect(SCALE_DEFAULT).toBe(110);
		expect(storedUiScale()).toBe(110);
		applyStoredAppearance();
		expect(document.documentElement.style.fontSize).toBe("110%");
	});

	it("keeps a chosen size on this device and puts it on the root font size", () => {
		setUiScale(120);
		expect(storedUiScale()).toBe(120);
		expect(document.documentElement.style.fontSize).toBe("120%");
	});

	it("snaps to a step and stays within the range", () => {
		setUiScale(112);
		expect(storedUiScale()).toBe(110);
		setUiScale(500);
		expect(storedUiScale()).toBe(SCALE_MAX);
		setUiScale(10);
		expect(storedUiScale()).toBe(SCALE_MIN);
	});

	it("ignores a stored value outside the range or not a whole number", () => {
		window.localStorage.setItem("app:ui-scale", "300");
		expect(storedUiScale()).toBe(SCALE_DEFAULT);
		window.localStorage.setItem("app:ui-scale", "abc");
		expect(storedUiScale()).toBe(SCALE_DEFAULT);
	});
});
