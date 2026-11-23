// Times the Live Map's moves: takes the animations the state queued (each
// names its source event), turns each into its moves (prop-map.ts) and keeps
// them while they play. A place that receives more than BATCH_LIMIT moves
// within BATCH_WINDOW_MS plays one batch with a count instead of each, so a
// burst of 50 reads is one move "×50", not 50 at once. Every move started (or
// folded into a batch) is written to the animation log with its source event,
// place, kind and time, so a test (or an acceptance run) can check that no
// motion happens without an event. Clock-free: the caller passes the time.
import type { Animation, LiveMapState } from "../live-map-state.ts";
import type { LiveMapEvent } from "../live-map-types.ts";
import { movesOf, pathPoint, type MotionKind, type Move } from "./prop-map.ts";
import type { PlaceId, Point, SceneTable } from "./scene-table.ts";

/** More moves than this at one place within BATCH_WINDOW_MS are played as one batch. */
export const BATCH_LIMIT = 8;
export const BATCH_WINDOW_MS = 1_000;
/** Moves playing at once at most (weak phones); the oldest stop first. */
export const MAX_ACTIVE = 200;
/** Log entries kept. */
export const LOG_CAP = 2_000;
/** A click this close (plate pixels) to a moving piece opens its event. */
export const HIT_RADIUS = 70;

/** A logged motion: a move, or the core starting to turn ("core-spin"). */
export type LoggedKind = MotionKind | "core-spin";

export interface DirectorLogEntry {
	readonly eventId: string;
	readonly place: PlaceId;
	readonly kind: LoggedKind;
	/** The caller's clock (ms) when it started. */
	readonly at: number;
}

export interface ActiveMove {
	readonly move: Move;
	readonly start: number;
	/** Events this move stands for (more than one for a batch). */
	readonly count: number;
	/** The newest event folded in (a batch opens its latest event). */
	readonly lastEventId: string;
}

/** A move at one moment: how far along (0 to 1) and where. */
export interface MoveFrame {
	readonly active: ActiveMove;
	readonly t: number;
	readonly at: Point;
}

export interface DirectorOptions {
	/** Keep the animation log (tests, acceptance runs). */
	readonly record?: boolean;
	/** A batch at a place started (count) or grew, or ended (null): the view shows its number. */
	readonly onBatch?: (place: PlaceId, count: number | null) => void;
}

export class AnimationDirector {
	private readonly scene: SceneTable;
	private readonly record: boolean;
	private readonly onBatch: ((place: PlaceId, count: number | null) => void) | undefined;
	private active: ActiveMove[] = [];
	private readonly recent = new Map<PlaceId, number[]>();
	private readonly entries: DirectorLogEntry[] = [];

	constructor(scene: SceneTable, options: DirectorOptions = {}) {
		this.scene = scene;
		this.record = options.record === true;
		this.onBatch = options.onBatch;
	}

	/** Starts the moves of `animations`; `state` holds their source events. */
	play(animations: readonly Animation[], state: LiveMapState, now: number): void {
		if (animations.length === 0) return;
		const byId = new Map<string, LiveMapEvent>();
		for (const e of state.log) byId.set(e.id, e);
		for (const anim of animations) {
			for (const move of movesOf(anim, byId.get(anim.eventId), state, this.scene)) this.start(move, now);
		}
		if (this.active.length > MAX_ACTIVE) this.active = this.active.slice(this.active.length - MAX_ACTIVE);
	}

	private start(move: Move, now: number): void {
		const times = (this.recent.get(move.place) ?? []).filter((t) => t > now - BATCH_WINDOW_MS);
		times.push(now);
		this.recent.set(move.place, times);
		if (times.length > BATCH_LIMIT) {
			this.fold(move, now);
			return;
		}
		this.active.push({ move, start: now, count: 1, lastEventId: move.eventId });
		this.write(move.eventId, move.place, move.kind, now);
	}

	/** Into the place's batch: one move whose count grows and whose time starts again. */
	private fold(move: Move, now: number): void {
		const i = this.active.findIndex((a) => a.move.kind === "batch" && a.move.place === move.place);
		const before = i < 0 ? undefined : this.active[i];
		const count = (before?.count ?? 0) + 1;
		const place = this.scene.places[move.place];
		const batch: Move = { ...move, kind: "batch", tone: move.tone === "error" ? "error" : (before?.move.tone ?? "normal"), path: [place.droneTarget], durationMs: 1200, flashes: 1 };
		const next: ActiveMove = { move: batch, start: now, count, lastEventId: move.eventId };
		if (i < 0) this.active.push(next);
		else this.active[i] = next;
		this.write(move.eventId, move.place, "batch", now);
		this.onBatch?.(move.place, count);
	}

	private write(eventId: string, place: PlaceId, kind: LoggedKind, at: number): void {
		if (!this.record) return;
		this.entries.push({ eventId, place, kind, at });
		if (this.entries.length > LOG_CAP) this.entries.splice(0, this.entries.length - LOG_CAP);
	}

	/** Records a still change shown by the scene (the core starting to turn): it too names its event. */
	note(eventId: string, place: PlaceId, kind: LoggedKind, now: number): void {
		this.write(eventId, place, kind, now);
	}

	/** The moves at `now`, finished ones dropped. */
	frame(now: number): MoveFrame[] {
		const out: MoveFrame[] = [];
		const kept: ActiveMove[] = [];
		for (const a of this.active) {
			const t = (now - a.start) / a.move.durationMs;
			if (t >= 1) {
				if (a.move.kind === "batch") this.onBatch?.(a.move.place, null);
				continue;
			}
			kept.push(a);
			out.push({ active: a, t: Math.max(0, t), at: pathPoint(a.move.path, ease(Math.max(0, t))) });
		}
		this.active = kept;
		return out;
	}

	get busy(): boolean {
		return this.active.length > 0;
	}

	/** The event of the moving piece nearest `p` (plate pixels) at `now`, or null. */
	hit(p: Point, now: number): string | null {
		let best: string | null = null;
		let bestDistance = HIT_RADIUS;
		for (const a of this.active) {
			const t = (now - a.start) / a.move.durationMs;
			if (t < 0 || t >= 1) continue;
			const at = pathPoint(a.move.path, ease(t));
			const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
			if (d <= bestDistance) {
				bestDistance = d;
				best = a.lastEventId;
			}
		}
		return best;
	}

	/** The animation log (empty unless recording). */
	log(): readonly DirectorLogEntry[] {
		return this.entries;
	}

	/** Stops every move (a hidden page, a lost context): the next frame shows the still scene. */
	clear(): void {
		for (const a of this.active) if (a.move.kind === "batch") this.onBatch?.(a.move.place, null);
		this.active = [];
		this.recent.clear();
	}
}

/** Ease in and out. */
export function ease(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}
