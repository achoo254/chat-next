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
		expect(INTERIOR.space).toEqual({ width: 1500, height: 900 });
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

	it("writes each trace's figures in free space: off every module and the model's title, and apart from each other", () => {
		// The widest figures ("124 lần gọi · p95 ls 37,6 s · 12 lỗi": 36 characters of 10.5 px mono, at the scene's text scale) and one line high.
		const W = 36 * 6.3 * INTERIOR.text + 8;
		const H = 15 * INTERIOR.text;
		const boxOf = (id: (typeof PLACE_IDS)[number]): { x: number; y: number; w: number; h: number } | null => {
			const label = INTERIOR.places[id].label;
			if (label === null) return null;
			const x = label.align === "left" ? label.at[0] : label.align === "center" ? label.at[0] - W / 2 : label.at[0] - W;
			return { x: x - 4, y: label.at[1] - 2, w: W, h: H };
		};
		const meet = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
			a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
		const [cx, cy] = INTERIOR.core.centre;
		const k = INTERIOR.core.radius / 120;
		// The model's title, its state line and its API line (when focused): about 250 px wide, centred under the lattice.
		const title = { x: cx - 150, y: cy + 124 * k, w: 300, h: 60 };
		const labelled = PLACE_IDS.filter((id) => boxOf(id) !== null);
		expect(labelled.sort()).toEqual(["external", "files", "git", "mcp", "memory", "sandbox", "skills", "testing"]);
		for (const id of labelled) {
			const box = boxOf(id);
			if (box === null) continue;
			expect(box.x >= 0 && box.x + box.w <= INTERIOR.space.width, id).toBe(true);
			expect(meet(box, title), `${id} meets the model's title`).toBe(false);
			for (const other of PLACE_IDS) {
				if (other === "core" || other === "orchestrator") continue;
				expect(meet(box, INTERIOR.places[other].rect), `${id} meets ${other}`).toBe(false);
			}
			for (const otherId of labelled) {
				const o = boxOf(otherId);
				if (otherId !== id && o !== null) expect(meet(box, o), `${id} meets ${otherId}'s figures`).toBe(false);
			}
		}
	});

	it("gives the design's tiers: main, secondary, background", () => {
		const tier = (id: (typeof PLACE_IDS)[number]): number => INTERIOR.places[id].tier;
		expect(["core", "monitoring", "files", "sandbox", "testing", "git"].map((id) => tier(id as (typeof PLACE_IDS)[number]))).toEqual([1, 1, 1, 1, 1, 1]);
		expect([tier("mcp"), tier("external")]).toEqual([2, 2]);
		expect([tier("memory"), tier("skills"), tier("security"), tier("user-desk")]).toEqual([3, 3, 3, 3]);
	});

	it("fits the board into a frame, letterboxed", () => {
		expect(fitScene(INTERIOR.space, { width: 750, height: 450 })).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 });
		expect(fitScene(INTERIOR.space, { width: 1500, height: 1000 })).toEqual({ scale: 1, offsetX: 0, offsetY: 50 });
		expect(fitScene(INTERIOR.space, { width: 0, height: 10 }).scale).toBe(0);
	});

	it("finds the model within its radius, a module in its box or on its name, nothing on empty ground", () => {
		expect(placeAt(INTERIOR, INTERIOR.core.centre)).toBe("core");
		expect(placeAt(INTERIOR, [250, 700])).toBe("files");
		expect(placeAt(INTERIOR, [250, 790])).toBe("files");
		expect(placeAt(INTERIOR, [1140, 700])).toBe("sandbox");
		expect(placeAt(INTERIOR, [480, 400])).toBe("monitoring");
		expect(placeAt(INTERIOR, [30, 410])).toBe("user-desk");
		expect(placeAt(INTERIOR, [40, 40])).toBeNull();
	});
});
