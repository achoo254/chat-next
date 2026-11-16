// Following the work between floors: the dots, moving to the floor where work
// began, holding six seconds on a floor, pausing thirty after the user picks
// one, and not moving with following off.
import { describe, expect, it } from "vitest";
import { busyFloors, FIRST_FLOOR, FLOOR_HOLD_MS, followTarget, latestWork, nextFloor, pickFloor, USER_PAUSE_MS } from "../../src/machines/office/office-floor-tabs.tsx";
import type { Placement } from "../../src/machines/office/office-placement.ts";
import type { FloorLevel, RoomCode } from "../../src/machines/office/office-rooms.ts";

const T = 1_000_000;

function placed(key: string, floor: FloorLevel, room: RoomCode, since: number, working = true): Placement {
	return { key, kind: key === "chairman" ? "chairman" : "employee", actor: null, member: null, floor, room, anchorId: "", since, activityRoom: working ? room : null, life: null };
}

describe("following the work between floors", () => {
	it("marks the floors where someone works, never for the chairman or the idle", () => {
		const list = [placed("a", 2, "LIBRARY", T), placed("b", 1, "WORK", T, false), placed("chairman", 1, "LOBBY", T)];
		expect([...busyFloors(list)]).toEqual([2]);
		expect(latestWork(list)).toEqual({ floor: 2, since: T });
		expect(latestWork([placed("b", 1, "WORK", T, false)])).toBeNull();
	});

	it("with nobody working, follows the crowd (the living floor at night) as of the latest arrival there", () => {
		const night = [placed("a", 4, "DORM", T, false), placed("b", 4, "DORM", T + 5, false), placed("c", 1, "WORK", T + 9, false), placed("chairman", 1, "LOBBY", T + 20)];
		expect(followTarget(night.filter((p) => p.key !== "chairman"))).toEqual({ floor: 4, since: T + 5 });
		// Work anywhere wins over the crowd.
		expect(followTarget([...night.slice(0, 3), placed("d", 2, "LIBRARY", T + 1)])).toEqual({ floor: 2, since: T + 1 });
		expect(followTarget([])).toBeNull();
	});

	it("moves to the floor where work just began", () => {
		const next = nextFloor(FIRST_FLOOR, { follow: true, now: T, latest: { floor: 3, since: T } });
		expect(next).toEqual({ floor: 3, switchedAt: T, pickedAt: null });
	});

	it("stays six seconds on a floor before following again, and never back to older work", () => {
		const on3 = { floor: 3, switchedAt: T, pickedAt: null } as const;
		expect(nextFloor(on3, { follow: true, now: T + FLOOR_HOLD_MS - 1, latest: { floor: 2, since: T + 1000 } }).floor).toBe(3);
		expect(nextFloor(on3, { follow: true, now: T + FLOOR_HOLD_MS, latest: { floor: 2, since: T + 1000 } }).floor).toBe(2);
		expect(nextFloor(on3, { follow: true, now: T + 60_000, latest: { floor: 2, since: T - 1 } }).floor).toBe(3);
	});

	it("pauses for thirty seconds after the user picks a floor", () => {
		const picked = pickFloor(1, T);
		expect(nextFloor(picked, { follow: true, now: T + USER_PAUSE_MS - 1, latest: { floor: 2, since: T + 7_000 } }).floor).toBe(1);
		expect(nextFloor(picked, { follow: true, now: T + USER_PAUSE_MS, latest: { floor: 2, since: T + 7_000 } }).floor).toBe(2);
	});

	it("does not move with following off", () => {
		expect(nextFloor(FIRST_FLOOR, { follow: false, now: T, latest: { floor: 3, since: T } })).toBe(FIRST_FLOOR);
	});
});
