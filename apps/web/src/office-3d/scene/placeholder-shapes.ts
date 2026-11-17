// Sizes and colours of the placeholder blocks, by the names the layout uses
// for furniture, small props and decor (metres: width along x, height, depth
// along z before the prop's turn). Colours follow the concept art: honey
// wood, lavender and slate fabrics, warm white. A name not listed gets a
// small grey block, so a new layout name shows up instead of vanishing.

export interface Shape {
	readonly w: number;
	readonly h: number;
	readonly d: number;
	readonly color: string;
	/** Raised off the floor (wall-hung or on a desk the layout already gives y for). */
	readonly lift?: number;
}

export const UNKNOWN_SHAPE: Shape = { w: 0.5, h: 0.5, d: 0.5, color: "#9a98a6" };

export const PROP_SHAPES: Readonly<Record<string, Shape>> = {
	desk: { w: 1.3, h: 0.74, d: 0.7, color: "#c89b6d" },
	"exec-desk": { w: 1.8, h: 0.76, d: 0.85, color: "#8a5a3b" },
	"reading-table": { w: 1.6, h: 0.74, d: 0.9, color: "#c89b6d" },
	"round-table": { w: 0.9, h: 0.74, d: 0.9, color: "#d4ad80" },
	"meeting-table": { w: 2.4, h: 0.74, d: 1.1, color: "#b98c62" },
	"coffee-table": { w: 0.9, h: 0.4, d: 0.55, color: "#c89b6d" },
	"side-table": { w: 0.45, h: 0.5, d: 0.45, color: "#c89b6d" },
	chair: { w: 0.5, h: 0.9, d: 0.5, color: "#6b5aa0" },
	"exec-chair": { w: 0.6, h: 1.05, d: 0.6, color: "#3e3a52" },
	stool: { w: 0.38, h: 0.48, d: 0.38, color: "#9c7ac9" },
	armchair: { w: 0.8, h: 0.8, d: 0.75, color: "#8e7cc3" },
	sofa: { w: 1.7, h: 0.75, d: 0.8, color: "#8e7cc3" },
	monitor: { w: 0.55, h: 0.4, d: 0.08, color: "#2d2c3a" },
	keyboard: { w: 0.42, h: 0.03, d: 0.15, color: "#ece8df" },
	"desk-lamp": { w: 0.18, h: 0.42, d: 0.18, color: "#f2c46d" },
	"floor-lamp": { w: 0.35, h: 1.6, d: 0.35, color: "#f2c46d" },
	"floor-plant": { w: 0.5, h: 1.1, d: 0.5, color: "#4f8f4a" },
	"low-cabinet": { w: 1.2, h: 0.75, d: 0.45, color: "#e3dccd" },
	"filing-cabinet": { w: 0.5, h: 1.25, d: 0.6, color: "#c9c4d4" },
	"trash-bin": { w: 0.3, h: 0.38, d: 0.3, color: "#7d7a8c" },
	printer: { w: 0.6, h: 0.45, d: 0.5, color: "#e8e6ee" },
	"water-cooler": { w: 0.35, h: 1.2, d: 0.35, color: "#a9cbe8" },
	bookshelf: { w: 1.2, h: 1.8, d: 0.4, color: "#a8744d" },
	"tall-bookcase": { w: 1.1, h: 2.2, d: 0.4, color: "#a8744d" },
	"server-rack": { w: 0.65, h: 2, d: 0.9, color: "#383d55" },
	"pantry-counter": { w: 2.2, h: 0.92, d: 0.65, color: "#efe7d8" },
	"coffee-machine": { w: 0.35, h: 0.45, d: 0.35, color: "#3b3340", lift: 0.92 },
	"mini-fridge": { w: 0.55, h: 0.85, d: 0.55, color: "#f4f2f7" },
	"reception-desk": { w: 2.2, h: 1.05, d: 0.7, color: "#d7b48a" },
	"kanban-board": { w: 1.8, h: 1.2, d: 0.08, color: "#f6f1e5", lift: 0.8 },
	globe: { w: 0.45, h: 0.9, d: 0.45, color: "#5aa0c8" },
	"mail-cubbies": { w: 1.4, h: 1.6, d: 0.4, color: "#b98c62" },
	"post-counter": { w: 2, h: 1, d: 0.65, color: "#d7b48a" },
	"parcel-boxes": { w: 0.8, h: 0.6, d: 0.6, color: "#c8a06a" },
	"parcel-cart": { w: 0.7, h: 0.9, d: 1, color: "#7d7a8c" },
	mailbox: { w: 0.45, h: 1.1, d: 0.45, color: "#d9473c" },
	"cctv-wall": { w: 2.4, h: 1.4, d: 0.15, color: "#2d2c3a", lift: 0.8 },
	turnstile: { w: 1.2, h: 1, d: 0.3, color: "#9a98a6" },
	locker: { w: 0.9, h: 1.9, d: 0.5, color: "#7f8fb0" },
	"cash-register": { w: 0.4, h: 0.25, d: 0.35, color: "#3e3a52" },
	"coin-stacks": { w: 0.3, h: 0.15, d: 0.3, color: "#e6b84a" },
	safe: { w: 0.7, h: 0.9, d: 0.7, color: "#4a4e63" },
	"test-bench": { w: 2, h: 0.9, d: 0.8, color: "#d4d8e2" },
	"signal-tower": { w: 0.2, h: 1.5, d: 0.2, color: "#4caf50" },
	"device-shelf": { w: 1.2, h: 1.7, d: 0.45, color: "#b4b9c8" },
	// The living rooms: dorm, gym, lounge and dining.
	bed: { w: 0.95, h: 0.5, d: 2, color: "#9fb3d9" },
	nightstand: { w: 0.45, h: 0.55, d: 0.4, color: "#c89b6d" },
	treadmill: { w: 0.8, h: 0.18, d: 1.8, color: "#3e3a52" },
	"gym-mat": { w: 0.9, h: 0.03, d: 1.8, color: "#5b7bd5" },
	"weight-bench": { w: 0.45, h: 0.45, d: 1.3, color: "#3e3a52" },
	"dumbbell-rack": { w: 1.2, h: 0.8, d: 0.45, color: "#7d7a8c" },
	"punching-bag": { w: 0.4, h: 1.5, d: 0.4, color: "#c0392b", lift: 0.3 },
	"tv-stand": { w: 1.8, h: 0.55, d: 0.45, color: "#5a4a6b" },
	beanbag: { w: 0.75, h: 0.4, d: 0.75, color: "#e9a23b" },
	"dining-table": { w: 0.9, h: 0.74, d: 2, color: "#c89b6d" },
	"dining-chair": { w: 0.45, h: 0.9, d: 0.45, color: "#8e7cc3" },
	"kitchen-counter": { w: 2.2, h: 0.92, d: 0.65, color: "#efe7d8" },
	microwave: { w: 0.5, h: 0.3, d: 0.38, color: "#d4d8e2" },
	fridge: { w: 0.7, h: 1.8, d: 0.7, color: "#f4f2f7" },
	// Small props (y comes from the layout: on a desk).
	mug: { w: 0.09, h: 0.1, d: 0.09, color: "#f0e6d8" },
	"paper-stack": { w: 0.3, h: 0.06, d: 0.22, color: "#fbfaf6" },
	"sticky-notes": { w: 0.08, h: 0.03, d: 0.08, color: "#f6d55c" },
	"desk-plant": { w: 0.14, h: 0.22, d: 0.14, color: "#5c9b52" },
	"book-stack": { w: 0.24, h: 0.14, d: 0.18, color: "#c25b4a" },
};

export function shapeOf(name: string): Shape {
	return PROP_SHAPES[name] ?? UNKNOWN_SHAPE;
}

/** Floor tone of each room (the placeholder slab). */
export const ROOM_TONES: Readonly<Record<string, string>> = {
	LOBBY: "#e6dfd2",
	DIRECTOR: "#c9a27a",
	WORK: "#d6b48c",
	SERVER: "#b8bccb",
	MEETING: "#cfc3df",
	PANTRY: "#e8dcc6",
	PLANNING: "#d6b48c",
	LIBRARY: "#c9a27a",
	POST: "#ddd1bd",
	SECURITY: "#bfc3cf",
	AUDIT: "#d6b48c",
	QA: "#d3dbe0",
	DORM: "#d9cfe6",
	GYM: "#c9d3dc",
	LOUNGE: "#e6d6b8",
};

export const RUG_TONES: Readonly<Record<string, string>> = {
	lavender: "#a99ad1",
	slate: "#6b739e",
	cream: "#e6d6b8",
	grey: "#8d8f9e",
};

export const WALL_COLOR = "#ddd9ec";
export const FRAME_COLOR = "#544d72";
export const GLASS_COLOR = "#bcd2f2";
export const CORE_COLOR = "#c7c4cf";
export const METAL_COLOR = "#b5b7c0";
