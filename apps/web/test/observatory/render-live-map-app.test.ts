// The Live Map's PixiJS glue with PixiJS replaced by a recorder: it starts
// WebGL then Canvas (never WebGPU) without autostart at a resolution of at
// most 2, picks the plate by MAX_TEXTURE_SIZE, draws nothing more after its
// first frame while idle, plays animations with their source events in the
// log, stops turning a thinking core no event moved for a while, stops on a lost context and draws again on restore, and on destroy
// removes every listener and destroys the app with its children and textures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMapMountOptions } from "../../src/machines/observatory/render/live-map-app.ts";
import { CORE_SPIN_IDLE_MS } from "../../src/machines/observatory/render/prop-map.ts";
import { prompt, tool } from "../machines/observatory/live-map-fixtures.ts";
import { played, shippedAssets } from "./render-fixtures.ts";

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
		addChild(...c: unknown[]) {
			this.children.push(...c);
		}
	}
	class Sprite {
		anchor = point();
		position = point();
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
	return { record, Container, Sprite, Application, Graphics: function Graphics() { return chain(); }, Texture: { from: () => ({}) }, Spritesheet: function Spritesheet() {} };
});

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => ({ Application: pixi.Application, Container: pixi.Container, Sprite: pixi.Sprite, Graphics: pixi.Graphics, Texture: pixi.Texture, Spritesheet: pixi.Spritesheet }));

/** requestAnimationFrame at 60 frames per second, run by hand. */
const frames = {
	queue: new Map<number, FrameRequestCallback>(),
	next: 1,
	now: 0,
	run(ms: number) {
		const end = frames.now + ms;
		while (frames.now < end) {
			frames.now += 16;
			const due = [...frames.queue.values()];
			frames.queue.clear();
			for (const cb of due) cb(frames.now);
		}
	},
};

const { mountLiveMap } = await import("../../src/machines/observatory/render/live-map-app.ts");

function options(over: Partial<LiveMapMountOptions> = {}): LiveMapMountOptions {
	return { host: document.createElement("div"), assets: shippedAssets(), state: played([]).state, width: 1200, height: 900, saveData: false, record: true, now: () => frames.now, ...over };
}

beforeEach(() => {
	Object.assign(pixi.record, { init: null, renderer: "webgl", maxTextureSize: 4096, failInit: false, renders: 0, destroyed: [], canvas: null });
	frames.queue.clear();
	frames.now = 0;
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		const id = frames.next++;
		frames.queue.set(id, cb);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.queue.delete(id));
	vi.stubGlobal("devicePixelRatio", 3);
	// jsdom has no image decoding; this file's environment is its own.
	HTMLImageElement.prototype.decode = () => Promise.resolve();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mounting the Live Map", () => {
	it("starts WebGL then Canvas, not WebGPU, without autostart, at a resolution of at most 2", async () => {
		const handle = await mountLiveMap(options());
		expect(pixi.record.init).toMatchObject({ preference: ["webgl", "canvas"], autoStart: false, sharedTicker: false, resolution: 2 });
		expect(handle.renderer).toBe("webgl");
		expect(handle.canvas.getAttribute("aria-hidden")).toBe("true");
		handle.destroy();
	});

	it("takes the 1280 plate when the GPU cannot hold the 2560 one, or the frame is narrow", async () => {
		const { table } = shippedAssets();
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
		expect(canvas.plate).toEqual(table.plate.full);
	});

	it("draws its first frame, then 0 frames over an idle minute", async () => {
		const handle = await mountLiveMap(options());
		frames.run(100);
		const settled = handle.frames();
		expect(settled).toBe(1);
		frames.run(60_000);
		expect(handle.frames()).toBe(settled);
		expect(frames.queue.size).toBe(0);
		// A new state that changes nothing on the scene draws nothing either.
		handle.update(played([]).state, []);
		frames.run(1_000);
		expect(handle.frames()).toBe(settled);
		handle.destroy();
	});

	it("plays animations with their source events", async () => {
		const handle = await mountLiveMap(options());
		frames.run(100);
		const { state, animations } = played([prompt(1, 0), tool("r1", 10), tool("r1", 20, { success: true })]);
		// The prompt leaves the core thinking (it turns); a stop would still it.
		handle.update({ ...state, live: null }, animations);
		frames.run(2_000);
		expect(handle.frames()).toBeGreaterThan(60);
		expect(handle.animationLog().map((e) => e.eventId)).toEqual(expect.arrayContaining(["prompt:p1", "tool:r1"]));
		expect(handle.animationLog().every((e) => e.eventId !== "")).toBe(true);
		handle.destroy();
	});

	it("stops turning the thinking core when no event came for CORE_SPIN_IDLE_MS, and turns again on a new event", async () => {
		const handle = await mountLiveMap(options());
		frames.run(100);
		// A turn the person interrupted while the model thought: no event ends it.
		const thinking = played([prompt(1, 0)]);
		handle.update({ ...thinking.state, live: null }, thinking.animations);
		frames.run(CORE_SPIN_IDLE_MS - 1_000);
		expect(frames.queue.size).toBe(1);
		frames.run(2_000);
		const still = handle.frames();
		frames.run(60_000);
		expect(handle.frames()).toBe(still);
		expect(frames.queue.size).toBe(0);
		// The same state again does not start it.
		handle.update({ ...thinking.state, live: null }, []);
		frames.run(1_000);
		expect(handle.frames()).toBe(still);
		// A new event does.
		const next = played([prompt(1, 0), tool("r1", 10)]);
		handle.update({ ...next.state, live: null }, []);
		frames.run(1_000);
		expect(handle.frames()).toBeGreaterThan(still + 30);
		handle.destroy();
	});

	it("stops on a lost context, shows the still plate, and draws the current state on restore", async () => {
		const onStill = vi.fn();
		const onRestored = vi.fn();
		const handle = await mountLiveMap(options({ onStill, onRestored }));
		frames.run(100);
		handle.canvas.dispatchEvent(new Event("webglcontextlost"));
		expect(onStill).toHaveBeenCalledWith("lost");
		const { state, animations } = played([prompt(1, 0)]);
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
