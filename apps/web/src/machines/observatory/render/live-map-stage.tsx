// The Live Map's frame: the activity card (the main read) with the session's
// figures and "Ẩn chi tiết" (remembered on this device, it hides file names,
// domains, commands, MCP tool names, the account's email and content), then
// the scene: the plate and the PixiJS canvas (live-map-app.ts, its own chunk,
// loaded when the frame mounts and destroyed when it unmounts), and over it
// the DOM world layer the camera moves (stage-world-layer.tsx: buttons, tags,
// road figures, the pipeline's steps, the board of the district in view), the
// camera's modes, the overview map and the legend.
//
// Camera: auto follows the AI; a drag, a pinch or Ctrl/⌘ + wheel switches to
// free, where the wheel alone zooms too (elsewhere a plain wheel scrolls the
// page past the map); a click on a district selects it (its drawer opens as
// before) and switches to focus; a click on empty ground clears the selection
// and goes back to auto. Tab onto a district's button frames it (the camera
// leans to it, and the frame never scrolls under the canvas); Enter selects
// it. A click on a moving packet opens its source event. Live times read in
// the machine's clock (machine-clock.ts). When neither WebGL
// nor Canvas can draw, or the GPU context is lost, the plate shows as a still
// picture with the same tags and buttons (the camera then stays on the whole
// scene).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import { activityCardOf, DONE_HOLD_MS } from "../activity-card-model.ts";
import { ActivityCard } from "../activity-card.tsx";
import type { Animation, LiveMapState } from "../live-map-state.ts";
import { useObservatoryCopy } from "../observatory-copy.ts";
import { placeNames } from "../place-names.ts";
import { machineNow } from "../machine-clock.ts";
import { useTickingNow, type ContentSource } from "../use-tool-content.ts";
import { useMachinesCopy } from "../../use-machines-copy.ts";
import "../live-map.css";
import "../station-palette.css";
import type { CameraMode, CameraView } from "./camera-director.ts";
import type { CameraState, LiveMapHandle, LiveMapMountOptions } from "./live-map-app.ts";
import { lookOf } from "./prop-map.ts";
import type { RootPlacement } from "./scene-layers.ts";
import { CameraControls, Legend, Minimap } from "./stage-camera-controls.tsx";
import { WorldLayer } from "./stage-world-layer.tsx";
import { assetBase, choosePlate, fitScene, loadSceneAssets, PLACE_IDS, type PlaceId, type SceneAssets } from "./scene-table.ts";

export const HIDE_DETAILS_KEY = "observe.hideDetails";
/** "1" keeps the animation log and exposes the scene as window.__liveMap (acceptance runs). */
export const ANIMATION_LOG_KEY = "observe.animationLog";

type Mount = (options: LiveMapMountOptions) => Promise<LiveMapHandle>;

export interface LiveMapStageProps {
	readonly state: LiveMapState;
	/** The signed-in chat account's email: the input port's tag. */
	readonly accountEmail: string;
	readonly selectedPlace: PlaceId | null;
	readonly onStation: (place: PlaceId) => void;
	readonly onEvent: (eventId: string) => void;
	/** A click on empty ground: the selection goes. */
	readonly onDeselect?: () => void;
	/** "Ẩn chi tiết" was switched: the drawer and the detail follow it. */
	readonly onHideDetails?: (hide: boolean) => void;
	/** The replayed moment (machine ms); absent while live. */
	readonly replayAt?: number | undefined;
	/** The machine's clock minus the viewer's (ms): live times are compared with the machine's now (machine-clock.ts). */
	readonly clockSkewMs?: number | undefined;
	/** Where the card and boards may ask a call's content; absent: they say it is not available. */
	readonly contentSource?: ContentSource | undefined;
	/** Test seams: the asset loader and the renderer's module. */
	readonly loadAssets?: () => Promise<SceneAssets>;
	readonly loadRenderer?: () => Promise<{ mountLiveMap: Mount }>;
}

type RenderStatus = "loading" | "ready" | "still" | "lost";

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

/** Whether "Ẩn chi tiết" is on (remembered on this device). */
export function readHideDetails(): boolean {
	return readFlag(HIDE_DETAILS_KEY);
}

function writeFlag(key: string, on: boolean): void {
	try {
		if (on) localStorage.setItem(key, "1");
		else localStorage.removeItem(key);
	} catch {
		// Storage refused (private mode, quota): the choice lasts for this view only.
	}
}

function saveData(): boolean {
	const connection: unknown = "connection" in navigator ? navigator.connection : undefined;
	return typeof connection === "object" && connection !== null && "saveData" in connection && connection.saveData === true;
}

/** Reduced motion, read when asked (it can change while the map is open). */
function reduceMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The Capacitor app's foreground changes, in the native build only. */
function appStateWatcher(): LiveMapMountOptions["watchAppState"] {
	if (import.meta.env.VITE_NATIVE !== "true") return undefined;
	return (onChange) => import("../../../native/native-app.ts").then((native) => native.subscribeAppState(onChange));
}

const defaultAssets = (): Promise<SceneAssets> => loadSceneAssets(assetBase(import.meta.env.BASE_URL));
const defaultRenderer = (): Promise<{ mountLiveMap: Mount }> => import("./live-map-app.ts");

/** The frame's size, followed with ResizeObserver. */
function useSize(el: HTMLElement | null): { width: number; height: number } {
	const [size, setSize] = useState({ width: 0, height: 0 });
	useEffect(() => {
		if (el === null) return;
		const read = (): void => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
		read();
		if (typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => observer.disconnect();
	}, [el]);
	return size;
}

/** Moves the DOM world layer and the overview's view box with the camera (no React render). */
function applyView(world: HTMLElement | null, minimapView: HTMLElement | null, p: RootPlacement, view: CameraView, space: { width: number; height: number }): void {
	if (world !== null) {
		world.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
		world.style.setProperty("--lm-inv", String(p.scale > 0 ? 1 / p.scale : 1));
	}
	if (minimapView !== null) {
		const w = 1 / view.s;
		minimapView.style.left = `${((view.x - space.width * w * 0.5) / space.width) * 100}%`;
		minimapView.style.top = `${((view.y - space.height * w * 0.5) / space.height) * 100}%`;
		minimapView.style.width = `${w * 100}%`;
		minimapView.style.height = `${w * 100}%`;
	}
}

const AUTO: CameraState = { mode: "auto", zone: null, contentZone: null, switches: 0 };

export function LiveMapStage({ state, accountEmail, selectedPlace, onStation, onEvent, onDeselect, onHideDetails, replayAt, clockSkewMs = 0, contentSource, loadAssets = defaultAssets, loadRenderer = defaultRenderer }: LiveMapStageProps) {
	const observe = useMachinesCopy().observe;
	const t = observe.map;
	const c = useObservatoryCopy();
	const names = useMemo(() => placeNames(observe), [observe]);
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const host = useRef<HTMLDivElement | null>(null);
	const world = useRef<HTMLDivElement | null>(null);
	const minimapView = useRef<HTMLDivElement | null>(null);
	const size = useSize(frame);
	const [assets, setAssets] = useState<SceneAssets | null>(null);
	const [assetsFailed, setAssetsFailed] = useState(false);
	const [status, setStatus] = useState<RenderStatus>("loading");
	const [renderer, setRenderer] = useState<string>("");
	const [hide, setHide] = useState(() => readFlag(HIDE_DETAILS_KEY));
	const [batches, setBatches] = useState<Partial<Record<PlaceId, number>>>({});
	const [camera, setCamera] = useState<CameraState>(AUTO);
	const handle = useRef<LiveMapHandle | null>(null);
	const played = useRef(new WeakSet<Animation>());
	const latest = useRef(state);
	const skew = useRef(clockSkewMs);
	const onEventRef = useRef(onEvent);
	const gesture = useRef<{ pointers: Map<number, { x: number; y: number }>; moved: boolean; start: { x: number; y: number } | null; suppressClick: boolean }>({ pointers: new Map(), moved: false, start: null, suppressClick: false });
	useEffect(() => {
		latest.current = state;
		skew.current = clockSkewMs;
		onEventRef.current = onEvent;
	});

	useEffect(() => {
		let alive = true;
		loadAssets().then(
			(a) => {
				if (alive) setAssets(a);
			},
			(error: unknown) => {
				console.warn("live map: scene assets did not load", error);
				if (alive) setAssetsFailed(true);
			},
		);
		return () => {
			alive = false;
		};
	}, [loadAssets]);

	const ready = assets !== null && size.width > 0 && size.height > 0;
	// The renderer mounts once per frame lifetime; size changes go through resize.
	const mountSize = useRef(size);
	useEffect(() => {
		mountSize.current = size;
	});
	useEffect(() => {
		const el = host.current;
		if (!ready || assets === null || el === null) return;
		let alive = true;
		let mounted: LiveMapHandle | null = null;
		const record = readFlag(ANIMATION_LOG_KEY);
		// What is queued already played before the scene existed.
		for (const a of latest.current.animations) played.current.add(a);
		const watchAppState = appStateWatcher();
		loadRenderer()
			.then((module) =>
				module.mountLiveMap({
					host: el,
					assets,
					state: latest.current,
					width: mountSize.current.width,
					height: mountSize.current.height,
					saveData: saveData(),
					reduceMotion,
					wallClock: () => machineNow(Date.now(), skew.current),
					record,
					onBatch: (place, count) => setBatches((b) => ({ ...b, [place]: count ?? undefined })),
					onView: (p, view) => applyView(world.current, minimapView.current, p, view, assets.scene.space),
					onCamera: setCamera,
					onStill: (reason) => {
						if (reason === "given-up") {
							mounted?.destroy();
							mounted = null;
							handle.current = null;
							setStatus("still");
						} else setStatus("lost");
					},
					onRestored: () => setStatus("ready"),
					...(watchAppState === undefined ? {} : { watchAppState }),
				}),
			)
			.then(
				(h) => {
					if (!alive) {
						h.destroy();
						return;
					}
					mounted = h;
					handle.current = h;
					if (record) Reflect.set(window, "__liveMap", h);
					setRenderer(h.renderer);
					setStatus("ready");
				},
				(error: unknown) => {
					console.warn("live map: the renderer could not start, showing the still scene", error);
					if (alive) setStatus("still");
				},
			);
		return () => {
			alive = false;
			mounted?.destroy();
			mounted = null;
			handle.current = null;
			if (record) Reflect.deleteProperty(window, "__liveMap");
		};
	}, [ready, assets, loadRenderer]);

	useEffect(() => {
		const h = handle.current;
		if (h === null || status !== "ready") return;
		const fresh = state.animations.filter((a) => !played.current.has(a));
		for (const a of fresh) played.current.add(a);
		h.update(state, fresh, replayAt ?? null);
	}, [state, status, replayAt]);

	useEffect(() => {
		handle.current?.resize(size.width, size.height);
	}, [size.width, size.height, status]);

	// Without the renderer, the world layer stays on the whole scene.
	useEffect(() => {
		if (assets === null || status === "ready") return;
		const fit = fitScene(assets.scene.space, size);
		applyView(world.current, minimapView.current, { scale: fit.scale, x: fit.offsetX, y: fit.offsetY }, { x: assets.scene.space.width / 2, y: assets.scene.space.height / 2, s: 1 }, assets.scene.space);
	}, [assets, size, status]);

	useEffect(() => {
		handle.current?.select(selectedPlace);
		if (selectedPlace === null && camera.mode === "focus") handle.current?.setCameraMode("auto");
	}, [selectedPlace, camera.mode, status]);

	// Ctrl/⌘ + wheel zooms the scene (and switches to free); in free the wheel alone does. Otherwise the page scrolls.
	// A native listener: React's is passive.
	const cameraMode = useRef(camera.mode);
	useEffect(() => {
		cameraMode.current = camera.mode;
	});
	useEffect(() => {
		if (frame === null) return;
		const onWheel = (e: globalThis.WheelEvent): void => {
			const h = handle.current;
			if (h === null) return;
			if (!e.ctrlKey && !e.metaKey && cameraMode.current !== "free") return;
			e.preventDefault();
			const r = frame.getBoundingClientRect();
			h.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
		};
		frame.addEventListener("wheel", onWheel, { passive: false });
		return () => frame.removeEventListener("wheel", onWheel);
	}, [frame]);

	const look = useMemo(() => (assets === null ? null : lookOf(state, assets.scene)), [state, assets]);
	const busy = look !== null && look.mode !== "idle";
	// Live: the clock ticks while the AI works; a finished call's hold is read again once it is over.
	// A CI run's timer ticks too (it runs after Claude's turn), and it turns unknown once stale.
	const ciRunning = look !== null && look.pipeline.steps.ci.status === "run";
	const tick = useTickingNow(replayAt === undefined && (busy || ciRunning), state, DONE_HOLD_MS + 50, clockSkewMs);
	const now = replayAt ?? tick;
	const card = activityCardOf(state, now);
	const active = useMemo(() => new Set(look === null ? [] : PLACE_IDS.filter((p) => look.places[p].active)), [look]);

	const toggleHide = (): void => {
		const next = !hide;
		writeFlag(HIDE_DETAILS_KEY, next);
		setHide(next);
		onHideDetails?.(next);
	};

	const setMode = (mode: CameraMode): void => {
		handle.current?.setCameraMode(mode);
		if (mode === "focus" && selectedPlace === null) onStation(camera.zone ?? "core");
	};

	const local = (e: { clientX: number; clientY: number; currentTarget: Element }): { x: number; y: number } => {
		const r = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
		const g = gesture.current;
		g.pointers.set(e.pointerId, local(e));
		if (g.pointers.size === 1) {
			g.start = local(e);
			g.moved = false;
		}
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
		const g = gesture.current;
		const before = g.pointers.get(e.pointerId);
		const h = handle.current;
		if (before === undefined || h === null) return;
		const at = local(e);
		if (g.pointers.size === 2) {
			const [a, b] = [...g.pointers.values()];
			g.pointers.set(e.pointerId, at);
			const [a2, b2] = [...g.pointers.values()];
			if (a === undefined || b === undefined || a2 === undefined || b2 === undefined) return;
			const d0 = Math.hypot(a.x - b.x, a.y - b.y);
			const d1 = Math.hypot(a2.x - b2.x, a2.y - b2.y);
			if (d0 > 0) h.zoomAt(d1 / d0, (a2.x + b2.x) / 2, (a2.y + b2.y) / 2);
			g.moved = true;
			return;
		}
		g.pointers.set(e.pointerId, at);
		const start = g.start;
		if (start === null) return;
		if (!g.moved && Math.hypot(at.x - start.x, at.y - start.y) < 5) return;
		g.moved = true;
		h.pan(at.x - before.x, at.y - before.y);
	};
	const onPointerEnd = (e: PointerEvent<HTMLDivElement>): void => {
		const g = gesture.current;
		g.pointers.delete(e.pointerId);
		if (g.pointers.size === 0) {
			if (g.moved) g.suppressClick = true;
			g.start = null;
			g.moved = false;
		}
	};

	// The frame clips the scene (overflow hidden): focusing a button near its edge would scroll it and shift the DOM
	// layer off the canvas. It never scrolls; the camera frames the focused district instead.
	const keepUnscrolled = (el: HTMLElement): void => {
		if (el.scrollLeft !== 0) el.scrollLeft = 0;
		if (el.scrollTop !== 0) el.scrollTop = 0;
	};
	const hitPlace = (target: EventTarget | null): PlaceId | null => {
		if (!(target instanceof HTMLElement) || !target.classList.contains("lm-hit")) return null;
		return PLACE_IDS.find((p) => p === target.dataset.place) ?? null;
	};
	const onFocus = (e: FocusEvent<HTMLDivElement>): void => {
		keepUnscrolled(e.currentTarget);
		const place = hitPlace(e.target);
		if (place !== null) handle.current?.peek(place);
	};
	const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
		// Moving to another district's button: its own focus frames it.
		if (hitPlace(e.target) !== null && hitPlace(e.relatedTarget) === null) handle.current?.peek(null);
	};

	const onClick = (e: MouseEvent<HTMLDivElement>): void => {
		const g = gesture.current;
		if (g.suppressClick) {
			g.suppressClick = false;
			return;
		}
		// The controls over the scene handle their own clicks.
		if (e.target instanceof Element && e.target.closest(".lm-camctl, .lm-minimap, .lm-legend") !== null) return;
		const h = handle.current;
		// A pointer click (not Enter on a button) on a moving packet opens its event.
		if (h !== null && e.detail > 0) {
			const p = local(e);
			const id = h.hitEvent(p.x, p.y);
			if (id !== null) {
				onEventRef.current(id);
				return;
			}
		}
		const place = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-place]")?.dataset.place : undefined;
		const id = PLACE_IDS.find((p) => p === place);
		if (id !== undefined) {
			onStation(id);
			h?.select(id);
			h?.setCameraMode("focus");
		} else if (e.detail > 0) {
			onDeselect?.();
			h?.select(null);
			h?.setCameraMode("auto");
		}
	};

	const plate = assets === null ? null : choosePlate(assets.table, { maxTextureSize: null, frameWidth: size.width, saveData: saveData() });
	const showPlate = status !== "ready";
	const note = assetsFailed || status === "still" ? t.still : status === "lost" ? t.lost : null;
	const percent = state.live?.contextPercent ?? null;
	const tps = state.live?.tokensPerSecond ?? state.scene.tokensPerSecond;
	const model = state.live?.mainModel || state.scene.model;
	const contentZone = status === "ready" ? camera.contentZone : selectedPlace;
	const where = camera.mode === "free" ? c.camera.free : camera.mode === "focus" ? (selectedPlace === null ? c.camera.whole : names[selectedPlace]) : camera.zone === null ? c.camera.whole : names[camera.zone];

	return (
		<section className={`lm-stage${hide ? " is-hidden-details" : ""}`} aria-label={t.label} data-id="observe-stage" data-status={assetsFailed ? "still" : status} data-renderer={renderer} data-camera={camera.mode}>
			<div className="lm-meta" data-id="observe-meta">
				{percent !== null && (
					<span title={state.live?.contextWindowAssumed === true ? t.contextApproxHint : undefined} data-id="observe-context">
						{state.live?.contextWindowAssumed === true ? t.contextApprox(Math.round(percent)) : t.context(Math.round(percent))}
					</span>
				)}
				{tps !== null && <span>{t.speed(Math.round(tps))}</span>}
				{model !== "" && <span>{model}</span>}
				<label className="lm-toggle" title={t.hideDetailsHint}>
					<input type="checkbox" checked={hide} onChange={toggleHide} data-id="observe-hide-details" />
					{t.hideDetails}
				</label>
			</div>
			<ActivityCard card={card} names={names} hide={hide} source={contentSource ?? null} onDetail={(id) => onEventRef.current(id)} />
			{/* Pointer gestures only move the camera; every action is also a button reachable with Tab. */}
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
			<div
				className="lm-frame"
				ref={setFrame}
				onClick={onClick}
				onFocus={onFocus}
				onBlur={onBlur}
				onScroll={(e) => keepUnscrolled(e.currentTarget)}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerEnd}
				style={assets === null ? undefined : ({ "--lm-ratio": assets.scene.space.width / assets.scene.space.height } as CSSProperties)}
			>
				<div className="lm-canvas-host" ref={host} />
				<div className="lm-world" ref={world} style={assets === null ? undefined : { width: assets.scene.space.width, height: assets.scene.space.height }}>
					{showPlate && plate !== null && assets !== null && <img className="lm-plate" src={assets.base + plate.file} alt="" />}
					{assets !== null && (
						<WorldLayer
							scene={assets.scene}
							state={state}
							now={now}
							names={names}
							observe={observe}
							c={c}
							accountEmail={accountEmail}
							hide={hide}
							selectedPlace={selectedPlace}
							contentZone={contentZone}
							source={contentSource ?? null}
							batches={batches}
						/>
					)}
				</div>
				{assets !== null && <Minimap c={c} scene={assets.scene} active={active} viewRef={minimapView} />}
				{status === "ready" && <CameraControls c={c} mode={camera.mode} where={where} switches={camera.switches} onMode={setMode} />}
				<Legend c={c} />
			</div>
			{note !== null && (
				<p className="note lm-note" role="status" data-id="observe-still">
					{note}
				</p>
			)}
			{status === "loading" && !assetsFailed && (
				<p className="note lm-note" role="status">
					{t.loading}
				</p>
			)}
		</section>
	);
}
