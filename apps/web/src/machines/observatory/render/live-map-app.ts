// The Live Map's PixiJS scene: loaded on demand by the Observe tab (its own
// chunk, never at startup), mounted while the tab shows, destroyed with every
// GPU resource when it unmounts. It owns the camera (camera-director.ts): the
// camera eases inside the scene's frames, and every change of the view is
// handed to the page (onView) so the DOM layer (tags, boards, buttons) moves
// with it.
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
// Renderers: WebGL, else PixiJS's Canvas renderer; never WebGPU. Frames
// (frame-gate.ts): every display frame only while something animates (a
// packet, the model thinking, a drone in flight, the camera easing, a district
// fading in or out); otherwise at most 20 per second for the steady motion
// (energy flowing on a busy road, the idle scene breathing), and none at all
// under reduced motion or save-data, where a timer still wakes the scene when
// a running call passes its p95 or a CI run turns unknown. A run of tool calls
// or a wait for permission alone never holds the full display rate. The
// activity the camera follows is worked out once per update, not per frame.
// The model stops thinking on the scene when no event came for
// CORE_SPIN_IDLE_MS; a lost GPU context shows the still plate
// (context-guard.ts).
import "pixi.js/unsafe-eval";
import { Application, Spritesheet, Texture, type SpritesheetData } from "pixi.js";
import type { Animation, LiveMapState } from "../live-map-state.ts";
import { AnimationDirector, type DirectorLogEntry } from "./animation-director.ts";
import { activityZone, CameraDirector, type Activity, type CameraMode, type CameraView } from "./camera-director.ts";
import { guardContext } from "./context-guard.ts";
import { createFrameGate, intersectionWatcher, type DrawResult, type FrameGateDeps } from "./frame-gate.ts";
import { activityOf, CORE_SPIN_IDLE_MS, lookOf, sameLook, type SceneLook } from "./prop-map.ts";
import { makeGlowTexture, readPalette, SceneLayers, type RootPlacement } from "./scene-layers.ts";
import { choosePlate, fitScene, type PlaceId, type PlateFile, type SceneAssets, type SceneFit } from "./scene-table.ts";

export type RendererKind = "webgl" | "canvas";

/** Where the camera stands, as the page needs it. */
export interface CameraState {
	readonly mode: CameraMode;
	/** auto's zone (null: the whole scene). */
	readonly zone: PlaceId | null;
	/** The place whose live content shows (focus: the selection, auto: its zone, free: the activity's). */
	readonly contentZone: PlaceId | null;
	/** auto's moves so far. */
	readonly switches: number;
}

export interface LiveMapMountOptions {
	/** The element the canvas goes into; it sizes the scene. */
	readonly host: HTMLElement;
	readonly assets: SceneAssets;
	readonly state: LiveMapState;
	readonly width: number;
	readonly height: number;
	/** navigator.connection.saveData. */
	readonly saveData: boolean;
	/** Reduced motion asked for (read each frame, so a change applies at once). */
	readonly reduceMotion?: () => boolean;
	/** Keep the animation log. */
	readonly record?: boolean;
	readonly onBatch?: (place: PlaceId, count: number | null) => void;
	/** The scene moved under the camera: where the root sits in the frame, and the camera's view. */
	readonly onView?: (placement: RootPlacement, view: CameraView) => void;
	/** The camera's mode, zone, content zone or move count changed. */
	readonly onCamera?: (camera: CameraState) => void;
	/** The GPU context was lost (show the still plate) or lost twice in a minute (stay still). */
	readonly onStill?: (reason: "lost" | "given-up") => void;
	/** The context came back: the canvas draws again. */
	readonly onRestored?: () => void;
	/** The Capacitor app's foreground changes (native build only). */
	readonly watchAppState?: FrameGateDeps["watchAppState"];
	/** Animation clock (ms); performance.now by default. */
	readonly now?: () => number;
	/** The machine's clock (ms), for runtimes against p95; Date.now by default. */
	readonly wallClock?: () => number;
}

export interface LiveMapHandle {
	readonly renderer: RendererKind;
	readonly plate: PlateFile;
	readonly canvas: HTMLCanvasElement;
	/** A new state and the animations it queued (taken from it by the caller); `at`: the replayed moment (null: live). */
	update(state: LiveMapState, animations: readonly Animation[], at?: number | null): void;
	/** The frame's size in CSS pixels. */
	resize(width: number, height: number): void;
	/** The source event of the moving packet at a frame point (CSS pixels), or null. */
	hitEvent(x: number, y: number): string | null;
	/** A frame point (CSS pixels) in scene pixels. */
	toScene(x: number, y: number): readonly [number, number];
	setCameraMode(mode: CameraMode): void;
	/** The selected place (focus locks on it). */
	select(place: PlaceId | null): void;
	/** The district the keyboard is on (null: none): the camera frames it, except in free. */
	peek(place: PlaceId | null): void;
	/** A drag by (dx, dy) CSS pixels (switches to free). */
	pan(dx: number, dy: number): void;
	/** A zoom by `factor` about the frame point (x, y) (switches to free). */
	zoomAt(factor: number, x: number, y: number): void;
	camera(): CameraState;
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

/** The atlases' frames by name. An atlas that does not load is left out (its frames are not drawn), the scene still starts. */
async function loadSprites(assets: SceneAssets): Promise<{ sprites: Map<string, Texture>; sheets: Spritesheet[] }> {
	const sprites = new Map<string, Texture>();
	const sheets: Spritesheet[] = [];
	for (const atlas of assets.table.atlases) {
		try {
			const response = await fetch(assets.base + atlas.sheet);
			if (!response.ok) throw new Error(`answered ${response.status}`);
			const data: unknown = await response.json();
			if (!isSheet(data)) throw new Error("not a spritesheet");
			const sheet = new Spritesheet(Texture.from(await loadImage(assets.base + atlas.image)), data);
			await sheet.parse();
			sheets.push(sheet);
			for (const name of atlas.sprites) {
				const texture = sheet.textures[name] ?? sheet.textures[`${name}.png`];
				if (texture !== undefined) sprites.set(name, texture);
			}
		} catch (error) {
			console.warn(`live map: atlas ${atlas.name} left out`, error);
		}
	}
	return { sprites, sheets };
}

/** Where the root sits for a fit and a camera view: the view's centre in the frame's middle. */
export function placementOf(fit: SceneFit, frame: { width: number; height: number }, view: CameraView): RootPlacement {
	const scale = fit.scale * view.s;
	return { scale, x: frame.width / 2 - view.x * scale, y: frame.height / 2 - view.y * scale };
}

export async function mountLiveMap(o: LiveMapMountOptions): Promise<LiveMapHandle> {
	const now = o.now ?? (() => performance.now());
	const reduce = o.reduceMotion ?? (() => false);
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
	let glow: Texture | null = null;
	/** The textures this module made itself (PixiJS's destroy only reaches those still on a sprite). */
	const releaseOwn = (): void => {
		for (const sheet of sheets) sheet.destroy(true);
		if (glow !== null && !glow.destroyed) glow.destroy(true);
		glow = null;
	};
	try {
		const renderer: RendererKind = app.renderer.name === "webgl" ? "webgl" : "canvas";
		const gl = glOf(app.renderer);
		const maxTextureSize = gl === null ? null : Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
		const plate = choosePlate(o.assets.table, { maxTextureSize, frameWidth: o.width, saveData: o.saveData });
		const [plateImage, atlas] = await Promise.all([loadImage(o.assets.base + plate.file), loadSprites(o.assets)]);
		sheets.push(...atlas.sheets);
		const scene = o.assets.scene;
		// The atlas glow has rays; the soft one drawn in code reads better under data. Made here, destroyed here.
		glow = makeGlowTexture();
		const layers = new SceneLayers(scene, { plate: Texture.from(plateImage), glow, sprites: atlas.sprites }, readPalette(o.host));
		app.stage.addChild(layers.root);
		const canvas = app.canvas;
		canvas.setAttribute("aria-hidden", "true");
		canvas.classList.add("lm-canvas");
		o.host.appendChild(canvas);

		const director = new AnimationDirector(scene, { record: o.record === true, ...(o.onBatch === undefined ? {} : { onBatch: o.onBatch }) });
		const cameraDirector = new CameraDirector(scene);
		let state = o.state;
		let replayAt: number | null = null;
		const wall = (): number => replayAt ?? (o.wallClock ?? Date.now)();
		let look: SceneLook = lookOf(state, scene, wall());
		layers.setLook(look);
		/** What the camera follows, worked out once per state. */
		let activity: Activity = activityOf(state);
		/** The newest event the model thinks for and when it came (this clock): past CORE_SPIN_IDLE_MS without a newer one, it stops. */
		let thinkFor: { eventId: string; since: number } | null = null;
		const noteThinking = (t: number): void => {
			const id = look.thinkingFor;
			if (id === null) thinkFor = null;
			else if (thinkFor?.eventId !== id) {
				thinkFor = { eventId: id, since: t };
				director.note(id, "core", "think", t);
			}
		};
		const thinking = (t: number): boolean => thinkFor !== null && t - thinkFor.since < CORE_SPIN_IDLE_MS;
		noteThinking(now());
		let size = { width: o.width, height: o.height };
		let fit = fitScene(scene.space, size);
		let placement = placementOf(fit, size, cameraDirector.view);
		let camera: CameraState = { mode: "auto", zone: null, contentZone: null, switches: 0 };
		const place = (): void => {
			placement = placementOf(fit, size, cameraDirector.view);
			layers.layout(placement);
			o.onView?.(placement, cameraDirector.view);
		};
		place();

		/** The next moment the picture changes by itself (a call past its p95, a CI run turning unknown), machine ms; null: none. */
		const nextDue = (now: number): number | null => {
			let due = look.pipeline.ciStaleAt;
			for (const road of look.roads) for (const job of road.running) if (job.overAt !== null && job.overAt > now && (due === null || job.overAt < due)) due = job.overAt;
			return due;
		};

		const draw = (t: number): DrawResult => {
			const motion = !reduce();
			const at = wall();
			if (look.pipeline.ciStaleAt !== null && at >= look.pipeline.ciStaleAt) {
				look = lookOf(state, scene, at);
				layers.setLook(look);
			}
			const before = cameraDirector.view;
			const cam = cameraDirector.step(activity, t, !motion);
			if (cam.view !== before) place();
			const mode = cameraDirector.mode;
			const contentZone = mode === "free" ? activityZone(activity) : (cameraDirector.peeked ?? (mode === "focus" ? cameraDirector.selected : cam.zone));
			const next: CameraState = { mode, zone: cam.zone, contentZone, switches: cameraDirector.switches };
			if (next.mode !== camera.mode || next.zone !== camera.zone || next.contentZone !== camera.contentZone || next.switches !== camera.switches) {
				camera = next;
				o.onCamera?.(camera);
			}
			layers.setFocus(cameraDirector.selected, contentZone);
			const isThinking = look.mode === "think" && thinking(t);
			const animating = layers.drawFrame({ t, wall: at, moves: director.frame(t), thinking: isThinking, motion });
			app.render();
			if (cam.wakeAt !== null) gate.wakeIn(cam.wakeAt - t);
			// Packets, the camera easing, a drone in flight, a district fading, the model thinking: the full rate.
			if (director.busy || !cam.settled || animating || (motion && isThinking)) return "moving";
			// The steady motion of a busy or idle scene: the ambient rate (none under reduced motion or save-data).
			const due = nextDue(at);
			if (due !== null && replayAt === null) gate.wakeIn(Math.max(0, due - at));
			return "ambient";
		};
		const watchOnScreen = intersectionWatcher();
		const gate = createFrameGate(canvas, draw, {
			requestFrame: (cb) => requestAnimationFrame(cb),
			cancelFrame: (id) => cancelAnimationFrame(id),
			page: document,
			ambientAllowed: () => !reduce() && !o.saveData,
			...(watchOnScreen === undefined ? {} : { watchOnScreen }),
			...(o.watchAppState === undefined ? {} : { watchAppState: o.watchAppState }),
		});
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

		const toScene = (x: number, y: number): readonly [number, number] => [(x - placement.x) / (placement.scale || 1), (y - placement.y) / (placement.scale || 1)];
		let destroyed = false;
		return {
			renderer,
			plate,
			canvas,
			update(next, animations, at = null) {
				if (destroyed) return;
				state = next;
				replayAt = at;
				const t = now();
				activity = activityOf(state);
				const nextLook = lookOf(state, scene, wall());
				const changed = !sameLook(look, nextLook);
				if (changed) {
					look = nextLook;
					layers.setLook(look);
				}
				noteThinking(t);
				director.play(animations, state, t);
				// The camera reads the activity at once (a call's end is its moment), then the frame draws it.
				gate.wake();
			},
			resize(width, height) {
				if (destroyed || width <= 0 || height <= 0) return;
				app.renderer.resize(width, height);
				size = { width, height };
				fit = fitScene(scene.space, size);
				place();
				gate.wake();
			},
			hitEvent(x, y) {
				return director.hit(toScene(x, y), now());
			},
			toScene,
			setCameraMode(mode) {
				cameraDirector.setMode(mode);
				gate.wake();
			},
			select(p) {
				cameraDirector.select(p);
				gate.wake();
			},
			peek(p) {
				cameraDirector.peek(p);
				gate.wake();
			},
			pan(dx, dy) {
				cameraDirector.pan(dx / (placement.scale || 1), dy / (placement.scale || 1));
				place();
				gate.wake();
			},
			zoomAt(factor, x, y) {
				const [sx, sy] = toScene(x, y);
				cameraDirector.zoomAt(factor, sx, sy);
				place();
				gate.wake();
			},
			camera: () => camera,
			frames: () => gate.frames,
			animationLog: () => director.log(),
			destroy() {
				if (destroyed) return;
				destroyed = true;
				gate.dispose();
				guard.dispose();
				director.clear();
				layers.destroy();
				releaseOwn();
				app.destroy(true, { children: true, texture: true, textureSource: true });
			},
		};
	} catch (error) {
		releaseOwn();
		app.destroy(true, { children: true, texture: true, textureSource: true });
		throw error;
	}
}
