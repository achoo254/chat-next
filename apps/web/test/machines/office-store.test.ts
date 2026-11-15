// The office store: snapshot and sequenced events, gaps and epochs, the power
// cut, the hourglass, closing activities when the session goes idle, one
// employee per agent type, desks and the meeting room, approvals, the
// session's numbers, and replay giving the same office.
import { create } from "@bufbuild/protobuf";
import { OfficeActorState, OfficeApprovalState, OfficeChecksSchema, OfficeRoom, OfficeTodoCountsSchema, OfficeUsageSchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it, vi } from "vitest";
import { CLOSING_MS, POWER_OUT_MS, SLOW_TOOL_MS } from "../../src/machines/office/office-store.ts";
import { act, director, ev, machine, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

describe("the office store", () => {
	it("is loading until the first snapshot, which replaces everything", () => {
		const { store } = storeAt();
		expect(store.state().status).toBe("loading");
		expect(store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} })])).toBe("need-snapshot");
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.LIBRARY) }), staff("a1", "scout")], { seq: 4n }));
		const s = store.state();
		expect(s.status).toBe("live");
		expect(s.actors.map((a) => a.id)).toEqual(["director", "a1"]);
		expect(s.actors[0]?.activity).toMatchObject({ id: "t1", room: "LIBRARY", group: "read" });
		expect(s.staff).toHaveLength(1);
		store.applySnapshot(snapshot([director()], { seq: 9n }));
		expect(store.state().actors).toHaveLength(1);
		expect(store.state().staff).toHaveLength(0);
	});

	it("applies events in order, drops repeats and old ones, and stops at a gap", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director()], { seq: 10n }));
		expect(store.applyEvents(1n, [ev(11, { case: "activityStart", value: { actorId: "director", activity: act("t1", OfficeRoom.POST, "Bash") } })])).toBe("ok");
		expect(store.state().actors[0]?.activity?.room).toBe("POST");
		// A repeat and an old event change nothing.
		expect(store.applyEvents(1n, [ev(10, { case: "actorLeave", value: { actorId: "director" } }), ev(11, { case: "actorLeave", value: { actorId: "director" } })])).toBe("ok");
		expect(store.state().actors).toHaveLength(1);
		// 13 after 11: a gap; 12 and what follows the gap are not applied.
		const before = store.state();
		expect(store.applyEvents(1n, [ev(13, { case: "actorEnter", value: staff("a1", "tester") })])).toBe("need-snapshot");
		expect(store.state().actors).toHaveLength(1);
		expect(store.state().awaitingSnapshot).toBe(true);
		expect(before.awaitingSnapshot).toBe(false);
		// Until the snapshot comes, nothing applies (even the event that would have been next).
		expect(store.applyEvents(1n, [ev(12, { case: "turnStart", value: {} })])).toBe("need-snapshot");
		store.applySnapshot(snapshot([director(), staff("a1", "tester")], { seq: 13n }));
		expect(store.state().awaitingSnapshot).toBe(false);
		expect(store.applyEvents(1n, [ev(14, { case: "turnStart", value: {} })])).toBe("ok");
		expect(store.state().lastTurnStart).toBe(T0 + 14_000);
	});

	it("drops a frame of another epoch and asks for a snapshot", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director()], { epoch: 5n, seq: 2n }));
		expect(store.applyEvents(6n, [ev(3, { case: "actorEnter", value: staff("a1", "scout") })])).toBe("need-snapshot");
		expect(store.state().actors).toHaveLength(1);
		store.applySnapshot(snapshot([director()], { epoch: 6n, seq: 0n }));
		expect(store.applyEvents(6n, [ev(1, { case: "actorEnter", value: staff("a1", "scout") })])).toBe("ok");
		expect(store.state().actors).toHaveLength(2);
	});

	it("cuts the power 30 s after the machine was last heard from, and turns it on with the snapshot after reconnecting", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director()]));
		store.linkStatus(false, T0);
		clock.now = T0 + POWER_OUT_MS - 1;
		store.tick(clock.now);
		expect(store.state().power).toBe("on");
		clock.now = T0 + POWER_OUT_MS;
		store.tick(clock.now);
		expect(store.state().power).toBe("out");
		store.linkStatus(true, clock.now);
		expect(store.state().power).toBe("out");
		expect(store.state().awaitingSnapshot).toBe(true);
		store.applySnapshot(snapshot([director()], { seq: 3n }));
		expect(store.state().power).toBe("on");
	});

	it("shows an hourglass on a tool running over two minutes", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.QA, "Bash", T0) })]));
		expect(store.state().actors[0]?.activity?.slow).toBe(false);
		const listener = vi.fn();
		store.subscribe(listener);
		clock.now = T0 + SLOW_TOOL_MS;
		store.tick(clock.now);
		expect(store.state().actors[0]?.activity?.slow).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		// Nothing time decides changed: no emit.
		store.tick(clock.now + 1000);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("ends every open activity when the session goes idle, and closes the building ten idle minutes later", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.LIBRARY) }), staff("a1", "scout", { activity: act("x", OfficeRoom.LIBRARY) })]));
		store.applyEvents(1n, [ev(1, { case: "session", value: session({ busy: false }) }, T0)]);
		expect(store.state().actors.every((a) => a.activity === null)).toBe(true);
		expect(store.state().idleSince).toBe(T0);
		clock.now = T0 + CLOSING_MS;
		store.tick(clock.now);
		expect(store.state().off).toBe(true);
		store.applyEvents(1n, [ev(2, { case: "session", value: session({ busy: true }) }, T0 + CLOSING_MS)]);
		expect(store.state().off).toBe(false);
	});

	it("seats nine employees on eight desks with one in the meeting room, and three on a phone's six", () => {
		const types = ["scout", "tester", "planner", "researcher", "code-reviewer", "debugger", "docs", "a", "b"];
		const actors = [director(), ...types.map((t, i) => staff(`s${i}`, t))];
		const { store } = storeAt(T0, 8);
		store.applySnapshot(snapshot(actors));
		expect(store.state().overflow).toBe(1);
		expect(store.state().staff.filter((m) => m.desk !== null).map((m) => m.desk)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		store.setDeskCount(6);
		expect(store.state().overflow).toBe(3);
		// A desk frees up: the one who waited longest takes it.
		store.setDeskCount(8);
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "s2" } })]);
		expect(store.state().overflow).toBe(0);
		expect(store.state().staff.find((m) => m.actorId === "s8")?.desk).toBe(2);
	});

	it("keeps one employee per agent type: a new subagent of a type whose employee finished is that employee", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("a1", "scout")]));
		// Another scout while the first one works: "Tí Trinh Sát 2".
		store.applyEvents(1n, [ev(1, { case: "actorEnter", value: staff("a2", "scout", { enteredAt: BigInt(T0 + 1000) }) })]);
		expect(store.state().staff.map((m) => [m.agentType, m.ordinal, m.actorId])).toEqual([
			["scout", 1, "a1"],
			["scout", 2, "a2"],
		]);
		store.applyEvents(1n, [ev(2, { case: "actorUpdate", value: staff("a1", "scout", { state: OfficeActorState.DONE, doneAt: BigInt(T0 + 2000) }) })]);
		store.applyEvents(1n, [ev(3, { case: "actorEnter", value: staff("a3", "scout", { enteredAt: BigInt(T0 + 3000) }) })]);
		const first = store.state().staff.find((m) => m.ordinal === 1);
		expect(first?.actorId).toBe("a3");
		expect(store.state().staff).toHaveLength(2);
		// The old actor leaving does not send anyone home.
		store.applyEvents(1n, [ev(4, { case: "actorLeave", value: { actorId: "a1" } })]);
		expect(store.state().staff).toHaveLength(2);
		expect(store.state().visitors.map((v) => v.key)).toEqual(["scout#1", "scout#2"]);
	});

	it("has no staff for an AI that does not report them (Antigravity): only the director, never made up", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.QA, "run_command") })], { reportsStaff: false }));
		expect(store.state().reportsStaff).toBe(false);
		expect(store.state().staff).toEqual([]);
		expect(store.state().actors.map((a) => a.role)).toEqual(["director"]);
	});

	it("puts an approval on the right person: waiting, then denied back to what they did", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("a1", "tester", { state: OfficeActorState.WORKING })]));
		store.applyEvents(1n, [ev(1, { case: "approval", value: { actorId: "a1", state: OfficeApprovalState.WAITING } })]);
		expect(store.state().actors.find((a) => a.id === "a1")).toMatchObject({ state: "awaiting", approval: { state: "waiting" } });
		expect(store.state().actors.find((a) => a.id === "director")?.state).toBe("working");
		store.applyEvents(1n, [ev(2, { case: "approval", value: { actorId: "a1", state: OfficeApprovalState.DENIED } })]);
		expect(store.state().actors.find((a) => a.id === "a1")).toMatchObject({ state: "working", approval: { state: "denied", at: T0 + 2000 } });
	});

	it("keeps the session's numbers, the chairman while the AI waits, and the result of an activity", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: act("t1", OfficeRoom.QA, "Bash") })]));
		store.applyEvents(1n, [
			ev(1, {
				case: "session",
				value: session({
					waitingForUser: true,
					todo: create(OfficeTodoCountsSchema, { pending: 3, inProgress: 1, done: 2 }),
					usage: create(OfficeUsageSchema, { inputTokens: 1200n, outputTokens: 300n, costUsdEstimate: 0.4, hasCost: true, available: true }),
					checks: create(OfficeChecksSchema, { passed: 2, failed: 1, lastOk: false }),
				}),
			}),
			ev(2, { case: "activityEnd", value: { actorId: "director", activityId: "other", ok: true } }),
		]);
		const s = store.state();
		expect(s.chairman).toBe(true);
		expect(s.session.todo).toEqual({ pending: 3, inProgress: 1, done: 2 });
		expect(s.session.usage).toEqual({ inputTokens: 1200, outputTokens: 300, costUsd: 0.4, hasCost: true, available: true });
		expect(s.session.checks).toEqual({ passed: 2, failed: 1, lastOk: false });
		// Another activity's end leaves the one shown.
		expect(s.actors[0]?.activity?.id).toBe("t1");
		store.applyEvents(1n, [ev(3, { case: "activityEnd", value: { actorId: "director", activityId: "t1", ok: false } })]);
		expect(store.state().actors[0]).toMatchObject({ activity: null, lastResult: { ok: false, at: T0 + 3000 } });
	});

	it("gives the same office for the same snapshot and events, whatever the viewer's clock", () => {
		const run = (start: number) => {
			const { store } = storeAt(start);
			store.applySnapshot(snapshot([director(), staff("a1", "scout"), machine("m1")], { seq: 1n }));
			store.applyEvents(1n, [
				ev(2, { case: "actorEnter", value: staff("a2", "tester") }),
				ev(3, { case: "activityStart", value: { actorId: "a2", activity: act("b", OfficeRoom.QA, "Bash") } }),
				ev(4, { case: "approval", value: { actorId: "a1", state: OfficeApprovalState.WAITING } }),
				ev(5, { case: "actorLeave", value: { actorId: "m1" } }),
			]);
			const { clockOffset: _offset, ...rest } = store.state();
			return rest;
		};
		expect(run(T0)).toEqual(run(T0 + 5_000));
	});
});
