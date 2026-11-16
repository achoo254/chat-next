// The people of the 3D office: turns each placement (office-placement.ts,
// shared with 2D) and the idle show into a target spot, walks people there
// along the walkways and through the elevator, keeps everyone moving on in
// logic even on floors not shown, picks each one's pose and animation rate,
// and reports positions for the HTML labels and speech bubbles. A newcomer
// after the first frame walks in from the lobby door; someone who left walks
// out before vanishing. During a power cut everyone freezes.
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { OfficeLayout } from "../../machines/office/office-layout.ts";
import { markerStatus } from "../../machines/office/office-names.ts";
import type { Placement } from "../../machines/office/office-placement.ts";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";
import type { OfficeState } from "../../machines/office/office-store.ts";
import { sampleRoute, type MotionSample } from "./actor-motion.ts";
import { animationRates, type LodEntry } from "./animation-lod.ts";
import { poseFor, type Pose } from "./anim-groups.ts";
import { personLook } from "./character-look.ts";
import type { CharacterPool } from "./character-pool.ts";
import type { CharacterVisual } from "./character-visual.ts";
import { idlePerformance, type IdleTarget } from "./idle-performer.ts";
import type { Router, Route } from "./office-routes.ts";
import { nearestNode, personTarget, shareIndices, type PersonTarget } from "./person-target.ts";

/** A pass is cheered this long, a failure smokes this long (viewer ms). */
export const CHEER_MS = 2_500;
export const SMOKE_MS = 4_000;
const ENTRANCE = "lobby-entry";

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
	/** Height of the name label over the feet, metres (the drawn character's). */
	readonly labelHeight: number;
}

interface Person {
	key: string;
	index: number;
	placement: Placement;
	visual: CharacterVisual;
	blob: InstancedMesh;
	target: PersonTarget;
	route: Route;
	routeStart: number;
	sample: MotionSample;
	idle: IdleTarget | null;
	pose: Pose;
	leaving: boolean;
	cheering: boolean;
	smoking: boolean;
	refused: boolean;
	lastResultAt: number;
}

export interface OfficePeople {
	update(placements: readonly Placement[], state: OfficeState, now: number): void;
	/** Per frame: `dt` seconds of scene clock (0 while frozen). */
	frame(dt: number, shown: FloorLevel, fullRate: number, inView: (x: number, z: number) => boolean, focus: { x: number; z: number }): void;
	views(): readonly PersonView[];
	/** Rebuilds every visual (the character model arrived). */
	rebuild(): void;
	meshes(): readonly AbstractMesh[];
	readonly count: number;
	dispose(): void;
}

export function createOfficePeople(layout: OfficeLayout, router: Router, pool: CharacterPool, onEvent: (e: PeopleEvent, floor: FloorLevel) => void): OfficePeople {
	const people = new Map<string, Person>();
	let clock = 0;
	let first = true;
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
		update(placements, state, now) {
			const occupiedDesks = placements.filter((p) => p.member?.desk != null && p.room === "WORK").map((p) => p.anchorId);
			const ctx = { enabled: state.power === "on" && !state.off, pantry, sofas, occupiedDesks };
			const wanted = placements.map((placement) => {
				const idle = idlePerformance({ key: placement.key, kind: placement.kind, activityRoom: placement.activityRoom, since: placement.since }, now, ctx);
				return { placement, idle, anchorId: idle?.anchorId ?? placement.anchorId };
			});
			const shares = shareIndices(wanted.map((w) => w.anchorId));
			const seen = new Set<string>();
			wanted.forEach((w, i) => {
				const key = w.placement.key;
				seen.add(key);
				const target = personTarget(layout, w.anchorId, shares[i] ?? 0, w.idle?.act === "patrol") ?? personTarget(layout, w.placement.anchorId, 0, false);
				if (target === null) return;
				let p = people.get(key);
				if (p === undefined) {
					const index = nextIndex++;
					const walksIn = !first && entrance !== null && (w.placement.kind === "employee" || w.placement.kind === "chairman");
					const start = walksIn && entrance !== null ? entrance : target;
					p = {
						key,
						index,
						placement: w.placement,
						visual: pool.create(key, personLook(w.placement), index),
						blob: pool.blob(key),
						target: start,
						route: { legs: [] },
						routeStart: clock,
						sample: atRest(start),
						idle: w.idle,
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
				const wasAwaiting = p.placement.actor?.state === "awaiting";
				p.placement = w.placement;
				p.idle = w.idle;
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
				// In the elevator: finish the ride first, the next update reroutes.
				if (moved && !p.sample.inLift) startRoute(p, target);
				else if (!moved) p.target = target;
			});
			for (const p of people.values()) {
				if (seen.has(p.key) || p.leaving) continue;
				p.leaving = true;
				if (entrance !== null && !p.sample.inLift && p.placement.kind !== "director") startRoute(p, entrance);
				else p.route = { legs: [] };
			}
			first = false;
		},
		frame(dt, shown, fullRate, inView, focus) {
			clock += dt;
			const lod: LodEntry[] = [];
			for (const p of [...people.values()]) {
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
				p.visual.root.position.set(s.x, 0, s.z);
				p.visual.root.rotation.y = arrived ? p.target.face : s.heading;
				p.blob.position.set(s.x, 0.015, s.z);
				const busy = p.placement.activityRoom !== null;
				const group = busy ? (p.placement.actor?.activity?.group ?? null) : null;
				const pose = poseFor({ moving: s.moving || s.inLift, seated: arrived && p.target.seated, group, idle: arrived ? (p.idle?.act ?? null) : null, cheering: p.cheering, refused: p.refused });
				if (pose !== p.pose) {
					if (visible && p.pose === "walk" && group !== null) onEvent("start-work", shown);
					p.pose = pose;
				}
				p.visual.setPose(pose);
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
				labelHeight: p.visual.labelHeight,
			}));
		},
		rebuild() {
			for (const p of people.values()) {
				p.visual.dispose();
				p.visual = pool.create(p.key, personLook(p.placement), p.index);
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
