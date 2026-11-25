// The Live Map's 2D canvas glue with the canvas' context replaced by a
// recorder: it sizes the canvas at a resolution of at most 2, draws the
// design's modules with their words, draws its idle scene at 20 frames a
// second at most and none at all with reduced motion or save-data, plays
// animations with their source events in the log, stops the model thinking
// on the scene when no event came for a while, never holds the full display
// rate for a run of tool calls or a wait alone, moves the camera (a drag
// switches to free and is reported), finds a packet and a module under a
// click, and on destroy removes every listener and its canvas; without a 2D
// canvas it throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVATORY_COPY } from "../../src/machines/observatory/observatory-copy.ts";
import type { LiveMapMountOptions } from "../../src/machines/observatory/render/live-map-app.ts";
import { CORE_SPIN_IDLE_MS } from "../../src/machines/observatory/render/prop-map.ts";
import { INTERIOR } from "../../src/machines/observatory/render/scene-table.ts";
import { api, lifecycle, prompt, tool } from "../machines/observatory/live-map-fixtures.ts";
import { played } from "./render-fixtures.ts";

/** A 2D context that records the text it fills and does nothing else. */
function recorder(texts: string[]): CanvasRenderingContext2D {
	const target: Record<string | symbol, unknown> = {
		fillText: (text: string) => texts.push(text),
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

/** requestAnimationFrame at 60 frames per second and the timers, run by hand together. */
const frames = {
	queue: new Map<number, FrameRequestCallback>(),
	next: 1,
	now: 0,
	run(ms: number) {
		const end = frames.now + ms;
		while (frames.now < end) {
			frames.now += 16;
			vi.advanceTimersByTime(16);
			const due = [...frames.queue.values()];
			frames.queue.clear();
			for (const cb of due) cb(frames.now);
		}
	},
};

const { mountLiveMap } = await import("../../src/machines/observatory/render/live-map-app.ts");

let reduce = true;
let texts: string[] = [];
let has2d = true;
const words = { copy: OBSERVATORY_COPY.vi.scene, duration: (ms: number) => `${ms}ms` };

function options(over: Partial<LiveMapMountOptions> = {}): LiveMapMountOptions {
	return { host: document.createElement("div"), state: played([]).state, width: 1200, height: 720, words, saveData: false, record: true, now: () => frames.now, reduceMotion: () => reduce, ...over };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	frames.queue.clear();
	frames.now = 0;
	reduce = true;
	texts = [];
	has2d = true;
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		const id = frames.next++;
		frames.queue.set(id, cb);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.queue.delete(id));
	vi.stubGlobal("devicePixelRatio", 3);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => (has2d ? recorder(texts) : null) as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mounting the Live Map", () => {
	it("sizes the canvas at a resolution of at most 2 and draws the design's modules", () => {
		const host = document.createElement("div");
		const handle = mountLiveMap(options({ host }));
		expect(host.contains(handle.canvas)).toBe(true);
		expect(handle.canvas.getAttribute("aria-hidden")).toBe("true");
		expect([handle.canvas.width, handle.canvas.height]).toEqual([2400, 1440]);
		frames.run(50);
		expect(texts).toEqual(expect.arrayContaining(["KHO TỆP", "TERMINAL", "KIỂM THỬ", "GIT · CI/CD", "CỔNG MCP", "BỂ NGỮ CẢNH", "CỔNG KHÔNG GIAN · internet", "MODEL", "rảnh", "commit", "prod"]));
		handle.resize(600, 360);
		expect([handle.canvas.width, handle.canvas.height]).toEqual([1200, 720]);
		handle.destroy();
		expect(host.contains(handle.canvas)).toBe(false);
	});

	it("leaves out targets and MCP names with Ẩn chi tiết", () => {
		const handle = mountLiveMap(options());
		const { state, animations } = played([prompt(1, 0), tool("r1", 10, { station: "FILES", target: "src/secret.ts" }), tool("r1", 20, { station: "FILES", target: "src/secret.ts", success: true })]);
		handle.update(state, animations);
		handle.select("files");
		handle.setCameraMode("focus");
		frames.run(100);
		expect(texts.some((t) => t.includes("src/secret.ts"))).toBe(true);
		texts.length = 0;
		handle.setHide(true);
		frames.run(100);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.some((t) => t.includes("src/secret.ts"))).toBe(false);
		handle.destroy();
	});

	it("throws without a 2D canvas", () => {
		has2d = false;
		expect(() => mountLiveMap(options())).toThrow(/2D canvas/);
	});

	it("with reduced motion draws its first frames, then 0 frames over an idle minute", () => {
		const handle = mountLiveMap(options());
		frames.run(500);
		const settled = handle.frames();
		expect(settled).toBeGreaterThan(0);
		frames.run(60_000);
		expect(handle.frames()).toBe(settled);
		expect(frames.queue.size).toBe(0);
		handle.destroy();
	});

	it("draws the idle scene's gentle motion at 20 frames a second at most", () => {
		reduce = false;
		const handle = mountLiveMap(options());
		frames.run(1_000);
		const start = handle.frames();
		frames.run(60_000);
		const idle = handle.frames() - start;
		expect(idle).toBeGreaterThan(60 * 5);
		expect(idle).toBeLessThanOrEqual(60 * 20 + 1);
		handle.destroy();
	});

	it("does not draw the idle motion with save-data", () => {
		reduce = false;
		const handle = mountLiveMap(options({ saveData: true }));
		frames.run(1_000);
		const settled = handle.frames();
		frames.run(30_000);
		expect(handle.frames()).toBe(settled);
		handle.destroy();
	});

	it("plays animations with their source events", () => {
		const handle = mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10), tool("r1", 20, { success: true })]);
		handle.update({ ...state, live: null }, animations);
		frames.run(2_000);
		expect(handle.animationLog().map((e) => e.eventId)).toEqual(expect.arrayContaining(["prompt:p1", "tool:r1"]));
		expect(handle.animationLog().every((e) => e.eventId !== "")).toBe(true);
		handle.destroy();
	});

	it("stops the model thinking on the scene when no event came for CORE_SPIN_IDLE_MS", () => {
		reduce = false;
		const handle = mountLiveMap(options());
		frames.run(100);
		// A turn the person interrupted while the model thought: no event ends it.
		const thinking = played([prompt(1, 0)]);
		handle.update({ ...thinking.state, live: null }, thinking.animations);
		frames.run(5_000);
		const busy = handle.frames();
		frames.run(1_000);
		// Thinking: every display frame.
		expect(handle.frames() - busy).toBeGreaterThan(50);
		frames.run(CORE_SPIN_IDLE_MS);
		const stale = handle.frames();
		frames.run(1_000);
		// The ambient rate only.
		expect(handle.frames() - stale).toBeLessThanOrEqual(21);
		expect(handle.animationLog().filter((e) => e.kind === "think").map((e) => e.eventId)).toEqual(["prompt:p1"]);
		handle.destroy();
	});

	it("drops to the ambient rate when a turn stalls while thinking, even with a token rate (the wave settles too)", () => {
		reduce = false;
		const handle = mountLiveMap(options());
		frames.run(100);
		const thinking = played([prompt(1, 0), api("a1", 10, { outputTokens: 900, durationMs: 3_000 })]);
		expect(thinking.state.scene.tokensPerSecond).toBeGreaterThan(0);
		handle.update({ ...thinking.state, live: null }, thinking.animations);
		// The spin stops after CORE_SPIN_IDLE_MS; the token wave then fades out (about 10 s from 300 tok/s).
		frames.run(CORE_SPIN_IDLE_MS + 15_000);
		const stale = handle.frames();
		frames.run(1_000);
		expect(handle.frames() - stale).toBeLessThanOrEqual(21);
		handle.destroy();
	});

	it("does not hold the full display rate while tool calls run or a permission waits: the ambient rate once settled", () => {
		reduce = false;
		for (const events of [[prompt(1, 0), tool("r1", 10, { station: "SANDBOX" })], [prompt(1, 0), lifecycle("permission_request", "q1", 10, { station: "SANDBOX" })]]) {
			const handle = mountLiveMap(options());
			frames.run(100);
			const { state, animations } = played(events);
			handle.update({ ...state, live: null }, animations);
			// Packets played, the camera moved and settled, the glows faded.
			frames.run(8_000);
			const settled = handle.frames();
			frames.run(1_000);
			expect(handle.frames() - settled).toBeLessThanOrEqual(21);
			handle.destroy();
		}
	});

	it("draws nothing while tool calls run under reduced motion, once settled", () => {
		const handle = mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10, { station: "SANDBOX" })]);
		handle.update({ ...state, live: null }, animations);
		frames.run(8_000);
		const settled = handle.frames();
		frames.run(10_000);
		expect(handle.frames()).toBe(settled);
		handle.destroy();
	});

	it("follows the activity with the camera, and a drag switches it to free", () => {
		const onCamera = vi.fn();
		const onView = vi.fn();
		const handle = mountLiveMap(options({ onCamera, onView }));
		frames.run(100);
		const { state } = played([prompt(1, 0), tool("r1", 10, { station: "SANDBOX" })]);
		handle.update(state, []);
		frames.run(2_000);
		expect(handle.camera()).toMatchObject({ mode: "auto", zone: "sandbox", contentZone: "sandbox", switches: 1 });
		expect(onCamera).toHaveBeenLastCalledWith(expect.objectContaining({ zone: "sandbox" }));
		handle.pan(40, 0);
		frames.run(100);
		expect(handle.camera().mode).toBe("free");
		expect(onView).toHaveBeenCalled();
		handle.select("files");
		handle.setCameraMode("focus");
		frames.run(100);
		expect(handle.camera()).toMatchObject({ mode: "focus", contentZone: "files" });
		frames.run(3_000);
		const [, view] = onView.mock.calls.at(-1) as [unknown, { s: number }];
		expect(view.s).toBeGreaterThan(1.3);
		handle.destroy();
	});

	it("finds the packet and the module under a click", () => {
		const handle = mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10, { station: "FILES" })]);
		handle.update(state, animations.filter((a) => a.eventId === "tool:r1"));
		const start = INTERIOR.places.files.route[0] ?? [0, 0];
		// The frame's point of the packet's start (the trace's first point) at the current view.
		let hit: string | null = null;
		for (let x = 0; x <= 1200 && hit === null; x += 10)
			for (let y = 0; y <= 720 && hit === null; y += 10) {
				const [sx, sy] = handle.toScene(x, y);
				if (Math.hypot(sx - start[0], sy - start[1]) < 40) hit = handle.hitEvent(x, y);
			}
		expect(hit).toBe("tool:r1");
		expect(handle.hitEvent(1, 1)).toBeNull();
		// The whole board shows at mount: frame pixels are scene pixels.
		const fresh = mountLiveMap(options());
		expect(fresh.placeAt(200, 560)).toBe("files");
		expect(fresh.placeAt(40, 40)).toBeNull();
		fresh.destroy();
		handle.destroy();
	});

	it("removes every listener on destroy and draws no more", () => {
		const add = vi.spyOn(document, "addEventListener");
		const remove = vi.spyOn(document, "removeEventListener");
		const handle = mountLiveMap(options());
		const listened = add.mock.calls.map(([type]) => type);
		handle.destroy();
		expect(remove.mock.calls.map(([type]) => type)).toEqual(listened);
		frames.run(1_000);
		expect(frames.queue.size).toBe(0);
		handle.destroy();
	});
});
