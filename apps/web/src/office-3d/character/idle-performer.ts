// The "show" layer that fills idle time (plan decision 3): a coffee in the
// pantry, a chat on the sofa, a yawn at the desk, the director's round of the
// desks people sit at. It only ever takes someone the placement leaves free
// (activityRoom null), only after a while free, and drops at once when real
// work comes (the next call returns null). Deterministic: the act depends on
// the person and the clock, so every view agrees. Pure, no engine.
import type { PersonKind } from "../../machines/office/office-placement.ts";

export type IdleAct = "coffee" | "chat" | "yawn" | "patrol";

export interface IdleTarget {
	readonly act: IdleAct;
	/** Where to go for it; null acts in place. */
	readonly anchorId: string | null;
}

export interface IdlePerson {
	readonly key: string;
	readonly kind: PersonKind;
	readonly activityRoom: string | null;
	/** Viewer time they came to where they are. */
	readonly since: number;
}

export interface IdleContext {
	/** False while the power is out or the building is closed: no show. */
	readonly enabled: boolean;
	readonly pantry: readonly string[];
	readonly sofas: readonly string[];
	/** Desks someone sits at, for the director's round. */
	readonly occupiedDesks: readonly string[];
}

/** Free this long before any show. */
export const IDLE_AFTER_MS = 15_000;
/** One act per slot at most, for its first ACT_MS. */
export const SLOT_MS = 50_000;
export const ACT_MS = 16_000;

/** A small stable hash of a string (FNV-1a). */
export function hashOf(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function pick<T>(list: readonly T[], n: number): T | undefined {
	return list.length === 0 ? undefined : list[n % list.length];
}

export function idlePerformance(person: IdlePerson, now: number, ctx: IdleContext): IdleTarget | null {
	if (!ctx.enabled || person.activityRoom !== null) return null;
	if (person.kind !== "employee" && person.kind !== "director") return null;
	if (now - person.since < IDLE_AFTER_MS) return null;
	const offset = hashOf(person.key) % SLOT_MS;
	const slot = Math.floor((now + offset) / SLOT_MS);
	const into = (now + offset) % SLOT_MS;
	if (into >= ACT_MS) return null;
	// The act must not start before the person was free for IDLE_AFTER_MS.
	if (now - into - person.since < IDLE_AFTER_MS) return null;
	const roll = hashOf(`${person.key}#${slot}`);
	if (person.kind === "director") {
		if (roll % 3 === 2) return { act: "yawn", anchorId: null };
		const desk = pick(ctx.occupiedDesks, roll >>> 3);
		return desk === undefined ? null : { act: "patrol", anchorId: desk };
	}
	switch (roll % 5) {
		case 0: {
			const spot = pick(ctx.pantry, roll >>> 3);
			return spot === undefined ? null : { act: "coffee", anchorId: spot };
		}
		case 1: {
			const spot = pick(ctx.sofas, roll >>> 3);
			return spot === undefined ? null : { act: "chat", anchorId: spot };
		}
		case 2:
			return { act: "yawn", anchorId: null };
		default:
			return null;
	}
}
