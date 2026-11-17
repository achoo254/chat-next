// Advisor in the office (docs/office-wire.md): an actor of a role this app
// does not know is left out (never hired as an employee), Advisor is kept but
// never takes a desk, a snapshot plus events give one office, Advisor sits at
// the head of the meeting table day and night and never talks with the
// residents, whoever asks it goes to its seat, and the names and bubbles say
// who it is and what it answered.
import { create } from "@bufbuild/protobuf";
import { OfficeActorSchema, OfficeActorState, OfficeAnimGroup, OfficeRole, OfficeRoom, type OfficeActor } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { lookOf } from "../../src/advisor/looks.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { officeTalks } from "../../src/machines/office/office-conversations.ts";
import { zoneOfRoom } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { markerView, personColor, personName, workGroup } from "../../src/machines/office/office-names.ts";
import { ADVISOR_ROOM, EMPTY_MEMORY, officePlacement, type OfficeAdvisor, type Placement } from "../../src/machines/office/office-placement.ts";
import { roleOf } from "../../src/machines/office/office-state.ts";
import { act, director, ev, localAt, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

const t = viMachines.office;
const PROFILE: OfficeAdvisor = { name: "Thầy Cú", lookId: "owl" };

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

function advisor(extra: Partial<Pick<OfficeActor, "activity" | "description">> = {}): OfficeActor {
	return create(OfficeActorSchema, { id: "advisor", role: OfficeRole.ADVISOR, state: OfficeActorState.IDLE, enteredAt: BigInt(T0), ...extra });
}

/** An actor of a role a newer agent might add. */
function stranger(id: string, role: number): OfficeActor {
	return create(OfficeActorSchema, { id, role: role as OfficeRole, agentType: "scout", spawnDepth: 1, state: OfficeActorState.WORKING, enteredAt: BigInt(T0) });
}

const consult = (id: string) => act(id, OfficeRoom.MEETING, "mcp", T0, OfficeAnimGroup.CONSULT);

function placed(list: readonly Placement[], key: string): Placement {
	const p = list.find((x) => x.key === key);
	if (p === undefined) throw new Error(`${key} not placed`);
	return p;
}

const seatOfAdvisor = (): string => {
	const seat = layout().anchors.find((a) => a.room === ADVISOR_ROOM && a.kind === "meeting");
	if (seat === undefined) throw new Error("no meeting seat");
	return seat.id;
};

describe("roles the app does not know", () => {
	it("reads the four roles it knows and nothing else", () => {
		expect([OfficeRole.DIRECTOR, OfficeRole.EMPLOYEE, OfficeRole.MACHINE, OfficeRole.ADVISOR].map(roleOf)).toEqual(["director", "employee", "machine", "advisor"]);
		expect(roleOf(OfficeRole.UNSPECIFIED)).toBeNull();
		expect(roleOf(99 as OfficeRole)).toBeNull();
	});

	it("leaves out an actor of an unknown role, in the snapshot and in events, and never hires it", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), stranger("x1", 99), stranger("x0", OfficeRole.UNSPECIFIED)]));
		expect(store.state().actors.map((a) => a.id)).toEqual(["director"]);
		expect(store.state().staff).toEqual([]);
		expect(store.applyEvents(1n, [ev(1, { case: "actorEnter", value: stranger("x2", 42) }), ev(2, { case: "activityStart", value: { actorId: "x2", activity: act("t", OfficeRoom.WORK) } })])).toBe("ok");
		expect(store.state().actors.map((a) => a.id)).toEqual(["director"]);
		expect(store.state().staff).toEqual([]);
	});

	it("an event without a kind (one about Advisor, sent to an app that did not say it draws it) only moves seq on", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director()]));
		expect(store.applyEvents(1n, [ev(1, { case: undefined }), ev(2, { case: "turnStart", value: {} })])).toBe("ok");
		expect(store.state().lastTurnStart).toBe(T0 + 2000);
	});
});

describe("Advisor in the store", () => {
	it("keeps Advisor without giving it a desk, and a snapshot plus events give the same office as a later snapshot", () => {
		const live = storeAt().store;
		live.applySnapshot(snapshot([director()]));
		live.applyEvents(1n, [
			ev(1, { case: "actorEnter", value: advisor() }),
			ev(2, { case: "activityStart", value: { actorId: "director", activity: consult("w1") } }),
			ev(3, { case: "activityStart", value: { actorId: "advisor", activity: consult("w1") } }),
			ev(4, { case: "activityEnd", value: { actorId: "advisor", activityId: "w1", ok: true } }),
			ev(5, { case: "actorUpdate", value: advisor({ description: "Rebase · 80%" }) }),
		]);
		const later = storeAt().store;
		later.applySnapshot(snapshot([director({ activity: consult("w1") }), advisor({ description: "Rebase · 80%" })], { seq: 5n }));
		const a = live.state();
		const b = later.state();
		expect(a.staff).toEqual([]);
		expect(a.actors.map((x) => [x.id, x.role, x.description, x.activity?.group ?? null])).toEqual(b.actors.map((x) => [x.id, x.role, x.description, x.activity?.group ?? null]));
		expect(a.actors.find((x) => x.role === "advisor")?.description).toBe("Rebase · 80%");
		live.applyEvents(1n, [ev(6, { case: "actorLeave", value: { actorId: "advisor" } })]);
		expect(live.state().actors.map((x) => x.id)).toEqual(["director"]);
		expect(live.state().residents).toEqual([]);
	});
});

describe("Advisor's place", () => {
	it("sits at its own seat in its own room, by day and by night, never in the living rooms", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), advisor()], { session: session({ busy: false }) }));
		for (const now of [T0, localAt(2), localAt(19, 30), localAt(6, 30)]) {
			const p = placed(officePlacement(store.state(), layout(), now, EMPTY_MEMORY, PROFILE).placements, "advisor");
			expect([p.room, p.anchorId, zoneOfRoom(layout(), p.room), p.life, p.activityRoom]).toEqual([ADVISOR_ROOM, seatOfAdvisor(), "c", null, null]);
			expect(p.advisor).toEqual(PROFILE);
		}
	});

	it("takes no employee's desk: eight employees still get the eight desks", () => {
		const { store } = storeAt();
		const types = ["scout", "tester", "planner", "debugger", "researcher", "code-reviewer", "general-purpose", "Explore"];
		store.applySnapshot(snapshot([director(), advisor(), ...types.map((type, i) => staff(`e${i}`, type))]));
		expect(store.state().staff.filter((m) => m.desk !== null)).toHaveLength(8);
	});

	it("whoever asks goes to Advisor's seat while the call runs, then back", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: consult("w1") }), advisor({ activity: consult("w1") })]));
		const asked = officePlacement(store.state(), layout(), T0, EMPTY_MEMORY, PROFILE);
		const d = placed(asked.placements, "director");
		expect([d.room, d.anchorId, d.activityRoom]).toEqual([ADVISOR_ROOM, seatOfAdvisor(), ADVISOR_ROOM]);
		expect(workGroup(d)).toBe("consult");
		expect(placed(asked.placements, "advisor").activityRoom).toBe(ADVISOR_ROOM);
		store.applyEvents(1n, [
			ev(1, { case: "activityEnd", value: { actorId: "director", activityId: "w1", ok: true } }),
			ev(2, { case: "activityEnd", value: { actorId: "advisor", activityId: "w1", ok: true } }),
			ev(3, { case: "activityStart", value: { actorId: "director", activity: act("think", OfficeRoom.DIRECTOR, "", T0, OfficeAnimGroup.THINK) } }),
		]);
		const back = officePlacement(store.state(), layout(), T0 + 60_000, asked.memory, PROFILE);
		expect(placed(back.placements, "director").room).toBe("DIRECTOR");
	});

	it("asking Advisor while it is not in (turned off meanwhile): the meeting room, like any activity there", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ activity: consult("w1") })]));
		const d = placed(officePlacement(store.state(), layout(), T0, EMPTY_MEMORY, PROFILE).placements, "director");
		expect([d.room, d.activityRoom]).toEqual(["MEETING", "MEETING"]);
		expect(officePlacement(store.state(), layout(), T0, EMPTY_MEMORY, PROFILE).placements.some((p) => p.kind === "advisor")).toBe(false);
	});

	it("never talks with the residents", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), advisor(), staff("e1", "scout", { state: OfficeActorState.DONE, doneAt: BigInt(T0) })], { session: session({ busy: false }) }));
		let memory = EMPTY_MEMORY;
		for (let now = T0; now < T0 + 3_600_000; now += 30_000) {
			const placedNow = officePlacement(store.state(), layout(), now, memory, PROFILE);
			memory = placedNow.memory;
			const talks = officeTalks(placedNow.placements, store.state(), layout(), now);
			expect(talks.some((x) => x.host === "advisor" || x.visitor === "advisor")).toBe(false);
		}
	});
});

describe("Advisor's name and bubbles", () => {
	const at = (actors: OfficeActor[], profile: OfficeAdvisor | null = PROFILE): readonly Placement[] => {
		const { store } = storeAt();
		store.applySnapshot(snapshot(actors));
		return officePlacement(store.state(), layout(), T0, EMPTY_MEMORY, profile).placements;
	};

	it("goes by the profile's name (the default one without a profile), in its look's colour", () => {
		const p = placed(at([director(), advisor()]), "advisor");
		expect(personName(t, p)).toBe("Thầy Cú");
		expect(personColor(p)).toBe(lookOf("owl").colors.body);
		const plain = placed(at([director(), advisor()], null), "advisor");
		expect(personName(t, plain)).toBe(t.advisor);
		expect(placed(at([director(), advisor()], { name: "Mèo", lookId: "cat" }), "advisor").advisor?.lookId).toBe("cat");
	});

	it("says its latest answer, and that it weighs while asked; the asker says they ask", () => {
		expect(markerView(t, placed(at([director(), advisor({ description: "Rebase · 80%" })]), "advisor"), null).bubble).toBe("Rebase · 80%");
		expect(markerView(t, placed(at([director(), advisor()]), "advisor"), null).bubble).toBe("");
		const asking = at([director({ activity: consult("w1") }), advisor({ activity: consult("w1"), description: "Rebase · 80%" })]);
		expect(markerView(t, placed(asking, "advisor"), null).bubble).toBe(t.doing.weigh);
		expect(markerView(t, placed(asking, "director"), null).bubble).toBe(t.doing.consult);
	});
});
