// The daily life of the office's residents, by the viewer's clock (the same
// clock that lights the building, office-daypart.ts): whoever is off duty
// sleeps, trains, eats and unwinds on the living floor at the hours real
// people do, and spends office hours on the work floors (with the idle show
// of the 3D view). Real work always wins: placement only asks the schedule
// about people with nothing to do. Each person runs a few minutes early or
// late (up to SHIFT_MINUTES, stable by their key) and has stable tastes (a
// gym lover trains at dawn and after work, a TV fan heads for the sofa), so
// no two live the same day. Deterministic: the person and the time give the
// plan, so every viewer sees the same. Pure, no React, no engine.
import { nameHash } from "./office-cast.ts";
import type { AnchorKind, LayoutAnchor } from "./office-layout.ts";

/** The parts of the day. */
export type LifeSlot = "sleep" | "dawn" | "breakfast" | "work" | "lunch" | "unwind" | "evening";

/** What a resident does at their place on the living floor (the 3D view's pose, the 2D view's status). */
export type LifeAct = "sleep" | "lounge" | "doze" | "run" | "pushup" | "jacks" | "punch" | "eat" | "watch" | "chat" | "dance";

export interface LifePlan {
	readonly slot: LifeSlot;
	/** The kinds of place to go to, best first; empty: stay on the work floors. */
	readonly kinds: readonly AnchorKind[];
}

export interface LifeTraits {
	/** Minutes this person runs early (negative) or late against the clock. */
	readonly shiftMinutes: number;
	/** Trains at dawn and after work (others sleep in and unwind on the sofa). */
	readonly gymLover: boolean;
	/** Spends the evening in front of the TV (others chat at the dining table). */
	readonly tvFan: boolean;
	/** After work, lies on the bed with nothing to do instead of the TV or the dining table (those who do not train). */
	readonly homebody: boolean;
}

/** The furthest a person's day runs early or late, minutes. */
export const SHIFT_MINUTES = 20;

/** Slot boundaries, local hours (fractional), in order: each slot runs until the next one starts. */
const SLOTS: readonly { readonly from: number; readonly slot: LifeSlot }[] = [
	{ from: 0, slot: "sleep" },
	{ from: 6, slot: "dawn" },
	{ from: 7, slot: "breakfast" },
	{ from: 8, slot: "work" },
	{ from: 12, slot: "lunch" },
	{ from: 13, slot: "work" },
	{ from: 17.5, slot: "unwind" },
	{ from: 19, slot: "evening" },
	{ from: 23, slot: "sleep" },
];

/** A person's stable shift and tastes, from their key (FNV-1a, office-cast.ts). */
export function lifeTraits(key: string): LifeTraits {
	const h = nameHash(`life:${key}`);
	return {
		shiftMinutes: (h % (2 * SHIFT_MINUTES + 1)) - SHIFT_MINUTES,
		gymLover: ((h >>> 8) & 1) === 1,
		tvFan: ((h >>> 9) & 3) !== 0,
		homebody: ((h >>> 11) & 1) === 1,
	};
}

/** The local hour (fractional) of `now` in the viewer's time zone, moved by `shiftMinutes`. */
export function localHour(now: number, shiftMinutes = 0): number {
	const d = new Date(now - shiftMinutes * 60_000);
	return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** The slot of a local hour. */
export function slotAt(hour: number): LifeSlot {
	let slot: LifeSlot = "sleep";
	for (const s of SLOTS) if (hour >= s.from) slot = s.slot;
	return slot;
}

/** Where `key` spends `now` (viewer time) when free. */
export function lifePlanAt(key: string, now: number): LifePlan {
	const traits = lifeTraits(key);
	const slot = slotAt(localHour(now, traits.shiftMinutes));
	switch (slot) {
		case "sleep":
			return { slot, kinds: ["bed", "tv"] };
		case "dawn":
			return { slot, kinds: traits.gymLover ? ["gym", "tv"] : ["bed", "tv"] };
		case "breakfast":
		case "lunch":
			return { slot, kinds: ["dine", "counter", "tv"] };
		case "unwind":
			return { slot, kinds: traits.gymLover ? ["gym", "tv", "dine"] : traits.homebody ? ["bed", "tv", "dine"] : ["tv", "dine", "gym"] };
		case "evening":
			return { slot, kinds: traits.tvFan ? ["tv", "dine", "counter"] : ["dine", "tv", "counter"] };
		case "work":
			return { slot, kinds: [] };
	}
}

/** Evening dancing in front of the TV: one window in DANCE_EVERY of DANCE_WINDOW_MS for each person, by their key. */
const DANCE_WINDOW_MS = 4 * 60_000;
const DANCE_EVERY = 5;

/** What `key` does at `anchor` during `slot` at `now`. */
export function lifeActAt(anchor: Pick<LayoutAnchor, "kind" | "act">, slot: LifeSlot, key: string, now: number): LifeAct {
	switch (anchor.kind) {
		case "bed":
			// Awake on the bed in the hours after work, asleep in it at night and at dawn.
			return slot === "unwind" || slot === "evening" ? "lounge" : "sleep";
		case "gym":
			return anchor.act ?? "jacks";
		case "dine":
			return slot === "breakfast" || slot === "lunch" ? "eat" : "chat";
		case "counter":
			return "eat";
		case "tv": {
			if (slot === "sleep" || slot === "dawn") return "doze";
			const window = Math.floor(now / DANCE_WINDOW_MS);
			return slot === "evening" && nameHash(`dance:${key}#${window}`) % DANCE_EVERY === 0 ? "dance" : "watch";
		}
		default:
			return "watch";
	}
}

/** Whether a resident doing `act` may be drawn into a conversation (never someone asleep, dozing or lying back resting). */
export function awakeAct(act: LifeAct): boolean {
	return act !== "sleep" && act !== "doze" && act !== "lounge";
}
