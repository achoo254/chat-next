// The light by the viewer's hour: day, evening, night (the building never
// closes), and a night mix that never jumps.
import { describe, expect, it } from "vitest";
import { officeDaypart } from "../../src/machines/office/office-daypart.ts";

/** Local time on a fixed day (the viewer's time zone, whatever it is). */
const at = (h: number, m = 0): number => new Date(2026, 10, 15, h, m).getTime();

describe("the office's light", () => {
	it("follows the viewer's hour", () => {
		expect(officeDaypart(at(10))).toEqual({ phase: "day", nightMix: 0 });
		expect(officeDaypart(at(17, 45)).phase).toBe("evening");
		expect(officeDaypart(at(22))).toEqual({ phase: "night", nightMix: 1 });
		expect(officeDaypart(at(3)).phase).toBe("night");
		expect(officeDaypart(at(6)).phase).toBe("evening");
		expect(officeDaypart(at(7))).toEqual({ phase: "day", nightMix: 0 });
	});

	it("blends day into night without a jump", () => {
		let previous = officeDaypart(at(0)).nightMix;
		for (let minute = 1; minute < 24 * 60; minute++) {
			const mix = officeDaypart(at(0, minute)).nightMix;
			expect(Math.abs(mix - previous)).toBeLessThan(0.02);
			expect(mix).toBeGreaterThanOrEqual(0);
			expect(mix).toBeLessThanOrEqual(1);
			previous = mix;
		}
	});
});
