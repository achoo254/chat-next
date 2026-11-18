// The overview panel's content: who is at work and on what, who rests and how,
// from the same placements the scene draws; only people of the building count.
import { describe, expect, it } from "vitest";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { officeOverview } from "../../src/machines/office/office-overview.ts";
import type { Placement } from "../../src/machines/office/office-placement.ts";

const t = viMachines.office;

function placement(key: string, over: Partial<Placement> = {}): Placement {
	return { key, kind: "employee", actor: null, member: null, room: "WORK", anchorId: key, since: 0, activityRoom: null, life: null, advisor: null, concurrent: 0, workKey: key, ...over };
}

describe("officeOverview", () => {
	it("counts the people of the building and sorts them into at work, resting and waiting at their seats", () => {
		const places: Placement[] = [
			placement("director", { kind: "director", activityRoom: "DIRECTOR" }),
			placement("advisor", { kind: "advisor", room: "DORM", life: { slot: "sleep", act: "sleep" }, advisor: { name: "", lookId: "" } }),
			placement("title:techLead", { room: "DORM", life: { slot: "sleep", act: "sleep" } }),
			placement("title:qaTester", { room: "GYM", life: { slot: "dawn", act: "jacks" } }),
			placement("title:planner"),
			placement("chairman", { kind: "chairman", room: "LOBBY" }),
		];
		const overview = officeOverview(places, t);
		expect(overview.people).toBe(5);
		expect(overview.working.map((w) => w.key)).toEqual(["director"]);
		expect(overview.working[0]?.room).toBe("DIRECTOR");
		expect(overview.restingCount).toBe(3);
		expect(overview.resting).toEqual([
			{ act: "sleep", count: 2 },
			{ act: "jacks", count: 1 },
		]);
		expect(overview.atSeat).toBe(1);
	});

	it("is empty for an empty office", () => {
		expect(officeOverview([], t)).toEqual({ people: 0, working: [], resting: [], restingCount: 0, atSeat: 0 });
	});

	it("keeps a room code out of the way: a worker carries the room it works in", () => {
		const overview = officeOverview([placement("title:qaTester", { activityRoom: "QA", room: "QA" })], t);
		expect(overview.working[0]).toMatchObject({ key: "title:qaTester", room: "QA" });
	});
});
