// The schematic drawings inside the Live Map's modules: a file lights the cell
// its target picks (blue for a read, yellow for an edit, a search lights none),
// the test bed shows an outcome and never a count, the shell keeps the newest
// line at its bottom, the commit graph names main and HEAD and branches from
// five commits, every service mark draws (an unknown one with its first letter).
import { describe, expect, it } from "vitest";
import { INK, rgba } from "../../src/machines/observatory/render/ink.ts";
import {
	EDIT_COLOUR,
	FILE_COLS,
	FILE_ROWS,
	hash,
	paintCommitGraph,
	paintFileMatrix,
	paintMcpPort,
	paintServiceMark,
	paintShell,
	paintTestBed,
	TEST_COLS,
	TEST_ROWS,
} from "../../src/machines/observatory/render/schematic-marks.ts";

interface Rec {
	readonly ctx: CanvasRenderingContext2D;
	readonly texts: string[];
	/** fillStyle at each fillRect, and each fill (a cell, a node). */
	readonly rects: string[];
	readonly fills: string[];
	readonly arcs: number[];
}

function recorder(): Rec {
	const texts: string[] = [];
	const rects: string[] = [];
	const fills: string[] = [];
	const arcs: number[] = [];
	const target: Record<string | symbol, unknown> = {
		measureText: (text: string) => ({ width: text.length * 6 }),
		createRadialGradient: () => ({ addColorStop: () => {} }),
	};
	const ctx = new Proxy(target, {
		get: (t, key) => {
			if (key === "fillText") return (text: string) => texts.push(text);
			if (key === "fillRect") return () => rects.push(String(t.fillStyle));
			if (key === "fill") return () => fills.push(String(t.fillStyle));
			if (key === "arc") return () => arcs.push(1);
			return key in t ? t[key] : () => {};
		},
		set: (t, key, value) => {
			t[key] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, texts, rects, fills, arcs };
}

const R = { x: 0, y: 0, w: 412, h: 120 };
const BLUE = "#70b8ff";

describe("the file matrix", () => {
	it("puts a target in a stable cell inside the matrix", () => {
		expect(hash("src/a.ts")).toBe(hash("src/a.ts"));
		expect(hash("src/a.ts")).not.toBe(hash("src/b.ts"));
		expect(hash("x") % (FILE_COLS * FILE_ROWS)).toBeLessThan(FILE_COLS * FILE_ROWS);
	});

	it("lights a read in the module's colour and an edit in yellow, and a search lights no cell", () => {
		const read = recorder();
		paintFileMatrix(read.ctx, R, BLUE, [{ key: "a", tool: "Read", strength: 0.9 }], false, false, 0, false);
		expect(read.rects.filter((s) => s === rgba(BLUE, 0.9))).toHaveLength(1);
		const edit = recorder();
		paintFileMatrix(edit.ctx, R, BLUE, [{ key: "a", tool: "Edit", strength: 0.9 }], false, false, 0, false);
		expect(edit.rects.filter((s) => s === rgba(EDIT_COLOUR, 0.9))).toHaveLength(1);
		const search = recorder();
		paintFileMatrix(search.ctx, R, BLUE, [{ key: "a", tool: "Grep", strength: 0.9 }], true, true, 0, false);
		expect(search.rects.some((s) => s === rgba(BLUE, 0.9))).toBe(false);
	});
});

describe("the test bed", () => {
	const cells = (state: "none" | "running" | "pass" | "fail", wall = 0): Rec => {
		const rec = recorder();
		paintTestBed(rec.ctx, { x: 0, y: 0, w: 215, h: 140 }, "#3dd68c", state, wall);
		return rec;
	};
	it("shows an outcome on every cell: all green when it passed, all red when it failed, grey before any", () => {
		const total = TEST_COLS * TEST_ROWS;
		expect(cells("pass").fills.filter((s) => s === rgba(INK.ok, 0.8))).toHaveLength(total);
		expect(cells("fail").fills.filter((s) => s === rgba(INK.err, 0.85))).toHaveLength(total);
		expect(cells("none").fills.filter((s) => s === "rgba(90,104,122,.35)")).toHaveLength(total);
	});
	it("while a run goes lights a few cells in amber and the rest stay grey", () => {
		const warm = cells("running", 0).fills.filter((s) => s.startsWith("rgba(255,197,61"));
		expect(warm.length).toBeGreaterThan(0);
		expect(warm.length).toBeLessThan(TEST_COLS * TEST_ROWS);
	});
});

describe("the shell window", () => {
	it("writes the lines with the newest last, and no cursor while a command runs", () => {
		const rec = recorder();
		const lines = [
			{ text: "$ pnpm install", colour: INK.fg },
			{ text: "✓ 2 s", colour: INK.muted },
			{ text: "…", colour: INK.muted },
		];
		paintShell(rec.ctx, { x: 0, y: 0, w: 164, h: 92 }, "#bde56c", lines, true, 0, 1.15);
		expect(rec.texts.filter((t) => t !== "zsh")).toEqual(["$ pnpm install", "✓ 2 s", "…"]);
	});
	it("keeps only the lines that fit, the newest", () => {
		const rec = recorder();
		const lines = Array.from({ length: 30 }, (_, i) => ({ text: `l${i}`, colour: INK.fg }));
		paintShell(rec.ctx, { x: 0, y: 0, w: 164, h: 92 }, "#bde56c", lines, false, 0, 1.15);
		const written = rec.texts.filter((t) => t !== "zsh");
		expect(written.length).toBeLessThan(30);
		expect(written.at(-1)).toBe("l29");
	});
});

describe("the commit graph", () => {
	const draw = (commits: number): Rec => {
		const rec = recorder();
		paintCommitGraph(rec.ctx, { x: 0, y: 0, w: 550, h: 95 }, "#ffa057", commits, false, 0, false, { main: "main", head: "HEAD" }, 1.15);
		return rec;
	};
	it("names the main lane and the newest commit", () => {
		expect(draw(3).texts).toEqual(["main", "HEAD"]);
	});
	it("draws one node per commit, at most five, and a feature branch node from five", () => {
		expect(draw(2).arcs).toHaveLength(2);
		expect(draw(4).arcs).toHaveLength(4);
		expect(draw(9).arcs).toHaveLength(5 + 1);
	});
});

describe("the service marks", () => {
	it("draws every known service and an unknown one by its first letter", () => {
		for (const name of ["claude-in-chrome", "github", "slack", "linear", "notion", "figma", "filesystem", "mongodb", "cloudflare", "gmail", "sentry", "stripe", "context7", "calendar", "onedash"]) {
			const rec = recorder();
			expect(() => paintServiceMark(rec.ctx, name, 0, 0, 16, "#0bd8b6")).not.toThrow();
			expect(rec.texts).toEqual([]);
		}
		const unknown = recorder();
		paintServiceMark(unknown.ctx, "acme-crm", 0, 0, 16, "#0bd8b6");
		expect(unknown.texts).toEqual(["A"]);
	});
	it("a connector port writes the name and the last tool with its runtime", () => {
		const rec = recorder();
		paintMcpPort(rec.ctx, 0, 0, 380, { name: "acme-crm", on: false, used: true, last: { tool: "lookup", runtime: "1 s" } }, "#0bd8b6", 0, false, 1.15);
		expect(rec.texts).toEqual(expect.arrayContaining(["A", "acme-crm", "lookup · 1 s"]));
	});
});
