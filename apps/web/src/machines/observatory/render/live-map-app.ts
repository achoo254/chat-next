// The Live Map's PixiJS scene: loaded on demand by the Observe tab (its own
// chunk, never at startup), mounted while the tab shows, destroyed with every
// GPU resource when it unmounts.
//
// Content Security Policy: production serves `script-src 'self' …
// 'wasm-unsafe-eval'` without 'unsafe-eval' and `worker-src 'self'` without
// blob: (infra/chat/nginx/chat.hoandat.com.conf). PixiJS v8 generates its
// uniform and shader sync code with `new Function`, so "pixi.js/unsafe-eval"
// is imported first, before anything starts PixiJS; and nothing here uses
// PixiJS's Assets loader, whose texture worker starts from a blob: URL (the
// plate and the atlases load as plain images). DO NOT LOOSEN THE CSP to make
// the renderer work: no 'unsafe-eval', no blob:, no new source. A renderer
// that cannot start under it falls back to the still view.
//
// Renderers: WebGL, else PixiJS's Canvas renderer; never WebGPU. Frames run
// only while something moves (frame-gate.ts); a lost GPU context shows the
// still plate (context-guard.ts).
import "pixi.js/unsafe-eval";
import { Application, Spritesheet, Texture, type SpritesheetData } from "pixi.js";
import type { Animation, LiveMapState } from "../live-map-state.ts";
import { AnimationDirector, type DirectorLogEntry } from "./animation-director.ts";
import { guardContext } from "./context-guard.ts";
import { createFrameGate, intersectionWatcher, type FrameGateDeps } from "./frame-gate.ts";
import { lookOf, sameLook, type SceneLook } from "./prop-map.ts";
import { SceneLayers, makeGlowTexture, readPalette } from "./scene-layers.ts";
import { choosePlate, fitScene, unproject, type PlaceId, type PlateFile, type SceneAssets } from "./scene-table.ts";

export type RendererKind = "webgl" | "canvas";

export interface LiveMapMountOptions {
	/** The element the canvas goes into; it sizes the scene. */
	readonly host: HTMLElement;
	readonly assets: SceneAssets;
	readonly state: LiveMapState;
	readonly width: number;
	readonly height: number;
	/** navigator.connection.saveData. */
	readonly saveData: boolean;
	/** Keep the animation log. */
	readonly record?: boolean;
	readonly onBatch?: (place: PlaceId, count: number | null) => void;
	/** The GPU context was lost (show the still plate) or lost twice in a minute (stay still). */
	readonly onStill?: (reason: "lost" | "given-up") => void;
	/** The context came back: the canvas draws again. */
	readonly onRestored?: () => void;
	/** The Capacitor app's foreground changes (native build only). */
	readonly watchAppState?: FrameGateDeps["watchAppState"];
	/** Clock (ms); performance.now by default. */
	readonly now?: () => number;
}

export interface LiveMapHandle {
	readonly renderer: RendererKind;
	readonly plate: PlateFile;
	readonly canvas: HTMLCanvasElement;
	/** A new state and the animations it queued (taken from it by the caller). */
	update(state: LiveMapState, animations: readonly Animation[]): void;
	/** The frame's size in CSS pixels. */
	resize(width: number, height: number): void;
	/** The source event of the moving piece at a frame point (CSS pixels), or null. */
	hitEvent(x: number, y: number): string | null;
	/** Frames drawn since mount. */
	frames(): number;
	animationLog(): readonly DirectorLogEntry[];
	destroy(): void;
}

/** The WebGL context of a renderer, when it has one. */
function glOf(renderer: object): WebGLRenderingContext | null {
	if (!("gl" in renderer)) return null;
	const gl: unknown = renderer.gl;
	return typeof gl === "object" && gl !== null && "getParameter" in gl && typeof gl.getParameter === "function" ? (gl as WebGLRenderingContext) : null;
}

/** A PixiJS spritesheet JSON: frames by name and meta (Spritesheet.parse reads the rest). */
function isSheet(v: unknown): v is SpritesheetData {
	if (typeof v !== "object" || v === null) return false;
	const frames: unknown = "frames" in v ? v.frames : undefined;
	const meta: unknown = "meta" in v ? v.meta : undefined;
	return typeof frames === "object" && frames !== null && typeof meta === "object" && meta !== null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
	const img = new Image();
	img.decoding = "async";
	img.src = url;
	return img.decode().then(() => img);
}

/** The atlases' sprites by name (none until the art is drawn). */
async function loadSprites(assets: SceneAssets): Promise<{ sprites: Map<string, Texture>; sheets: Spritesheet[] }> {
	const sprites = new Map<string, Texture>();
	const sheets: Spritesheet[] = [];
	for (const atlas of assets.table.atlases) {
		const response = await fetch(assets.base + atlas.sheet);
		if (!response.ok) throw new Error(`live map: atlas ${atlas.name} answered ${response.status}`);
		const data: unknown = await response.json();
		if (!isSheet(data)) throw new Error(`live map: atlas ${atlas.name} is not a spritesheet`);
		const sheet = new Spritesheet(Texture.from(await loadImage(assets.base + atlas.image)), data);
		await sheet.parse();
		sheets.push(sheet);
		for (const name of atlas.sprites) {
			const texture = sheet.textures[name] ?? sheet.textures[`${name}.png`];
			if (texture !== undefined) sprites.set(name, texture);
		}
	}
	return { sprites, sheets };
}

export async function mountLiveMap(o: LiveMapMountOptions): Promise<LiveMapHandle> {
	const now = o.now ?? (() => performance.now());
	const app = new Application();
	try {
		await app.init({
			preference: ["webgl", "canvas"],
			autoStart: false,
			sharedTicker: false,
			resolution: Math.min(window.devicePixelRatio || 1, 2),
			autoDensity: true,
			width: Math.max(1, o.width),
			height: Math.max(1, o.height),
			backgroundAlpha: 0,
			antialias: true,
		});
	} catch (error) {
		app.destroy(true);
		throw error;
	}
	const sheets: Spritesheet[] = [];
	try {
		const renderer: RendererKind = app.renderer.name === "webgl" ? "webgl" : "canvas";
		const gl = glOf(app.renderer);
		const maxTextureSize = gl === null ? null : Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
		const plate = choosePlate(o.assets.table, { maxTextureSize, frameWidth: o.width, saveData: o.saveData });
		const [plateImage, atlas] = await Promise.all([loadImage(o.assets.base + plate.file), loadSprites(o.assets)]);
		sheets.push(...atlas.sheets);
		const layers = new SceneLayers(o.assets.scene, { plate: Texture.from(plateImage), glow: atlas.sprites.get("glow") ?? makeGlowTexture(), sprites: atlas.sprites }, readPalette(o.host));
		app.stage.addChild(layers.root);
		const canvas = app.canvas;
		canvas.setAttribute("aria-hidden", "true");
		canvas.classList.add("lm-canvas");
		o.host.appendChild(canvas);

		const director = new AnimationDirector(o.assets.scene, { record: o.record === true, ...(o.onBatch === undefined ? {} : { onBatch: o.onBatch }) });
		let state = o.state;
		let look: SceneLook = lookOf(state, o.assets.scene);
		layers.setLook(look);
		let spin: { start: number; base: number; speed: number } | null = null;
		const spinTurns = (t: number): number | null => (spin === null ? null : spin.base + ((t - spin.start) / 1000) * spin.speed);
		const setSpin = (next: SceneLook["spin"], t: number): void => {
			if (next === null) spin = null;
			else if (spin === null) {
				spin = { start: t, base: 0, speed: next.speed };
				director.note(next.eventId, "core", "core-spin", t);
			} else if (spin.speed !== next.speed) spin = { start: t, base: spinTurns(t) ?? 0, speed: next.speed };
		};
		setSpin(look.spin, now());
		let fit = fitScene(o.assets.scene.space, { width: o.width, height: o.height });
		layers.layout(fit);

		const watchOnScreen = intersectionWatcher();
		const gate = createFrameGate(
			canvas,
			() => {
				const t = now();
				layers.drawFrame(director.frame(t), spinTurns(t));
				app.render();
				return director.busy || spin !== null;
			},
			{
				requestFrame: (cb) => requestAnimationFrame(cb),
				cancelFrame: (id) => cancelAnimationFrame(id),
				page: document,
				...(watchOnScreen === undefined ? {} : { watchOnScreen }),
				...(o.watchAppState === undefined ? {} : { watchAppState: o.watchAppState }),
			},
		);
		const guard = guardContext(canvas, {
			lost() {
				gate.setContextLost(true);
				director.clear();
				o.onStill?.("lost");
			},
			restored() {
				// PixiJS uploads the textures again from their kept images; draw the state as it is now.
				layers.setLook(look);
				gate.setContextLost(false);
				gate.wake();
				o.onRestored?.();
			},
			givenUp() {
				o.onStill?.("given-up");
			},
		});
		gate.wake();

		let destroyed = false;
		return {
			renderer,
			plate,
			canvas,
			update(next, animations) {
				if (destroyed) return;
				state = next;
				const t = now();
				const nextLook = lookOf(state, o.assets.scene);
				const changed = !sameLook(look, nextLook);
				if (changed) {
					look = nextLook;
					layers.setLook(look);
				}
				setSpin(look.spin, t);
				director.play(animations, state, t);
				if (changed || animations.length > 0) gate.wake();
			},
			resize(width, height) {
				if (destroyed || width <= 0 || height <= 0) return;
				app.renderer.resize(width, height);
				fit = fitScene(o.assets.scene.space, { width, height });
				layers.layout(fit);
				gate.wake();
			},
			hitEvent(x, y) {
				return director.hit(unproject(x, y, fit), now());
			},
			frames: () => gate.frames,
			animationLog: () => director.log(),
			destroy() {
				if (destroyed) return;
				destroyed = true;
				gate.dispose();
				guard.dispose();
				director.clear();
				for (const sheet of sheets) sheet.destroy(true);
				app.destroy(true, { children: true, texture: true, textureSource: true });
			},
		};
	} catch (error) {
		for (const sheet of sheets) sheet.destroy(true);
		app.destroy(true, { children: true, texture: true, textureSource: true });
		throw error;
	}
}
