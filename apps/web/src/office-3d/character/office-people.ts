// The people of the 3D office: turns each placement (office-placement.ts,
// shared with 2D) and the idle show into a target spot, walks people there
// along the walkways and through the elevator, keeps everyone moving on in
// logic even on floors not shown, picks each one's pose and animation rate,
// and reports positions for the HTML labels and speech bubbles. Whoever is
// there when the office is first seen live (opening the tab, a reload, coming
// back to it) is already at their place; only someone who came in after the
// tab opened (by their entry time) walks in from the lobby door, as does the
// chairman showing up later. Someone who left walks out before vanishing. Residents talk (person-intent.ts: the visitor walks
// over and both face each other), sleep in the dorm's beds at the mattress's
// height and get up before walking off, run on the treadmill's belt. During a
// power cut everyone freezes.
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { OfficeLayout } from "../../machines/office/office-layout.ts";
import { markerStatus } from "../../machines/office/office-names.ts";
import type { Placement } from "../../machines/office/office-placement.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";
import type { Talk } from "../../machines/office/office-conversations.ts";
import type { OfficeState } from "../../machines/office/office-store.ts";
import { sampleRoute, type MotionSample } from "./actor-motion.ts";
import { animationRates, type LodEntry } from "./animation-lod.ts";
import { isLyingPose, poseFor, type Pose, type TalkRole } from "./anim-groups.ts";
import { dressKey, personLook } from "./character-look.ts";
import type { CharacterPool } from "./character-pool.ts";
import type { CharacterVisual } from "./character-visual.ts";
import type { IdleTarget } from "./idle-performer.ts";
import type { Router, Route } from "./office-routes.ts";
import { personIntent } from "./person-intent.ts";
import { nearestNode, personTarget, shareIndices, type PersonTarget } from "./person-target.ts";

/** A pass is cheered this long, a failure smokes this long (viewer ms). */
export const CHEER_MS = 2_500;
export const SMOKE_MS = 4_000;
/** Getting out of bed (LayToIdle) before walking off, scene seconds. */
export const WAKE_SECONDS = 1.6;
const ENTRANCE = "lobby-entry";
/** Entry times this close before the tab opened still count as before it (clocks and frames lag a little), viewer ms. */
const ENTERED_BEFORE_SLACK_MS = 2_000;

export type PeopleEvent = "arrive-lift" | "start-work" | "cheer" | "smoke" | "approval";

export interface PersonView {
	readonly key: string;
	readonly floor: FloorLevel;
	readonly x: number;
	readonly z: number;
	/** Drawn on the floor shown (not in the elevator, not on another floor). */
	readonly visible: boolean;
	readonly smoking: boolean;
	readonly working: boolean;
	/** The desk anchor they work at (screens glow there). */
	readonly deskAnchor: string | null;
	/** The anchor walked to (or stood at) and the pose now, for tests. */
	readonly target: string;
	readonly pose: Pose;
	/** Dozing off over a stuck tool where they work. */
	readonly dozing: boolean;
	/** Height of the name label over the feet, metres (the drawn character's). */
	readonly labelHeight: number;
	/** What draws them (a service's robot once its model is in). */
	readonly model: CharacterVisual["model"];
	/** Babylon rotation.y drawn now (the target's facing once there). */
	readonly heading: number;
}

interface Person {
	key: string;
	index: number;
	placement: Placement;
	visual: CharacterVisual;
	/** What the visual was dressed as (dressKey): drawn again when it changes. */
	dress: string;
	blob: InstancedMesh;
	target: PersonTarget;
	route: Route;
	routeStart: number;
	sample: MotionSample;
	idle: IdleTarget | null;
	talk: TalkRole | null;
	/** Waking up in bed until this scene time, then walking to `pending`. */
	wakeUntil: number;
	pending: PersonTarget | null;
	pose: Pose;
	leaving: boolean;
	cheering: boolean;
	smoking: boolean;
	refused: boolean;
	lastResultAt: number;
}

export interface OfficePeople {
	update(placements: readonly Placement[], state: OfficeState, now: number, talks?: readonly Talk[]): void;
	/** Per frame: `dt` seconds of scene clock (0 while frozen). */
	frame(dt: number, shown: FloorLevel, fullRate: number, inView: (x: number, z: number) => boolean, focus: { x: number; z: number }): void;
	views(): readonly PersonView[];
	/** Each drawn person's head from their root on the floor plane (tests only: computed on call). */
	headOffsets(): ReadonlyMap<string, { readonly x: number; readonly z: number }>;
	/** Rebuilds every visual (the character model arrived). */
	rebuild(): void;
	meshes(): readonly AbstractMesh[];
	readonly count: number;
	dispose(): void;
}

/**
 * Whether a person newly drawn came in after the office was first seen live
 * at `liveSince` (viewer time): an employee by when they entered (machine time
 * plus the clock offset), the chairman once the office was live. Nobody walks
 * in on the first live frame: they were there before the tab opened.
 */
export function cameInAfterOpening(
	p: { readonly kind: Placement["kind"]; readonly actor: { readonly enteredAt: number } | null; readonly member: { readonly firstEnteredAt: number } | null },
	state: Pick<OfficeState, "clockOffset">, liveSince: number | null): boolean {
	if (liveSince === null) return false;
	if (p.kind === "chairman") return true;
	if (p.kind !== "employee") return false;
	const entered = p.actor?.enteredAt ?? p.member?.firstEnteredAt ?? 0;
	return entered > 0 && entered + state.clockOffset >= liveSince - ENTERED_BEFORE_SLACK_MS;
}

export function createOfficePeople(layout: OfficeLayout, router: Router, pool: CharacterPool, onEvent: (e: PeopleEvent, floor: FloorLevel) => void): OfficePeople {
	const people = new Map<string, Person>();
	let clock = 0;
	/** Viewer time the office was first seen live (the snapshot came); null before. */
	let liveSince: number | null = null;
	let nextIndex = 0;
	const deskAnchors = new Set(layout.floors.flatMap((f) => f.anchors.filter((a) => a.kind === "desk").map((a) => a.id)));
	const pantry = layout.floors.flatMap((f) => f.anchors.filter((a) => a.kind === "pantry").map((a) => a.id));
	const sofas = layout.floors.flatMap((f) => f.anchors.filter((a) => a.kind === "sofa").map((a) => a.id));
	const entrance = personTarget(layout, ENTRANCE, 0, false);

	const startRoute = (p: Person, to: PersonTarget): void => {
		const s = p.sample;
		// Mid-walk: rejoin at the node of the segment walked; at rest: the node of the anchor stood at.
		const node = s.resume?.node ?? (s.done ? p.target.node : null) ?? nearestNode(layout, s.floor, s.x, s.z) ?? to.node;
		p.route = router.route({ floor: s.floor, x: s.x, z: s.z, node }, { floor: to.floor, x: to.x, z: to.z, node: to.node });
		p.routeStart = clock;
		p.target = to;
	};

	const atRest = (t: PersonTarget): MotionSample => ({ floor: t.floor, x: t.x, z: t.z, heading: t.face, moving: false, inLift: false, done: true, resume: null });

	return {
		get count() {
			return people.size;
		},
		update(placements, state, now, talks = []) {
			const occupiedDesks = placements.filter((p) => p.member?.desk != null && p.room === "WORK").map((p) => p.anchorId);
			const ctx = { enabled: state.power === "on", pantry, sofas, occupiedDesks };
			const wanted = placements.map((placement) => personIntent(placement, talks, now, ctx));
			// Standing beside an anchor (a talk's visitor, the director's round) is not a share of the anchor itself.
			const shares = shareIndices(wanted.map((w) => (w.beside ? `beside:${w.anchorId}` : w.anchorId)));
			const seen = new Set<string>();
			wanted.forEach((w, i) => {
				const key = w.placement.key;
				seen.add(key);
				const found = personTarget(layout, w.anchorId, shares[i] ?? 0, w.beside) ?? personTarget(layout, w.placement.anchorId, 0, false);
				if (found === null) return;
				// A standing host turns to the visitor; someone lying down keeps the bed's own facing (head on the pillow).
				const lying = w.placement.life?.act === "sleep";
				const target = w.turn !== 0 && !found.seated && !lying ? { ...found, face: found.face + w.turn } : found;
				let p = people.get(key);
				const look = personLook(w.placement);
				if (p === undefined) {
					const index = nextIndex++;
					const walksIn = entrance !== null && cameInAfterOpening(w.placement, state, liveSince);
					const start = walksIn && entrance !== null ? entrance : target;
					p = {
						key,
						index,
						placement: w.placement,
						visual: pool.create(key, look, index),
						dress: dressKey(look),
						blob: pool.blob(key),
						target: start,
						route: { legs: [] },
						routeStart: clock,
						sample: atRest(start),
						idle: w.idle,
						talk: w.talk,
						wakeUntil: 0,
						pending: null,
						pose: "stand-idle",
						leaving: false,
						cheering: false,
						smoking: false,
						refused: false,
						lastResultAt: w.placement.actor?.lastResult?.at ?? 0,
					};
					people.set(key, p);
					if (walksIn) startRoute(p, target);
				}
				if (dressKey(look) !== p.dress) {
					// Dressed otherwise now (Advisor's look from a profile read late, or changed): drawn again where they are.
					p.visual.dispose();
					p.visual = pool.create(key, look, p.index);
					p.dress = dressKey(look);
					p.pose = "stand-idle";
				}
				const wasAwaiting = p.placement.actor?.state === "awaiting";
				p.placement = w.placement;
				p.idle = w.idle;
				p.talk = w.talk;
				p.leaving = false;
				const actor = w.placement.actor;
				if (actor?.state === "awaiting" && !wasAwaiting) onEvent("approval", target.floor);
				const result = actor?.lastResult ?? null;
				const resultAge = result === null ? Infinity : now - (result.at + state.clockOffset);
				if (result !== null && result.at !== p.lastResultAt) {
					p.lastResultAt = result.at;
					if (resultAge < SMOKE_MS) onEvent(result.ok ? "cheer" : "smoke", p.sample.floor);
				}
				p.cheering = result?.ok === true && resultAge < CHEER_MS;
				p.smoking = result?.ok === false && resultAge < SMOKE_MS;
				p.refused = markerStatus(w.placement.kind, actor) === "denied";
				const moved = target.anchorId !== p.target.anchorId || Math.hypot(target.x - p.target.x, target.z - p.target.z) > 0.05 || target.floor !== p.target.floor;
				if (p.pending !== null) p.pending = target;
				else if (moved && p.sample.done && isLyingPose(p.pose)) {
					// Out of bed first: get up, then walk.
					p.wakeUntil = clock + WAKE_SECONDS;
					p.pending = target;
				}
				// In the elevator: finish the ride first, the next update reroutes.
				else if (moved && !p.sample.inLift) startRoute(p, target);
				else if (!moved) p.target = target;
			});
			for (const p of people.values()) {
				if (seen.has(p.key) || p.leaving) continue;
				p.leaving = true;
				if (entrance !== null && !p.sample.inLift && p.placement.kind !== "director") startRoute(p, entrance);
				else p.route = { legs: [] };
			}
			if (liveSince === null && state.status === "live") liveSince = now;
		},
		frame(dt, shown, fullRate, inView, focus) {
			clock += dt;
			const lod: LodEntry[] = [];
			for (const p of [...people.values()]) {
				if (p.pending !== null && clock >= p.wakeUntil) {
					startRoute(p, p.pending);
					p.pending = null;
				}
				const waking = p.pending !== null;
				const wasLift = p.sample.inLift;
				p.sample = sampleRoute(p.route, clock - p.routeStart, { floor: p.target.floor, x: p.target.x, z: p.target.z, heading: p.target.face });
				if (wasLift && !p.sample.inLift && p.sample.floor === shown) onEvent("arrive-lift", shown);
				if (p.leaving && p.sample.done) {
					p.visual.dispose();
					p.blob.dispose();
					people.delete(p.key);
					continue;
				}
				const s = p.sample;
				const arrived = s.done;
				const visible = !s.inLift && s.floor === shown;
				p.visual.setVisible(visible);
				p.blob.setEnabled(visible);
				// On the bed or the treadmill once there; on the floor while walking.
				p.visual.root.position.set(s.x, arrived ? p.target.y : 0, s.z);
				p.visual.root.rotation.y = arrived ? p.target.face : s.heading;
				p.blob.position.set(s.x, 0.015, s.z);
				const busy = p.placement.activityRoom !== null;
				const activity = p.placement.actor?.activity ?? null;
				// Dozing off over a stuck tool: the plain sitting or standing pose where they work.
				const group = busy && activity?.stuckMs == null ? (activity?.group ?? null) : null;
				const life = arrived ? (p.placement.life?.act ?? null) : null;
				// A dancer stands up in front of their seat.
				const seated = arrived && p.target.seated && life !== "dance";
				const pose = poseFor({
					moving: s.moving || s.inLift,
					seated,
					group,
					idle: arrived ? (p.idle?.act ?? null) : null,
					cheering: p.cheering,
					refused: p.refused,
					life,
					talk: arrived ? p.talk : null,
					waking,
					low: p.target.low,
				});
				if (pose !== p.pose) {
					if (visible && p.pose === "walk" && group !== null) onEvent("start-work", shown);
					p.pose = pose;
				}
				p.visual.setPose(pose, p.target.seat);
				p.visual.setDozing?.(arrived && busy && activity?.stuckMs != null);
				lod.push({ key: p.key, onFloor: visible, onScreen: visible && inView(s.x, s.z), active: s.moving || busy, distance: Math.hypot(s.x - focus.x, s.z - focus.z) });
			}
			const rates = animationRates(lod, fullRate);
			for (const p of people.values()) {
				p.visual.setUpdateEvery(dt === 0 ? 0 : (rates.get(p.key) ?? 0));
				p.visual.tick(clock);
			}
		},
		views() {
			return [...people.values()].map((p) => ({
				key: p.key,
				floor: p.sample.floor,
				x: p.sample.x,
				z: p.sample.z,
				visible: !p.sample.inLift,
				smoking: p.smoking,
				working: p.placement.activityRoom !== null && p.sample.done,
				deskAnchor: p.sample.done && deskAnchors.has(p.target.anchorId) ? p.target.anchorId : null,
				target: p.target.anchorId,
				pose: p.pose,
				dozing: p.sample.done && p.placement.activityRoom !== null && p.placement.actor?.activity?.stuckMs != null,
				labelHeight: p.visual.labelHeight,
				model: p.visual.model,
				heading: p.visual.root.rotation.y,
			}));
		},
		headOffsets() {
			const out = new Map<string, { readonly x: number; readonly z: number }>();
			for (const p of people.values()) {
				const offset = p.visual.headOffset?.() ?? null;
				if (offset !== null) out.set(p.key, offset);
			}
			return out;
		},
		rebuild() {
			for (const p of people.values()) {
				p.visual.dispose();
				const look = personLook(p.placement);
				p.visual = pool.create(p.key, look, p.index);
				p.dress = dressKey(look);
				p.pose = "stand-idle";
			}
		},
		meshes() {
			return [...people.values()].flatMap((p) => p.visual.meshes());
		},
		dispose() {
			for (const p of people.values()) {
				p.visual.dispose();
				p.blob.dispose();
			}
			people.clear();
		},
	};
}
