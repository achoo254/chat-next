// Draws the inside of the machine on a 2D canvas, as the approved design does
// (hoandat-app/plans/dattqh/261125-2211-observatory-machine-interior/reports/prototype-v6.html):
// a dark board with a faint grid and copper traces; the model as a neural
// lattice (sparks fly while it thinks, it stays calm while tools run);
// subagents circling it; a trace from the model (or the subagent that makes
// the call) to each module, its width by calls, its red share by failures,
// dashes flowing while a call runs (amber once past the session's p95 of its
// kind), its label the runtime or the calls, p95 and failures; the modules
// (files, terminal, testing, Git · CI/CD pipeline, MCP slots, the space
// portal of the internet, memory, skills, the permission lock, the input
// port), the context reservoir and the token wave; and the packets of
// arriving events. The module the camera is on shows its live
// content (its last calls). "Ẩn chi tiết" leaves out every target and MCP
// name. Everything comes from the scene's look (prop-map.ts) and the state;
// nothing here keeps data, only the motion between frames (sparks, stars,
// the wave's phase, how long ago a module was touched).
import { districtBoardOf, type BoardRow, type DistrictBoard } from "../district-board-model.ts";
import { callLabel } from "../drill-format.ts";
import type { LiveMapState } from "../live-map-state.ts";
import type { ObservatoryCopy } from "../observatory-copy.ts";
import type { StepStatus } from "../pipeline-model.ts";
import type { MoveFrame } from "./animation-director.ts";
import { clamp01, INK, rgba } from "./ink.ts";
import { pathPoint, subPath, type SceneLook, type Tone } from "./prop-map.ts";
import { PIPELINE_CELL, PLACE_IDS, pipelineCell, type PlaceId, type Point, type Rect, type SceneTable } from "./scene-table.ts";
import {
	cornerTicks,
	EDIT_COLOUR,
	MCP_ROW_GAP,
	MCP_ROW_H,
	paintCommitGraph,
	paintFileMatrix,
	paintMcpPort,
	paintMemoryChip,
	paintPermissionShield,
	paintPromptPort,
	paintShell,
	paintSkillBolt,
	paintTestBed,
	plate,
	type FileTouch,
	type ShellLine,
	type TestState,
} from "./schematic-marks.ts";

export { INK, rgba };

export const PLACE_COLOR: Readonly<Record<PlaceId, string>> = {
	core: "#baa7ff",
	orchestrator: "#e796f3",
	files: "#70b8ff",
	memory: "#4ccce6",
	skills: "#dbb594",
	mcp: "#0bd8b6",
	external: "#ff8dcc",
	sandbox: "#bde56c",
	testing: "#3dd68c",
	git: "#ffa057",
	"user-desk": "#dfe6ee",
	security: "#ffc53d",
	monitoring: "#4ccce6",
};

const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
const TIER = { 1: { font: 13, sub: 11.5, line: 1.6, alpha: 1 }, 2: { font: 12, sub: 11, line: 1.2, alpha: 0.9 }, 3: { font: 13, sub: 12, line: 1.2, alpha: 0.85 } } as const;
/** Side of the marks at the right of memory and skills, and the permission shield's scale (it is drawn 24 wide). */
const SMALL_MARK = 36;
const SHIELD_SCALE = 1.5;
/** A module glows this long after a packet reached or left it. */
const GLOW_MS = 1_400;
/** A compaction sends sparks back through the lattice this long after it starts. */
const COMPACT_SPARK_MS = 1_600;
/** Boards' runtimes are read again this often. */
const BOARD_TICK_MS = 250;
/** The deploy's light rings this long after it succeeded. */
const PROD_RING_MS = 4_000;

export type SceneCopy = ObservatoryCopy["scene"];

export interface PaintInput {
	readonly look: SceneLook;
	readonly state: LiveMapState;
	/** The machine's clock (ms): runtimes. */
	readonly wall: number;
	/** The animation clock (ms). */
	readonly t: number;
	/** Since the last frame (ms). */
	readonly dt: number;
	readonly moves: readonly MoveFrame[];
	/** The model thinks on the scene (its spin stops a while after the last event). */
	readonly thinking: boolean;
	readonly selected: PlaceId | null;
	/** The module whose live content shows. */
	readonly contentZone: PlaceId | null;
	readonly hide: boolean;
	readonly motion: boolean;
	readonly copy: SceneCopy;
	readonly duration: (ms: number) => string;
}

/** Cuts a text to about `px` wide at `size` px monospace. */
function clip(s: string, px: number, size: number): string {
	const n = Math.max(1, Math.floor(px / (size * 0.6)));
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The model's lattice: a centre node and three rings, each node linked to its close neighbours on the next ring. */
interface Node {
	readonly r: number;
	readonly a: number;
	readonly ring: number;
}
const NODES: readonly Node[] = (() => {
	const o: Node[] = [{ r: 0, a: 0, ring: 0 }];
	const rings: ReadonlyArray<readonly [number, number]> = [
		[8, 34],
		[14, 62],
		[20, 88],
	];
	rings.forEach(([n, r], ri) => {
		for (let i = 0; i < n; i++) o.push({ r, a: (i / n) * Math.PI * 2 + ri * 0.3, ring: ri + 1 });
	});
	return o;
})();
const EDGES: ReadonlyArray<readonly [number, number]> = (() => {
	const e: Array<[number, number]> = [];
	NODES.forEach((a, i) =>
		NODES.forEach((b, j) => {
			if (j <= i || b.ring !== a.ring + 1) return;
			const da = Math.abs(((a.a - b.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
			if (a.ring === 0 || da < 0.42) e.push([i, j]);
		}),
	);
	return e;
})();

const STAGES = ["commit", "push", "ci", "deploy"] as const;

/** A seeded random, so the board's copper traces are the same on every visit. */
function seeded(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 16807) % 2147483647;
		return s / 2147483647;
	};
}

interface Spark {
	edge: readonly [number, number];
	t: number;
	back: boolean;
}

interface Star {
	a: number;
	r: number;
	s: number;
}

export class InteriorPainter {
	private readonly scene: SceneTable;
	private readonly background: HTMLCanvasElement | null;
	private sparks: Spark[] = [];
	private readonly stars: Star[];
	private wavePhase = 0;
	/** The token rate the wave shows: it follows the model while it thinks and fades after. */
	private waveRate = 0;
	private readonly touched = new Map<PlaceId, number>();
	/** When the context's compaction began (animation clock); null when none runs. */
	private compactSince: number | null = null;
	/** The text's scale (scene-table.ts `text`). */
	private readonly ts: number;
	/** Modules' boards, worked out once per state and quarter second (they read the whole log). */
	private boards = new Map<string, DistrictBoard>();
	private boardsOf: { state: LiveMapState | null; bucket: number } = { state: null, bucket: -1 };
	private readonly random: () => number;
	private ctx: CanvasRenderingContext2D | null = null;
	private input: PaintInput | null = null;

	constructor(scene: SceneTable, random: () => number = Math.random) {
		this.scene = scene;
		this.ts = scene.text;
		this.random = random;
		this.stars = Array.from({ length: 70 }, () => ({ a: random() * 7, r: 20 + random() * 44, s: 0.3 + random() }));
		this.background = this.makeBackground();
	}

	private makeBackground(): HTMLCanvasElement | null {
		if (typeof document === "undefined") return null;
		const { width: W, height: H } = this.scene.space;
		const bg = document.createElement("canvas");
		bg.width = W;
		bg.height = H;
		const g = bg.getContext("2d");
		if (g === null) return null;
		g.fillStyle = INK.board;
		g.fillRect(0, 0, W, H);
		g.strokeStyle = "rgba(120,150,180,.04)";
		for (let x = 0; x < W; x += 24) {
			g.beginPath();
			g.moveTo(x + 0.5, 0);
			g.lineTo(x + 0.5, H);
			g.stroke();
		}
		for (let y = 0; y < H; y += 24) {
			g.beginPath();
			g.moveTo(0, y + 0.5);
			g.lineTo(W, y + 0.5);
			g.stroke();
		}
		const rnd = seeded(7);
		g.strokeStyle = "rgba(122,90,60,.12)";
		for (let i = 0; i < 60; i++) {
			let x = Math.round((rnd() * W) / 12) * 12;
			let y = Math.round((rnd() * H) / 12) * 12;
			g.beginPath();
			g.moveTo(x, y);
			for (let j = 0; j < 3; j++) {
				if (rnd() > 0.5) x += (rnd() - 0.5) * 220;
				else y += (rnd() - 0.5) * 160;
				x = Math.round(x / 12) * 12;
				y = Math.round(y / 12) * 12;
				g.lineTo(x, y);
			}
			g.stroke();
		}
		return bg;
	}

	/** A module glows a while after a packet: its level now (0 to 1). */
	private glowOf(place: PlaceId): number {
		const at = this.touched.get(place);
		const t = this.input?.t ?? 0;
		return at === undefined ? 0 : Math.max(0, 1 - (t - at) / GLOW_MS);
	}

	/** Something on the scene still moves by itself (a glow fading, sparks flying, the wave settling). */
	get animating(): boolean {
		for (const id of PLACE_IDS) if (this.glowOf(id) > 0) return true;
		return this.sparks.length > 0 || this.waveRate > 0.5;
	}

	/** Paints the scene in scene pixels (the caller set the camera's transform). */
	paint(ctx: CanvasRenderingContext2D, input: PaintInput): void {
		this.ctx = ctx;
		this.input = input;
		for (const m of input.moves) {
			const place = m.active.move.place;
			const before = this.touched.get(place);
			if (before === undefined || m.active.start > before) this.touched.set(place, m.active.start);
		}
		const target = input.look.mode === "think" && input.thinking ? (input.look.tokensPerSecond ?? 0) : 0;
		this.waveRate = target >= this.waveRate ? target : Math.max(target, this.waveRate - input.dt * 0.03);
		if (this.background !== null) ctx.drawImage(this.background, 0, 0, this.scene.space.width, this.scene.space.height);
		else {
			ctx.fillStyle = INK.board;
			ctx.fillRect(0, 0, this.scene.space.width, this.scene.space.height);
		}
		this.drawTraces();
		// The token wave is a background module of the design: dim, dimmer still while the AI works elsewhere.
		this.c.globalAlpha = TIER[3].alpha * 0.75 * (input.look.mode === "idle" || !input.look.dimOthers ? 1 : 0.45);
		this.drawWave();
		this.c.globalAlpha = 1;
		this.withAlpha("monitoring", () => this.drawReservoir());
		this.withAlpha("files", () => this.drawFiles());
		this.withAlpha("sandbox", () => this.drawTerminal());
		this.withAlpha("testing", () => this.drawTesting());
		this.withAlpha("mcp", () => this.drawMcp());
		this.withAlpha("external", () => this.drawPortal());
		this.withAlpha("git", () => this.drawGit());
		this.drawSmall();
		this.drawModel();
		this.drawPackets();
	}

	private get c(): CanvasRenderingContext2D {
		if (this.ctx === null) throw new Error("interior painter: no context");
		return this.ctx;
	}

	private get i(): PaintInput {
		if (this.input === null) throw new Error("interior painter: no input");
		return this.input;
	}

	/** A module's board (its last calls, the model's turn), kept for the state and a quarter second. */
	private board(place: PlaceId): DistrictBoard {
		const { state, wall } = this.i;
		const bucket = Math.floor(wall / BOARD_TICK_MS);
		if (this.boardsOf.state !== state || this.boardsOf.bucket !== bucket) {
			this.boards = new Map();
			this.boardsOf = { state, bucket };
		}
		let board = this.boards.get(place);
		if (board === undefined) {
			board = districtBoardOf(state, place, wall);
			this.boards.set(place, board);
		}
		return board;
	}

	private presence(place: PlaceId): number {
		const { look, selected, contentZone } = this.i;
		if (selected === place || contentZone === place) return 1;
		const p = look.places[place];
		const tierAlpha = TIER[this.scene.places[place].tier].alpha;
		// A module touched a moment ago stays bright while it glows.
		return this.glowOf(place) >= 0.3 ? Math.max(p.presence, tierAlpha) : p.presence;
	}

	private withAlpha(place: PlaceId, draw: () => void): void {
		this.c.globalAlpha = this.presence(place);
		draw();
		this.c.globalAlpha = 1;
	}

	private running(place: PlaceId): number {
		return this.i.look.roads.find((r) => r.place === place)?.running.length ?? 0;
	}

	private calls(place: PlaceId): number {
		return this.i.look.roads.find((r) => r.place === place)?.calls ?? 0;
	}

	private rr(x: number, y: number, w: number, h: number, r: number): void {
		const c = this.c;
		c.beginPath();
		c.roundRect(x, y, w, h, r);
	}

	private poly(p: readonly Point[]): void {
		const c = this.c;
		c.beginPath();
		p.forEach(([x, y], k) => (k === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
	}

	private dashedFrame(r: Rect): void {
		const c = this.c;
		c.setLineDash([4, 4]);
		this.rr(r.x - 6, r.y - 6, r.w + 12, r.h + 12, 9);
		c.strokeStyle = rgba(INK.fg, 0.6);
		c.stroke();
		c.setLineDash([]);
	}

	/** Where a subagent circles the model now. */
	private subPos(slot: number): Point {
		const [cx, cy] = this.scene.core.centre;
		const [rx, ry] = this.scene.core.orbit;
		const a = this.i.t / 2600 + slot * 2.1;
		return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
	}

	/** A module's box with its tag and sub line; returns its glow. */
	private box(place: PlaceId, col: string, withCalls = true, opts: { iconW?: number; noSub?: boolean } = {}): number {
		const c = this.c;
		const { look, selected, copy, wall } = this.i;
		const p = this.scene.places[place];
		const r = p.rect;
		const t = TIER[p.tier];
		const pl = look.places[place];
		const focus = pl.involved || selected === place;
		const alarm = pl.bottleneck;
		const runs = this.running(place) > 0;
		const waiting = place === "security" && look.mode === "wait";
		const g = Math.max(this.glowOf(place), runs ? 0.55 + 0.3 * Math.sin(wall / 180) : 0, waiting ? 0.6 + 0.4 * Math.sin(wall / 150) : 0);
		if (g > 0) {
			c.save();
			c.shadowColor = col;
			c.shadowBlur = 26 * g;
			this.rr(r.x, r.y, r.w, r.h, 6);
			c.fillStyle = INK.boxGlow;
			c.fill();
			c.restore();
		}
		this.rr(r.x, r.y, r.w, r.h, 6);
		c.fillStyle = INK.box;
		c.fill();
		c.lineWidth = alarm !== "none" ? 2 : focus ? t.line + 0.6 : t.line;
		c.strokeStyle = alarm !== "none" ? (alarm === "alert" ? INK.err : INK.warn) : focus || g > 0.1 ? rgba(col, 0.5 + 0.5 * g) : INK.edge;
		c.stroke();
		c.lineWidth = 1;
		cornerTicks(c, r, col, 0.4 + 0.4 * g);
		if (selected === place) this.dashedFrame(r);
		c.textBaseline = "top";
		c.textAlign = "left";
		// The text keeps clear of a mark drawn at the right of the box.
		const room = r.w - 20 - (opts.iconW ?? 0);
		c.font = `600 ${t.font * this.ts}px ${MONO}`;
		c.fillStyle = INK.fg;
		c.fillText(clip(copy.tags[place], room, t.font * this.ts), r.x + 10, r.y + 8);
		if (opts.noSub === true) return g;
		c.font = `400 ${t.sub * this.ts}px ${MONO}`;
		c.fillStyle = INK.muted;
		const n = this.calls(place);
		c.fillText(clip(n > 0 && withCalls ? `${copy.subs[place]} · ${copy.calls(n)}` : copy.subs[place], room, t.sub * this.ts), r.x + 10, r.y + 10 + t.font * this.ts + 2);
		return g;
	}

	private rowText(r: BoardRow): string {
		const { copy, hide } = this.i;
		const agent = r.agent === null ? "" : `${r.agent === "" ? copy.subagentShort : r.agent}›`;
		return `${r.running ? "▶ " : ""}${agent}${callLabel(r.tool, r.mcpServer, r.target, hide, copy.mcpTool)}`;
	}

	/** A module's live content: its last calls, newest first, the running ones marked. */
	private listRows(place: PlaceId, x: number, y: number, w: number, rows: number, size = 10.5): void {
		const c = this.c;
		const { copy, duration } = this.i;
		const board = this.board(place);
		const items = board.kind === "calls" ? board.rows.slice(0, rows) : [];
		const col = PLACE_COLOR[place];
		c.font = `400 ${size * this.ts}px ${MONO}`;
		c.textBaseline = "top";
		c.textAlign = "left";
		items.forEach((r, k) => {
			const yy = y + k * (size * this.ts + 4);
			const failed = r.ok === false;
			const right = failed ? `✗ ${duration(r.runtimeMs)}` : duration(r.runtimeMs);
			c.fillStyle = r.running ? col : failed ? INK.err : INK.fg;
			c.fillText(clip(this.rowText(r), w - 48, size), x, yy);
			c.textAlign = "right";
			c.fillStyle = r.running ? col : failed ? INK.err : INK.muted;
			c.fillText(right, x + w, yy);
			c.textAlign = "left";
		});
		if (items.length === 0) {
			c.fillStyle = INK.muted;
			c.fillText(copy.noCalls, x, y);
		}
	}

	private drawTraces(): void {
		const c = this.c;
		const { look, wall, motion, copy, duration } = this.i;
		const [cx, cy] = this.scene.core.centre;
		for (const road of look.roads) {
			const r = road.path;
			const col = PLACE_COLOR[road.place];
			// The input port's and the lock's traces count prompts and permission asks, not calls: as in the design, they carry no figures.
			const n = road.place === "user-desk" || road.place === "security" ? 0 : road.calls;
			const run = road.running;
			const hot = run.length > 0 || road.waiting || this.glowOf(road.place) > 0;
			const dim = look.dimOthers && look.mode !== "idle" && !look.places[road.place].involved && !hot;
			const w = 1.2 + Math.min(7, Math.log2(1 + n) * 1.7);
			this.poly(r);
			c.lineCap = "round";
			c.lineJoin = "round";
			if (n === 0 && !hot) {
				c.setLineDash([3, 5]);
				c.strokeStyle = rgba(INK.copper, 0.5);
				c.lineWidth = 1;
				c.stroke();
				c.setLineDash([]);
			} else {
				c.strokeStyle = rgba(col, (dim ? 0.14 : 0.3) + (hot ? 0.2 : 0));
				c.lineWidth = w;
				c.stroke();
			}
			if (road.failures > 0 && n > 0) {
				this.poly(subPath(r, road.failures / n));
				c.strokeStyle = rgba(INK.err, 0.8);
				c.lineWidth = 2;
				c.stroke();
			}
			// Running: dashes flow from the caller to the module (no made-up progress); amber once past the session's p95.
			for (const job of run) {
				const over = job.overAt !== null && wall > job.overAt;
				const drone = job.agentId === "" ? undefined : look.drones.find((d) => d.agentId === job.agentId);
				const from: Point = drone === undefined ? [cx, cy] : this.subPos(drone.slot);
				this.poly([from, ...r]);
				c.setLineDash([10, 8]);
				c.lineDashOffset = motion ? -wall / 18 : 0;
				c.strokeStyle = over ? INK.warn : drone !== undefined ? PLACE_COLOR.orchestrator : col;
				c.lineWidth = 3.2;
				c.stroke();
				c.setLineDash([]);
			}
			if (road.waiting) {
				this.poly(r);
				c.setLineDash([10, 8]);
				c.lineDashOffset = motion ? -wall / 18 : 0;
				c.strokeStyle = INK.warn;
				c.lineWidth = 3.2;
				c.stroke();
				c.setLineDash([]);
			}
			if (road.bottleneck !== "none") {
				this.poly(r);
				c.setLineDash([5, 6]);
				c.lineDashOffset = motion ? -wall / 40 : 0;
				c.strokeStyle = rgba(road.bottleneck === "alert" ? INK.err : INK.warn, 0.55 + 0.35 * Math.sin(wall / 200));
				c.lineWidth = 2.5;
				c.stroke();
				c.setLineDash([]);
			}
			c.lineWidth = 1;
			c.lineCap = "butt";
			// The label: the runtime while a call runs, else the calls, the p95 and the failures; each value says what it is.
			const first = run[0];
			const spot = this.scene.places[road.place].label;
			if (spot !== null && (n > 0 || first !== undefined)) {
				const parts = [copy.calls(n)];
				if (road.p95Ms !== null) parts.push(copy.p95(duration(road.p95Ms)));
				if (road.failures > 0) parts.push(copy.failures(road.failures));
				const txt = first !== undefined ? copy.runtime(duration(Math.max(0, wall - first.startedAt))) : parts.join(" · ");
				c.font = `500 ${10.5 * this.ts}px ${MONO}`;
				const tw = c.measureText(txt).width;
				// Each trace writes at its own spot (scene-table.ts), clear of the others.
				const x = spot.align === "left" ? spot.at[0] : spot.align === "center" ? spot.at[0] - tw / 2 : spot.at[0] - tw;
				const y = spot.at[1];
				c.globalAlpha = dim ? 0.5 : 1;
				c.fillStyle = "rgba(12,18,26,.88)";
				c.fillRect(x - 4, y - 2, tw + 8, 15 * this.ts);
				c.fillStyle = first === undefined && road.failures > 0 ? INK.err : col;
				c.textBaseline = "top";
				c.textAlign = "left";
				c.fillText(txt, x, y);
				c.globalAlpha = 1;
			}
		}
	}

	private drawPackets(): void {
		const c = this.c;
		for (const m of this.i.moves) {
			const move = m.active.move;
			const col = toneColour(move.tone, PLACE_COLOR[move.place]);
			const e = m.t < 0.5 ? 2 * m.t * m.t : 1 - (-2 * m.t + 2) ** 2 / 2;
			if (move.path.length >= 2 && (move.kind === "packet-out" || move.kind === "packet-back")) {
				for (let k = 0; k < 6; k++) {
					const [x, y] = pathPoint(move.path, Math.max(0, e - k * 0.025));
					c.beginPath();
					c.arc(x, y, k === 0 ? 4 : 3.2 - k * 0.45, 0, 7);
					c.fillStyle = rgba(col, k === 0 ? 1 : 0.55 - k * 0.08);
					c.fill();
				}
				continue;
			}
			// A pulse, an alarm or a batch stays at its place: a ring that widens and fades.
			const [x, y] = move.path[0] ?? this.scene.core.centre;
			c.beginPath();
			c.arc(x, y, 10 + e * 38, 0, 7);
			c.strokeStyle = rgba(col, 1 - m.t);
			c.lineWidth = move.kind === "alarm" ? 2.5 : 1.6;
			c.stroke();
			c.lineWidth = 1;
			if (move.kind === "batch") {
				c.font = `600 ${12 * this.ts}px ${MONO}`;
				c.fillStyle = col;
				c.textAlign = "center";
				c.textBaseline = "middle";
				c.fillText(`×${m.active.count}`, x, y);
				c.textAlign = "left";
			}
		}
	}

	private drawModel(): void {
		const c = this.c;
		const { look, state, t, dt, motion, thinking, selected, copy } = this.i;
		const [cx, cy] = this.scene.core.centre;
		// The design's lattice is drawn for a radius of 120; a larger model scales it.
		const k = this.scene.core.radius / 120;
		const think = look.mode === "think" && thinking;
		const exec = look.mode === "exec";
		const waiting = look.mode === "wait";
		const base = waiting ? INK.warn : PLACE_COLOR.core;
		const energy = think ? 1 : exec ? 0.25 : waiting ? 0.35 : 0.12;
		const rot = t / (think ? 5000 : 14000);
		const grd = c.createRadialGradient(cx, cy, 8, cx, cy, 140 * k);
		grd.addColorStop(0, rgba(base, 0.1 + 0.3 * energy));
		grd.addColorStop(1, rgba(base, 0));
		c.fillStyle = grd;
		c.beginPath();
		c.arc(cx, cy, 140 * k, 0, 7);
		c.fill();
		for (const r of [34 * k, 62 * k, 88 * k, 112 * k]) {
			c.beginPath();
			c.arc(cx, cy, r, 0, 7);
			c.strokeStyle = rgba(base, 0.06 + 0.1 * energy);
			c.stroke();
		}
		const pos = (n: Node): Point => {
			const a = n.a + rot * (n.ring % 2 === 1 ? 1 : -1);
			return [cx + Math.cos(a) * n.r * k, cy + Math.sin(a) * n.r * k];
		};
		const nodeAt = (k: number): Point => pos(NODES[k] ?? { r: 0, a: 0, ring: 0 });
		for (const [a, b] of EDGES) {
			const [x1, y1] = nodeAt(a);
			const [x2, y2] = nodeAt(b);
			c.beginPath();
			c.moveTo(x1, y1);
			c.lineTo(x2, y2);
			c.strokeStyle = rgba(base, 0.06 + 0.14 * energy);
			c.stroke();
		}
		if (motion && think) {
			const tps = look.tokensPerSecond ?? 0;
			const n = dt * (0.02 + tps / 4000);
			for (let k = 0; k < n || this.random() < n - k; k++) this.spark(false);
		}
		const compacting = state.live?.core === "compacting" || state.scene.core === "compacting";
		if (!compacting) this.compactSince = null;
		else this.compactSince ??= t;
		if (motion && this.compactSince !== null && t - this.compactSince < COMPACT_SPARK_MS) for (let k = 0; k < 3; k++) this.spark(true);
		const kept: Spark[] = [];
		for (const s of this.sparks) {
			s.t += dt / 420;
			if (s.t >= 1) continue;
			kept.push(s);
			const [i, j] = s.back ? [s.edge[1], s.edge[0]] : s.edge;
			const [x1, y1] = nodeAt(i);
			const [x2, y2] = nodeAt(j);
			const tl = Math.max(0, s.t - 0.3);
			c.beginPath();
			c.moveTo(x1 + (x2 - x1) * tl, y1 + (y2 - y1) * tl);
			c.lineTo(x1 + (x2 - x1) * s.t, y1 + (y2 - y1) * s.t);
			c.strokeStyle = rgba(INK.think, 0.95);
			c.lineWidth = 1.8;
			c.stroke();
			c.lineWidth = 1;
		}
		this.sparks = motion ? kept : [];
		NODES.forEach((n, k) => {
			const [x, y] = pos(n);
			const lit = think ? 0.45 + 0.55 * Math.abs(Math.sin(t / (180 + k * 23) + k)) : 0.2 + 0.25 * energy;
			c.beginPath();
			c.arc(x, y, k === 0 ? 11 : n.ring === 1 ? 4 : 3, 0, 7);
			c.fillStyle = rgba(base, lit);
			c.fill();
		});
		c.save();
		c.shadowColor = base;
		c.shadowBlur = 12 + 30 * energy;
		c.beginPath();
		c.arc(cx, cy, 8, 0, 7);
		c.fillStyle = "#fff";
		c.fill();
		c.restore();
		if (selected === "core" || selected === "orchestrator") {
			c.setLineDash([4, 4]);
			c.beginPath();
			c.arc(cx, cy, 120 * k, 0, 7);
			c.strokeStyle = rgba(INK.fg, 0.6);
			c.stroke();
			c.setLineDash([]);
		}
		const sub = PLACE_COLOR.orchestrator;
		for (const d of look.drones) {
			const [sx, sy] = this.subPos(d.slot);
			c.beginPath();
			c.moveTo(cx, cy);
			c.lineTo(sx, sy);
			c.setLineDash([3, 5]);
			c.lineDashOffset = motion ? -t / 30 : 0;
			c.strokeStyle = rgba(sub, 0.6);
			c.stroke();
			c.setLineDash([]);
			for (let q = 0; q < 6; q++) {
				const aa = (q / 6) * Math.PI * 2 - t / 700;
				c.beginPath();
				c.arc(sx + Math.cos(aa) * 14, sy + Math.sin(aa) * 14, 2.4, 0, 7);
				c.fillStyle = rgba(sub, 0.5 + 0.5 * Math.abs(Math.sin(t / 150 + q)));
				c.fill();
			}
			c.beginPath();
			c.arc(sx, sy, 5, 0, 7);
			c.fillStyle = sub;
			c.fill();
			c.font = `400 ${11 * this.ts}px ${MONO}`;
			c.fillStyle = sub;
			c.textBaseline = "top";
			c.textAlign = "left";
			c.fillText(copy.subagent(d.agentType === "" ? copy.subagentShort : d.agentType), sx + 18, sy - 6);
		}
		const model = state.live?.mainModel || state.scene.model;
		c.textAlign = "center";
		c.textBaseline = "top";
		c.font = `600 ${14 * this.ts}px ${MONO}`;
		c.fillStyle = INK.fg;
		c.fillText(copy.modelTitle(model), cx, cy + 124 * k);
		c.font = `600 ${12 * this.ts}px ${MONO}`;
		c.fillStyle = think ? INK.think : waiting ? INK.warn : INK.muted;
		c.fillText(think ? copy.thinking : waiting ? copy.waiting : exec ? copy.executing : copy.idle, cx, cy + 124 * k + 18);
		c.textAlign = "left";
	}

	private spark(back: boolean): void {
		const edge = EDGES[Math.floor(this.random() * EDGES.length)];
		if (edge !== undefined) this.sparks.push({ edge, t: 0, back: back || this.random() < 0.5 });
	}

	/** The context reservoir: four columns that fill with the context used. */
	private drawReservoir(): void {
		const c = this.c;
		const { look, selected, copy } = this.i;
		const p = this.scene.places.monitoring.rect;
		const percent = look.contextPercent;
		const fillRatio = clamp01((percent ?? 0) / 100);
		const n = 4;
		const w = 18;
		const gap = (p.w - n * w) / (n - 1);
		const fill = fillRatio * n;
		const col = fillRatio > 0.8 ? INK.warn : PLACE_COLOR.monitoring;
		const think = look.mode === "think";
		for (let k = 0; k < n; k++) {
			const x = p.x + k * (w + gap);
			c.fillStyle = INK.box;
			c.fillRect(x, p.y, w, p.h);
			const f = clamp01(fill - k);
			for (let q = 0; q < 10; q++) {
				const yy = p.y + p.h - (q + 1) * (p.h / 10) + 3;
				const lit = (q + 1) / 10 <= f + 1e-6;
				c.fillStyle = lit ? rgba(col, 0.35 + (think ? 0.3 * Math.abs(Math.sin(this.i.t / 300 + q + k)) : 0.15)) : "rgba(70,82,98,.3)";
				c.fillRect(x + 2, yy, w - 4, p.h / 10 - 6);
			}
		}
		if (selected === "monitoring") {
			c.setLineDash([4, 4]);
			c.strokeStyle = rgba(INK.fg, 0.6);
			c.strokeRect(p.x - 6, p.y - 6, p.w + 12, p.h + 12);
			c.setLineDash([]);
		}
		c.font = `600 ${13 * this.ts}px ${MONO}`;
		c.fillStyle = INK.fg;
		c.textBaseline = "top";
		c.textAlign = "left";
		c.fillText(copy.tags.monitoring, p.x, p.y + p.h + 10);
	}

	/** The token wave: its height and frequency follow the model's output rate. */
	private drawWave(): void {
		const c = this.c;
		const { dt, motion } = this.i;
		const p = this.scene.wave;
		const amp = Math.min(1, this.waveRate / 140);
		if (motion) this.wavePhase += dt * (this.waveRate / 130) * 0.012;
		this.rr(p.x, p.y, p.w, p.h, 4);
		c.fillStyle = "#0e141c";
		c.fill();
		c.strokeStyle = INK.edge;
		c.stroke();
		c.beginPath();
		for (let k = 0; k <= p.w - 12; k += 2) {
			const u = k / (p.w - 12);
			const v = Math.sin(u * (6 + 14 * amp) * Math.PI - this.wavePhase * 6) * Math.sin(u * Math.PI) * (p.h / 2 - 10) * (0.06 + 0.94 * amp);
			if (k === 0) c.moveTo(p.x + 6 + k, p.y + p.h / 2 + v);
			else c.lineTo(p.x + 6 + k, p.y + p.h / 2 + v);
		}
		c.strokeStyle = rgba(INK.think, 0.3 + 0.65 * amp);
		c.lineWidth = 1.5;
		c.stroke();
		c.lineWidth = 1;
	}

	/** The internet: a space portal whose stars fall in faster while a fetch runs. */
	private drawPortal(): void {
		const c = this.c;
		const { look, dt, motion, selected, contentZone, copy, hide } = this.i;
		const p = this.scene.places.external.rect;
		const cx = p.x + p.w / 2 + 6;
		const cy = p.y + p.h / 2 - 4;
		const col = PLACE_COLOR.external;
		const act = look.places.external.active;
		const g = Math.max(this.glowOf("external"), act ? 0.8 : 0);
		const grd = c.createRadialGradient(cx, cy, 2, cx, cy, 60);
		grd.addColorStop(0, "#000");
		grd.addColorStop(0.55, rgba(col, 0.06 + 0.22 * g));
		grd.addColorStop(1, rgba(col, 0));
		c.fillStyle = grd;
		c.beginPath();
		c.arc(cx, cy, 60, 0, 7);
		c.fill();
		const sp = motion ? dt / 16 : 0;
		for (const st of this.stars) {
			st.r -= (act ? 1.4 : 0.12) * st.s * sp;
			st.a += (act ? 0.05 : 0.006) * st.s * sp;
			if (st.r < 6) {
				st.r = 64;
				st.a = this.random() * 7;
			}
			c.fillStyle = rgba("#ffffff", Math.min(1, st.r / 64) * (0.25 + 0.6 * g));
			c.fillRect(cx + Math.cos(st.a) * st.r, cy + Math.sin(st.a) * st.r * 0.82, 1.6, 1.6);
		}
		for (let k = 0; k < 4; k++) {
			c.save();
			c.translate(cx, cy);
			c.rotate((this.i.t / (act ? 450 : 4000)) * (k % 2 === 1 ? 1 : -1) + k);
			c.beginPath();
			c.ellipse(0, 0, 22 + k * 10, 18 + k * 8, 0, 0, Math.PI * (1.2 + k * 0.15));
			c.strokeStyle = rgba(col, Math.max(0.12, 0.3 + 0.55 * g - k * 0.06));
			c.lineWidth = 2 - k * 0.3;
			c.stroke();
			c.restore();
		}
		c.lineWidth = 1;
		if (selected === "external") {
			c.setLineDash([4, 4]);
			c.beginPath();
			c.arc(cx, cy, 64, 0, 7);
			c.strokeStyle = rgba(INK.fg, 0.6);
			c.stroke();
			c.setLineDash([]);
		}
		c.textAlign = "center";
		c.textBaseline = "top";
		c.font = `600 ${12 * this.ts}px ${MONO}`;
		c.fillStyle = INK.fg;
		c.fillText(copy.portal, cx, p.y + p.h + 4);
		c.textAlign = "left";
		if (contentZone === "external") {
			c.fillStyle = "rgba(12,18,26,.9)";
			c.fillRect(p.x - 270, p.y + 4, 252, 52);
			this.listRows("external", p.x - 264, p.y + 10, 240, 3);
			return;
		}
		const board = this.board("external");
		const live = board.kind === "calls" ? board.rows.find((r) => r.running) : undefined;
		const n = this.calls("external");
		c.textAlign = "center";
		c.font = `400 ${11 * this.ts}px ${MONO}`;
		c.fillStyle = col;
		c.fillText(live !== undefined ? `▶ ${hide || live.target === "" ? live.tool : live.target}` : n > 0 ? copy.calls(n) : "", cx, p.y + p.h + 4 + 16 * this.ts);
		c.textAlign = "left";
	}

	/** The MCP gate: one slot per server the session used, the one running lit; in focus, each server's last tool. */
	private drawMcp(): void {
		const c = this.c;
		const { state, wall, copy, hide, duration, motion } = this.i;
		const p = this.scene.places.mcp.rect;
		this.box("mcp", PLACE_COLOR.mcp);
		const servers = Object.values(state.scene.mcp);
		const top = p.y + 10 + 34 * this.ts;
		const fits = Math.floor((p.y + p.h - 6 - top + MCP_ROW_GAP) / (MCP_ROW_H + MCP_ROW_GAP));
		const shown = servers.length > fits ? servers.slice(0, Math.max(0, fits - 1)) : servers;
		const board = this.board("mcp");
		shown.forEach((s, k) => {
			const last = board.kind === "calls" ? board.rows.find((r) => r.mcpServer === s.server) : undefined;
			const prefix = `mcp__${s.server}__`;
			const tool = last === undefined ? "" : hide ? copy.mcpTool : last.tool.startsWith(prefix) ? last.tool.slice(prefix.length) : last.tool;
			paintMcpPort(
				c,
				p.x + 10,
				top + k * (MCP_ROW_H + MCP_ROW_GAP),
				p.w - 20,
				{ name: hide ? copy.mcpServer(k + 1) : s.server, on: s.running > 0, used: s.calls > 0 || s.running > 0, last: last === undefined ? null : { tool: clip(tool, 110, 11), runtime: duration(last.runtimeMs) } },
				PLACE_COLOR.mcp,
				wall,
				motion,
				this.ts,
			);
		});
		c.textBaseline = "middle";
		c.textAlign = "left";
		c.font = `400 ${11 * this.ts}px ${MONO}`;
		c.fillStyle = INK.muted;
		if (servers.length === 0) c.fillText(copy.noMcp, p.x + 18, top + 12);
		else if (servers.length > shown.length) c.fillText(copy.moreServers(servers.length - shown.length), p.x + 18, top + shown.length * (MCP_ROW_H + MCP_ROW_GAP) + 12);
		c.textBaseline = "top";
	}

	/** Files: a matrix of cells; the sub line is also the colour key (read, edit, search). */
	private drawFiles(): void {
		const c = this.c;
		const { contentZone, wall, hide, copy, motion } = this.i;
		const p = this.scene.places.files.rect;
		const run = this.running("files") > 0;
		this.box("files", PLACE_COLOR.files, false, { noSub: true });
		if (contentZone === "files") {
			this.listRows("files", p.x + 10, p.y + 10 + 30 * this.ts, p.w - 20, 4);
			return;
		}
		const rows = this.board("files");
		const calls = rows.kind === "calls" ? rows.rows : [];
		const touches: FileTouch[] = calls.map((r, k) => ({ key: hide || r.target === "" ? r.eventId : r.target, tool: r.tool, strength: r.running ? 0.7 + 0.3 * Math.sin(wall / 90) : 0.85 - k * 0.12 }));
		paintFileMatrix(c, p, PLACE_COLOR.files, touches, run, calls.some((r) => r.running && (r.tool === "Grep" || r.tool === "Glob")), wall, motion);
		// The sub line's words wear the colours of what they mean: read, edit, search.
		c.font = `400 ${TIER[1].sub * this.ts}px ${MONO}`;
		c.textBaseline = "top";
		c.textAlign = "left";
		let x = p.x + 10;
		const y = p.y + 10 + TIER[1].font * this.ts + 2;
		const palette = [PLACE_COLOR.files, EDIT_COLOUR, INK.muted];
		copy.subs.files.split(" · ").forEach((word, i) => {
			if (i > 0) {
				c.fillStyle = INK.muted;
				c.fillText(" · ", x, y);
				x += c.measureText(" · ").width;
			}
			c.fillStyle = palette[i] ?? INK.muted;
			c.fillText(word, x, y);
			x += c.measureText(word).width;
		});
	}

	/** Terminal: a shell window with the latest commands (and how each ended), the running one marked. */
	private drawTerminal(): void {
		const { contentZone, wall, copy, hide, duration } = this.i;
		const p = this.scene.places.sandbox.rect;
		const run = this.running("sandbox") > 0;
		this.box("sandbox", PLACE_COLOR.sandbox, false);
		const screen = { x: p.x + 8, y: p.y + 10 + 30 * this.ts, w: p.w - 16, h: p.y + p.h - 8 - (p.y + 10 + 30 * this.ts) };
		if (contentZone === "sandbox" || contentZone === "testing") {
			plate(this.c, screen, PLACE_COLOR.sandbox, run ? 1 : 0);
			this.listRows("sandbox", screen.x + 6, screen.y + 18, screen.w - 12, 4, 10);
			return;
		}
		const board = this.board("sandbox");
		const rows = board.kind === "calls" ? board.rows : [];
		const label = (r: BoardRow): string => `$ ${callLabel(r.tool, r.mcpServer, r.target, hide, copy.mcpTool)}`;
		const lines: ShellLine[] = [];
		for (const r of rows.filter((x) => !x.running).slice(0, 2).reverse()) {
			lines.push({ text: label(r), colour: INK.fg });
			lines.push(r.ok === false ? { text: `✗ ${duration(r.runtimeMs)}`, colour: INK.err } : { text: `✓ ${duration(r.runtimeMs)}`, colour: INK.muted });
		}
		for (const r of rows.filter((x) => x.running)) lines.push({ text: label(r), colour: PLACE_COLOR.sandbox });
		lines.push(run ? { text: "…", colour: INK.muted } : { text: "$ ", colour: PLACE_COLOR.sandbox });
		paintShell(this.c, screen, PLACE_COLOR.sandbox, lines, run, wall, this.ts);
	}

	/** Testing: a bed of cells showing the last run's outcome (green or red), a light travelling it while a run goes. */
	private drawTesting(): void {
		const c = this.c;
		const { contentZone, wall, copy } = this.i;
		const p = this.scene.places.testing.rect;
		const run = this.running("testing") > 0;
		this.box("testing", PLACE_COLOR.testing);
		if (contentZone === "testing") {
			this.listRows("testing", p.x + 10, p.y + 10 + 30 * this.ts, p.w - 20, 3, 10);
			return;
		}
		const board = this.board("testing");
		const last = board.kind === "calls" ? board.rows.find((r) => !r.running) : undefined;
		const state: TestState = run ? "running" : last === undefined ? "none" : last.ok === false ? "fail" : "pass";
		paintTestBed(c, p, PLACE_COLOR.testing, state, wall);
		c.font = `500 ${10 * this.ts}px ${MONO}`;
		c.textBaseline = "top";
		c.textAlign = "right";
		c.fillStyle = state === "fail" ? INK.err : state === "pass" ? INK.ok : INK.muted;
		c.fillText(copy.tests[state === "running" ? "running" : state === "fail" ? "failed" : state === "pass" ? "passed" : "none"], p.x + p.w - 12, p.y + p.h - 20);
		c.textAlign = "left";
	}

	/** Git · CI/CD: the commit graph on the left, the release pipeline (commit, push, CI, deploy, prod) on the right. */
	private drawGit(): void {
		const c = this.c;
		const { look, wall, motion, contentZone, copy, duration, hide } = this.i;
		const p = this.scene.places.git.rect;
		this.box("git", PLACE_COLOR.git, true, { noSub: false });
		paintCommitGraph(c, p, PLACE_COLOR.git, look.commits, this.running("git") > 0, wall, motion, { main: "main", head: "HEAD" }, this.ts);
		const pipe = look.pipeline;
		const { h, w: cw, gap } = PIPELINE_CELL;
		const { x: x0, y } = pipelineCell(p, 0);
		const colourOf = (s: StepStatus): string => (s === "ok" ? INK.ok : s === "err" ? INK.err : s === "run" ? PLACE_COLOR.git : s === "unknown" || s === "cancelled" ? INK.muted : INK.edge);
		STAGES.forEach((k, idx) => {
			const x = x0 + idx * (cw + gap);
			const st = pipe.steps[k];
			const col = colourOf(st.status);
			// A release that ran without following CI (deploy does not wait for it): not a failure, not pending.
			const untracked = k === "ci" && st.status === "idle" && pipe.steps.push.status !== "idle";
			const started = st.startedAt ?? wall;
			if (idx > 0) {
				const before = pipe.steps[STAGES[idx - 1] ?? "commit"];
				const lx = x - gap;
				c.strokeStyle = before.status === "ok" ? rgba(INK.ok, 0.6) : INK.edge;
				c.beginPath();
				c.moveTo(lx, y + h / 2);
				c.lineTo(x, y + h / 2);
				c.stroke();
				if (st.status === "run" && motion) {
					const f = ((wall - started) % 700) / 700;
					c.beginPath();
					c.arc(lx + f * gap, y + h / 2, 2.5, 0, 7);
					c.fillStyle = PLACE_COLOR.git;
					c.fill();
				}
			}
			this.rr(x, y, cw, h, 5);
			c.fillStyle = st.status === "run" ? rgba(PLACE_COLOR.git, 0.14 + 0.1 * Math.sin(wall / 160)) : "#151c26";
			c.fill();
			c.strokeStyle = col;
			c.lineWidth = st.status === "idle" ? 1 : 1.6;
			if (untracked) c.setLineDash([3, 3]);
			c.stroke();
			c.setLineDash([]);
			c.lineWidth = 1;
			if (st.status === "run") {
				// No percent is known: an indeterminate sweep.
				const f = ((wall - started) / 1100) % 1;
				c.fillStyle = PLACE_COLOR.git;
				c.fillRect(x + 4 + (cw - 32) * f, y + h - 5, 24, 2);
			}
			c.textAlign = "center";
			c.textBaseline = "top";
			c.font = `600 ${11 * this.ts}px ${MONO}`;
			c.fillStyle = st.status === "idle" ? INK.muted : INK.fg;
			c.fillText(copy.steps[k], x + cw / 2, y + 6);
			c.font = `400 ${10 * this.ts}px ${MONO}`;
			c.fillStyle = col;
			const value =
				st.status === "run" ? duration(Math.max(0, wall - started)) : st.status === "ok" ? `✓ ${duration(st.durationMs ?? 0)}` : st.status === "err" ? copy.stepFailed : st.status === "unknown" ? copy.stepUnknown : st.status === "cancelled" ? copy.stepCancelled : untracked ? copy.stepUntracked : "–";
			c.fillText(value, x + cw / 2, y + 21);
			c.textAlign = "left";
		});
		const dx = x0 + 4 * (cw + gap) - 4;
		const deploy = pipe.steps.deploy;
		const ok = pipe.prod && deploy.status === "ok";
		const doneAt = (deploy.startedAt ?? 0) + (deploy.durationMs ?? 0);
		const live = ok && motion ? Math.max(0, 1 - (wall - doneAt) / PROD_RING_MS) : 0;
		const my = y + h / 2;
		c.strokeStyle = ok ? rgba(INK.ok, 0.6) : INK.edge;
		c.beginPath();
		c.moveTo(dx - gap + 4, my);
		c.lineTo(dx + 3, my);
		c.stroke();
		c.beginPath();
		c.arc(dx + 10, my, 7, 0, 7);
		c.fillStyle = ok ? INK.ok : "#1d2632";
		c.fill();
		if (live > 0) {
			c.beginPath();
			c.arc(dx + 10, my, 7 + (1 - live) * 22, 0, 7);
			c.strokeStyle = rgba(INK.ok, live);
			c.stroke();
		}
		c.font = `400 ${10 * this.ts}px ${MONO}`;
		c.fillStyle = INK.muted;
		c.textBaseline = "top";
		c.fillText(copy.prod, dx, y + h + 3);
		if (contentZone === "git") {
			const board = this.board("git");
			const r = board.kind === "calls" ? board.rows[0] : undefined;
			if (r !== undefined) {
				c.font = `400 ${10.5 * this.ts}px ${MONO}`;
				c.fillStyle = INK.fg;
				c.fillText(clip(hide || r.target === "" ? r.tool : `${r.tool} ${r.target}`, p.w - 260, 10.5), p.x + 250, p.y + 10);
			}
		}
	}

	/** Memory, skills, the input port and the permission lock: small modules at the edges, each with a mark that lights when used. */
	private drawSmall(): void {
		const c = this.c;
		const { look, wall } = this.i;
		const markAt = (place: PlaceId): { x: number; y: number } => {
			const r = this.scene.places[place].rect;
			return { x: r.x + r.w - 48, y: r.y + (r.h - SMALL_MARK) / 2 };
		};
		this.withAlpha("memory", () => {
			this.box("memory", PLACE_COLOR.memory, false, { iconW: 50 });
			const m = markAt("memory");
			paintMemoryChip(c, m.x, m.y, SMALL_MARK, PLACE_COLOR.memory, this.glowOf("memory"));
		});
		this.withAlpha("skills", () => {
			this.box("skills", PLACE_COLOR.skills, false, { iconW: 50 });
			const m = markAt("skills");
			paintSkillBolt(c, m.x, m.y, SMALL_MARK, PLACE_COLOR.skills, this.glowOf("skills"));
		});
		this.withAlpha("user-desk", () => {
			this.box("user-desk", PLACE_COLOR["user-desk"], false);
			paintPromptPort(c, this.scene.places["user-desk"].rect, PLACE_COLOR["user-desk"], this.glowOf("user-desk"), wall, this.ts);
		});
		c.globalAlpha = this.presence("security");
		this.box("security", INK.warn, false, { iconW: 38 });
		const r = this.scene.places.security.rect;
		paintPermissionShield(c, r.x + r.w - 42, r.y + (r.h - 24 * SHIELD_SCALE) / 2, look.mode === "wait", wall, SHIELD_SCALE);
		c.globalAlpha = 1;
	}
}

function toneColour(tone: Tone, base: string): string {
	switch (tone) {
		case "success":
			return INK.ok;
		case "warn":
			return INK.warn;
		case "error":
			return INK.err;
		case "muted":
			return INK.muted;
		default:
			return base;
	}
}
