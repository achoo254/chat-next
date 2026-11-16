import { describe, expect, it } from "vitest";
import { stackLabels } from "../../src/office-3d/office-overlay.ts";

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
