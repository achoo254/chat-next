// Which place of the living floor each free resident takes for their part of
// the day (office-life-schedule.ts says the kinds of place, best first): a
// person keeps the place they already have while it still fits, otherwise
// takes the first free one, trying places in an order of their own (stable by
// key) so the dorm's beds and the sofa fill differently for everyone. Never
// two people on one place while one of the kinds has room; when every place of
// every kind is taken, people share the first one (the views offset them).
// Pure.
import { nameHash } from "./office-cast.ts";
import type { LayoutAnchor, OfficeLayout } from "./office-layout.ts";
import type { LifePlan } from "./office-life-schedule.ts";

export interface LifeSeeker {
	readonly key: string;
	readonly plan: LifePlan;
	/** The place the person had at the last call, if any. */
	readonly had: string | null;
}

function placesOf(layout: OfficeLayout, kind: LayoutAnchor["kind"]): readonly LayoutAnchor[] {
	return layout.floors.flatMap((f) => f.anchors.filter((a) => a.kind === kind));
}

/** The places of `plan` for `key`, best kind first, each kind's places rotated by the person's own offset. */
export function lifeCandidates(layout: OfficeLayout, key: string, plan: LifePlan): readonly LayoutAnchor[] {
	const turn = nameHash(`place:${key}`);
	return plan.kinds.flatMap((kind) => {
		const all = placesOf(layout, kind);
		if (all.length === 0) return [];
		const start = turn % all.length;
		return [...all.slice(start), ...all.slice(0, start)];
	});
}

/** Each seeker's place (anchor id), given places already `taken` by others (which it extends). */
export function allocateLifePlaces(layout: OfficeLayout, seekers: readonly LifeSeeker[], taken: Set<string>): ReadonlyMap<string, LayoutAnchor> {
	const out = new Map<string, LayoutAnchor>();
	const lists = new Map(seekers.map((s) => [s.key, lifeCandidates(layout, s.key, s.plan)]));
	// Those keeping their place claim it first, so a newcomer never takes a bed someone sleeps in.
	for (const s of seekers) {
		const kept = lists.get(s.key)?.find((a) => a.id === s.had);
		if (kept === undefined || taken.has(kept.id)) continue;
		out.set(s.key, kept);
		taken.add(kept.id);
	}
	for (const s of seekers) {
		if (out.has(s.key)) continue;
		const list = lists.get(s.key) ?? [];
		const chosen = list.find((a) => !taken.has(a.id)) ?? list[0];
		if (chosen === undefined) continue;
		out.set(s.key, chosen);
		taken.add(chosen.id);
	}
	return out;
}
