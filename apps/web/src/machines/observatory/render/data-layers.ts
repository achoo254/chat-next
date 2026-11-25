// The Live Map's code-drawn data layers, on PixiJS Graphics in scene pixels:
// the energy roads (width by calls, a red share by failures, energy flowing
// from the actor to the district while a call runs, amber once a call passes
// its kind's p95 of the session, a pulsing amber or red dash for a
// bottleneck, a thin muted dash for a road never used), the release
// pipeline's slots on the Git district, and the token wave. The pictures
// (districts, tower, drones) are the AI-drawn sprites; these are the data.
import type { Graphics } from "pixi.js";
import type { Pipeline, StepStatus } from "../pipeline-model.ts";
import { RELEASE_STEPS } from "../call-history.ts";
import { dashes, pipelineSlots, roadWidth, subPath, type RoadLook } from "./prop-map.ts";
import type { Palette } from "./scene-palette.ts";
import type { Point, Rect, SceneTable } from "./scene-table.ts";

function polyline(g: Graphics, path: readonly Point[]): Graphics {
	const [first, ...rest] = path;
	if (first === undefined) return g;
	g.moveTo(first[0], first[1]);
	for (const [x, y] of rest) g.lineTo(x, y);
	return g;
}

function dashed(g: Graphics, path: readonly Point[], dash: number, gap: number, offset: number, stroke: { color: number; width: number; alpha: number }): void {
	for (const [a, b] of dashes(path, dash, gap, offset)) g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
	g.stroke({ ...stroke, cap: "round" });
}

export interface RoadFrame {
	/** Time for flowing dashes and pulses (ms); fixed under reduced motion. */
	readonly t: number;
	/** The machine's clock now (ms): a running call past its p95 turns amber. */
	readonly wall: number;
	/** Where each running subagent's drone is now. */
	readonly drones: ReadonlyMap<string, Point>;
	/** The AI works (roads not taking part dim). */
	readonly busy: boolean;
	readonly flow: boolean;
}

/** Every road of the scene. */
export function drawRoads(g: Graphics, roads: readonly RoadLook[], palette: Palette, f: RoadFrame): void {
	for (const road of roads) {
		const colour = palette[road.place];
		const hot = road.running.length > 0 || road.waiting;
		const dim = f.busy && !hot;
		if (road.calls === 0 && !hot) {
			dashed(g, road.path, 8, 12, 0, { color: palette.muted, width: 2, alpha: 0.45 });
		} else {
			const w = roadWidth(road.calls);
			// The road's glow, then its core line.
			polyline(g, road.path).stroke({ color: colour, width: w * 2.6, alpha: dim ? 0.05 : 0.12 + (hot ? 0.1 : 0), cap: "round", join: "round" });
			polyline(g, road.path).stroke({ color: colour, width: w, alpha: (dim ? 0.18 : 0.42) + (hot ? 0.25 : 0), cap: "round", join: "round" });
			if (road.failures > 0 && road.calls > 0) polyline(g, subPath(road.path, road.failures / road.calls)).stroke({ color: palette.error, width: Math.max(3, w * 0.45), alpha: 0.85, cap: "round", join: "round" });
		}
		const offset = f.flow ? -f.t / 9 : 0;
		for (const job of road.running) {
			const drone = job.agentId === "" ? undefined : f.drones.get(job.agentId);
			// Energy from who runs it: the core's base for the main agent, the subagent's drone otherwise.
			const path: readonly Point[] = drone === undefined ? road.path : [drone, road.path[road.path.length - 1] ?? drone];
			const over = job.overAt !== null && f.wall > job.overAt;
			const colour2 = over ? palette.warn : drone !== undefined ? palette.orchestrator : colour;
			dashed(g, path, 22, 16, offset, { color: colour2, width: 7, alpha: 0.95 });
		}
		if (road.waiting) dashed(g, road.path, 18, 14, offset, { color: palette.warn, width: 6, alpha: 0.9 });
		if (road.bottleneck !== "none") {
			const pulse = f.flow ? 0.55 + 0.35 * Math.sin(f.t / 200) : 0.8;
			dashed(g, road.path, 10, 12, f.flow ? -f.t / 40 : 0, { color: road.bottleneck === "alert" ? palette.error : palette.warn, width: 5, alpha: pulse });
		}
	}
}

/** A step's colour by state; null: the Git district's own (running). */
const STEP_TONE: Readonly<Record<StepStatus, "success" | "error" | "muted" | null>> = { idle: "muted", run: null, ok: "success", err: "error" };

/** The release pipeline: a slot per step tinted by its state, a sweep on a running one, the prod light. */
export function drawPipeline(g: Graphics, scene: SceneTable, pipeline: Pipeline, palette: Palette, t: number, flow: boolean): void {
	const { steps, prod } = pipelineSlots(scene);
	RELEASE_STEPS.forEach((step, i) => {
		const slot = steps[i];
		if (slot === undefined) return;
		const st = pipeline.steps[step];
		const tone = STEP_TONE[st.status];
		const colour = tone === null ? palette.git : palette[tone];
		g.roundRect(slot.x, slot.y, slot.w, slot.h, 8).fill({ color: colour, alpha: st.status === "idle" ? 0.12 : st.status === "run" ? 0.28 : 0.22 });
		g.roundRect(slot.x, slot.y, slot.w, slot.h, 8).stroke({ color: colour, width: st.status === "idle" ? 1.5 : 3, alpha: st.status === "idle" ? 0.5 : 1 });
		if (st.status === "run") {
			// Indeterminate: a sweep, never a percentage.
			const k = flow ? (t / 1100) % 1 : 0.5;
			g.rect(slot.x + 4 + (slot.w - 52) * k, slot.y + slot.h - 7, 44, 4).fill({ color: palette.git, alpha: 1 });
		}
		const prev = steps[i - 1];
		if (prev !== undefined) {
			const ok = pipeline.steps[RELEASE_STEPS[i - 1] ?? "commit"].status === "ok";
			g.moveTo(prev.x + prev.w, slot.y + slot.h / 2).lineTo(slot.x, slot.y + slot.h / 2).stroke({ color: ok ? palette.success : palette.muted, width: 3, alpha: 0.7 });
		}
	});
	const last = steps[steps.length - 1];
	if (last !== undefined) g.moveTo(last.x + last.w, prod[1]).lineTo(prod[0] - 14, prod[1]).stroke({ color: pipeline.prod ? palette.success : palette.muted, width: 3, alpha: 0.7 });
	g.circle(prod[0], prod[1], 14).fill({ color: pipeline.prod ? palette.success : palette.muted, alpha: pipeline.prod ? 1 : 0.35 });
}

/** The token wave: a sine whose height and density follow tokens per second. */
export function drawWave(g: Graphics, wave: Rect, tokensPerSecond: number, phase: number, palette: Palette): void {
	const amp = Math.min(1, Math.max(0, tokensPerSecond) / 140);
	const pts: Point[] = [];
	const inner = wave.w - 24;
	for (let i = 0; i <= inner; i += 4) {
		const x = i / inner;
		const v = Math.sin(x * (6 + 14 * amp) * Math.PI - phase * 6) * Math.sin(x * Math.PI) * (wave.h / 2 - 14) * (0.06 + 0.94 * amp);
		pts.push([wave.x + 12 + i, wave.y + wave.h / 2 + v]);
	}
	polyline(g, pts).stroke({ color: palette.think, width: 3, alpha: 0.3 + 0.65 * amp });
}

/** A dashed outline around a selected place. */
export function drawSelection(g: Graphics, r: Rect, palette: Palette): void {
	const pad = 12;
	const box: Point[] = [
		[r.x - pad, r.y - pad],
		[r.x + r.w + pad, r.y - pad],
		[r.x + r.w + pad, r.y + r.h + pad],
		[r.x - pad, r.y + r.h + pad],
		[r.x - pad, r.y - pad],
	];
	dashed(g, box, 14, 12, 0, { color: palette.text, width: 3, alpha: 0.6 });
}

/** A beam from a drone down to the district it serves. */
export function drawTether(g: Graphics, from: Point, to: Point, colour: number, t: number, flow: boolean): void {
	dashed(g, [from, to], 8, 10, flow ? -t / 30 : 0, { color: colour, width: 3, alpha: 0.6 });
}

