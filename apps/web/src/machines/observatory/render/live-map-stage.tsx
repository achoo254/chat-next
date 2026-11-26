// The Live Map, laid out as the approved design (prototype v6): on the left
// the activity card (the main read) over the scene of the machine's interior
// (a 2D canvas drawn by live-map-app.ts, mounted when the frame mounts and
// dropped when it unmounts) with the camera's modes; on the right the
// session's gauges, the detail of what was picked and the event list
// (live-map-side.tsx, event-feed.tsx); under them how to read the scene.
// "Ẩn chi tiết" (remembered on this device) hides file names, domains,
// commands, MCP tool names and content.
//
// Camera: auto follows the AI; a drag, a pinch or Ctrl/⌘ + wheel switches to
// free, where the wheel alone zooms too (elsewhere a plain wheel scrolls the
// page past the map); a click on a module picks it (its detail shows) and
// switches to focus; a click on empty ground clears the pick and goes back
// to auto. Each module is also a button under the canvas, reachable with
// Tab: focusing one frames it (the frame never scrolls), Enter picks it. A
// click on a moving packet opens its source event. Live times read in the
// machine's clock (machine-clock.ts). A browser without a 2D canvas shows
// the card and the column only.
import { useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import { activityCardOf, DONE_HOLD_MS } from "../activity-card-model.ts";
import { ActivityCard } from "../activity-card.tsx";
import { EventFeed, feedRowsOf } from "../event-feed.tsx";
import { duration } from "../drill-format.ts";
import type { Animation, LiveMapState } from "../live-map-state.ts";
import { DetailBox, SessionBox, type SidePick } from "../live-map-side.tsx";
import { machineNow } from "../machine-clock.ts";
import { useObservatoryCopy } from "../observatory-copy.ts";
import { placeNames } from "../place-names.ts";
import { useTickingNow, type ContentSource } from "../use-tool-content.ts";
import { useMachinesCopy } from "../../use-machines-copy.ts";
import "../live-map.css";
import type { CameraMode } from "./camera-director.ts";
import type { CameraState, LiveMapHandle, LiveMapMountOptions, PaintWords, RootPlacement } from "./live-map-app.ts";
import { lookOf } from "./prop-map.ts";
import { fitScene, INTERIOR, PLACE_IDS, type PlaceId } from "./scene-table.ts";

export const HIDE_DETAILS_KEY = "observe.hideDetails";
/** "1" keeps the animation log and exposes the scene as window.__liveMap (acceptance runs). */
export const ANIMATION_LOG_KEY = "observe.animationLog";

type Mount = (options: LiveMapMountOptions) => LiveMapHandle;

export interface LiveMapStageProps {
	readonly state: LiveMapState;
	/** Open with this event's detail (a link's `?event=`). */
	readonly initialEvent?: string | undefined;
	/** The pick changed (the page marks it for tests and links). */
	readonly onPick?: (pick: SidePick) => void;
	/** The machine's clock minus the viewer's (ms): live times are compared with the machine's now (machine-clock.ts). */
	readonly clockSkewMs?: number | undefined;
	/** Where the card and the detail may ask a call's content; absent: they say it is not available. */
	readonly contentSource?: ContentSource | undefined;
	/** Test seam: the renderer's module. */
	readonly loadRenderer?: () => Promise<{ mountLiveMap: Mount }>;
}

type RenderStatus = "loading" | "ready" | "still";

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

/** Moves the modules' buttons with the camera (no React render). */
function applyView(world: HTMLElement | null, p: RootPlacement): void {
	if (world === null) return;
	world.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
}

const AUTO: CameraState = { mode: "auto", zone: null, contentZone: null, switches: 0 };

/** The legend's paragraph: bold and plain parts, bold first. */
function LegendParagraph({ parts }: { parts: readonly string[] }) {
	return (
		<div>
			{parts.map((part, i) =>
				// The parts never move: their index is their identity.
				i % 2 === 0 ? <b key={i}>{part}</b> : <span key={i}>{part}</span>,
			)}
		</div>
	);
}

export function LiveMapStage({ state, initialEvent, onPick, clockSkewMs = 0, contentSource, loadRenderer = defaultRenderer }: LiveMapStageProps) {
	const observe = useMachinesCopy().observe;
	const t = observe.map;
	const c = useObservatoryCopy();
	const names = useMemo(() => placeNames(observe), [observe]);
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const host = useRef<HTMLDivElement | null>(null);
	const world = useRef<HTMLDivElement | null>(null);
	const size = useSize(frame);
	const [status, setStatus] = useState<RenderStatus>("loading");
	const [hide, setHide] = useState(() => readFlag(HIDE_DETAILS_KEY));
	const [camera, setCamera] = useState<CameraState>(AUTO);
	const [pick, setPickState] = useState<SidePick>(initialEvent === undefined ? null : { kind: "event", eventId: initialEvent });
	/** The module the camera's focus is on: kept while an event's detail is opened, as in the design. */
	const [focused, setFocused] = useState<PlaceId | null>(null);
	const handle = useRef<LiveMapHandle | null>(null);
	const played = useRef(new WeakSet<Animation>());
	const latest = useRef(state);
	const skew = useRef(clockSkewMs);
	const hideRef = useRef(hide);
	const words: PaintWords = useMemo(() => ({ copy: c.scene, duration: (ms: number) => duration(c, ms) }), [c]);
	const wordsRef = useRef(words);
	const gesture = useRef<{ pointers: Map<number, { x: number; y: number }>; moved: boolean; start: { x: number; y: number } | null; suppressClick: boolean }>({ pointers: new Map(), moved: false, start: null, suppressClick: false });
	useEffect(() => {
		latest.current = state;
		skew.current = clockSkewMs;
		hideRef.current = hide;
		wordsRef.current = words;
	});

	const setPick = (next: SidePick): void => {
		setPickState(next);
		onPick?.(next);
	};

	const ready = size.width > 0 && size.height > 0;
	// The renderer mounts once per frame lifetime; size changes go through resize.
	const mountSize = useRef(size);
	useEffect(() => {
		mountSize.current = size;
	});
	useEffect(() => {
		const el = host.current;
		if (!ready || el === null) return;
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
					state: latest.current,
					width: mountSize.current.width,
					height: mountSize.current.height,
					words: wordsRef.current,
					hide: hideRef.current,
					saveData: saveData(),
					reduceMotion,
					wallClock: () => machineNow(Date.now(), skew.current),
					record,
					onView: (p) => applyView(world.current, p),
					onCamera: setCamera,
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
					setStatus("ready");
				},
				(error: unknown) => {
					console.warn("live map: the scene could not start", error);
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
	}, [ready, loadRenderer]);

	useEffect(() => {
		const h = handle.current;
		if (h === null || status !== "ready") return;
		const fresh = state.animations.filter((a) => !played.current.has(a));
		for (const a of fresh) played.current.add(a);
		h.update(state, fresh);
	}, [state, status]);

	useEffect(() => {
		handle.current?.resize(size.width, size.height);
	}, [size.width, size.height, status]);

	useEffect(() => {
		handle.current?.setWords(words);
	}, [words, status]);

	useEffect(() => {
		handle.current?.setHide(hide);
	}, [hide, status]);

	// Without the scene, the buttons stay on the whole board.
	useEffect(() => {
		if (status === "ready") return;
		const fit = fitScene(INTERIOR.space, size);
		applyView(world.current, { scale: fit.scale, x: fit.offsetX, y: fit.offsetY });
	}, [size, status]);

	useEffect(() => {
		handle.current?.select(focused);
		if (focused === null && camera.mode === "focus") handle.current?.setCameraMode("auto");
	}, [focused, camera.mode, status]);

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

	const look = useMemo(() => lookOf(state, INTERIOR), [state]);
	const busy = look.mode !== "idle";
	// Live: the clock ticks while the AI works; a finished call's hold is read again once it is over.
	// A CI run's timer ticks too (it runs after Claude's turn), and it turns unknown once stale.
	const ciRunning = look.pipeline.steps.ci.status === "run";
	const now = useTickingNow(busy || ciRunning, state, DONE_HOLD_MS + 50, clockSkewMs);
	const card = activityCardOf(state, now);
	const feed = useMemo(() => feedRowsOf(c, state, hide), [c, state, hide]);

	const toggleHide = (): void => {
		const next = !hide;
		writeFlag(HIDE_DETAILS_KEY, next);
		setHide(next);
	};

	const pickPlace = (place: PlaceId): void => {
		setPick({ kind: "place", place });
		setFocused(place);
		handle.current?.select(place);
		handle.current?.setCameraMode("focus");
	};

	const setMode = (mode: CameraMode): void => {
		handle.current?.setCameraMode(mode);
		if (mode === "focus" && focused === null) pickPlace(camera.zone ?? "core");
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

	// The frame clips the scene (overflow hidden): focusing a button near its edge would scroll it and shift the
	// buttons off the canvas. It never scrolls; the camera frames the focused module instead.
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
		// Moving to another module's button: its own focus frames it.
		if (hitPlace(e.target) !== null && hitPlace(e.relatedTarget) === null) handle.current?.peek(null);
	};

	const onClick = (e: MouseEvent<HTMLDivElement>): void => {
		const g = gesture.current;
		if (g.suppressClick) {
			g.suppressClick = false;
			return;
		}
		const h = handle.current;
		const p = local(e);
		// A pointer click (not Enter on a button) on a moving packet opens its event.
		if (h !== null && e.detail > 0) {
			const id = h.hitEvent(p.x, p.y);
			if (id !== null) {
				setPick({ kind: "event", eventId: id });
				return;
			}
		}
		const button = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-place]")?.dataset.place : undefined;
		const place = PLACE_IDS.find((x) => x === button) ?? (h !== null && e.detail > 0 ? h.placeAt(p.x, p.y) : null);
		if (place !== null) pickPlace(place === "orchestrator" ? "core" : place);
		else if (e.detail > 0) {
			// Empty ground clears the pick; only focus goes back to auto (free stays where the person put it), as in the design.
			setPick(null);
			setFocused(null);
			h?.select(null);
			if (camera.mode === "focus") h?.setCameraMode("auto");
		}
	};

	const where = camera.mode === "free" ? c.camera.free : camera.mode === "focus" ? (focused === null ? c.camera.whole : names[focused]) : camera.zone === null ? c.camera.whole : names[camera.zone];
	const modes: readonly CameraMode[] = ["auto", "free", "focus"];

	return (
		<section className={`lm-stage${hide ? " is-hidden-details" : ""}`} aria-label={t.label} data-id="observe-stage" data-status={status} data-camera={camera.mode}>
			<div className="lm-top">
				<ActivityCard card={card} names={names} hide={hide} source={contentSource ?? null} onDetail={(id) => setPick({ kind: "event", eventId: id })} />
				<SessionBox state={state} hide={hide} hideLabel={t.hideDetails} hideHint={t.hideDetailsHint} approxHint={t.contextApproxHint} onHide={toggleHide} />
			</div>
			<div className="lm-main">
				<div className="lm-col">
					{/* Pointer gestures only move the camera; every action is also a button reachable with Tab. */}
					{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
					<div
						className="lm-board"
						ref={setFrame}
						onClick={onClick}
						onFocus={onFocus}
						onBlur={onBlur}
						onScroll={(e) => keepUnscrolled(e.currentTarget)}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerEnd}
						onPointerCancel={onPointerEnd}
					>
						<div className="lm-canvas-host" ref={host} />
						<div className="lm-world" ref={world} style={{ width: INTERIOR.space.width, height: INTERIOR.space.height }}>
							{PLACE_IDS.filter((p) => p !== "orchestrator").map((p) => {
								const r = INTERIOR.places[p].rect;
								return (
									<button
										key={p}
										type="button"
										className="lm-hit"
										data-place={p}
										data-id={`observe-place-${p}`}
										aria-pressed={pick?.kind === "place" && pick.place === p}
										aria-label={names[p]}
										style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
									/>
								);
							})}
						</div>
						{status === "still" && (
							<p className="note lm-note" role="status" data-id="observe-still">
								{t.still}
							</p>
						)}
					</div>
					{/* Under the scene, never over it: no module is ever covered by the camera's controls. */}
					{status === "ready" && (
						<div className="lm-camctl">
							<div className="lm-seg" role="group" aria-label={c.camera.label}>
								{modes.map((m) => (
									<button key={m} type="button" aria-pressed={camera.mode === m} data-id={`observe-camera-${m}`} onClick={() => setMode(m)}>
										{c.camera[m]}
									</button>
								))}
							</div>
							<span className="lm-camnote" data-id="observe-camera-note">
								{c.camera.note(where, camera.switches, feed.total)}
							</span>
						</div>
					)}
				</div>
				<div className="lm-col">
					<DetailBox state={state} pick={pick} now={now} hide={hide} source={contentSource ?? null} names={names} />
					<EventFeed feed={feed} onEvent={(eventId) => setPick({ kind: "event", eventId })} onPlace={pickPlace} />
				</div>
			</div>
			<div className="lm-legend">
				{c.legend.map((parts, i) => (
					// The paragraphs never move: their index is their identity.
					<LegendParagraph key={i} parts={parts} />
				))}
			</div>
		</section>
	);
}

