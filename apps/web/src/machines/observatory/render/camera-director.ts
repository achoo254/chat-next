// The Live Map's camera (pure; the caller passes the time): where it looks
// and when it moves. Three modes:
//
// - auto: follows the AI's activity, not its events. The activity is a place
//   (activityZone): the permission lock while Claude waits for the person,
//   the district of the newest running call (tests: the testing district
//   with the terminal), the core while the model thinks, none while idle.
//   The view moves to a new zone only once that zone held STABLE_MS and the
//   current view held HOLD_MS, so twenty file reads in a row are one move.
//   Thinking right after a call keeps the call's district until
//   THINK_HOLD_MS after that call ENDED (a short think between two calls
//   does not pull back to the core; a longer one does), and an idle session
//   keeps the last view IDLE_MS before going back to the whole scene. Every
//   move is counted (`switches`).
// - free: the person pans (drag) and zooms (Ctrl/⌘ + wheel, pinch) between 1 and
//   MAX_ZOOM; a drag or a zoom in another mode switches to free.
// - focus: locked on the selected place, zoomed closer.
//
// A district the keyboard is on (peek) is framed instead while it is, in auto
// and focus (free stays where the person put it), so a focused button is
// always in view.
//
// The view eases toward its target with a time constant of EASE_MS; with
// reduced motion it jumps.
import type { ActivityMode } from "../call-history.ts";
import type { PlaceId, Rect, SceneTable } from "./scene-table.ts";

export type CameraMode = "auto" | "free" | "focus";

/** Where the camera looks: the centre of the view (scene px) and the zoom (1: the whole scene). */
export interface CameraView {
	readonly x: number;
	readonly y: number;
	readonly s: number;
}

export const STABLE_MS = 500;
export const HOLD_MS = 1_500;
export const THINK_HOLD_MS = 1_200;
export const IDLE_MS = 3_000;
export const EASE_MS = 420;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2.4;
const AUTO_ZOOM = 1.32;
const FOCUS_ZOOM = 1.7;
/** Auto leans this far toward its zone; the rest of the scene stays in view. */
const AUTO_LEAN = 0.8;
/** Room around a zone's box, scene px. */
const MARGIN = 160;
/** Close enough to the target (scene px; a fraction of a screen pixel at any zoom). */
const SETTLED = 2;

/** Places framed together with a zone's own. */
const ZONE_SET: Partial<Record<PlaceId, readonly PlaceId[]>> = { testing: ["testing", "sandbox"], security: ["security", "core"] };

/** Places where work happens (not the core, not the permission lock). */
const isWork = (z: PlaceId | null): z is PlaceId => z !== null && z !== "core" && z !== "security";

export interface Activity {
	readonly mode: ActivityMode;
	/** The place of the newest running call (exec). */
	readonly newestPlace: PlaceId | null;
	/** A test run is among the running calls. */
	readonly testing: boolean;
}

/** The zone of an activity: where auto would look. */
export function activityZone(a: Activity): PlaceId | null {
	switch (a.mode) {
		case "wait":
			return "security";
		case "exec":
			return a.testing ? "testing" : a.newestPlace;
		case "think":
			return "core";
		case "idle":
			return null;
	}
}

function bboxOf(scene: SceneTable, places: readonly PlaceId[]): Rect {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const id of places) {
		const r = scene.places[id].rect;
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, r.x + r.w);
		y1 = Math.max(y1, r.y + r.h);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The view that frames `zone` (null: the whole scene); `strong`: focus (closer, centred). */
export function viewFor(scene: SceneTable, zone: PlaceId | null, strong: boolean): CameraView {
	const W = scene.space.width;
	const H = scene.space.height;
	if (zone === null) return { x: W / 2, y: H / 2, s: 1 };
	const frame = (places: readonly PlaceId[]): CameraView => {
		const b = bboxOf(scene, places);
		const fits = Math.min(W / (b.w + MARGIN), H / (b.h + MARGIN));
		const s = Math.max(MIN_ZOOM, Math.min(strong ? FOCUS_ZOOM : AUTO_ZOOM, fits * (strong ? 0.8 : 0.55)));
		const lean = strong ? 1 : AUTO_LEAN;
		return clampView(scene, { x: W / 2 + (b.x + b.w / 2 - W / 2) * lean, y: H / 2 + (b.y + b.h / 2 - H / 2) * lean, s });
	};
	// Focus frames the selected place alone; auto frames the zone with its companions unless together they fill the scene.
	const set = strong ? undefined : ZONE_SET[zone];
	if (set === undefined) return frame([zone]);
	const together = frame(set);
	return together.s > MIN_ZOOM + 0.05 ? together : frame([zone]);
}

/** Keeps the view on the scene. */
export function clampView(scene: SceneTable, v: CameraView): CameraView {
	const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s));
	const hw = scene.space.width / (2 * s);
	const hh = scene.space.height / (2 * s);
	return { s, x: Math.max(hw, Math.min(scene.space.width - hw, v.x)), y: Math.max(hh, Math.min(scene.space.height - hh, v.y)) };
}

export interface CameraFrame {
	readonly view: CameraView;
	/** The view has reached its target: no frame is needed for the camera. */
	readonly settled: boolean;
	/** auto's zone (null: the whole scene). */
	readonly zone: PlaceId | null;
	/** When auto could move next (a timer should wake the scene then); null when nothing is pending. */
	readonly wakeAt: number | null;
}

export class CameraDirector {
	private readonly scene: SceneTable;
	private modeNow: CameraMode = "auto";
	private selectedPlace: PlaceId | null = null;
	private peekPlace: PlaceId | null = null;
	private zoneNow: PlaceId | null = null;
	private zoneSince = -Infinity;
	/** The raw activity zone and since when (auto's candidate). */
	private candidate: PlaceId | null = null;
	private candidateSince = -Infinity;
	private candidateNeed = STABLE_MS;
	/** The latest work zone and when the work there ended (null while it runs). */
	private lastWork: { zone: PlaceId; endedAt: number | null } | null = null;
	private viewNow: CameraView;
	private lastStep: number | null = null;
	private switchCount = 0;

	constructor(scene: SceneTable) {
		this.scene = scene;
		this.viewNow = viewFor(scene, null, false);
	}

	get mode(): CameraMode {
		return this.modeNow;
	}

	get zone(): PlaceId | null {
		return this.zoneNow;
	}

	get selected(): PlaceId | null {
		return this.selectedPlace;
	}

	/** auto's moves so far. */
	get switches(): number {
		return this.switchCount;
	}

	get view(): CameraView {
		return this.viewNow;
	}

	setMode(mode: CameraMode): void {
		if (mode === this.modeNow) return;
		this.modeNow = mode;
		// Back to auto: it finds its zone again from the activity, and may move at once.
		if (mode === "auto") {
			this.zoneNow = null;
			this.zoneSince = -Infinity;
		}
	}

	select(place: PlaceId | null): void {
		this.selectedPlace = place;
	}

	/** The district the keyboard is on (null: none). */
	get peeked(): PlaceId | null {
		return this.peekPlace;
	}

	/** Frames `place` while the keyboard is on it (null: back to the mode's own target). */
	peek(place: PlaceId | null): void {
		this.peekPlace = place;
	}

	/** Moves the view by (dx, dy) scene px (a drag); switches to free. */
	pan(dx: number, dy: number): void {
		this.setMode("free");
		this.viewNow = clampView(this.scene, { ...this.viewNow, x: this.viewNow.x - dx, y: this.viewNow.y - dy });
	}

	/** Zooms by `factor` keeping the scene point (px, py) under the pointer; switches to free. */
	zoomAt(factor: number, px: number, py: number): void {
		this.setMode("free");
		const v = this.viewNow;
		const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
		// The point stays where it is on screen: its offset from the centre shrinks by the zoom's ratio.
		const k = v.s / s;
		this.viewNow = clampView(this.scene, { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
	}

	/** Follows the activity at `now` (ms); `reduceMotion` jumps instead of easing. */
	step(activity: Activity, now: number, reduceMotion: boolean): CameraFrame {
		const dt = this.lastStep === null ? 0 : Math.max(0, now - this.lastStep);
		this.lastStep = now;
		const wakeAt = this.follow(activityZone(activity), now);
		if (this.modeNow === "free") return { view: this.viewNow, settled: true, zone: this.zoneNow, wakeAt: null };
		const focus = this.modeNow === "focus";
		const target = this.peekPlace !== null ? viewFor(this.scene, this.peekPlace, focus) : focus ? viewFor(this.scene, this.selectedPlace ?? "core", true) : viewFor(this.scene, this.zoneNow, false);
		const k = reduceMotion ? 1 : 1 - Math.exp(-dt / EASE_MS);
		const v = this.viewNow;
		const next = clampView(this.scene, { x: v.x + (target.x - v.x) * k, y: v.y + (target.y - v.y) * k, s: v.s + (target.s - v.s) * k });
		const settled = Math.abs(next.x - target.x) < SETTLED && Math.abs(next.y - target.y) < SETTLED && Math.abs(next.s - target.s) < 0.004;
		this.viewNow = settled ? target : next;
		return { view: this.viewNow, settled, zone: this.zoneNow, wakeAt: this.modeNow === "auto" ? wakeAt : null };
	}

	/**
	 * auto's zone from the raw activity zone; returns when a pending move is
	 * due. Thinking within THINK_HOLD_MS of a call's end still counts as that
	 * call's district (its candidate keeps its time); past that, the core is
	 * the candidate from that moment and needs no further wait.
	 */
	private follow(raw: PlaceId | null, now: number): number | null {
		if (isWork(raw)) this.lastWork = { zone: raw, endedAt: null };
		else if (this.lastWork !== null && this.lastWork.endedAt === null) this.lastWork = { zone: this.lastWork.zone, endedAt: now };
		const work = this.lastWork;
		const holdUntil = raw === "core" && work !== null && work.endedAt !== null ? work.endedAt + THINK_HOLD_MS : null;
		const held = holdUntil !== null && work !== null && now < holdUntil;
		const effective = held && work !== null ? work.zone : raw;
		if (effective !== this.candidate) {
			// The hold after a call just ran out: the core is the candidate since then, with no further wait.
			const afterHold = holdUntil !== null && !held && work !== null && this.candidate === work.zone;
			this.candidate = effective;
			this.candidateSince = afterHold && holdUntil !== null ? holdUntil : now;
			this.candidateNeed = effective === null ? IDLE_MS : afterHold ? 0 : STABLE_MS;
		}
		if (this.modeNow !== "auto") return null;
		if (effective === this.zoneNow) return held ? holdUntil : null;
		const due = Math.max(this.candidateSince + this.candidateNeed, this.zoneSince + HOLD_MS);
		if (now < due) return due;
		this.zoneNow = effective;
		this.zoneSince = now;
		this.switchCount += 1;
		return held ? holdUntil : null;
	}
}
