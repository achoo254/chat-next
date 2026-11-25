// The Live Map's PixiJS glue with PixiJS replaced by a recorder: it starts
// WebGL then Canvas (never WebGPU) without autostart at a resolution of at
// most 2, picks the plate by MAX_TEXTURE_SIZE, draws its idle scene at 20
// frames a second at most and none at all with reduced motion, plays
// animations with their source events in the log, stops the model thinking
// on the scene when no event came for a while, leaves out an atlas that does
// not load, moves the camera (a drag switches to free and is reported), finds
// a packet under a click, stops on a lost context and draws again on restore,
// and on destroy removes every listener and destroys the app with its
// children and textures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMapMountOptions } from "../../src/machines/observatory/render/live-map-app.ts";
import { CORE_SPIN_IDLE_MS } from "../../src/machines/observatory/render/prop-map.ts";
import { lifecycle, prompt, tool } from "../machines/observatory/live-map-fixtures.ts";
import { fixtureAssets, fixtureFile, played, SHEET_FILE } from "./render-fixtures.ts";

const pixi = vi.hoisted(() => {
	const record = {
		init: null as Record<string, unknown> | null,
		renderer: "webgl",
		maxTextureSize: 4096,
		failInit: false,
		renders: 0,
		destroyed: [] as unknown[][],
		canvas: null as HTMLCanvasElement | null,
	};
	/** Any method returns the object itself: Graphics' chained drawing calls. */
	const chain = (): object => {
		const target = {};
		const proxy: object = new Proxy(target, { get: (_t, key) => (key === "then" ? undefined : () => proxy) });
		return proxy;
	};
	const point = () => ({ set: () => {} });
	class Container {
		children: unknown[] = [];
		scale = point();
		position = point();
		rotation = 0;
		addChild(...c: unknown[]) {
			this.children.push(...c);
		}
		addChildAt(c: unknown, i: number) {
			this.children.splice(i, 0, c);
		}
		removeChild(c: unknown) {
			this.children = this.children.filter((x) => x !== c);
		}
		getChildIndex(c: unknown) {
			return this.children.indexOf(c);
		}
	}
	const texture = () => ({ width: 10, height: 10, frame: { x: 0, y: 0, width: 10, height: 10 }, source: {}, destroy: () => {} });
	class Texture {
		width = 10;
		height = 10;
		frame = { x: 0, y: 0, width: 10, height: 10 };
		source = {};
		destroy() {}
		static from() {
			return texture();
		}
	}
	class Sprite {
		anchor = point();
		position = point();
		scale = point();
		width = 0;
		height = 0;
		tint = 0;
		alpha = 1;
		visible = true;
		rotation = 0;
		constructor(public texture: unknown) {}
	}
	class Application {
		renderer: unknown = null;
		canvas: HTMLCanvasElement = document.createElement("canvas");
		stage = new Container();
		async init(options: Record<string, unknown>) {
			record.init = options;
			if (record.failInit) throw new Error("no renderer");
			record.canvas = this.canvas;
			this.renderer = { name: record.renderer, gl: record.renderer === "webgl" ? { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => record.maxTextureSize } : undefined, resize: () => {} };
		}
		render() {
			record.renders += 1;
		}
		destroy(...args: unknown[]) {
			record.destroyed.push(args);
		}
	}
	return {
		record,
		Container,
		Sprite,
		Application,
		Texture,
		Rectangle: function Rectangle() {
			return {};
		},
		Graphics: function Graphics() {
			return chain();
		},
		Spritesheet: class Spritesheet {
			textures: Record<string, object> = {};
			constructor(
				_texture: unknown,
				public data: { frames: Record<string, unknown> },
			) {}
			destroy() {}
			async parse() {
				for (const name of Object.keys(this.data.frames)) this.textures[name] = texture();
			}
		},
	};
});

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => ({ Application: pixi.Application, Container: pixi.Container, Sprite: pixi.Sprite, Graphics: pixi.Graphics, Texture: pixi.Texture, Spritesheet: pixi.Spritesheet, Rectangle: pixi.Rectangle }));

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
let fetched: string[] = [];

function options(over: Partial<LiveMapMountOptions> = {}): LiveMapMountOptions {
	return { host: document.createElement("div"), assets: fixtureAssets(), state: played([]).state, width: 1200, height: 720, saveData: false, record: true, now: () => frames.now, reduceMotion: () => reduce, ...over };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	Object.assign(pixi.record, { init: null, renderer: "webgl", maxTextureSize: 4096, failInit: false, renders: 0, destroyed: [], canvas: null });
	frames.queue.clear();
	frames.now = 0;
	reduce = true;
	fetched = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		const id = frames.next++;
		frames.queue.set(id, cb);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.queue.delete(id));
	vi.stubGlobal("devicePixelRatio", 3);
	// The atlas sheet is served from the fixtures, as the page's server would.
	vi.stubGlobal("fetch", async (url: string) => {
		fetched.push(url);
		return { ok: true, status: 200, json: async () => fixtureFile(url.replace("/observatory/", "")) };
	});
	// jsdom has no image decoding; this file's environment is its own.
	HTMLImageElement.prototype.decode = () => Promise.resolve();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mounting the Live Map", () => {
	it("starts WebGL then Canvas, not WebGPU, without autostart, at a resolution of at most 2", async () => {
		const handle = await mountLiveMap(options());
		expect(pixi.record.init).toMatchObject({ preference: ["webgl", "canvas"], autoStart: false, sharedTicker: false, resolution: 2 });
		expect(handle.renderer).toBe("webgl");
		expect(handle.canvas.getAttribute("aria-hidden")).toBe("true");
		expect(fetched).toEqual([`/observatory/${SHEET_FILE}`]);
		handle.destroy();
	});

	it("takes the half plate when the GPU cannot hold the full one, or the frame is narrow", async () => {
		const { table } = fixtureAssets();
		pixi.record.maxTextureSize = 2048;
		const small = await mountLiveMap(options());
		expect(small.plate).toEqual(table.plate.half);
		small.destroy();
		pixi.record.maxTextureSize = 8192;
		expect((await mountLiveMap(options())).plate).toEqual(table.plate.full);
		expect((await mountLiveMap(options({ width: 600 }))).plate).toEqual(table.plate.half);
		pixi.record.renderer = "canvas";
		const canvas = await mountLiveMap(options());
		expect(canvas.renderer).toBe("canvas");
	});

	it("leaves out an atlas that does not load and still starts", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 404, json: async () => ({}) }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handle = await mountLiveMap(options());
		expect(warn).toHaveBeenCalled();
		frames.run(100);
		expect(handle.frames()).toBeGreaterThan(0);
		handle.destroy();
	});

	it("with reduced motion draws its first frames, then 0 frames over an idle minute", async () => {
		const handle = await mountLiveMap(options());
		frames.run(500);
		const settled = handle.frames();
		expect(settled).toBeGreaterThan(0);
		frames.run(60_000);
		expect(handle.frames()).toBe(settled);
		expect(frames.queue.size).toBe(0);
		handle.destroy();
	});

	it("draws the idle scene's gentle motion at 20 frames a second at most", async () => {
		reduce = false;
		const handle = await mountLiveMap(options());
		frames.run(1_000);
		const start = handle.frames();
		frames.run(60_000);
		const idle = handle.frames() - start;
		expect(idle).toBeGreaterThan(60 * 5);
		expect(idle).toBeLessThanOrEqual(60 * 20 + 1);
		handle.destroy();
	});

	it("does not draw the idle motion with save-data", async () => {
		reduce = false;
		const handle = await mountLiveMap(options({ saveData: true }));
		frames.run(1_000);
		const settled = handle.frames();
		frames.run(30_000);
		expect(handle.frames()).toBe(settled);
		handle.destroy();
	});

	it("plays animations with their source events", async () => {
		const handle = await mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10), tool("r1", 20, { success: true })]);
		handle.update({ ...state, live: null }, animations);
		frames.run(2_000);
		expect(handle.animationLog().map((e) => e.eventId)).toEqual(expect.arrayContaining(["prompt:p1", "tool:r1"]));
		expect(handle.animationLog().every((e) => e.eventId !== "")).toBe(true);
		handle.destroy();
	});

	it("stops the model thinking on the scene when no event came for CORE_SPIN_IDLE_MS", async () => {
		reduce = false;
		const handle = await mountLiveMap(options());
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

	it("follows the activity with the camera, and a drag switches it to free", async () => {
		const onCamera = vi.fn();
		const onView = vi.fn();
		const handle = await mountLiveMap(options({ onCamera, onView }));
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

	it("finds the packet under a click while it moves", async () => {
		const handle = await mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10, { station: "FILES" })]);
		handle.update(state, animations.filter((a) => a.eventId === "tool:r1"));
		const scene = fixtureAssets().scene;
		const start = scene.places.files.route[0] ?? [0, 0];
		// The frame's point of the packet's start (the road's first point) at the current view.
		let hit: string | null = null;
		for (let x = 0; x <= 1200 && hit === null; x += 10) for (let y = 0; y <= 720 && hit === null; y += 10) {
			const [sx, sy] = handle.toScene(x, y);
			if (Math.hypot(sx - start[0], sy - start[1]) < 40) hit = handle.hitEvent(x, y);
		}
		expect(hit).toBe("tool:r1");
		expect(handle.hitEvent(1, 1)).toBeNull();
		handle.destroy();
	});

	it("stops on a lost context, shows the still plate, and draws the current state on restore", async () => {
		const onStill = vi.fn();
		const onRestored = vi.fn();
		const handle = await mountLiveMap(options({ onStill, onRestored }));
		frames.run(100);
		handle.canvas.dispatchEvent(new Event("webglcontextlost"));
		expect(onStill).toHaveBeenCalledWith("lost");
		const { state, animations } = played([prompt(1, 0), lifecycle("stop", "s", 10)]);
		handle.update(state, animations);
		const before = handle.frames();
		frames.run(5_000);
		expect(handle.frames()).toBe(before);
		handle.canvas.dispatchEvent(new Event("webglcontextrestored"));
		expect(onRestored).toHaveBeenCalledOnce();
		frames.run(100);
		expect(handle.frames()).toBeGreaterThan(before);
		handle.destroy();
	});

	it("destroys the app with its children and textures and removes every listener", async () => {
		const add = vi.spyOn(document, "addEventListener");
		const remove = vi.spyOn(document, "removeEventListener");
		const onStill = vi.fn();
		const handle = await mountLiveMap(options({ onStill }));
		const listened = add.mock.calls.map(([type]) => type);
		handle.destroy();
		expect(pixi.record.destroyed).toEqual([[true, { children: true, texture: true, textureSource: true }]]);
		expect(remove.mock.calls.map(([type]) => type)).toEqual(listened);
		handle.canvas.dispatchEvent(new Event("webglcontextlost"));
		expect(onStill).not.toHaveBeenCalled();
		frames.run(1_000);
		expect(frames.queue.size).toBe(0);
		handle.destroy();
		expect(pixi.record.destroyed).toHaveLength(1);
	});

	it("destroys the app and throws when no renderer starts", async () => {
		pixi.record.failInit = true;
		await expect(mountLiveMap(options())).rejects.toThrow(/no renderer/);
		expect(pixi.record.destroyed).toEqual([[true]]);
	});
});
