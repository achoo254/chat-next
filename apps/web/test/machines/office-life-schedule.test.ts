// The residents' day by the viewer's clock: the parts of the day, each
// person's stable shift and tastes, what they do at each place, and the
// placement that follows it (the director like everyone else: bed at 23:30,
// the TV or the table at 20:00, the office at 10:00), with real work always
// winning and never two people on one place.
import { OfficeActorState, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { anchorById, zoneOfRoom } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { allocateLifePlaces, lifeCandidates } from "../../src/machines/office/office-life-places.ts";
import { awakeAct, lifeActAt, lifePlanAt, lifeTraits, localHour, SHIFT_MINUTES, slotAt } from "../../src/machines/office/office-life-schedule.ts";
import { EMPTY_MEMORY, MAX_RESIDENTS, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import type { OfficeStore } from "../../src/machines/office/office-store.ts";
import { act, director, ev, localAt, session, snapshot, staff, storeAt } from "./office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

function placeAt(store: OfficeStore, now: number): readonly Placement[] {
	return officePlacement(store.state(), layout(), now, EMPTY_MEMORY).placements;
}

const find = (list: readonly Placement[], key: string): Placement => {
	const p = list.find((x) => x.key === key);
	if (p === undefined) throw new Error(`${key} not placed`);
	return p;
};

/** A session at rest: the director idle, employees of `types` finished. */
function resting(types: readonly string[] = []): OfficeStore {
	const { store } = storeAt();
	store.applySnapshot(snapshot([director({ state: OfficeActorState.IDLE }), ...types.map((t, i) => staff(`s${i}`, t, { state: OfficeActorState.DONE }))], { session: session({ busy: false }) }));
	return store;
}

describe("the parts of the day", () => {
	it("runs sleep, dawn, breakfast, work, lunch, work, unwind, evening, sleep", () => {
		expect([0, 5.9, 6, 7, 8, 11.9, 12, 13, 17.4, 17.5, 19, 22.9, 23].map(slotAt)).toEqual([
			"sleep",
			"sleep",
			"dawn",
			"breakfast",
			"work",
			"work",
			"lunch",
			"work",
			"work",
			"unwind",
			"evening",
			"evening",
			"sleep",
		]);
	});

	it("gives each person a stable shift within twenty minutes and stable tastes", () => {
		const keys = ["director", "scout#1", "tester#1", "planner#1", "general-purpose#2", "~explore#1"];
		const shifts = new Set<number>();
		for (const key of keys) {
			const traits = lifeTraits(key);
			expect(traits).toEqual(lifeTraits(key));
			expect(Math.abs(traits.shiftMinutes)).toBeLessThanOrEqual(SHIFT_MINUTES);
			shifts.add(traits.shiftMinutes);
		}
		expect(shifts.size).toBeGreaterThan(1);
		// The shift moves the person's clock, not the viewer's.
		expect(localHour(localAt(10), 30)).toBeCloseTo(9.5);
	});

	it("plans beds at night, meals at meal times, nothing in office hours, and gym or sofa by taste", () => {
		expect(lifePlanAt("director", localAt(23, 30)).kinds[0]).toBe("bed");
		expect(lifePlanAt("director", localAt(3)).kinds[0]).toBe("bed");
		expect(lifePlanAt("director", localAt(7, 30)).kinds[0]).toBe("dine");
		expect(lifePlanAt("director", localAt(12, 30)).kinds[0]).toBe("dine");
		expect(lifePlanAt("director", localAt(10)).kinds).toEqual([]);
		expect(lifePlanAt("director", localAt(15)).kinds).toEqual([]);
		const lovers = ["a#1", "b#1", "c#1", "d#1", "e#1", "f#1", "g#1", "h#1"].filter((k) => lifeTraits(k).gymLover);
		expect(lovers.length).toBeGreaterThan(0);
		for (const key of lovers) expect(lifePlanAt(key, localAt(18, 15)).kinds[0]).toBe("gym");
	});

	it("sends the homebodies who do not train to lie back on a bed after work, and nobody else", () => {
		const keys = Array.from({ length: 60 }, (_, i) => `person#${i}`);
		const homebodies = keys.filter((k) => !lifeTraits(k).gymLover && lifeTraits(k).homebody);
		const others = keys.filter((k) => lifeTraits(k).gymLover || !lifeTraits(k).homebody);
		expect(homebodies.length).toBeGreaterThan(5);
		expect(others.length).toBeGreaterThan(5);
		for (const key of homebodies) expect(lifePlanAt(key, localAt(18, 15)).kinds[0], key).toBe("bed");
		for (const key of others) expect(lifePlanAt(key, localAt(18, 15)).kinds[0], key).not.toBe("bed");
		// Lying back is rest: nobody is pulled out of it into a conversation, like a sleeper.
		expect(awakeAct("lounge")).toBe(false);
		expect(awakeAct("sleep")).toBe(false);
		expect(awakeAct("watch")).toBe(true);
	});

	it("does at each place what it is for", () => {
		const place = (kind: "bed" | "gym" | "dine" | "counter" | "tv", act: "run" | "punch" | null = null) => ({ kind, act });
		expect(lifeActAt(place("bed"), "sleep", "x", localAt(1))).toBe("sleep");
		expect(lifeActAt(place("gym", "run"), "dawn", "x", localAt(6, 30))).toBe("run");
		expect(lifeActAt(place("gym", "punch"), "unwind", "x", localAt(18))).toBe("punch");
		expect(lifeActAt(place("dine"), "lunch", "x", localAt(12, 30))).toBe("eat");
		expect(lifeActAt(place("dine"), "evening", "x", localAt(20))).toBe("chat");
		expect(lifeActAt(place("counter"), "breakfast", "x", localAt(7, 30))).toBe("eat");
		expect(lifeActAt(place("tv"), "sleep", "x", localAt(1))).toBe("doze");
		// A bed: asleep at night and at dawn, awake and lying back in the hours after work.
		expect(lifeActAt(place("bed"), "dawn", "x", localAt(6, 30))).toBe("sleep");
		expect(lifeActAt(place("bed"), "unwind", "x", localAt(18))).toBe("lounge");
		expect(lifeActAt(place("bed"), "evening", "x", localAt(20))).toBe("lounge");
		// Some evening windows dance, most watch.
		const evening = Array.from({ length: 40 }, (_, i) => lifeActAt(place("tv"), "evening", "x", localAt(19) + i * 4 * 60_000));
		expect(evening).toContain("watch");
		expect(evening).toContain("dance");
	});
});

describe("places in the living rooms", () => {
	it("tries places in each person's own order and never gives one place to two", () => {
		const plan = { slot: "sleep" as const, kinds: ["bed", "tv"] as const };
		const orders = ["a#1", "b#1", "c#1"].map((k) => lifeCandidates(layout(), k, { ...plan, kinds: [...plan.kinds] })[0]?.id);
		expect(new Set(orders).size).toBeGreaterThan(1);
		const seekers = Array.from({ length: 15 }, (_, i) => ({ key: `p${i}#1`, plan: { ...plan, kinds: [...plan.kinds] }, had: null }));
		const places = allocateLifePlaces(layout(), seekers, new Set());
		const ids = [...places.values()].map((a) => a.id);
		expect(ids).toHaveLength(15);
		expect(new Set(ids).size).toBe(15);
		// Sixteen beds: fifteen sleepers all lie down.
		expect(ids.filter((id) => id.startsWith("bed-"))).toHaveLength(15);
	});

	it("keeps the place someone already has", () => {
		const plan = { slot: "sleep" as const, kinds: ["bed" as const] };
		const first = allocateLifePlaces(layout(), [{ key: "a#1", plan, had: "bed-5" }, { key: "b#1", plan, had: null }], new Set());
		expect(first.get("a#1")?.id).toBe("bed-5");
		expect(first.get("b#1")?.id).not.toBe("bed-5");
	});
});

describe("living by the schedule", () => {
	it("puts the idle director in a bed at 23:30, at the TV or the table at 20:00, and in the office at 10:00", () => {
		const store = resting();
		const night = find(placeAt(store, localAt(23, 30)), "director");
		expect(night.anchorId).toMatch(/^bed-\d+$/);
		expect(night).toMatchObject({ room: "DORM", activityRoom: null, life: { slot: "sleep", act: "sleep" } });
		expect(zoneOfRoom(layout(), night.room)).toBe("d");
		const evening = find(placeAt(store, localAt(20)), "director");
		expect(evening.anchorId).toMatch(/^(tv|dine)-\d$/);
		expect(zoneOfRoom(layout(), evening.room)).toBe("d");
		const morning = find(placeAt(store, localAt(10)), "director");
		expect(morning).toMatchObject({ room: "DIRECTOR", anchorId: "director", life: null });
		expect(zoneOfRoom(layout(), morning.room)).toBe("a");
	});

	it("follows a clock set back at once (no hold on time that has not passed)", () => {
		const store = resting();
		const night = officePlacement(store.state(), layout(), localAt(23, 30), EMPTY_MEMORY);
		expect(find(night.placements, "director").room).toBe("DORM");
		const back = officePlacement(store.state(), layout(), localAt(10), night.memory);
		expect(find(back.placements, "director").room).toBe("DIRECTOR");
	});

	it("lets real work win: the director working at 23:30 is at the room of the tool", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.LIBRARY) })], { session: session({ busy: true }) }));
		expect(find(placeAt(store, localAt(23, 30)), "director")).toMatchObject({ room: "LIBRARY", life: null });
		// Between two tools of a running turn nobody goes to bed.
		const between = resting();
		between.applyEvents(1n, [ev(1, { case: "session", value: session({ busy: true }) })]);
		expect(find(placeAt(between, localAt(23, 30)), "director").room).toBe("DIRECTOR");
	});

	it("sends finished employees to bed at night and keeps them in the work rooms in office hours", () => {
		const store = resting(["scout", "tester"]);
		const night = placeAt(store, localAt(1));
		expect(find(night, "scout#1").room).toBe("DORM");
		expect(find(night, "tester#1").room).toBe("DORM");
		const day = placeAt(store, localAt(10));
		expect(find(day, "scout#1").room).toBe("WORK");
		expect(zoneOfRoom(layout(), find(day, "tester#1").room)).not.toBe("d");
	});

	it("shows at most twelve residents, never two on one place, each in a bed of the sixteen at night", () => {
		const types = Array.from({ length: 14 }, (_, i) => `type-${i}`);
		const store = resting(types);
		// Every subagent left: fourteen off-duty residents and the director.
		store.applyEvents(
			1n,
			types.map((_, i) => ev(i + 1, { case: "actorLeave", value: { actorId: `s${i}` } })),
		);
		expect(store.state().residents).toHaveLength(14);
		const placed = placeAt(store, localAt(1));
		const residents = placed.filter((p) => p.kind === "director" || p.kind === "employee");
		expect(residents).toHaveLength(MAX_RESIDENTS);
		const ids = residents.map((p) => p.anchorId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((id) => id.startsWith("bed-"))).toHaveLength(MAX_RESIDENTS);
		for (const p of residents) expect(anchorById(layout(), p.anchorId)?.room, p.key).toMatch(/^(DORM|LOUNGE)$/);
	});
});
