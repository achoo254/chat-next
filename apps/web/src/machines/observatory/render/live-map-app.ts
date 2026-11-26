// The Live Map's scene on a 2D canvas: mounted while the Observe tab shows,
// dropped when it unmounts. It owns the camera (camera-director.ts): the
// camera eases inside the scene's frames, and every change of the view is
// handed to the page (onView) so the DOM layer (the modules' buttons) moves
// with it. The picture is drawn by interior-painter.ts from the scene's look
// (prop-map.ts); the packets of arriving events are timed by
// animation-director.ts.
//
// No eval, no worker, no image: nothing here needs the Content Security
// Policy loosened.
//
// Frames (frame-gate.ts): every display frame only while something animates
// (a packet, the model thinking, the camera easing, a module's glow fading);
// otherwise at most 20 per second for the steady motion (dashes flowing on a
// busy trace, the idle scene breathing), and none at all under reduced motion
// or save-data, where a timer still wakes the scene when a running call
// passes its p95 or a CI run turns unknown. The model stops thinking on the
// scene when no event came for CORE_SPIN_IDLE_MS.
import type { Animation, LiveMapState } from "../live-map-state.ts";
import { AnimationDirector, type DirectorLogEntry } from "./animation-director.ts";
import { activityZone, CameraDirector, type Activity, type CameraMode, type CameraView } from "./camera-director.ts";
import { createFrameGate, intersectionWatcher, type DrawResult, type FrameGateDeps } from "./frame-gate.ts";
import { InteriorPainter, INK, type SceneCopy } from "./interior-painter.ts";
import { activityOf, CORE_SPIN_IDLE_MS, lookOf, sameLook, type SceneLook } from "./prop-map.ts";
import { fitScene, INTERIOR, placeAt, type PlaceId, type SceneFit, type SceneTable } from "./scene-table.ts";

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

/** Where the scene's origin sits in the frame (CSS px) and its scale. */
export interface RootPlacement {
	readonly scale: number;
	readonly x: number;
	readonly y: number;
}

/** The words drawn on the canvas, in the viewer's language. */
export interface PaintWords {
	readonly copy: SceneCopy;
	readonly duration: (ms: number) => string;
}

export interface LiveMapMountOptions {
	/** The element the canvas goes into; it sizes the scene. */
	readonly host: HTMLElement;
	readonly state: LiveMapState;
	readonly width: number;
	readonly height: number;
	readonly words: PaintWords;
	/** "Ẩn chi tiết" at mount. */
	readonly hide?: boolean;
	/** navigator.connection.saveData. */
	readonly saveData: boolean;
	/** Reduced motion asked for (read each frame, so a change applies at once). */
	readonly reduceMotion?: () => boolean;
	/** Keep the animation log. */
	readonly record?: boolean;
	/** The scene moved under the camera: where the origin sits in the frame, and the camera's view. */
	readonly onView?: (placement: RootPlacement, view: CameraView) => void;
	/** The camera's mode, zone, content zone or move count changed. */
	readonly onCamera?: (camera: CameraState) => void;
	/** The Capacitor app's foreground changes (native build only). */
	readonly watchAppState?: FrameGateDeps["watchAppState"];
	/** Animation clock (ms); performance.now by default. */
	readonly now?: () => number;
	/** The machine's clock (ms), for runtimes against p95; Date.now by default. */
	readonly wallClock?: () => number;
	/** The scene; the machine's interior by default. */
	readonly scene?: SceneTable;
}

export interface LiveMapHandle {
	readonly canvas: HTMLCanvasElement;
	/** A new state and the animations it queued (taken from it by the caller). */
	update(state: LiveMapState, animations: readonly Animation[]): void;
	/** The frame's size in CSS pixels. */
	resize(width: number, height: number): void;
	/** New words (the viewer changed language). */
	setWords(words: PaintWords): void;
	/** "Ẩn chi tiết" switched. */
	setHide(hide: boolean): void;
	/** The source event of the moving packet at a frame point (CSS pixels), or null. */
	hitEvent(x: number, y: number): string | null;
	/** The module at a frame point (CSS pixels), or null. */
	placeAt(x: number, y: number): PlaceId | null;
	/** A frame point (CSS pixels) in scene pixels. */
	toScene(x: number, y: number): readonly [number, number];
	setCameraMode(mode: CameraMode): void;
	/** The selected place (focus locks on it). */
	select(place: PlaceId | null): void;
	/** The module the keyboard is on (null: none): the camera frames it, except in free. */
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

/** Where the origin sits for a fit and a camera view: the view's centre in the frame's middle. */
export function placementOf(fit: SceneFit, frame: { width: number; height: number }, view: CameraView): RootPlacement {
	const scale = fit.scale * view.s;
	return { scale, x: frame.width / 2 - view.x * scale, y: frame.height / 2 - view.y * scale };
}

export function mountLiveMap(o: LiveMapMountOptions): LiveMapHandle {
	const now = o.now ?? (() => performance.now());
	const reduce = o.reduceMotion ?? (() => false);
	const scene = o.scene ?? INTERIOR;
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (ctx === null) throw new Error("live map: no 2D canvas");
	canvas.setAttribute("aria-hidden", "true");
	canvas.classList.add("lm-canvas");
	o.host.appendChild(canvas);

	const painter = new InteriorPainter(scene);
	const director = new AnimationDirector(scene, { record: o.record === true });
	const cameraDirector = new CameraDirector(scene);
	let words = o.words;
	let hide = o.hide === true;
	let state = o.state;
	const wall = (): number => (o.wallClock ?? Date.now)();
	let look: SceneLook = lookOf(state, scene, wall());
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
	let dpr = 1;
	let fit = fitScene(scene.space, size);
	let placement = placementOf(fit, size, cameraDirector.view);
	let camera: CameraState = { mode: "auto", zone: null, contentZone: null, switches: 0 };
	let lastT: number | null = null;

	const sizeCanvas = (): void => {
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.max(1, Math.round(size.width * dpr));
		canvas.height = Math.max(1, Math.round(size.height * dpr));
		canvas.style.width = `${size.width}px`;
		canvas.style.height = `${size.height}px`;
	};
	sizeCanvas();
	const place = (): void => {
		placement = placementOf(fit, size, cameraDirector.view);
		o.onView?.(placement, cameraDirector.view);
	};
	place();

	/** The next moment the picture changes by itself (a call past its p95, a CI run turning unknown), machine ms; null: none. */
	const nextDue = (at: number): number | null => {
		let due = look.pipeline.ciStaleAt;
		for (const road of look.roads) for (const job of road.running) if (job.overAt !== null && job.overAt > at && (due === null || job.overAt < due)) due = job.overAt;
		return due;
	};

	const draw = (t: number): DrawResult => {
		const motion = !reduce();
		const at = wall();
		const dt = lastT === null ? 16 : Math.min(64, Math.max(0, t - lastT));
		lastT = t;
		if (look.pipeline.ciStaleAt !== null && at >= look.pipeline.ciStaleAt) look = lookOf(state, scene, at);
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
		const isThinking = look.mode === "think" && thinking(t);
		const moves = director.frame(t);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = INK.board;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr * placement.scale, 0, 0, dpr * placement.scale, dpr * placement.x, dpr * placement.y);
		painter.paint(ctx, { look, state, wall: at, t, dt, moves, thinking: isThinking, selected: cameraDirector.selected, contentZone, hide, motion, copy: words.copy, duration: words.duration });
		if (cam.wakeAt !== null) gate.wakeIn(cam.wakeAt - t);
		// Packets, the camera easing, a glow fading, the model thinking: the full rate.
		if (moves.length > 0 || !cam.settled || (motion && (painter.animating || isThinking))) return "moving";
		// The steady motion of a busy or idle scene: the ambient rate (none under reduced motion or save-data).
		const due = nextDue(at);
		if (due !== null) gate.wakeIn(Math.max(0, due - at));
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
	gate.wake();

	const toScene = (x: number, y: number): readonly [number, number] => [(x - placement.x) / (placement.scale || 1), (y - placement.y) / (placement.scale || 1)];
	let destroyed = false;
	return {
		canvas,
		update(next, animations) {
			if (destroyed) return;
			state = next;
			const t = now();
			activity = activityOf(state);
			const nextLook = lookOf(state, scene, wall());
			if (!sameLook(look, nextLook)) look = nextLook;
			noteThinking(t);
			director.play(animations, state, t);
			// The camera reads the activity at once (a call's end is its moment), then the frame draws it.
			gate.wake();
		},
		resize(width, height) {
			if (destroyed || width <= 0 || height <= 0) return;
			size = { width, height };
			fit = fitScene(scene.space, size);
			sizeCanvas();
			place();
			gate.wake();
		},
		setWords(next) {
			words = next;
			gate.wake();
		},
		setHide(next) {
			hide = next;
			gate.wake();
		},
		hitEvent(x, y) {
			return director.hit(toScene(x, y), now());
		},
		placeAt(x, y) {
			return placeAt(scene, toScene(x, y));
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
			director.clear();
			canvas.remove();
		},
	};
}
