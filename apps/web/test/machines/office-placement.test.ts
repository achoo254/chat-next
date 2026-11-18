// Where everyone is: fifteen people always in the building (the director, the
// advisor and the 13 staff of the studio), each job title at its home seat; real
// work takes a title's person to the room of the tool and back; rest, play and
// sleep only off office hours while no agent runs (nobody is exempt, Advisor and
// Backend & DevOps included); Backend & DevOps stays in the server room while it
// works; the director only directs (his tools belong to a department,
// a subagent starting shows the hand-over); approvals go to Security and the
// reviewer greets there; asking Advisor takes the asker to its room; no two on a
// spot; the same input gives the same places.
import { OfficeActorState, OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { STUDIO_TITLES } from "../../src/machines/office/office-cast.ts";
import { anchorById, zoneOfRoom } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { DELEGATE_MS, EMPTY_MEMORY, HAND_IN_MS, LINGER_MS, MIN_STAY_MS, officePlacement, type Placement, type PlacementMemory } from "../../src/machines/office/office-placement.ts";
import type { OfficeStore } from "../../src/machines/office/office-store.ts";
import { act, director, ev, localAt, machine, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

/** Places people at successive moments, keeping the memory like the views do. */
function placer(store: OfficeStore) {
	let memory: PlacementMemory = EMPTY_MEMORY;
	return (now: number): readonly Placement[] => {
		const result = officePlacement(store.state(), layout(), now, memory);
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
function startOn(store: OfficeStore, actorId: string, id: string, room: OfficeRoom, tool = "Read", group = OfficeAnimGroup.READ): void {
	seq += 1;
	store.applyEvents(1n, [ev(seq, { case: "activityStart", value: { actorId, activity: act(id, room, tool, T0, group) } })]);
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

/** A session at rest: no agent runs. */
const RESTING = { session: session({ busy: false }) };
const quietDirector = () => director({ state: OfficeActorState.IDLE });

/** The 13 job titles and their home seats (tools/office-art/staff-cast.json, the layout's `home` anchors). */
const HOMES: Record<string, [string, string]> = {
	producerPm: ["PLANNING", "planning-desk-0"],
	techLead: ["WORK", "desk-1"],
	gameplayDeveloper: ["WORK", "desk-2"],
	backendDevops: ["SERVER", "server-desk"],
	gameDesigner: ["PLANNING", "planning-desk-1"],
	uiUxDesigner: ["WORK", "desk-5"],
	artist: ["WORK", "desk-6"],
	qaTester: ["WORK", "desk-0"],
	codeSecurityReviewer: ["AUDIT", "audit-work-0"],
	contentMarketing: ["PLANNING", "planning-desk-2"],
	growthAnalytics: ["LIBRARY", "library-seat-1"],
	researchAnalyst: ["LIBRARY", "library-seat-0"],
	financeController: ["AUDIT", "audit-work-1"],
};

describe("office placement", () => {
	it("always shows fifteen people (the director, the advisor and the 13 staff), each at their home seat in office hours, with no agent at work", () => {
		const places = placer(fresh([quietDirector()], RESTING))(T0);
		const people = places.filter((p) => p.kind !== "chairman");
		expect(people).toHaveLength(15);
		expect(find(places, "director")).toMatchObject({ room: "DIRECTOR", anchorId: "director", activityRoom: null, life: null });
		expect(find(places, "advisor")).toMatchObject({ room: "ADVISOR", anchorId: "advisor-seat", activityRoom: null });
		for (const title of STUDIO_TITLES) {
			const [room, seat] = HOMES[title.key] ?? ["", ""];
			expect(find(places, `title:${title.key}`), title.key).toMatchObject({ room, anchorId: seat, activityRoom: null, life: null });
		}
		// Not one of them depends on a subagent: even before the first snapshot has an employee.
		expect(new Set(people.map((p) => p.anchorId)).size).toBe(15);
	});

	it("takes the title's person to the room of the tool: WORK is the home room of the title, any other room is visited, then home", () => {
		const store = fresh([director(), staff("a1", "planner", { activity: act("e", OfficeRoom.WORK, "Edit") }), staff("a2", "code-reviewer", { activity: act("r", OfficeRoom.LIBRARY) })]);
		const places = placer(store)(T0);
		expect(find(places, "title:producerPm")).toMatchObject({ room: "PLANNING", anchorId: "planning-desk-0", activityRoom: "PLANNING" });
		expect(find(places, "title:codeSecurityReviewer")).toMatchObject({ room: "LIBRARY", activityRoom: "LIBRARY" });
		expect(zoneOfRoom(layout(), "LIBRARY")).toBe("b");
		// An agent type that no title claims is the Gameplay Developer's; one with a security name is the reviewer's.
		const odd = fresh([director(), staff("a1", "mystery-bot", { activity: act("e", OfficeRoom.WORK, "Edit") }), staff("a2", "security", { activity: act("s", OfficeRoom.AUDIT, "Bash") })]);
		const oddPlaces = placer(odd)(T0);
		expect(find(oddPlaces, "title:gameplayDeveloper")).toMatchObject({ room: "WORK", anchorId: "desk-2", activityRoom: "WORK" });
		expect(find(oddPlaces, "title:codeSecurityReviewer")).toMatchObject({ room: "AUDIT", anchorId: "audit-work-0" });
	});

	it("makes several subagents of one title the same person, with their count", () => {
		const store = fresh([director(), staff("a1", "scout", { activity: act("r1", OfficeRoom.LIBRARY) }), staff("a2", "Explore", { activity: act("r2", OfficeRoom.LIBRARY) }), staff("a3", "tester", { activity: act("q", OfficeRoom.QA, "Bash") })]);
		const places = placer(store)(T0);
		expect(places.filter((p) => p.key.startsWith("title:"))).toHaveLength(13);
		expect(find(places, "title:techLead").concurrent).toBe(2);
		expect(find(places, "title:qaTester").concurrent).toBe(1);
	});

	it("keeps Backend & DevOps in the server room while it works, whatever room the tool is in; free off hours it goes to bed like the others", () => {
		const night = localAt(23, 30);
		const rest = fresh([quietDirector()], RESTING);
		const asleep = find(placer(rest)(night), "title:backendDevops");
		expect(asleep.life).toMatchObject({ act: "sleep" });
		expect(anchorById(layout(), asleep.anchorId)?.kind).toBe("bed");
		// In office hours with nothing to do it sits at the server desk.
		expect(find(placer(rest)(T0), "title:backendDevops")).toMatchObject({ room: "SERVER", anchorId: "server-desk", life: null });
		const busy = fresh([director(), staff("g", "git-manager", { activity: act("g1", OfficeRoom.LIBRARY, "Bash") })]);
		expect(find(placer(busy)(T0), "title:backendDevops")).toMatchObject({ room: "SERVER", anchorId: "server-desk", activityRoom: "SERVER" });
		// Nobody else stands in the server room regularly.
		const places = placer(rest)(T0);
		expect(places.filter((p) => p.room === "SERVER").map((p) => p.key)).toEqual(["title:backendDevops"]);
	});

	it("lets everyone rest, play and sleep only off office hours and only while no agent runs", () => {
		const resting = fresh([quietDirector()], RESTING);
		// Office hours: nobody leaves their seat.
		const day = placer(resting)(T0);
		expect(day.filter((p) => p.life !== null)).toHaveLength(0);
		// Evening, no agent running: all fifteen live by the schedule, Backend & DevOps and Advisor too.
		const night = placer(fresh([quietDirector()], RESTING))(localAt(23, 30));
		const living = night.filter((p) => p.life !== null).map((p) => p.key);
		expect(living).toContain("director");
		expect(living).toContain("title:backendDevops");
		expect(living).toContain("advisor");
		expect(living).toHaveLength(15);
		expect(night.filter((p) => p.life?.act === "sleep").every((p) => anchorById(layout(), p.anchorId)?.kind === "bed")).toBe(true);
		// The same evening with an agent running: everyone is back at their seat.
		const running = placer(fresh([director(), staff("a1", "planner", { activity: act("e", OfficeRoom.PLANNING, "Edit") })]))(localAt(23, 30));
		expect(running.filter((p) => p.life !== null)).toHaveLength(0);
		const home = find(running, "title:techLead");
		expect([home.room, home.anchorId]).toEqual(["WORK", "desk-1"]);
		expect(find(running, "director")).toMatchObject({ room: "DIRECTOR", anchorId: "director" });
	});

	it("keeps the marketers at planning and the library, the accountant at the token board's room, the reviewer at audit", () => {
		const places = placer(fresh([quietDirector()], RESTING))(T0);
		expect(find(places, "title:contentMarketing")).toMatchObject({ room: "PLANNING", anchorId: "planning-desk-2" });
		expect(find(places, "title:growthAnalytics")).toMatchObject({ room: "LIBRARY", anchorId: "library-seat-1" });
		expect(find(places, "title:financeController")).toMatchObject({ room: "AUDIT", anchorId: "audit-work-1" });
		expect(find(places, "title:codeSecurityReviewer")).toMatchObject({ room: "AUDIT", anchorId: "audit-work-0" });
		expect(anchorById(layout(), "audit-work-1")?.room).toBe("AUDIT");
	});

	it("takes whoever waits for an approval to Security, where the reviewer greets; the chairman stays in the lobby", () => {
		const store = fresh([director(), staff("a1", "tester", { state: OfficeActorState.AWAITING_APPROVAL, activity: act("b", OfficeRoom.WORK, "Bash") })], { session: session({ waitingForUser: true }) });
		const places = placer(store)(T0);
		expect(find(places, "title:qaTester")).toMatchObject({ room: "SECURITY" });
		expect(find(places, "title:codeSecurityReviewer")).toMatchObject({ room: "SECURITY", anchorId: "security-work-0" });
		expect(zoneOfRoom(layout(), "SECURITY")).toBe("c");
		expect(find(places, "chairman")).toMatchObject({ room: "LOBBY", anchorId: "chairman", activityRoom: null });
	});

	it("sends whoever asks Advisor to its room; Advisor sits in it in office hours, counts as busy only while asked and rests off hours", () => {
		const alone = placer(fresh([quietDirector()], RESTING))(T0);
		expect(find(alone, "advisor")).toMatchObject({ room: "ADVISOR", anchorId: "advisor-seat", activityRoom: null });
		const night = find(placer(fresh([quietDirector()], RESTING))(localAt(23, 30)), "advisor");
		expect(night.life).toMatchObject({ act: "sleep" });
		expect(anchorById(layout(), night.anchorId)?.kind).toBe("bed");
		const store = fresh([director(), staff("a1", "planner", { activity: act("c", OfficeRoom.MEETING, "mcp", T0, OfficeAnimGroup.CONSULT) })]);
		const places = placer(store)(T0);
		expect(find(places, "title:producerPm")).toMatchObject({ room: "ADVISOR", activityRoom: "ADVISOR" });
		expect(find(places, "advisor")).toMatchObject({ room: "ADVISOR", anchorId: "advisor-seat", activityRoom: "ADVISOR" });
		expect(zoneOfRoom(layout(), "ADVISOR")).toBe("c");
	});

	it("lets the director only direct: his tools belong to the department, he sits at his chair", () => {
		const store = fresh([director({ activity: act("r", OfficeRoom.LIBRARY) })]);
		const places = placer(store)(T0 + DELEGATE_MS);
		expect(find(places, "director")).toMatchObject({ room: "DIRECTOR", anchorId: "director", activityRoom: null });
		expect(find(places, "director").actor?.activity).toBeNull();
		// The research analyst does the reading, as an employee of the title.
		const reader = find(places, "title:researchAnalyst");
		expect(reader).toMatchObject({ room: "LIBRARY", activityRoom: "LIBRARY" });
		expect(reader.actor).toMatchObject({ role: "employee", agentType: "researcher" });
		expect(reader.actor?.activity?.tool).toBe("Read");
		// Typing at WORK is the Gameplay Developer's, a command in the server room Backend & DevOps's.
		const typing = placer(fresh([director({ activity: act("e", OfficeRoom.WORK, "Edit") })]))(T0 + DELEGATE_MS);
		expect(find(typing, "title:gameplayDeveloper")).toMatchObject({ room: "WORK", anchorId: "desk-2", activityRoom: "WORK" });
		expect(find(typing, "director").activityRoom).toBeNull();
		const server = placer(fresh([director({ activity: act("b", OfficeRoom.SERVER, "Bash") })]))(T0 + DELEGATE_MS);
		expect(find(server, "title:backendDevops")).toMatchObject({ room: "SERVER", activityRoom: "SERVER" });
		// Thinking is his own work, at his chair.
		const thinking = placer(fresh([director({ activity: act("t", OfficeRoom.DIRECTOR, "", T0, OfficeAnimGroup.THINK) })]))(T0 + DELEGATE_MS);
		expect(find(thinking, "director")).toMatchObject({ room: "DIRECTOR", anchorId: "director", activityRoom: "DIRECTOR" });
		// Asking Advisor takes him to its room.
		const asking = placer(fresh([director({ activity: act("c", OfficeRoom.MEETING, "mcp", T0, OfficeAnimGroup.CONSULT) })]))(T0 + DELEGATE_MS);
		expect(find(asking, "director")).toMatchObject({ room: "ADVISOR", activityRoom: "ADVISOR" });
	});

	it("shows the director handing the job over only while a subagent really starts", () => {
		const store = fresh([director(), staff("a1", "planner", { activity: act("e", OfficeRoom.PLANNING, "Edit") })]);
		const place = placer(store);
		const handing = find(place(T0 + 500), "director");
		expect(handing).toMatchObject({ room: "DIRECTOR", anchorId: "director", activityRoom: "DIRECTOR" });
		expect(handing.actor?.activity?.group).toBe("hand-in");
		// Later, the same subagent running on is no hand-over.
		expect(find(place(T0 + DELEGATE_MS + MIN_STAY_MS + LINGER_MS), "director").actor?.activity ?? null).toBeNull();
		// A director alone, with no subagent starting, never hands anything over.
		const alone = find(placer(fresh([director()]))(T0 + 500), "director");
		expect(alone.activityRoom).toBeNull();
	});

	it("moves a person at most once every four seconds through a burst of short tools", () => {
		const store = fresh([director(), staff("a1", "scout")]);
		const place = placer(store);
		const rooms: string[] = [];
		const note = (now: number) => rooms.push(find(place(now), "title:techLead").room);
		startOn(store, "a1", "r1", OfficeRoom.LIBRARY);
		note(T0);
		endOn(store, "a1", "r1");
		startOn(store, "a1", "e1", OfficeRoom.WORK, "Edit");
		note(T0 + 300);
		endOn(store, "a1", "e1");
		startOn(store, "a1", "r2", OfficeRoom.LIBRARY);
		note(T0 + 600);
		startOn(store, "a1", "e2", OfficeRoom.WORK, "Edit");
		note(T0 + 1_500);
		note(T0 + MIN_STAY_MS - 1);
		note(T0 + MIN_STAY_MS);
		expect(rooms).toEqual(["LIBRARY", "LIBRARY", "LIBRARY", "LIBRARY", "LIBRARY", "WORK"]);
	});

	it("lingers six seconds where the work ended, then goes back to the seat", () => {
		const store = fresh([director(), staff("a1", "scout")]);
		const place = placer(store);
		startOn(store, "a1", "r", OfficeRoom.LIBRARY);
		expect(find(place(T0), "title:techLead").room).toBe("LIBRARY");
		// The views place people every second: the last frame that saw the work is when it ended.
		const ended = T0 + 5_000;
		expect(find(place(ended), "title:techLead").activityRoom).toBe("LIBRARY");
		endOn(store, "a1", "r");
		expect(find(place(ended + 1), "title:techLead")).toMatchObject({ room: "LIBRARY", activityRoom: "LIBRARY" });
		expect(find(place(ended + LINGER_MS - 1), "title:techLead").room).toBe("LIBRARY");
		expect(find(place(ended + LINGER_MS), "title:techLead")).toMatchObject({ room: "WORK", anchorId: "desk-1", activityRoom: null });
	});

	it("lets a finished employee hand in their file at the director's, then sends them to the seat", () => {
		const store = fresh([director(), staff("a1", "scout", { state: OfficeActorState.DONE, doneAt: BigInt(T0), activity: act("hand-in", OfficeRoom.DIRECTOR, "", T0, OfficeAnimGroup.HAND_IN) })]);
		const place = placer(store);
		expect(find(place(T0), "title:techLead")).toMatchObject({ room: "DIRECTOR", activityRoom: "DIRECTOR" });
		expect(find(place(T0 + HAND_IN_MS - 1), "title:techLead").room).toBe("DIRECTOR");
		expect(find(place(T0 + HAND_IN_MS + LINGER_MS), "title:techLead")).toMatchObject({ room: "WORK", anchorId: "desk-1", activityRoom: null });
	});

	it("never puts two people on one spot while the room has free ones", () => {
		const library = ["researcher", "scout", "tester", "planner"].map((t, i) => staff(`s${i}`, t, { activity: act(`x${i}`, OfficeRoom.LIBRARY) }));
		const places = placer(fresh([director(), ...library]))(T0).filter((p) => p.room === "LIBRARY");
		// The two home seats of the library are taken by their own people; the visitors take free spots.
		const spots = places.map((p) => p.anchorId);
		expect(spots.length).toBeGreaterThanOrEqual(4);
		expect(new Set(spots).size).toBe(spots.length);
	});

	it("freezes everyone while the power is out", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), staff("a1", "scout", { activity: act("r", OfficeRoom.LIBRARY) })]));
		const place = placer(store);
		expect(find(place(T0), "title:techLead").room).toBe("LIBRARY");
		store.applyEvents(1n, [ev(1, { case: "activityStart", value: { actorId: "a1", activity: act("q", OfficeRoom.QA, "Bash", T0, OfficeAnimGroup.MACHINE) } })]);
		store.linkStatus(false, T0);
		clock.now = T0 + 40_000;
		store.tick(clock.now);
		expect(store.state().power).toBe("out");
		expect(find(place(clock.now), "title:techLead").room).toBe("LIBRARY");
	});

	it("gives the same places for the same input", () => {
		const build = () => fresh([director({ activity: act("r", OfficeRoom.POST, "Bash") }), staff("a1", "tester", { activity: act("q", OfficeRoom.QA, "Bash") }), machine("m1")]);
		const a = officePlacement(build().state(), layout(), T0, EMPTY_MEMORY);
		const b = officePlacement(build().state(), layout(), T0, EMPTY_MEMORY);
		expect(a.placements.map((p) => [p.key, p.room, p.anchorId])).toEqual(b.placements.map((p) => [p.key, p.room, p.anchorId]));
		expect([...a.memory.entries()]).toEqual([...b.memory.entries()]);
	});
});
