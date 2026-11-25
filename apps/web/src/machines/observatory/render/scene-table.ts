// Where everything sits inside the machine (the Live Map's scene), in scene
// pixels of a 1200 × 720 board, as the approved design lays it out
// (hoandat-app/plans/dattqh/261125-2211-observatory-machine-interior/reports/prototype-v6.html):
// the model's neural lattice in the middle, the context reservoir and the
// token wave beside it, the main modules (files, terminal, testing, Git ·
// CI/CD) below, the secondary ones (MCP, internet) on the right, the
// background ones (memory, skills, permission lock, input port) small at the
// edges. Each module has its rect, tier and the trace from the model to it
// (straight legs). The scene is drawn in code (render/interior-painter.ts):
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

export interface ScenePlace {
	readonly id: PlaceId;
	/** The module's box: the click area and the camera's focus box. */
	readonly rect: Rect;
	readonly tier: Tier;
	/** The trace from the model to the module; empty when none. */
	readonly route: readonly Point[];
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
	readonly places: Readonly<Record<PlaceId, ScenePlace>>;
}

const MODEL: Rect = { x: 508, y: 238, w: 224, h: 224 };

const place = (id: PlaceId, rect: Rect, tier: Tier, route: readonly Point[] = []): ScenePlace => ({ id, rect, tier, route });

/** The scene of the machine's interior. */
export const INTERIOR: SceneTable = {
	space: { width: 1200, height: 720 },
	core: { centre: [620, 350], radius: 120, orbit: [150, 118] },
	wave: { x: 300, y: 18, w: 190, h: 62 },
	places: {
		core: place("core", MODEL, 1),
		orchestrator: place("orchestrator", MODEL, 1),
		monitoring: place("monitoring", { x: 330, y: 170, w: 120, h: 300 }, 1),
		files: place("files", { x: 96, y: 520, w: 330, h: 96 }, 1, [
			[520, 420],
			[470, 420],
			[470, 568],
			[426, 568],
		]),
		sandbox: place("sandbox", { x: 800, y: 500, w: 170, h: 120 }, 1, [
			[720, 420],
			[770, 420],
			[770, 560],
			[800, 560],
		]),
		testing: place("testing", { x: 1000, y: 500, w: 180, h: 120 }, 1, [
			[720, 440],
			[750, 440],
			[750, 484],
			[1090, 484],
			[1090, 500],
		]),
		git: place("git", { x: 520, y: 640, w: 440, h: 76 }, 1, [
			[650, 462],
			[650, 640],
		]),
		mcp: place("mcp", { x: 840, y: 160, w: 320, h: 140 }, 2, [
			[720, 300],
			[790, 300],
			[790, 230],
			[840, 230],
		]),
		external: place("external", { x: 1060, y: 6, w: 130, h: 130 }, 2, [
			[690, 250],
			[690, 70],
			[1066, 70],
		]),
		memory: place("memory", { x: 130, y: 100, w: 100, h: 46 }, 3, [
			[550, 250],
			[550, 123],
			[230, 123],
		]),
		skills: place("skills", { x: 130, y: 168, w: 100, h: 46 }, 3, [
			[572, 250],
			[572, 191],
			[230, 191],
		]),
		security: place("security", { x: 470, y: 572, w: 60, h: 44 }, 3, [
			[560, 452],
			[560, 530],
			[500, 530],
			[500, 572],
		]),
		"user-desk": place("user-desk", { x: 4, y: 306, w: 56, h: 50 }, 3, [
			[520, 332],
			[60, 332],
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
