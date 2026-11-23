// The Live Map's frame: the plate, the PixiJS canvas (live-map-app.ts, its
// own chunk, loaded when the frame mounts and destroyed when it unmounts), and
// everything that is text, in the DOM over it: a name tag per place at its
// anchor, the session's status strip, and "Ẩn chi tiết" (remembered on this
// device), which hides file names, domains, commands, MCP tool names and the
// account's email. Each place has an invisible button over its outline
// (Tab to reach, Enter to open its station); a click on a moving piece opens
// its source event instead. When neither WebGL nor Canvas can draw, or the GPU
// context is lost, the plate shows as a still picture with the same tags and
// buttons. On a phone the scene pinches from 1 to 2.5 times and the tags drop
// their details.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { coreOf, type Animation, type LiveMapState } from "../live-map-state.ts";
import type { LiveMapEvent } from "../live-map-types.ts";
import { STATION_CODES, type StationCode } from "../station-catalog.ts";
import { useMachinesCopy } from "../../use-machines-copy.ts";
import "../live-map.css";
import { queueOverflow } from "./prop-map.ts";
import type { LiveMapHandle, LiveMapMountOptions } from "./live-map-app.ts";
import { assetBase, choosePlate, fitScene, loadSceneAssets, PLACE_IDS, project, STATION_PLACE, type PlaceId, type SceneAssets, type SceneFit } from "./scene-table.ts";

export const HIDE_DETAILS_KEY = "observe.hideDetails";
/** "1" keeps the animation log and exposes the scene as window.__liveMap (acceptance runs). */
export const ANIMATION_LOG_KEY = "observe.animationLog";
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2.5;

type Mount = (options: LiveMapMountOptions) => Promise<LiveMapHandle>;

export interface LiveMapStageProps {
	readonly state: LiveMapState;
	/** The signed-in chat account's email: the user desk's name tag. */
	readonly accountEmail: string;
	readonly selectedPlace: PlaceId | null;
	readonly onStation: (place: PlaceId) => void;
	readonly onEvent: (eventId: string) => void;
	/** "Ẩn chi tiết" was switched: the drawer and the detail follow it. */
	readonly onHideDetails?: (hide: boolean) => void;
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

const SHORT_MODEL = /^claude-([a-z]+)/;

interface Tag {
	readonly place: PlaceId;
	readonly name: string;
	/** Shown whatever "Ẩn chi tiết" says (counts, states). */
	readonly facts: readonly string[];
	/** Names: hidden by "Ẩn chi tiết". */
	readonly detail: string;
	readonly bottleneck: "none" | "warn" | "alert";
	readonly mine?: boolean;
}

export function LiveMapStage({ state, accountEmail, selectedPlace, onStation, onEvent, onHideDetails, loadAssets = defaultAssets, loadRenderer = defaultRenderer }: LiveMapStageProps) {
	const copy = useMachinesCopy().observe;
	const t = copy.map;
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const host = useRef<HTMLDivElement | null>(null);
	const world = useRef<HTMLDivElement | null>(null);
	const size = useSize(frame);
	const [assets, setAssets] = useState<SceneAssets | null>(null);
	const [assetsFailed, setAssetsFailed] = useState(false);
	const [status, setStatus] = useState<RenderStatus>("loading");
	const [renderer, setRenderer] = useState<string>("");
	const [hide, setHide] = useState(() => readFlag(HIDE_DETAILS_KEY));
	const [batches, setBatches] = useState<Partial<Record<PlaceId, number>>>({});
	const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
	const handle = useRef<LiveMapHandle | null>(null);
	const played = useRef(new WeakSet<Animation>());
	const latest = useRef(state);
	const onEventRef = useRef(onEvent);
	useEffect(() => {
		latest.current = state;
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
					record,
					onBatch: (place, count) => setBatches((b) => ({ ...b, [place]: count ?? undefined })),
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
		h.update(state, fresh);
	}, [state, status]);

	useEffect(() => {
		handle.current?.resize(size.width, size.height);
	}, [size.width, size.height, status]);

	const fit: SceneFit = useMemo(() => (assets === null ? { scale: 0, offsetX: 0, offsetY: 0 } : fitScene(assets.scene.space, size)), [assets, size]);
	const tags = useTags(state, accountEmail, assets);
	const overflow = assets === null ? {} : queueOverflow(state, assets.scene);
	const core = state.live?.core ?? coreOf(state);

	const toggleHide = (): void => {
		const next = !hide;
		writeFlag(HIDE_DETAILS_KEY, next);
		setHide(next);
		onHideDetails?.(next);
	};

	const onClick = (e: MouseEvent<HTMLDivElement>): void => {
		const w = world.current;
		// A pointer click (not Enter on a button) on a moving piece opens its event.
		if (w !== null && e.detail > 0 && handle.current !== null) {
			const rect = w.getBoundingClientRect();
			const id = handle.current.hitEvent((e.clientX - rect.left) / zoom.scale, (e.clientY - rect.top) / zoom.scale);
			if (id !== null) {
				onEventRef.current(id);
				return;
			}
		}
		const place = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-place]")?.dataset.place : undefined;
		const id = PLACE_IDS.find((p) => p === place);
		if (id !== undefined) onStation(id);
	};

	const pinch = usePinch(size, zoom, setZoom);
	const plate = assets === null ? null : choosePlate(assets.table, { maxTextureSize: null, frameWidth: size.width, saveData: saveData() });
	const showPlate = status !== "ready";
	const note = assetsFailed || status === "still" ? t.still : status === "lost" ? t.lost : null;
	const percent = state.live?.contextPercent ?? null;
	const tps = state.live?.tokensPerSecond ?? state.scene.tokensPerSecond;
	const model = state.live?.mainModel || state.scene.model;
	const worldStyle: CSSProperties = { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` };

	return (
		<section className={`lm-stage${hide ? " is-hidden-details" : ""}`} aria-label={t.label} data-id="observe-stage" data-status={assetsFailed ? "still" : status} data-renderer={renderer}>
			<div className="lm-strip" data-id="observe-strip" role="status">
				<span className="lm-strip-core" data-core={core}>
					{copy.stations.CORE} · {t.core[core]}
				</span>
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
			{/* Pointer gestures only zoom; every action is also a button reachable with Tab. */}
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
			<div className="lm-frame" ref={setFrame} onClick={onClick} {...pinch}>
				<div className="lm-world" ref={world} style={worldStyle}>
					{showPlate && plate !== null && assets !== null && <img className="lm-plate" src={assets.base + plate.file} alt="" style={plateStyle(fit, assets)} />}
					<div className="lm-canvas-host" ref={host} />
					{assets !== null &&
						fit.scale > 0 &&
						tags.map((tag) => {
							const place = assets.scene.places[tag.place];
							const xs = place.hit.map((p) => p[0]);
							const ys = place.hit.map((p) => p[1]);
							const left = Math.min(...xs);
							const top = Math.min(...ys);
							const w = Math.max(...xs) - left;
							const h = Math.max(...ys) - top;
							const box = project([left, top], fit);
							const clip = `polygon(${place.hit.map(([x, y]) => `${(((x - left) / w) * 100).toFixed(2)}% ${(((y - top) / h) * 100).toFixed(2)}%`).join(", ")})`;
							return (
								<button
									key={`hit-${tag.place}`}
									type="button"
									className="lm-hit"
									data-place={tag.place}
									data-id={`observe-place-${tag.place}`}
									aria-label={tag.name}
									aria-pressed={selectedPlace === tag.place}
									style={{ left: box.x, top: box.y, width: w * fit.scale, height: h * fit.scale, clipPath: clip }}
								/>
							);
						})}
					{assets !== null &&
						fit.scale > 0 &&
						tags.map((tag) => {
							const at = project(assets.scene.places[tag.place].label, fit);
							const more = overflow[tag.place];
							const batch = batches[tag.place];
							const cls = ["lm-tag", tag.bottleneck !== "none" ? `is-${tag.bottleneck}` : "", selectedPlace === tag.place ? "is-selected" : "", tag.mine === true ? "is-mine" : ""].filter(Boolean).join(" ");
							return (
								<div key={`tag-${tag.place}`} className={cls} style={{ left: at.x, top: at.y }} data-id={`observe-tag-${tag.place}`} aria-hidden="true">
									<b>
										{tag.bottleneck !== "none" && <span title={t.bottleneck}>⚠ </span>}
										{tag.name}
									</b>
									{tag.facts.length > 0 && <i>{tag.facts.join(" · ")}</i>}
									{tag.detail !== "" && !hide && (
										<i className="lm-detail" data-id="observe-detail">
											{tag.detail}
										</i>
									)}
									{more !== undefined && <i>{t.more(more)}</i>}
									{batch !== undefined && <em className="lm-batch">{t.batch(batch)}</em>}
								</div>
							);
						})}
				</div>
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

function plateStyle(fit: SceneFit, assets: SceneAssets): CSSProperties {
	return { left: fit.offsetX, top: fit.offsetY, width: assets.scene.space.width * fit.scale, height: assets.scene.space.height * fit.scale };
}

/** The name tag of every place, from the state. */
function useTags(state: LiveMapState, accountEmail: string, assets: SceneAssets | null): Tag[] {
	const copy = useMachinesCopy().observe;
	const t = copy.map;
	return useMemo(() => {
		if (assets === null) return [];
		const byId = new Map<string, LiveMapEvent>();
		let prompts = 0;
		for (const e of state.log) {
			byId.set(e.id, e);
			if (e.kind === "prompt") prompts += 1;
		}
		const s = state.scene;
		const out: Tag[] = [];
		const core = state.live?.core ?? coreOf(state);
		const model = SHORT_MODEL.exec(state.live?.mainModel || s.model)?.[1] ?? (state.live?.mainModel || s.model);
		out.push({ place: "core", name: copy.stations.CORE, facts: [model, t.core[core]].filter((x) => x !== ""), detail: "", bottleneck: s.stations.CORE.bottleneck });
		out.push({ place: "user-desk", name: t.userDesk, facts: prompts > 0 ? [t.prompt(prompts)] : [], detail: accountEmail, bottleneck: "none", mine: true });
		for (const code of STATION_CODES) {
			if (code === "CORE") continue;
			const st = s.stations[code];
			const facts: string[] = [];
			if (st.calls > 0) facts.push(t.calls(st.calls, st.failures));
			if (code === "ORCHESTRATOR") {
				const running = Object.values(s.subagents).filter((x) => x.running).length;
				if (running > 0) facts.push(t.subagents(running));
				if (s.todo !== null) facts.push(t.todo(s.todo.pending, s.todo.inProgress, s.todo.done));
			}
			const last = st.last === null ? undefined : byId.get(st.last);
			const detail = last?.kind === "tool" ? last.target : "";
			out.push({ place: STATION_PLACE[code as StationCode], name: copy.stations[code], facts, detail, bottleneck: st.bottleneck });
		}
		const waiting = Object.values(s.stations).reduce((n, st) => n + st.queued, 0);
		out.push({ place: "security", name: t.gateway, facts: waiting > 0 ? [t.waiting(waiting)] : [], detail: "", bottleneck: "none" });
		const tps = state.live?.tokensPerSecond ?? s.tokensPerSecond;
		out.push({ place: "monitoring", name: t.monitoring, facts: tps === null ? [] : [t.speed(Math.round(tps))], detail: "", bottleneck: "none" });
		return out;
	}, [state, accountEmail, assets, copy, t]);
}

/** Two-finger pinch (1 to 2.5 times), ctrl+wheel (a trackpad's pinch), and a one-finger drag while zoomed. */
function usePinch(
	size: { width: number; height: number },
	zoom: { scale: number; x: number; y: number },
	setZoom: (z: { scale: number; x: number; y: number }) => void,
): {
	onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
	onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
	onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void;
	onWheel: (e: WheelEvent<HTMLDivElement>) => void;
} {
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const start = useRef<{ distance: number; zoom: typeof zoom; mid: { x: number; y: number } } | null>(null);
	const clamp = (scale: number, x: number, y: number): typeof zoom => {
		const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
		return { scale: s, x: Math.min(0, Math.max(size.width * (1 - s), x)), y: Math.min(0, Math.max(size.height * (1 - s), y)) };
	};
	/** Zoom to `scale` keeping the frame point (fx, fy) where it is. */
	const zoomAt = (from: typeof zoom, scale: number, fx: number, fy: number): typeof zoom => {
		const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
		const wx = (fx - from.x) / from.scale;
		const wy = (fy - from.y) / from.scale;
		return clamp(s, fx - wx * s, fy - wy * s);
	};
	const local = (e: { clientX: number; clientY: number; currentTarget: Element }): { x: number; y: number } => {
		const r = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};
	const end = (e: PointerEvent<HTMLDivElement>): void => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) start.current = null;
	};
	return {
		onPointerDown(e) {
			pointers.current.set(e.pointerId, local(e));
			if (pointers.current.size === 2) {
				const [a, b] = [...pointers.current.values()];
				if (a !== undefined && b !== undefined) start.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
			}
		},
		onPointerMove(e) {
			const before = pointers.current.get(e.pointerId);
			if (before === undefined) return;
			const now = local(e);
			pointers.current.set(e.pointerId, now);
			const s = start.current;
			if (s !== null && pointers.current.size === 2) {
				const [a, b] = [...pointers.current.values()];
				if (a === undefined || b === undefined || s.distance === 0) return;
				setZoom(zoomAt(s.zoom, (s.zoom.scale * Math.hypot(a.x - b.x, a.y - b.y)) / s.distance, s.mid.x, s.mid.y));
			} else if (pointers.current.size === 1 && zoom.scale > 1 && e.pointerType !== "mouse") {
				setZoom(clamp(zoom.scale, zoom.x + now.x - before.x, zoom.y + now.y - before.y));
			}
		},
		onPointerUp: end,
		onPointerCancel: end,
		onWheel(e) {
			if (!e.ctrlKey) return;
			const p = local(e);
			setZoom(zoomAt(zoom, zoom.scale * Math.exp(-e.deltaY / 200), p.x, p.y));
		},
	};
}
