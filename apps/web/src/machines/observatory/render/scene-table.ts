// Where everything sits inside the machine (the Live Map's scene), in scene
// pixels of a 1500 × 900 board, as the approved design lays it out (given room)
// (hoandat-app/plans/dattqh/261125-2211-observatory-machine-interior/reports/prototype-v6.html):
// the model's neural lattice in the middle, the context reservoir and the
// token wave beside it, the main modules (files, terminal, testing, Git ·
// CI/CD) below, the secondary ones (MCP, internet) on the right, the
// background ones (memory, skills, permission lock, input port) small at the
// edges. Each module has its rect, tier and the trace from the model to it
// (straight legs) and the spot its figures are written. The scene is drawn in code (render/interior-painter.ts):
// there are no image assets.
import type { StationCode } from "../station-catalog.ts";

/** The 13 places of the scene. */
export const PLACE_IDS = ["core", "user-desk", "orchestrator", "memory", "skills", "files", "mcp", "external", "security", "sandbox", "testing", "git", "monitoring"] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export type Point = readonly [number, number];

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** 1: main, 2: secondary, 3: background (smaller, dimmer while unused). */
export type Tier = 1 | 2 | 3;

/** Where a trace's figures are written: a point in free space and which way the text runs from it. */
export interface TraceLabel {
	readonly at: Point;
	readonly align: "left" | "center" | "right";
}

export interface ScenePlace {
	readonly id: PlaceId;
	/** The module's box: the click area and the camera's focus box. */
	readonly rect: Rect;
	readonly tier: Tier;
	/** The trace from the model to the module; empty when none. */
	readonly route: readonly Point[];
	/** Where the trace's figures go, clear of every module, other trace's figures and the model's title; null: none written. */
	readonly label: TraceLabel | null;
}

export interface SceneSpace {
	readonly width: number;
	readonly height: number;
}

export interface SceneCore {
	/** The lattice's centre. */
	readonly centre: Point;
	readonly radius: number;
	/** Half axes of the ellipse subagents circle on. */
	readonly orbit: Point;
}

export interface SceneTable {
	readonly space: SceneSpace;
	readonly core: SceneCore;
	/** The token wave's box. */
	readonly wave: Rect;
	/** How much larger than the design's the text is drawn (the board grew more, so the traces run longer). */
	readonly text: number;
	readonly places: Readonly<Record<PlaceId, ScenePlace>>;
}

const MODEL: Rect = { x: 635, y: 298, w: 280, h: 280 };

const place = (id: PlaceId, rect: Rect, tier: Tier, route: readonly Point[] = [], label: TraceLabel | null = null): ScenePlace => ({ id, rect, tier, route, label });
const at = (x: number, y: number, align: TraceLabel["align"] = "left"): TraceLabel => ({ at: [x, y], align });

/**
 * The scene of the machine's interior: the design's layout given room (a
 * 1500 × 900 board, the same 5:3 as the design's 1200 × 720), so each trace
 * runs long enough to carry its figures and no two figures, module or the
 * model's title meet.
 */
export const INTERIOR: SceneTable = {
	space: { width: 1500, height: 900 },
	core: { centre: [775, 438], radius: 150, orbit: [188, 148] },
	wave: { x: 375, y: 10, w: 238, h: 62 },
	text: 1.15,
	places: {
		core: place("core", MODEL, 1),
		orchestrator: place("orchestrator", MODEL, 1),
		monitoring: place("monitoring", { x: 412, y: 212, w: 150, h: 375 }, 1),
		files: place("files", { x: 120, y: 650, w: 412, h: 120 }, 1, [
			[650, 525],
			[588, 525],
			[588, 710],
			[532, 710],
		], at(120, 628)),
		sandbox: place("sandbox", { x: 1060, y: 610, w: 180, h: 140 }, 1, [
			[900, 525],
			[962, 525],
			[962, 700],
			[1060, 700],
		], at(972, 590)),
		testing: place("testing", { x: 1265, y: 610, w: 215, h: 140 }, 1, [
			[900, 560],
			[1372, 560],
			[1372, 610],
		], at(1160, 541, "center")),
		git: place("git", { x: 650, y: 800, w: 550, h: 95 }, 1, [
			[812, 578],
			[812, 800],
		], at(822, 765)),
		mcp: place("mcp", { x: 1050, y: 200, w: 400, h: 175 }, 2, [
			[900, 375],
			[988, 375],
			[988, 288],
			[1050, 288],
		], at(998, 390)),
		external: place("external", { x: 1325, y: 8, w: 162, h: 162 }, 2, [
			[862, 312],
			[862, 88],
			[1332, 88],
		], at(1090, 68, "center")),
		memory: place("memory", { x: 120, y: 84, w: 190, h: 64 }, 3, [
			[688, 312],
			[688, 116],
			[310, 116],
		], at(500, 96, "center")),
		skills: place("skills", { x: 120, y: 160, w: 190, h: 64 }, 3, [
			[715, 312],
			[715, 192],
			[310, 192],
		], at(500, 172, "center")),
		security: place("security", { x: 570, y: 720, w: 105, h: 70 }, 3, [
			[700, 565],
			[700, 662],
			[625, 662],
			[625, 720],
		]),
		"user-desk": place("user-desk", { x: 5, y: 372, w: 130, h: 84 }, 3, [
			[650, 415],
			[135, 415],
		]),
	},
};

export interface SceneFit {
	readonly scale: number;
	readonly offsetX: number;
	readonly offsetY: number;
}

/** How the scene fits a frame (CSS pixels): scale and offset, letterboxed. */
export function fitScene(s: SceneSpace, frame: { readonly width: number; readonly height: number }): SceneFit {
	if (frame.width <= 0 || frame.height <= 0) return { scale: 0, offsetX: 0, offsetY: 0 };
	const scale = Math.min(frame.width / s.width, frame.height / s.height);
	return { scale, offsetX: (frame.width - s.width * scale) / 2, offsetY: (frame.height - s.height * scale) / 2 };
}

export function insideRect(p: Point, r: Rect): boolean {
	return p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
}

/** The Git module's release pipeline (commit, push, CI, deploy): where its step boxes sit inside the module, in scene pixels. */
export const PIPELINE_CELL = { dx: 198, dy: 41, w: 70, h: 38, gap: 12 } as const;

/** The box of the `index`th pipeline step of a Git module at `git`. */
export function pipelineCell(git: Rect, index: number): Rect {
	return { x: git.x + PIPELINE_CELL.dx + index * (PIPELINE_CELL.w + PIPELINE_CELL.gap), y: git.y + PIPELINE_CELL.dy, w: PIPELINE_CELL.w, h: PIPELINE_CELL.h };
}

/** Places tried by a click after the model's lattice, in the design's order. */
const HIT_ORDER: readonly PlaceId[] = ["monitoring", "files", "sandbox", "testing", "git", "mcp", "external", "memory", "skills", "security", "user-desk"];

/** The place at a scene point, or null: the model within its radius, else a module's box (its name under it counts too). */
export function placeAt(scene: SceneTable, p: Point): PlaceId | null {
	const [cx, cy] = scene.core.centre;
	if (Math.hypot(p[0] - cx, p[1] - cy) < scene.core.radius) return "core";
	for (const id of HIT_ORDER) {
		const r = scene.places[id].rect;
		if (p[0] >= r.x - 4 && p[0] <= r.x + r.w + 4 && p[1] >= r.y - 4 && p[1] <= r.y + r.h + 30) return id;
	}
	return null;
}

/** The place a station's things happen at; the three places without a station (input port, permission lock, context reservoir) take what the scene sends them. */
export const STATION_PLACE: Readonly<Record<StationCode, PlaceId>> = {
	CORE: "core",
	ORCHESTRATOR: "orchestrator",
	FILES: "files",
	MEMORY: "memory",
	SKILLS: "skills",
	MCP: "mcp",
	EXTERNAL: "external",
	SANDBOX: "sandbox",
	TESTING: "testing",
	GIT: "git",
};
