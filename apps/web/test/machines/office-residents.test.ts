// Nobody goes home: an employee whose subagent left stays as an off-duty
// resident, the next subagent of the type brings that same person back, a
// fresh snapshot of the same run keeps them; and the work log keeps only
// normalized facts (the kind and room of the last work, its length, counts,
// approval waits) for the residents' talks.
import { OfficeAnimGroup, OfficeApprovalState, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { act, director, ev, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

describe("residents", () => {
	it("keeps an employee whose subagent left as an off-duty resident, without a desk", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "scout")]));
		expect(store.state().staff[0]?.desk).toBe("desk-0");
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "s1" } })]);
		const s = store.state();
		expect(s.staff).toEqual([]);
		expect(s.residents.map((r) => [r.key, r.desk])).toEqual([["scout#1", null]]);
	});

	it("brings the same resident back to work for the next subagent of the type, and numbers newcomers past them", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "scout"), staff("s2", "scout")]));
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "s1" } }), ev(2, { case: "actorLeave", value: { actorId: "s2" } })]);
		expect(store.state().residents.map((r) => r.key)).toEqual(["scout#1", "scout#2"]);
		store.applyEvents(1n, [ev(3, { case: "actorEnter", value: staff("s3", "scout") })]);
		expect(store.state().staff.map((m) => [m.key, m.actorId])).toEqual([["scout#1", "s3"]]);
		expect(store.state().residents.map((r) => r.key)).toEqual(["scout#2"]);
		store.applyEvents(1n, [ev(4, { case: "actorEnter", value: staff("s4", "scout") }), ev(5, { case: "actorEnter", value: staff("s5", "scout") })]);
		expect(store.state().staff.map((m) => m.key)).toEqual(["scout#1", "scout#2", "scout#3"]);
		expect(store.state().residents).toEqual([]);
	});

	it("keeps residents across a snapshot of the same run, and turns anyone missing from it into one", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "scout"), staff("s2", "tester")]));
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "s1" } })]);
		store.applySnapshot(snapshot([director()], { seq: 5n }));
		expect(store.state().residents.map((r) => r.key).sort()).toEqual(["scout#1", "tester#1"]);
		// Another run (the agent restarted): a new day in the office.
		store.applySnapshot(snapshot([director()], { epoch: 2n }));
		expect(store.state().residents).toEqual([]);
	});
});

describe("the work log", () => {
	it("records the kind, room and length of each finished activity per person, never its subject", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "tester")]));
		store.applyEvents(1n, [
			ev(1, { case: "activityStart", value: { actorId: "s1", activity: act("a1", OfficeRoom.QA, "Bash", T0 + 1000, OfficeAnimGroup.MACHINE) } }),
			ev(2, { case: "activityEnd", value: { actorId: "s1", activityId: "a1", ok: false } }, T0 + 91_000),
		]);
		const log = store.state().work["tester#1"];
		expect(log).toEqual({ done: 1, last: { group: "machine", room: "QA", ok: false, at: T0 + 91_000, ms: 90_000 }, approval: null });
		expect(JSON.stringify(store.state().work)).not.toContain("Bash");
	});

	it("records how long an approval waited", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.WORK, "Edit") })]));
		store.applyEvents(1n, [
			ev(1, { case: "approval", value: { actorId: "director", state: OfficeApprovalState.WAITING } }, T0 + 1_000),
			ev(2, { case: "approval", value: { actorId: "director", state: OfficeApprovalState.ALLOWED } }, T0 + 181_000),
		]);
		expect(store.state().work.director?.approval).toEqual({ waitMs: 180_000, at: T0 + 181_000 });
	});
});
