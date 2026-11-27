// A road with a failed call is red along its whole length on the Live Map,
// not only a short stretch where it meets its module (which read as a glitch).
// The canvas' context is replaced by a recorder of every stroke: its colour
// and the points of its path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVATORY_COPY } from "../../src/machines/observatory/observatory-copy.ts";
import { INK, rgba } from "../../src/machines/observatory/render/ink.ts";
import { INTERIOR, type Point } from "../../src/machines/observatory/render/scene-table.ts";
import { prompt, tool } from "../machines/observatory/live-map-fixtures.ts";
import { played } from "./render-fixtures.ts";

interface Stroke {
	readonly style: string;
	readonly points: readonly Point[];
}

/** A 2D context that records each stroke's colour and path, and does nothing else. */
function recorder(strokes: Stroke[]): CanvasRenderingContext2D {
	let path: Point[] = [];
	const target: Record<string | symbol, unknown> = {
		strokeStyle: "",
		beginPath: () => {
			path = [];
		},
		moveTo: (x: number, y: number) => path.push([x, y]),
		lineTo: (x: number, y: number) => path.push([x, y]),
		stroke: () => strokes.push({ style: String(target.strokeStyle), points: path }),
		measureText: (text: string) => ({ width: text.length * 6 }),
		createRadialGradient: () => ({ addColorStop: () => {} }),
	};
	return new Proxy(target, {
		get: (t, key) => (key in t ? t[key] : () => {}),
		set: (t, key, value) => {
			t[key] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

const { mountLiveMap } = await import("../../src/machines/observatory/render/live-map-app.ts");

let strokes: Stroke[] = [];
const frames = new Map<number, FrameRequestCallback>();
let next = 1;

beforeEach(() => {
	strokes = [];
	frames.clear();
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frames.set(next, cb);
		return next++;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorder(strokes) as never);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const near = (a: Point | undefined, b: Point | undefined) => a !== undefined && b !== undefined && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;

describe("a road with failed calls", () => {
	it("is red from the model to its module", () => {
		const words = { copy: OBSERVATORY_COPY.vi.scene, duration: (ms: number) => `${ms}ms` };
		const { state, animations } = played([
			prompt(1, 0),
			// Each call starts, then ends: 40 that pass, one that fails.
			...Array.from({ length: 40 }, (_, i) => [
				tool(`ok${i}`, 10 + 2 * i, { station: "SANDBOX", toolName: "Bash" }),
				tool(`ok${i}`, 11 + 2 * i, { station: "SANDBOX", toolName: "Bash", success: true }),
			]).flat(),
			tool("bad", 100, { station: "SANDBOX", toolName: "Bash" }),
			tool("bad", 101, { station: "SANDBOX", toolName: "Bash", success: false }),
		]);
		const handle = mountLiveMap({ host: document.createElement("div"), state, width: 1200, height: 720, words, saveData: false, record: true, now: () => 1_000, reduceMotion: () => true });
		handle.update(state, animations);
		for (let i = 0; i < 5; i++) for (const cb of [...frames.values()]) cb(1_000 + i * 16);
		const road = INTERIOR.places.sandbox.road;
		const red = strokes.filter((s) => s.style === rgba(INK.err, 0.92));
		// One failure in 41 calls still paints the whole track, not its last few pixels.
		expect(red.some((s) => near(s.points[0], road[0]) && near(s.points.at(-1), road.at(-1)) && s.points.length === road.length)).toBe(true);
		handle.destroy();
	});
});
