// What the inspector panel says about a person (office-inspector.ts) and what the
// timeline behind it keeps (office-timeline.ts, fed by the store): the record
// follows the person the scene shows (the director's tools handed to a
// department belong to its person, several subagents of one title are one
// person), says how an activity ended only when the agent said so, never keeps a
// subject, and shows the same chat the bubble does.
import { create } from "@bufbuild/protobuf";
import {
	OfficeActivitySchema,
	OfficeActorState,
	OfficeAnimGroup,
	OfficeApprovalState,
	OfficeRoom,
	OfficeServiceKind,
	type OfficeActivity,
} from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { inspectorOf } from "../../src/machines/office/office-inspector.ts";
import { activitySubject, markerView, workSubject } from "../../src/machines/office/office-names.ts";
import { EMPTY_MEMORY, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import { SLOW_TOOL_MS, STUCK_MS, type OfficeStore } from "../../src/machines/office/office-store.ts";
import { TIMELINE_LIMIT } from "../../src/machines/office/office-timeline.ts";
import { act, director, ev, localAt, machine, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

const t = viMachines.office;

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

/** An activity that carries a subject, as the agent sends for the director's tools. */
function actWith(id: string, room: OfficeRoom, tool: string, subject: string, group = OfficeAnimGroup.READ, startedAt = T0): OfficeActivity {
	return create(OfficeActivitySchema, { id, tool, group, room, subject, startedAt: BigInt(startedAt) });
}

let seq = 0;
function fresh(actors: Parameters<typeof snapshot>[0], options: Parameters<typeof snapshot>[1] = {}): { store: OfficeStore; clock: { now: number } } {
	seq = 0;
	const made = storeAt();
	made.store.applySnapshot(snapshot(actors, options));
	return made;
}
function end(store: OfficeStore, actorId: string, id: string, ok = true): void {
	seq += 1;
	store.applyEvents(1n, [ev(seq, { case: "activityEnd", value: { actorId, activityId: id, ok } })]);
}
function start(store: OfficeStore, actorId: string, activity: OfficeActivity): void {
	seq += 1;
	store.applyEvents(1n, [ev(seq, { case: "activityStart", value: { actorId, activity } })]);
}

function placements(store: OfficeStore, now = T0): readonly Placement[] {
	return officePlacement(store.state(), layout(), now, EMPTY_MEMORY).placements;
}
function inspect(store: OfficeStore, key: string, now = T0) {
	return inspectorOf(placements(store, now), key, store.state(), now);
}

describe("the subject rule shared by the bubble and the panel", () => {
	it("says what the bubble says after the tool name, and nothing where the bubble says something else", () => {
		const base = { id: "x", tool: "Read", group: "read", room: "LIBRARY", subject: "plan.md", startedAt: 1, slow: false, stuckMs: null } as const;
		expect(activitySubject(base)).toBe("plan.md");
		expect(activitySubject({ ...base, stuckMs: 400_000 })).toBe("");
		expect(activitySubject({ ...base, tool: "", group: "think" })).toBe("");
		expect(activitySubject({ ...base, group: "consult" })).toBe("");
		expect(activitySubject(null)).toBe("");
	});

	it("shows an employee's subject in the bubble and in the panel alike: the privacy rule lives in the agent, not in the web", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: actWith("q", OfficeRoom.QA, "Bash", "secret.sh", OfficeAnimGroup.TYPE) })]);
		const list = placements(store);
		const tester = list.find((p) => p.key === "title:qaTester");
		if (tester === undefined) throw new Error("tester not placed");
		expect(workSubject(tester)).toBe("secret.sh");
		expect(markerView(t, tester, null).bubble).toContain("secret.sh");
		expect(inspectorOf(list, "title:qaTester", store.state(), T0)?.work?.subject).toBe("secret.sh");
	});
});

describe("the timeline of a person", () => {
	it("records an ended activity on the job title of the subagent, with how it ended and how long it ran", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		end(store, "a1", "q1", false);
		const entry = store.state().timeline["title:qaTester"]?.entries[0];
		expect(entry).toMatchObject({ group: "type", room: "QA", result: "failed" });
		expect(store.state().timeline["title:qaTester"]?.done).toBe(1);
	});

	it("keeps no subject, command or path: an entry holds only the group, the room, the result and the times", () => {
		const { store } = fresh([director({ activity: actWith("r1", OfficeRoom.LIBRARY, "Read", "secret.md") })]);
		end(store, "director", "r1");
		const entries = Object.values(store.state().timeline).flatMap((p) => p.entries);
		expect(entries.length).toBe(1);
		for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["at", "group", "ms", "result", "room"]);
		expect(JSON.stringify(store.state().timeline)).not.toContain("secret.md");
	});

	it("keeps the last eight and counts all", () => {
		const { store } = fresh([director(), staff("a1", "tester")]);
		for (let i = 0; i < TIMELINE_LIMIT + 4; i += 1) {
			start(store, "a1", act(`t${i}`, OfficeRoom.QA, "Bash", T0 + i, OfficeAnimGroup.TYPE));
			end(store, "a1", `t${i}`);
		}
		const person = store.state().timeline["title:qaTester"];
		expect(person?.entries.length).toBe(TIMELINE_LIMIT);
		expect(person?.done).toBe(TIMELINE_LIMIT + 4);
		// Newest first.
		expect(person?.entries[0]?.at).toBeGreaterThan(person?.entries[1]?.at ?? Infinity);
	});

	it("is one timeline for every subagent of a job title", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) }), staff("a2", "tester", { activity: act("q2", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		end(store, "a1", "q1");
		end(store, "a2", "q2");
		expect(store.state().timeline["title:qaTester"]?.done).toBe(2);
		expect(Object.keys(store.state().timeline)).toEqual(["title:qaTester"]);
	});

	it("credits a tool of the director to the department's person, as the bubble shows it, and to nobody when no department claims its room", () => {
		const { store } = fresh([director({ activity: actWith("r1", OfficeRoom.LIBRARY, "Read", "a.ts") })]);
		end(store, "director", "r1");
		expect(store.state().timeline["title:researchAnalyst"]?.done).toBe(1);
		expect(store.state().timeline["director"]).toBeUndefined();
		start(store, "director", act("l1", OfficeRoom.LOBBY, "Bash", T0, OfficeAnimGroup.TYPE));
		end(store, "director", "l1");
		expect(Object.keys(store.state().timeline)).toEqual(["title:researchAnalyst"]);
	});

	it("keeps the director's own consulting for the director and the visit for Advisor, and skips thinking and handing in", () => {
		const { store } = fresh([director(), staff("a1", "tester")]);
		start(store, "director", act("c1", OfficeRoom.MEETING, "mcp", T0, OfficeAnimGroup.CONSULT));
		end(store, "director", "c1");
		start(store, "director", act("th", OfficeRoom.DIRECTOR, "", T0, OfficeAnimGroup.THINK));
		end(store, "director", "th");
		expect(store.state().timeline["director"]?.done).toBe(1);
		expect(store.state().timeline["director"]?.entries.map((e) => e.group)).toEqual(["consult"]);
	});

	it("records an Advisor consultation under Advisor and a machine's activity under that machine", () => {
		const { store } = fresh([director(), machine("m1")]);
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "actorEnter", value: { id: "advisor", role: 4, state: OfficeActorState.IDLE, enteredAt: BigInt(T0) } })]);
		start(store, "advisor", act("c9", OfficeRoom.MEETING, "", T0, OfficeAnimGroup.CONSULT));
		end(store, "advisor", "c9");
		end(store, "m1", "m1");
		expect(store.state().timeline["advisor"]?.done).toBe(1);
		expect(store.state().timeline["machine:m1"]?.done).toBe(1);
	});

	it("counts an activity that a hand-in replaced as finished with an unknown result, and the hand-in itself not at all", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		seq += 1;
		store.applyEvents(1n, [
			ev(seq, {
				case: "actorUpdate",
				value: { id: "a1", role: 2, agentType: "tester", spawnDepth: 1, state: OfficeActorState.DONE, enteredAt: BigInt(T0), doneAt: BigInt(T0 + 5000), activity: act("h1", OfficeRoom.DIRECTOR, "", T0 + 5000, OfficeAnimGroup.HAND_IN) },
			}),
		]);
		const entries = store.state().timeline["title:qaTester"]?.entries ?? [];
		expect(entries.map((e) => e.result)).toEqual(["unknown"]);
		expect(store.state().timeline["title:qaTester"]?.done).toBe(1);
	});

	it("counts the director's open tool when the turn ends without an end event", () => {
		const { store } = fresh([director({ activity: act("r1", OfficeRoom.LIBRARY, "Read") })]);
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "session", value: { busy: false, startedAt: BigInt(T0) } })]);
		expect(store.state().timeline["title:researchAnalyst"]?.entries.map((e) => e.result)).toEqual(["unknown"]);
	});

	it("keeps the timeline through a snapshot of the same run and clears it for another", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		end(store, "a1", "q1");
		store.applySnapshot(snapshot([director(), staff("a1", "tester")], { epoch: 1n, seq: BigInt(seq) }));
		expect(store.state().timeline["title:qaTester"]?.done).toBe(1);
		store.applySnapshot(snapshot([director(), staff("a1", "tester")], { epoch: 2n }));
		expect(store.state().timeline).toEqual({});
	});

	it("keeps how long the person's last approval waited, on the person", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "approval", value: { actorId: "a1", state: OfficeApprovalState.WAITING } }, T0 + 1000)]);
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "approval", value: { actorId: "a1", state: OfficeApprovalState.ALLOWED } }, T0 + 4000)]);
		expect(inspect(store, "title:qaTester")?.approvalWaitMs).toBe(3000);
	});
});

describe("the record of a person", () => {
	it("says who the director is at rest: at his chair, nothing running", () => {
		const { store } = fresh([director({ state: OfficeActorState.IDLE })], { session: session({ busy: false }) });
		expect(inspect(store, "director")).toMatchObject({ kind: "director", homeRoom: "DIRECTOR", mode: "idle", work: null, service: null, done: 0, timeline: [], title: null });
	});

	it("shows an employee at work with the tool, the room, how long it has run, and the subagent's description", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0 - 30_000, OfficeAnimGroup.TYPE) })]);
		const model = inspect(store, "title:qaTester");
		expect(model).toMatchObject({ kind: "employee", title: "qaTester", mode: "work", work: { tool: "Bash", group: "type", room: "QA", slow: false, stuckMs: null } });
		expect(model?.work?.runningMs).toBeGreaterThanOrEqual(29_000);
		expect(model?.work?.runningMs).toBeLessThan(40_000);
		expect(model?.homeRoom).toBe("WORK");
	});

	it("shows the director's tool on the department's person and not on the director, with the subject the bubble shows", () => {
		const { store } = fresh([director({ activity: actWith("r1", OfficeRoom.LIBRARY, "Read", "plan.md") })]);
		const list = placements(store);
		const analyst = inspectorOf(list, "title:researchAnalyst", store.state(), T0);
		expect(analyst?.work).toMatchObject({ tool: "Read", subject: "plan.md", room: "LIBRARY" });
		expect(inspectorOf(list, "director", store.state(), T0)?.work).toBeNull();
	});

	it("shows a dozing person's silence and no subject", () => {
		const { store, clock } = fresh([director(), staff("a1", "tester", { activity: actWith("q1", OfficeRoom.QA, "Bash", "make", OfficeAnimGroup.TYPE, T0) })]);
		// One event ties the clocks (viewer time = machine time), then five silent minutes pass over a slow tool.
		store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
		const later = T0 + SLOW_TOOL_MS + STUCK_MS;
		clock.now = later;
		store.tick(later);
		const model = inspect(store, "title:qaTester", later);
		expect(model?.work?.stuckMs).toBe(later - T0);
		expect(model?.work?.slow).toBe(true);
		expect(model?.work?.subject).toBe("");
		expect(model?.status).toBe("stuck");
	});

	it("shows a labelled machine by what it runs and no tool of its own", () => {
		const { store } = fresh([director(), machine("m1", OfficeRoom.SERVER, { kind: OfficeServiceKind.DEV_SERVER, port: 5173, startedAt: BigInt(T0 - 120_000) })]);
		const model = inspect(store, "machine:m1");
		expect(model).toMatchObject({ kind: "machine", homeRoom: null, work: null, service: { kind: "dev-server", port: 5173 } });
		expect(model?.service?.uptimeMs).toBeGreaterThanOrEqual(119_000);
	});

	it("names an off-duty person's simulated life, not work", () => {
		const night = localAt(23, 30);
		const { store } = fresh([director({ state: OfficeActorState.IDLE }), staff("a1", "tester", { state: OfficeActorState.DONE })], { session: session({ busy: false }) });
		const model = inspect(store, "title:qaTester", night);
		expect(model?.mode).toBe("life");
		expect(model?.life).not.toBeNull();
		expect(model?.work).toBeNull();
	});

	it("says how the last finished activity ended and how long ago, from the activities that said so", () => {
		const { store } = fresh([director(), staff("a1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.TYPE) })]);
		end(store, "a1", "q1", false);
		const model = inspect(store, "title:qaTester", T0 + 10_000);
		expect(model?.lastResult?.ok).toBe(false);
		expect(model?.timeline.length).toBe(1);
	});

	it("is null for someone who is not there (a machine that left), for a key nobody has, and for the chairman", () => {
		const { store } = fresh([director(), machine("m1")], { session: session({ waitingForUser: true }) });
		expect(inspect(store, "chairman")).toBeNull();
		expect(inspect(store, "title:nobody")).toBeNull();
		expect(inspect(store, "machine:m1")).not.toBeNull();
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "actorLeave", value: { actorId: "m1" } })]);
		expect(inspect(store, "machine:m1")).toBeNull();
	});

	it("marks what shows as out of date while a new snapshot is awaited", () => {
		const { store } = fresh([director()]);
		expect(inspect(store, "director")?.stale).toBe(false);
		store.applyEvents(1n, [ev(50, { case: "turnStart", value: {} })]);
		expect(store.state().awaitingSnapshot).toBe(true);
		expect(inspect(store, "director")?.stale).toBe(true);
	});

	it("shows Advisor's latest answer as its description", () => {
		const { store } = fresh([director()]);
		seq += 1;
		store.applyEvents(1n, [ev(seq, { case: "actorEnter", value: { id: "advisor", role: 4, state: OfficeActorState.IDLE, enteredAt: BigInt(T0), description: "Rebase · 80%" } })]);
		expect(inspect(store, "advisor")).toMatchObject({ kind: "advisor", description: "Rebase · 80%" });
	});
});
