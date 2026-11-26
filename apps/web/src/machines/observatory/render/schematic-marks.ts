// The schematic drawings inside the Live Map's modules (interior-painter.ts
// calls them): a matrix of file cells, a shell window, a bed of test cells, a
// commit graph, service marks on connector ports, and the marks of the small
// modules (memory chip, skill bolt, prompt port, permission shield). Each one
// draws what it is from the data it is given and keeps nothing between frames.
import { INK, rgba } from "./ink.ts";
import type { Rect } from "./scene-table.ts";

const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
/** What an edited file lights in: distinct from the module's own colour (read). */
export const EDIT_COLOUR = "#ffd36e";

/** A stable number for a text: where a file lands in the matrix. */
export function hash(text: string): number {
	let h = 2166136261;
	for (const ch of text) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	c.beginPath();
	c.roundRect(x, y, w, h, r);
}

/** Four corner ticks, the frame of a technical drawing. */
export function cornerTicks(c: CanvasRenderingContext2D, r: Rect, colour: string, alpha: number, len = 9): void {
	c.strokeStyle = rgba(colour, alpha);
	c.lineWidth = 1.5;
	const corners: ReadonlyArray<readonly [number, number, number, number]> = [
		[r.x, r.y, 1, 1],
		[r.x + r.w, r.y, -1, 1],
		[r.x, r.y + r.h, 1, -1],
		[r.x + r.w, r.y + r.h, -1, -1],
	];
	for (const [x, y, sx, sy] of corners) {
		c.beginPath();
		c.moveTo(x + sx * len, y);
		c.lineTo(x, y);
		c.lineTo(x, y + sy * len);
		c.stroke();
	}
	c.lineWidth = 1;
}

/** A recessed plate (a screen, a bed of cells) with corner ticks; `lit` 0 to 1 brightens its edge. */
export function plate(c: CanvasRenderingContext2D, r: Rect, colour: string, lit: number): void {
	roundRect(c, r.x, r.y, r.w, r.h, 4);
	c.fillStyle = "#0a0f15";
	c.fill();
	c.strokeStyle = lit > 0 ? rgba(colour, 0.35 + 0.4 * lit) : "#222c3a";
	c.stroke();
	cornerTicks(c, r, colour, 0.45, 7);
}

// ---- Files: a matrix of file cells ----

export const FILE_COLS = 19;
export const FILE_ROWS = 8;
const FILE_CELL = 10;
const FILE_GAP = 2;
/** The matrix's width, for the module to leave room for it. */
export const FILE_MATRIX_W = FILE_COLS * (FILE_CELL + FILE_GAP) - FILE_GAP + 16;

export interface FileTouch {
	/** What the call touched ("" when hidden): it picks the cell. */
	readonly key: string;
	readonly tool: string;
	/** 0 to 1: how bright it lights (the newest brightest). */
	readonly strength: number;
}

/**
 * The files' matrix at the right of `r`: each touched file lights its cell, blue
 * for a read and yellow for an edit; a search sweeps a bright column across.
 */
export function paintFileMatrix(c: CanvasRenderingContext2D, r: Rect, colour: string, touches: readonly FileTouch[], running: boolean, searching: boolean, wall: number, motion: boolean): void {
	const w = FILE_COLS * (FILE_CELL + FILE_GAP) - FILE_GAP;
	const h = FILE_ROWS * (FILE_CELL + FILE_GAP) - FILE_GAP;
	const mx = r.x + r.w - 12 - w;
	const my = r.y + (r.h - h) / 2;
	plate(c, { x: mx - 8, y: my - 8, w: w + 16, h: h + 16 }, colour, running ? 1 : 0);
	const lit = new Map<number, { colour: string; alpha: number }>();
	for (const t of touches) {
		if (t.tool === "Grep" || t.tool === "Glob") continue;
		const cell = hash(t.key) % (FILE_COLS * FILE_ROWS);
		const edit = t.tool === "Edit" || t.tool === "Write" || t.tool === "NotebookEdit" || t.tool === "MultiEdit";
		const prev = lit.get(cell);
		if (prev === undefined || prev.alpha < t.strength) lit.set(cell, { colour: edit ? EDIT_COLOUR : colour, alpha: t.strength });
	}
	const sweep = searching && motion ? Math.floor(wall / 55) % FILE_COLS : -1;
	const shades = [0.07, 0.11, 0.16];
	for (let i = 0; i < FILE_COLS * FILE_ROWS; i++) {
		const col = i % FILE_COLS;
		const row = Math.floor(i / FILE_COLS);
		const x = mx + col * (FILE_CELL + FILE_GAP);
		const y = my + row * (FILE_CELL + FILE_GAP);
		const l = lit.get(i);
		// A stable pattern of three dim shades stands for the kinds of file.
		c.fillStyle = l === undefined ? rgba(colour, shades[hash(String(i)) % 3] ?? 0.1) : rgba(l.colour, l.alpha);
		c.fillRect(x, y, FILE_CELL, FILE_CELL);
		if (col === sweep) {
			c.fillStyle = rgba(colour, 0.5);
			c.fillRect(x, y, FILE_CELL, FILE_CELL);
		}
		if (l !== undefined) {
			c.strokeStyle = rgba(l.colour, 0.9);
			c.strokeRect(x - 0.5, y - 0.5, FILE_CELL + 1, FILE_CELL + 1);
		}
	}
}

// ---- Terminal: a shell window ----

export interface ShellLine {
	readonly text: string;
	readonly colour: string;
}

/**
 * The shell window: a title bar, the lines newest at the bottom, a blinking
 * cursor on the last (or "…" while a command runs), faint scanlines.
 */
export function paintShell(c: CanvasRenderingContext2D, r: Rect, colour: string, lines: readonly ShellLine[], running: boolean, wall: number, ts: number): void {
	plate(c, r, colour, running ? 1 : 0);
	c.fillStyle = "#121a24";
	c.fillRect(r.x + 1, r.y + 1, r.w - 2, 12);
	[INK.err, INK.warn, INK.ok].forEach((dot, i) => {
		c.beginPath();
		c.arc(r.x + 9 + i * 9, r.y + 7, 2.4, 0, 7);
		c.fillStyle = rgba(dot, 0.75);
		c.fill();
	});
	c.font = `400 ${8.5 * ts}px ${MONO}`;
	c.fillStyle = INK.muted;
	c.textBaseline = "middle";
	c.textAlign = "right";
	c.fillText("zsh", r.x + r.w - 6, r.y + 7.5);
	c.textAlign = "left";
	const size = 9.5 * ts;
	const pitch = size + 3;
	const room = Math.max(1, Math.floor((r.h - 20) / pitch));
	const shown = lines.slice(-room);
	const cursor = Math.floor(wall / 450) % 2 === 0;
	c.save();
	c.beginPath();
	c.rect(r.x + 1, r.y + 14, r.w - 2, r.h - 15);
	c.clip();
	c.font = `400 ${size}px ${MONO}`;
	c.textBaseline = "alphabetic";
	shown.forEach((line, i) => {
		const y = r.y + r.h - 6 - (shown.length - 1 - i) * pitch;
		const fit = Math.max(1, Math.floor((r.w - 14) / (size * 0.6)));
		const text = line.text.length > fit ? `${line.text.slice(0, fit - 1)}…` : line.text;
		c.fillStyle = line.colour;
		c.fillText(text, r.x + 6, y);
		if (i === shown.length - 1 && cursor && !running) {
			c.fillStyle = colour;
			c.fillRect(r.x + 6 + c.measureText(text).width + 2, y - size + 2, size * 0.55, size);
		}
	});
	c.restore();
	c.fillStyle = "rgba(255,255,255,.025)";
	for (let y = r.y + 14; y < r.y + r.h; y += 3) c.fillRect(r.x + 1, y, r.w - 2, 1);
}

// ---- Testing: a bed of test cells ----

export const TEST_COLS = 8;
export const TEST_ROWS = 3;
export type TestState = "none" | "running" | "pass" | "fail";

/**
 * The bed of test cells at `r`'s centre. Claude Code reports a run's outcome,
 * not each test, so the cells show that outcome together (green or red) and
 * while a run is going a light travels the bed (no figure of progress is known).
 */
export function paintTestBed(c: CanvasRenderingContext2D, r: Rect, colour: string, state: TestState, wall: number): void {
	const cw = 19;
	const ch = 16;
	const gap = 4;
	const bw = TEST_COLS * (cw + gap) - gap;
	const bh = TEST_ROWS * (ch + gap) - gap;
	const mx = r.x + (r.w - bw) / 2;
	const my = r.y + 48;
	plate(c, { x: mx - 8, y: my - 8, w: bw + 16, h: bh + 16 }, colour, state === "running" ? 1 : 0);
	const total = TEST_COLS * TEST_ROWS;
	const head = Math.floor(wall / 70) % total;
	for (let i = 0; i < total; i++) {
		const x = mx + (i % TEST_COLS) * (cw + gap);
		const y = my + Math.floor(i / TEST_COLS) * (ch + gap);
		let fill = "rgba(90,104,122,.35)";
		if (state === "running") {
			const d = (head - i + total) % total;
			if (d < 5) fill = rgba(INK.warn, 0.95 - d * 0.17);
		} else if (state === "pass") fill = rgba(INK.ok, 0.8);
		else if (state === "fail") fill = rgba(INK.err, 0.85);
		roundRect(c, x, y, cw, ch, 3);
		c.fillStyle = fill;
		c.fill();
		if (state === "fail") {
			c.strokeStyle = "rgba(255,255,255,.55)";
			c.beginPath();
			c.moveTo(x + 6, y + 5);
			c.lineTo(x + cw - 6, y + ch - 5);
			c.moveTo(x + cw - 6, y + 5);
			c.lineTo(x + 6, y + ch - 5);
			c.stroke();
		}
	}
}

// ---- Git: a commit graph ----

/**
 * The commit graph: `main` as a lane of commit nodes (at most five, the newest
 * with a HEAD tag), and from five commits a short feature branch that forks and
 * merges back. `busy` rings the newest node while a git call runs.
 */
export function paintCommitGraph(c: CanvasRenderingContext2D, r: Rect, colour: string, commits: number, busy: boolean, wall: number, motion: boolean, labels: { main: string; head: string }, ts: number): void {
	const laneA = r.y + 56;
	const laneB = r.y + 76;
	const gx0 = r.x + 54;
	const step = 24;
	const nodes = Math.min(5, Math.max(2, commits));
	const ax = (i: number): number => gx0 + i * step;
	c.lineWidth = 2;
	c.strokeStyle = rgba(colour, 0.55);
	c.beginPath();
	c.moveTo(ax(0), laneA);
	c.lineTo(ax(nodes - 1), laneA);
	c.stroke();
	if (nodes >= 5) {
		c.strokeStyle = rgba(colour, 0.4);
		c.beginPath();
		c.moveTo(ax(1), laneA);
		c.bezierCurveTo(ax(1) + 9, laneA, ax(1) + 4, laneB, ax(2), laneB);
		c.lineTo(ax(nodes - 3), laneB);
		c.bezierCurveTo(ax(nodes - 3) + 9, laneB, ax(nodes - 3) + 4, laneA, ax(nodes - 2), laneA);
		c.stroke();
		for (let i = 2; i <= nodes - 3; i++) {
			c.beginPath();
			c.arc(ax(i), laneB, 4, 0, 7);
			c.fillStyle = "#10171f";
			c.fill();
			c.lineWidth = 1.6;
			c.strokeStyle = rgba(colour, 0.7);
			c.stroke();
		}
	}
	for (let i = 0; i < nodes; i++) {
		const newest = i === nodes - 1;
		c.beginPath();
		c.arc(ax(i), laneA, newest ? 6 : 4.5, 0, 7);
		c.fillStyle = newest ? colour : "#10171f";
		c.fill();
		c.lineWidth = 1.8;
		c.strokeStyle = rgba(colour, newest ? 1 : 0.8);
		c.stroke();
		if (newest && busy && motion) {
			const k = (wall / 40) % 10;
			c.beginPath();
			c.arc(ax(i), laneA, 6 + k, 0, 7);
			c.strokeStyle = rgba(colour, 0.5 - k / 22);
			c.stroke();
		}
	}
	c.lineWidth = 1;
	c.font = `600 ${9 * ts}px ${MONO}`;
	c.textBaseline = "middle";
	c.textAlign = "left";
	c.fillStyle = INK.muted;
	c.fillText(labels.main, r.x + 12, laneA);
	const hx = ax(nodes - 1) + 12;
	roundRect(c, hx, laneA - 7, 36, 14, 7);
	c.fillStyle = rgba(colour, 0.2);
	c.fill();
	c.strokeStyle = rgba(colour, 0.8);
	c.stroke();
	c.fillStyle = colour;
	c.textAlign = "center";
	c.fillText(labels.head, hx + 18, laneA + 0.5);
	c.textAlign = "left";
}

// ---- Service marks, for the MCP ports ----

/** A small vector mark per service (strokes, no images); an unknown service shows its first letter. */
export function paintServiceMark(c: CanvasRenderingContext2D, name: string, x: number, y: number, s: number, colour: string): void {
	const n = name.toLowerCase();
	const cx = x + s / 2;
	const cy = y + s / 2;
	const u = s / 16;
	const line = (...pts: ReadonlyArray<readonly [number, number]>): void => {
		c.beginPath();
		pts.forEach(([px, py], i) => (i === 0 ? c.moveTo(x + px * u, y + py * u) : c.lineTo(x + px * u, y + py * u)));
		c.stroke();
	};
	const dot = (px: number, py: number, r: number): void => {
		c.beginPath();
		c.arc(px, py, r, 0, 7);
		c.fill();
	};
	c.save();
	c.strokeStyle = colour;
	c.fillStyle = colour;
	c.lineWidth = 1.5;
	c.lineJoin = "round";
	c.lineCap = "round";
	if (/chrome|browser|playwright|puppeteer|web/.test(n)) {
		c.beginPath();
		c.arc(cx, cy, s * 0.4, 0, 7);
		c.stroke();
		dot(cx, cy, s * 0.15);
	} else if (/github|gitlab|git/.test(n)) {
		dot(x + 4 * u, y + 3 * u, 1.8);
		dot(x + 4 * u, y + 13 * u, 1.8);
		dot(x + 12 * u, y + 7 * u, 1.8);
		line([4, 3], [4, 13]);
		c.beginPath();
		c.moveTo(x + 4 * u, y + 10 * u);
		c.quadraticCurveTo(x + 4 * u, y + 7 * u, x + 12 * u, y + 7 * u);
		c.stroke();
	} else if (/slack|chat|discord|telegram/.test(n)) {
		line([6, 2], [5, 14]);
		line([11, 2], [10, 14]);
		line([2, 6], [14, 6]);
		line([2, 10], [14, 10]);
	} else if (/linear|jira|asana|task|todo|monday/.test(n)) {
		c.beginPath();
		c.arc(cx, cy, s * 0.4, 0, 7);
		c.stroke();
		line([5, 8.5], [7.3, 11], [11.5, 5.5]);
	} else if (/notion|docs|wiki|confluence|drive|sheet|doc/.test(n)) {
		c.beginPath();
		c.moveTo(x + 3 * u, y + 1.5 * u);
		c.lineTo(x + 10 * u, y + 1.5 * u);
		c.lineTo(x + 13 * u, y + 4.5 * u);
		c.lineTo(x + 13 * u, y + 14.5 * u);
		c.lineTo(x + 3 * u, y + 14.5 * u);
		c.closePath();
		c.stroke();
		for (let i = 0; i < 3; i++) line([5.5, 7 + i * 2.6], [10.5, 7 + i * 2.6]);
	} else if (/figma|canva|design/.test(n)) {
		roundRect(c, x + 3 * u, y + 2 * u, 5 * u, 5.5 * u, 2.5 * u);
		c.stroke();
		roundRect(c, x + 8 * u, y + 2 * u, 5 * u, 5.5 * u, 2.5 * u);
		c.stroke();
		roundRect(c, x + 3 * u, y + 7.5 * u, 5 * u, 5.5 * u, 2.5 * u);
		c.stroke();
		c.beginPath();
		c.arc(x + 10.5 * u, y + 10.3 * u, 2.5 * u, 0, 7);
		c.stroke();
	} else if (/filesystem|file|fs|folder/.test(n)) {
		c.beginPath();
		c.moveTo(x + 1.5 * u, y + 4 * u);
		c.lineTo(x + 6 * u, y + 4 * u);
		c.lineTo(x + 7.5 * u, y + 6 * u);
		c.lineTo(x + 14.5 * u, y + 6 * u);
		c.lineTo(x + 14.5 * u, y + 13.5 * u);
		c.lineTo(x + 1.5 * u, y + 13.5 * u);
		c.closePath();
		c.stroke();
	} else if (/mongo|postgres|mysql|sql|redis|supabase|db|data/.test(n)) {
		c.beginPath();
		c.ellipse(cx, y + s * 0.22, s * 0.34, s * 0.13, 0, 0, 7);
		c.stroke();
		c.beginPath();
		c.moveTo(cx - s * 0.34, y + s * 0.22);
		c.lineTo(cx - s * 0.34, y + s * 0.78);
		c.ellipse(cx, y + s * 0.78, s * 0.34, s * 0.13, 0, Math.PI, 0, true);
		c.lineTo(cx + s * 0.34, y + s * 0.22);
		c.stroke();
		c.beginPath();
		c.ellipse(cx, y + s * 0.5, s * 0.34, s * 0.13, 0, 0, Math.PI);
		c.stroke();
	} else if (/cloudflare|aws|gcp|azure|vercel|netlify|cloud/.test(n)) {
		c.beginPath();
		c.moveTo(x + 4 * u, y + 12 * u);
		c.bezierCurveTo(x, y + 12 * u, x, y + 7 * u, x + 4 * u, y + 7 * u);
		c.bezierCurveTo(x + 4 * u, y + 3 * u, x + 10 * u, y + 2 * u, x + 11 * u, y + 6.5 * u);
		c.bezierCurveTo(x + 15 * u, y + 6 * u, x + 16 * u, y + 12 * u, x + 12 * u, y + 12 * u);
		c.closePath();
		c.stroke();
	} else if (/gmail|mail|email|outlook/.test(n)) {
		roundRect(c, x + 1.5 * u, y + 3.5 * u, 13 * u, 9 * u, 2);
		c.stroke();
		line([2, 4.5], [8, 9], [14, 4.5]);
	} else if (/sentry|log|monitor|datadog|grafana|metric/.test(n)) {
		line([1.5, 9], [5, 9], [7, 3], [10, 13], [12, 9], [14.5, 9]);
	} else if (/stripe|pay|billing|polar/.test(n)) {
		roundRect(c, x + 1.5 * u, y + 3.5 * u, 13 * u, 9 * u, 2);
		c.stroke();
		c.fillRect(x + 1.5 * u, y + 6 * u, 13 * u, 2 * u);
	} else if (/context7|search|exa|brave|tavily/.test(n)) {
		c.beginPath();
		c.arc(x + 7 * u, y + 7 * u, 4.5 * u, 0, 7);
		c.stroke();
		line([10.5, 10.5], [14, 14]);
	} else if (/calendar|cal/.test(n)) {
		roundRect(c, x + 2 * u, y + 3 * u, 12 * u, 11 * u, 2);
		c.stroke();
		line([2, 7], [14, 7]);
		line([5.5, 1.5], [5.5, 4]);
		line([10.5, 1.5], [10.5, 4]);
	} else if (/dash|server|admin|ops/.test(n)) {
		for (let i = 0; i < 3; i++) {
			roundRect(c, x + s * 0.12, y + s * 0.1 + i * s * 0.3, s * 0.76, s * 0.2, 2);
			c.stroke();
			dot(x + s * 0.26, y + s * 0.2 + i * s * 0.3, 1.3);
		}
	} else {
		c.font = `700 ${s * 0.7}px ${MONO}`;
		c.textAlign = "center";
		c.textBaseline = "middle";
		c.fillText(name.slice(0, 1).toUpperCase() || "?", cx, cy + 1);
	}
	c.restore();
}

export interface McpPort {
	readonly name: string;
	/** A call runs on this server now. */
	readonly on: boolean;
	/** True once a call of this server was seen. */
	readonly used: boolean;
	/** The last tool it ran and its runtime text; null when none is known (or hidden). */
	readonly last: { readonly tool: string; readonly runtime: string } | null;
}

export const MCP_ROW_H = 34;
export const MCP_ROW_GAP = 6;

/** One connector port: a socket, a cable, the service mark, the name, the last tool and runtime, an LED. */
export function paintMcpPort(c: CanvasRenderingContext2D, x: number, y: number, w: number, port: McpPort, colour: string, wall: number, motion: boolean, ts: number): void {
	const mid = y + MCP_ROW_H / 2;
	const pulse = port.on ? 0.5 + 0.5 * Math.sin(wall / 140) : 0;
	roundRect(c, x, y, w, MCP_ROW_H, 5);
	c.fillStyle = port.on ? rgba(colour, 0.1 + 0.08 * pulse) : "#10171f";
	c.fill();
	c.strokeStyle = port.on ? rgba(colour, 0.7) : "#26313f";
	c.stroke();
	c.beginPath();
	c.arc(x + 14, mid, 6, 0, 7);
	c.fillStyle = "#0a0f15";
	c.fill();
	c.strokeStyle = port.on ? colour : "#3a4656";
	c.lineWidth = 1.6;
	c.stroke();
	c.beginPath();
	c.arc(x + 14, mid, 2.2, 0, 7);
	c.fillStyle = port.on ? colour : port.used ? rgba(colour, 0.5) : "#3a4656";
	c.fill();
	c.beginPath();
	c.moveTo(x + 21, mid);
	c.lineTo(x + 38, mid);
	if (port.on) {
		c.setLineDash([4, 3]);
		c.lineDashOffset = motion ? -wall / 40 : 0;
	}
	c.strokeStyle = port.on ? colour : "#3a4656";
	c.stroke();
	c.setLineDash([]);
	c.lineWidth = 1;
	roundRect(c, x + 38, mid - 13, 26, 26, 5);
	c.fillStyle = "#0a0f15";
	c.fill();
	c.strokeStyle = port.on ? rgba(colour, 0.8) : "#2b3644";
	c.stroke();
	paintServiceMark(c, port.name, x + 43, mid - 8, 16, port.on ? colour : port.used ? rgba(colour, 0.7) : INK.muted);
	c.font = `500 ${11 * ts}px ${MONO}`;
	c.textBaseline = "middle";
	c.textAlign = "left";
	c.fillStyle = port.on ? INK.fg : "#a9b7c6";
	const fit = Math.max(4, Math.floor((w - 74 - 150) / (11 * ts * 0.6)));
	c.fillText(port.name.length > fit ? `${port.name.slice(0, fit - 1)}…` : port.name, x + 74, mid);
	if (port.last !== null) {
		c.textAlign = "right";
		c.font = `400 ${10 * ts}px ${MONO}`;
		c.fillStyle = port.on ? colour : INK.muted;
		c.fillText(`${port.last.tool} · ${port.last.runtime}`, x + w - 26, mid);
		c.textAlign = "left";
	}
	c.beginPath();
	c.arc(x + w - 13, mid, 4, 0, 7);
	c.fillStyle = port.on ? INK.ok : port.used ? rgba(INK.ok, 0.45) : "#2b3644";
	c.fill();
	if (port.on) {
		c.save();
		c.shadowColor = INK.ok;
		c.shadowBlur = 8;
		c.fill();
		c.restore();
	}
}

// ---- The small modules ----

/** A memory chip: a die with pins on two sides; its core lights with `glow` (0 to 1). */
export function paintMemoryChip(c: CanvasRenderingContext2D, x: number, y: number, s: number, colour: string, glow: number): void {
	c.strokeStyle = rgba(colour, 0.55 + 0.45 * glow);
	c.lineWidth = 1.5;
	roundRect(c, x + 5, y + 3, s - 10, s - 6, 3);
	c.stroke();
	for (let i = 0; i < 3; i++) {
		const py = y + 6.5 + i * 5.5;
		c.beginPath();
		c.moveTo(x + 1, py);
		c.lineTo(x + 5, py);
		c.moveTo(x + s - 5, py);
		c.lineTo(x + s - 1, py);
		c.stroke();
	}
	c.fillStyle = rgba(colour, 0.15 + 0.6 * glow);
	c.fillRect(x + 9, y + 7, s - 18, s - 14);
	c.lineWidth = 1;
}

/** A lightning bolt in a hexagon; the bolt fills with `glow`. */
export function paintSkillBolt(c: CanvasRenderingContext2D, x: number, y: number, s: number, colour: string, glow: number): void {
	c.strokeStyle = rgba(colour, 0.55 + 0.45 * glow);
	c.lineWidth = 1.5;
	c.lineJoin = "round";
	c.beginPath();
	for (let i = 0; i < 6; i++) {
		const a = Math.PI / 6 + (i * Math.PI) / 3;
		c.lineTo(x + s / 2 + Math.cos(a) * s * 0.5, y + s / 2 + Math.sin(a) * s * 0.5);
	}
	c.closePath();
	c.stroke();
	c.beginPath();
	c.moveTo(x + s * 0.56, y + s * 0.16);
	c.lineTo(x + s * 0.32, y + s * 0.54);
	c.lineTo(x + s * 0.5, y + s * 0.54);
	c.lineTo(x + s * 0.44, y + s * 0.86);
	c.lineTo(x + s * 0.7, y + s * 0.44);
	c.lineTo(x + s * 0.52, y + s * 0.44);
	c.closePath();
	c.fillStyle = rgba(colour, 0.25 + 0.7 * glow);
	c.fill();
	c.stroke();
	c.lineWidth = 1;
}

/** The prompt port: a tiny screen with a caret; a ripple leaves it while `glow` fades. */
export function paintPromptPort(c: CanvasRenderingContext2D, r: Rect, colour: string, glow: number, wall: number, ts: number): void {
	const x = r.x + 10;
	const y = r.y + r.h - 26;
	const w = r.w - 20;
	const h = 17;
	c.strokeStyle = rgba(colour, 0.45 + 0.4 * glow);
	c.strokeRect(x + 0.5, y + 0.5, w, h);
	c.fillStyle = rgba(colour, 0.1 + 0.2 * glow);
	c.fillRect(x + 1, y + 1, w - 1, h - 1);
	c.font = `600 ${12 * ts}px ${MONO}`;
	c.textBaseline = "middle";
	c.textAlign = "left";
	c.fillStyle = colour;
	c.fillText("›", x + 5, y + h / 2 + 1);
	if (Math.floor(wall / 500) % 2 === 0 || glow > 0) c.fillRect(x + 20, y + 4, 7, h - 8);
	if (glow > 0) {
		c.beginPath();
		c.arc(r.x + r.w, r.y + r.h / 2, 6 + (1 - glow) * 22, 0, 7);
		c.strokeStyle = rgba(colour, glow * 0.6);
		c.stroke();
	}
}

/** A shield with a lock; while a permission is asked it pulses and the shackle opens. */
export function paintPermissionShield(c: CanvasRenderingContext2D, x: number, y: number, waiting: boolean, wall: number, scale = 1): void {
	c.save();
	c.translate(x, y);
	c.scale(scale, scale);
	x = 0;
	y = 0;
	const pulse = waiting ? 0.5 + 0.5 * Math.sin(wall / 150) : 0;
	const colour = waiting ? INK.warn : INK.muted;
	c.strokeStyle = rgba(colour, waiting ? 0.55 + 0.45 * pulse : 0.75);
	c.lineWidth = 1.5;
	c.lineJoin = "round";
	c.beginPath();
	c.moveTo(x + 12, y + 1);
	c.lineTo(x + 22, y + 5);
	c.lineTo(x + 22, y + 12);
	c.quadraticCurveTo(x + 22, y + 20, x + 12, y + 24);
	c.quadraticCurveTo(x + 2, y + 20, x + 2, y + 12);
	c.lineTo(x + 2, y + 5);
	c.closePath();
	c.stroke();
	if (waiting) {
		c.fillStyle = rgba(INK.warn, 0.08 + 0.18 * pulse);
		c.fill();
	}
	c.beginPath();
	c.arc(x + 12, y + 11 - (waiting ? 2 : 0), 3.2, Math.PI, 0);
	c.stroke();
	c.fillStyle = rgba(colour, 0.8);
	c.fillRect(x + 8, y + 11, 8, 6);
	c.restore();
	c.lineWidth = 1;
}
