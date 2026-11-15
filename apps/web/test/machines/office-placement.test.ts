// Where everyone is: each room of the table reached on its floor, home rooms
// replacing only WORK, holds against running about, lingering then going
// home, approvals to Security, the chairman in the lobby, no two people on
// one spot, and the same input giving the same places.
import { OfficeActorState, OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { deskOrder } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { EMPTY_MEMORY, LINGER_MS, MIN_STAY_MS, officePlacement, type Placement, type PlacementMemory } from "../../src/machines/office/office-placement.ts";
import type { OfficeStore } from "../../src/machines/office/office-store.ts";
import { act, director, ev, machine, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

/** Places people at successive moments, keeping the memory like the views do. */
function placer(store: OfficeStore) {
	let memory: PlacementMemory = EMPTY_MEMORY;
	return (now: number, size: "desktop" | "phone" = "desktop"): readonly Placement[] => {
		const result = officePlacement(store.state(), layout(), now, memory, size);
		memory = result.memory;
		return result.placements;
	};
}

const find = (list: readonly Placement[], key: string): Placement => {
	const p = list.find((x) => x.key === key);
	if (p === undefined) throw new Error(`${key} not placed`);
	return p;
};

let seq = 0;
function startOn(store: OfficeStore, actorId: string, id: string, room: OfficeRoom, tool = "Read"): void {
	seq += 1;
	store.applyEvents(1n, [ev(seq, { case: "activityStart", value: { actorId, activity: act(id, room, tool) } })]);
}
function endOn(store: OfficeStore, actorId: string, id: string): void {
	seq += 1;
	store.applyEvents(1n, [ev(seq, { case: "activityEnd", value: { actorId, activityId: id, ok: true } })]);
}
function fresh(actors: Parameters<typeof snapshot>[0], options: Parameters<typeof snapshot>[1] = {}): OfficeStore {
	seq = 0;
	const { store } = storeAt();
	store.applySnapshot(snapshot(actors, options));
	return store;
}

describe("office placement", () => {
	it("takes each person to the room of their activity, on its floor", () => {
		const rooms: [OfficeRoom, string, 1 | 2 | 3][] = [
			[OfficeRoom.LOBBY, "LOBBY", 1],
			[OfficeRoom.DIRECTOR, "DIRECTOR", 1],
			[OfficeRoom.WORK, "WORK", 1],
			[OfficeRoom.SERVER, "SERVER", 1],
			[OfficeRoom.MEETING, "MEETING", 1],
			[OfficeRoom.PANTRY, "PANTRY", 1],
			[OfficeRoom.PLANNING, "PLANNING", 2],
			[OfficeRoom.LIBRARY, "LIBRARY", 2],
			[OfficeRoom.POST, "POST", 2],
			[OfficeRoom.SECURITY, "SECURITY", 3],
			[OfficeRoom.AUDIT, "AUDIT", 3],
			[OfficeRoom.QA, "QA", 3],
		];
		for (const [room, code, floor] of rooms) {
			const store = fresh([director({ activity: act("t", room) })]);
			const p = find(placer(store)(T0), "director");
			expect([p.room, p.floor], code).toEqual([code, floor]);
			expect(p.activityRoom).toBe(code);
		}
		// A room the agent does not know (or UNSPECIFIED) is WORK.
		const unknown = fresh([director({ activity: act("t", 99 as OfficeRoom) })]);
		expect(find(placer(unknown)(T0), "director").room).toBe("WORK");
	});

	it("replaces only WORK with an agent type's home room", () => {
		const store = fresh([director(), staff("a1", "tester", { activity: act("e", OfficeRoom.WORK, "Edit") }), staff("a2", "code-reviewer", { activity: act("r", OfficeRoom.LIBRARY) })]);
		const places = placer(store)(T0);
		expect(find(places, "tester#1").room).toBe("QA");
		// An activity with its own room goes there, home room or not.
		expect(find(places, "code-reviewer#1").room).toBe("LIBRARY");
		// Without a home room, typing happens at the employee's own desk.
		const plain = fresh([director(), staff("a1", "scout", { activity: act("e", OfficeRoom.WORK, "Edit") })]);
		const desk = find(placer(plain)(T0), "scout#1");
		expect(desk.room).toBe("WORK");
		expect(desk.anchorId).toBe(deskOrder(layout(), "desktop")[0]);
	});

	it("sends idle people home: the director to their office, employees to their desk, nested ones and those without a desk to the meeting room", () => {
		const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((t, i) => staff(`s${i}`, t, { state: OfficeActorState.DONE }));
		const store = fresh([director({ state: OfficeActorState.IDLE }), ...nine, staff("n1", "Explore", { spawnDepth: 2, parentId: "s0" })]);
		const places = placer(store)(T0);
		expect(find(places, "director")).toMatchObject({ room: "DIRECTOR", anchorId: "director", activityRoom: null });
		expect(find(places, "a#1")).toMatchObject({ room: "WORK", anchorId: "desk-0", activityRoom: null });
		expect(find(places, "i#1").room).toBe("MEETING");
		expect(find(places, "~Explore#1").room).toBe("MEETING");
		// A phone's desk order.
		const phone = officePlacement(store.state(), layout(), T0, EMPTY_MEMORY, "phone").placements;
		expect(find(phone, "a#1").anchorId).toBe(deskOrder(layout(), "phone")[0]);
	});

	it("moves at most once every four seconds through a burst of short tools", () => {
		const store = fresh([director()]);
		const place = placer(store);
		const rooms: string[] = [];
		const note = (now: number) => rooms.push(find(place(now), "director").room);
		startOn(store, "director", "r1", OfficeRoom.LIBRARY);
		note(T0);
		endOn(store, "director", "r1");
		startOn(store, "director", "e1", OfficeRoom.WORK, "Edit");
		note(T0 + 300);
		endOn(store, "director", "e1");
		startOn(store, "director", "r2", OfficeRoom.LIBRARY);
		note(T0 + 600);
		startOn(store, "director", "e2", OfficeRoom.WORK, "Edit");
		note(T0 + 1_500);
		note(T0 + MIN_STAY_MS - 1);
		note(T0 + MIN_STAY_MS);
		expect(rooms).toEqual(["LIBRARY", "LIBRARY", "LIBRARY", "LIBRARY", "LIBRARY", "WORK"]);
	});

	it("lingers six seconds where the work ended, then goes home", () => {
		const store = fresh([director(), staff("a1", "scout")]);
		const place = placer(store);
		startOn(store, "a1", "r", OfficeRoom.LIBRARY);
		expect(find(place(T0), "scout#1").room).toBe("LIBRARY");
		// The views place people every second: the last frame that saw the work is when it ended.
		const ended = T0 + 5_000;
		expect(find(place(ended), "scout#1").activityRoom).toBe("LIBRARY");
		endOn(store, "a1", "r");
		expect(find(place(ended + 1), "scout#1")).toMatchObject({ room: "LIBRARY", activityRoom: "LIBRARY" });
		expect(find(place(ended + LINGER_MS - 1), "scout#1").room).toBe("LIBRARY");
		expect(find(place(ended + LINGER_MS), "scout#1")).toMatchObject({ room: "WORK", anchorId: "desk-0", activityRoom: null });
	});

	it("takes whoever waits for an approval to Security, and puts the chairman in the lobby", () => {
		const store = fresh([director({ state: OfficeActorState.AWAITING_APPROVAL, activity: act("b", OfficeRoom.SERVER, "Bash") })], { session: session({ waitingForUser: true }) });
		const places = placer(store)(T0);
		expect(find(places, "director")).toMatchObject({ room: "SECURITY", floor: 3 });
		expect(find(places, "chairman")).toMatchObject({ room: "LOBBY", floor: 1, anchorId: "chairman", activityRoom: null });
	});

	it("never puts two people on one spot while the room has free ones", () => {
		const four = ["a", "b", "c", "d"].map((t, i) => staff(`s${i}`, t, { activity: act(`x${i}`, OfficeRoom.LIBRARY) }));
		const store = fresh([director(), ...four]);
		const places = placer(store)(T0).filter((p) => p.room === "LIBRARY");
		expect(places).toHaveLength(4);
		// The library has three places to stand: the fourth shares one, never before.
		const spots = places.map((p) => p.anchorId);
		expect(new Set(spots.slice(0, 3)).size).toBe(3);
		const machines = fresh([director(), machine("m1"), machine("m2"), machine("m3")]);
		const servers = placer(machines)(T0).filter((p) => p.kind === "machine").map((p) => p.anchorId);
		expect(new Set(servers).size).toBe(3);
	});

	it("freezes everyone while the power is out", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("r", OfficeRoom.LIBRARY) })]));
		const place = placer(store);
		expect(find(place(T0), "director").room).toBe("LIBRARY");
		store.applyEvents(1n, [ev(1, { case: "activityStart", value: { actorId: "director", activity: act("q", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.MACHINE) } })]);
		store.linkStatus(false, T0);
		clock.now = T0 + 40_000;
		store.tick(clock.now);
		expect(store.state().power).toBe("out");
		expect(find(place(clock.now), "director").room).toBe("LIBRARY");
	});

	it("gives the same places for the same input", () => {
		const build = () => fresh([director({ activity: act("r", OfficeRoom.POST, "Bash") }), staff("a1", "tester", { activity: act("q", OfficeRoom.QA, "Bash") }), machine("m1")]);
		const a = officePlacement(build().state(), layout(), T0, EMPTY_MEMORY);
		const b = officePlacement(build().state(), layout(), T0, EMPTY_MEMORY);
		expect(a.placements.map((p) => [p.key, p.room, p.anchorId])).toEqual(b.placements.map((p) => [p.key, p.room, p.anchorId]));
		expect([...a.memory.entries()]).toEqual([...b.memory.entries()]);
	});
});
