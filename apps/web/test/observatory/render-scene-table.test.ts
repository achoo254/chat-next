// The scene of the machine's interior as the approved design lays it out:
// 13 places on the 1200 × 720 board, every rect and trace on it, tiers as the
// design gives them, every trace starting at the model; the board fitted into
// a frame; a click found on the model's lattice or in a module's box (its
// name under it counts too).
import { describe, expect, it } from "vitest";
import { fitScene, INTERIOR, PLACE_IDS, placeAt } from "../../src/machines/observatory/render/scene-table.ts";

describe("the interior scene", () => {
	it("holds all 13 places on the board, each trace from the model to its module", () => {
		expect(Object.keys(INTERIOR.places).sort()).toEqual([...PLACE_IDS].sort());
		expect(INTERIOR.space).toEqual({ width: 1200, height: 720 });
		const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= INTERIOR.space.width && y <= INTERIOR.space.height;
		for (const id of PLACE_IDS) {
			const p = INTERIOR.places[id];
			expect(inside(p.rect.x, p.rect.y) && inside(p.rect.x + p.rect.w, p.rect.y + p.rect.h)).toBe(true);
			for (const [x, y] of p.route) expect(inside(x, y)).toBe(true);
			const [ex, ey] = p.route.at(-1) ?? [p.rect.x, p.rect.y];
			// The trace ends on its module's edge.
			expect(ex >= p.rect.x && ex <= p.rect.x + p.rect.w && ey >= p.rect.y && ey <= p.rect.y + p.rect.h).toBe(true);
		}
		// Every trace leaves from the model's box.
		const m = INTERIOR.places.core.rect;
		for (const id of ["files", "sandbox", "testing", "git", "mcp", "external", "memory", "skills", "security", "user-desk"] as const) {
			const [sx, sy] = INTERIOR.places[id].route[0] ?? [0, 0];
			expect(sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h).toBe(true);
		}
	});

	it("gives the design's tiers: main, secondary, background", () => {
		const tier = (id: (typeof PLACE_IDS)[number]): number => INTERIOR.places[id].tier;
		expect(["core", "monitoring", "files", "sandbox", "testing", "git"].map((id) => tier(id as (typeof PLACE_IDS)[number]))).toEqual([1, 1, 1, 1, 1, 1]);
		expect([tier("mcp"), tier("external")]).toEqual([2, 2]);
		expect([tier("memory"), tier("skills"), tier("security"), tier("user-desk")]).toEqual([3, 3, 3, 3]);
	});

	it("fits the board into a frame, letterboxed", () => {
		expect(fitScene(INTERIOR.space, { width: 600, height: 360 })).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 });
		expect(fitScene(INTERIOR.space, { width: 1200, height: 1000 })).toEqual({ scale: 1, offsetX: 0, offsetY: 140 });
		expect(fitScene(INTERIOR.space, { width: 0, height: 10 }).scale).toBe(0);
	});

	it("finds the model within its radius, a module in its box or on its name, nothing on empty ground", () => {
		expect(placeAt(INTERIOR, INTERIOR.core.centre)).toBe("core");
		expect(placeAt(INTERIOR, [200, 560])).toBe("files");
		expect(placeAt(INTERIOR, [200, 640])).toBe("files");
		expect(placeAt(INTERIOR, [880, 560])).toBe("sandbox");
		expect(placeAt(INTERIOR, [380, 300])).toBe("monitoring");
		expect(placeAt(INTERIOR, [20, 330])).toBe("user-desk");
		expect(placeAt(INTERIOR, [40, 40])).toBeNull();
	});
});
