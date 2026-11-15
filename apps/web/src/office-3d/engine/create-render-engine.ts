// Picks the render backend: WebGPU where the browser offers a working
// adapter, WebGL2 otherwise (from Chùa Nhỏ's create-render-engine.ts). A
// canvas keeps the first kind of context it hands out, so a WebGPU attempt
// that fails part-way gets its canvas thrown away and WebGL2 starts on a
// fresh one from `makeCanvas`.
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

export type RenderBackend = "webgpu" | "webgl2";
export type RendererPreference = "auto" | "webgl2";

export interface RenderEngine {
	readonly engine: AbstractEngine;
	readonly backend: RenderBackend;
	readonly canvas: HTMLCanvasElement;
}

/** Anti-aliasing is done in post-processing; the scaler sets the pixel ratio. */
const OPTIONS = { antialias: false, stencil: false, powerPreference: "high-performance", adaptToDeviceRatio: false } as const;

async function tryWebGpu(makeCanvas: () => HTMLCanvasElement): Promise<RenderEngine | null> {
	if (!("gpu" in navigator)) return null;
	if (!(await WebGPUEngine.IsSupportedAsync)) return null;
	const canvas = makeCanvas();
	const engine = new WebGPUEngine(canvas, { ...OPTIONS });
	try {
		await engine.initAsync();
		return { engine, backend: "webgpu", canvas };
	} catch (error) {
		console.warn("office: WebGPU could not start, trying WebGL2", error);
		engine.dispose();
		canvas.remove();
		return null;
	}
}

function tryWebGl2(makeCanvas: () => HTMLCanvasElement): RenderEngine | null {
	const canvas = makeCanvas();
	try {
		const engine = new Engine(canvas, OPTIONS.antialias, { ...OPTIONS, disableWebGL2Support: false }, OPTIONS.adaptToDeviceRatio);
		if (engine.webGLVersion < 2) {
			engine.dispose();
			canvas.remove();
			return null;
		}
		return { engine, backend: "webgl2", canvas };
	} catch (error) {
		console.warn("office: WebGL2 could not start", error);
		canvas.remove();
		return null;
	}
}

/** The best engine this browser can run, or null when neither WebGPU nor WebGL2 works. */
export async function createRenderEngine(makeCanvas: () => HTMLCanvasElement, preference: RendererPreference): Promise<RenderEngine | null> {
	if (preference === "auto") {
		const webGpu = await tryWebGpu(makeCanvas).catch((error: unknown) => {
			console.warn("office: WebGPU probe failed", error);
			return null;
		});
		if (webGpu !== null) return webGpu;
	}
	return tryWebGl2(makeCanvas);
}
