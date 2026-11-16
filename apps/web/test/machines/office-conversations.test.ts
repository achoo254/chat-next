// The residents' talks: the Vietnamese pool is big enough, every line fills
// from facts with no slot left, no internal word slips in; topics follow the
// facts; pairs form only among free, awake people in the same or a
// neighbouring room, at most two a floor, never twice inside three minutes;
// lines alternate, 2.5 to 4 s each; the same people and time give the same
// talk.
import { OfficeActorState, OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { lineOf, neighbourRooms, officeTalks, TALK_COOLDOWN_WINDOWS, TALK_WINDOW_MS, talkWindowOf, LINE_MAX_MS, LINE_MIN_MS } from "../../src/machines/office/office-conversations.ts";
import { DIALOGUE_SLOTS, DIALOGUE_VI, fillLine, QUIRKS, slotsOf, type DialogueSlot } from "../../src/machines/office/office-dialogue-vi.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { EMPTY_MEMORY, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import { talkFacts } from "../../src/machines/office/office-talk-facts.ts";
import { EMPTY_SESSION, type OfficeState } from "../../src/machines/office/office-state.ts";
import { EMPTY_WORK } from "../../src/machines/office/office-work-log.ts";
import { act, director, ev, localAt, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

const ALL_LINES: readonly string[] = [
	...Object.values(DIALOGUE_VI).flatMap((topic) => [...topic.opener, ...topic.reply, ...topic.follow, ...topic.close]),
	...Object.values(QUIRKS).flat(),
];

const FULL: Readonly<Record<DialogueSlot, string>> = {
	ten: "Tí Trinh Sát",
	viec: "viết code",
	phong: "ở phòng QA",
	lau: "3 phút",
	lan: "4",
	cho: "2 phút",
	xong: "7",
	dat: "5",
	truot: "1",
	bua: "bữa trưa",
	gio: "21 giờ",
};

/** The facts each topic is only chosen with (office-talk-facts.ts). */
const GUARANTEED: Readonly<Record<string, readonly DialogueSlot[]>> = {
	workDone: ["viec", "phong", "lau", "lan"],
	testsPass: ["dat"],
	testsFail: ["truot"],
	approvalWait: ["cho"],
	meal: ["bua"],
};

/** Words of the machine's internals that must never reach a bubble. */
const FORBIDDEN = /\b(bash|read|edit|write|grep|glob|tool|subagent|agent|mcp|token|path|file|json|undefined|null|NaN)\b|\.ts\b|\/|\\|\{|\}/i;

/** A session at rest at `now`'s day with the director and finished employees of `types`. */
function resting(types: readonly string[]): { state: OfficeState; placements: readonly Placement[]; at: (now: number) => readonly Placement[] } {
	const { store } = storeAt();
	store.applySnapshot(snapshot([director({ state: OfficeActorState.IDLE }), ...types.map((t, i) => staff(`s${i}`, t, { state: OfficeActorState.DONE }))], { session: session({ busy: false, tasksDone: 3 }) }));
	const at = (now: number): readonly Placement[] => officePlacement(store.state(), layout(), now, EMPTY_MEMORY).placements.map((p) => ({ ...p, since: 0 }));
	return { state: store.state(), placements: at(localAt(20)), at };
}

describe("the dialogue pool", () => {
	it("holds at least 120 lines, over eleven topics and every character", () => {
		expect(ALL_LINES.length).toBeGreaterThanOrEqual(120);
		expect(Object.keys(DIALOGUE_VI)).toHaveLength(11);
		for (const [topic, lines] of Object.entries(DIALOGUE_VI)) {
			for (const role of [lines.opener, lines.reply, lines.follow, lines.close]) {
				expect(role.length, topic).toBeGreaterThanOrEqual(2);
				// A role always has a line needing only what the topic's own facts guarantee, so a talk never runs out of lines.
				const sure = new Set<DialogueSlot>(["ten", "gio", ...(GUARANTEED[topic] ?? [])]);
				expect(role.some((l) => slotsOf(l).every((s) => sure.has(s))), topic).toBe(true);
			}
		}
	});

	it("fills every line from facts with no slot left and no internal word", () => {
		for (const line of ALL_LINES) {
			for (const slot of slotsOf(line)) expect(DIALOGUE_SLOTS).toContain(slot);
			const text = fillLine(line, FULL);
			expect(text, line).not.toMatch(FORBIDDEN);
			expect(text.trim(), line).toBe(text);
			expect(text.length, line).toBeLessThanOrEqual(80);
		}
	});

	it("chooses topics from the facts", () => {
		const base = { session: EMPTY_SESSION, clockOffset: 0, now: localAt(15), slot: "work" as const, acts: [] };
		expect(talkFacts({ ...base, work: EMPTY_WORK }).topics).toEqual(["smallTalk"]);
		const worked = talkFacts({ ...base, work: { done: 3, last: { group: "type", room: "QA", ok: true, at: localAt(14, 50), ms: 125_000 }, approval: null } });
		expect(worked.topics).toContain("workDone");
		expect(worked.values).toMatchObject({ viec: "viết code", phong: "ở phòng QA", lau: "2 phút", lan: "3" });
		const failing = talkFacts({ ...base, work: EMPTY_WORK, session: { ...EMPTY_SESSION, checks: { passed: 2, failed: 1, lastOk: false } } });
		expect(failing.topics).toContain("testsFail");
		expect(failing.topics).not.toContain("testsPass");
		const waited = talkFacts({ ...base, work: { done: 0, last: null, approval: { waitMs: 240_000, at: localAt(14) } } });
		expect(waited.values.cho).toBe("4 phút");
		const dinner = talkFacts({ ...base, work: EMPTY_WORK, slot: "evening", now: localAt(20), acts: ["watch", "eat"] });
		expect(dinner.topics).toEqual(expect.arrayContaining(["tv", "meal", "evening"]));
		expect(talkFacts({ ...base, work: EMPTY_WORK, slot: "evening", now: localAt(22, 45) }).topics).toContain("goodNight");
	});
});

describe("who talks", () => {
	it("gives nobody two talk windows within three minutes", () => {
		for (const key of ["director", "scout#1", "tester#1", "planner#1"]) {
			const windows = Array.from({ length: 600 }, (_, i) => i).filter((w) => talkWindowOf(key, w + 30_000_000));
			expect(windows.length).toBeGreaterThan(50);
			for (let i = 1; i < windows.length; i += 1) expect((windows[i] ?? 0) - (windows[i - 1] ?? 0)).toBeGreaterThanOrEqual(TALK_COOLDOWN_WINDOWS);
		}
	});

	it("knows which rooms are neighbours", () => {
		expect(neighbourRooms(layout(), "GYM", "DORM")).toBe(true);
		expect(neighbourRooms(layout(), "GYM", "LOUNGE")).toBe(true);
		expect(neighbourRooms(layout(), "DORM", "LOUNGE")).toBe(false);
		expect(neighbourRooms(layout(), "WORK", "QA")).toBe(false);
	});

	it("pairs free residents of a floor in turn, two talks at most, lines alternating 2.5 to 4 s, the same for every viewer", () => {
		const { state, at } = resting(["scout", "tester", "planner", "researcher", "debugger", "explore"]);
		let talked = 0;
		for (let w = 0; w < 30; w += 1) {
			const now = localAt(20) + w * TALK_WINDOW_MS + 9_000;
			const placements = at(now);
			const talks = officeTalks(placements, state, layout(), now);
			expect(talks).toEqual(officeTalks(placements, state, layout(), now));
			const perFloor = new Map<number, number>();
			for (const talk of talks) {
				talked += 1;
				perFloor.set(talk.floor, (perFloor.get(talk.floor) ?? 0) + 1);
				expect(talk.lines.length).toBeGreaterThanOrEqual(2);
				expect(talk.lines.length).toBeLessThanOrEqual(4);
				talk.lines.forEach((line, i) => {
					expect(line.speaker).toBe(i % 2 === 0 ? talk.visitor : talk.host);
					expect(line.to - line.from).toBeGreaterThanOrEqual(LINE_MIN_MS);
					expect(line.to - line.from).toBeLessThanOrEqual(LINE_MAX_MS);
					expect(line.text).not.toMatch(FORBIDDEN);
				});
				const host = placements.find((p) => p.key === talk.host);
				expect(talk.hostAnchor).toBe(host?.anchorId);
			}
			for (const n of perFloor.values()) expect(n).toBeLessThanOrEqual(2);
		}
		expect(talked).toBeGreaterThan(0);
	});

	it("never talks to someone asleep or at work, and a talk ends when work pulls one of them away", () => {
		const { state, at } = resting(["scout", "tester", "planner", "researcher"]);
		for (let w = 0; w < 20; w += 1) {
			const now = localAt(1) + w * TALK_WINDOW_MS + 9_000;
			expect(officeTalks(at(now), state, layout(), now)).toEqual([]);
		}
		// Find an evening talk, then send its visitor to work.
		const { store } = storeAt();
		store.applySnapshot(snapshot([director({ state: OfficeActorState.IDLE }), staff("s0", "scout", { state: OfficeActorState.DONE }), staff("s1", "tester", { state: OfficeActorState.DONE }), staff("s2", "planner", { state: OfficeActorState.DONE })], { session: session({ busy: false }) }));
		const placed = (now: number): readonly Placement[] => officePlacement(store.state(), layout(), now, EMPTY_MEMORY).placements.map((p) => ({ ...p, since: 0 }));
		let found: { now: number; visitor: string } | null = null;
		for (let w = 0; w < 60 && found === null; w += 1) {
			const now = localAt(20) + w * TALK_WINDOW_MS + 9_000;
			const talk = officeTalks(placed(now), store.state(), layout(), now)[0];
			if (talk !== undefined) found = { now, visitor: talk.visitor };
		}
		expect(found).not.toBeNull();
		if (found === null) return;
		const actorId = store.state().staff.find((m) => m.key === found?.visitor)?.actorId ?? "director";
		store.applyEvents(1n, [ev(1, { case: "activityStart", value: { actorId, activity: act("w1", OfficeRoom.LIBRARY, "Read", T0, OfficeAnimGroup.READ) } })]);
		const after = officeTalks(placed(found.now), store.state(), layout(), found.now);
		expect(after.some((t) => t.visitor === found?.visitor || t.host === found?.visitor)).toBe(false);
	});

	it("says each line only while it is its time", () => {
		const { state, at } = resting(["scout", "tester", "planner", "researcher", "debugger", "explore"]);
		for (let w = 0; w < 30; w += 1) {
			const now = localAt(20) + w * TALK_WINDOW_MS + 9_000;
			const talk = officeTalks(at(now), state, layout(), now)[0];
			const first = talk?.lines[0];
			if (talk === undefined || first === undefined) continue;
			expect(lineOf([talk], first.speaker, first.from)).toBe(first.text);
			expect(lineOf([talk], first.speaker, first.from - 1)).toBeNull();
			return;
		}
		throw new Error("no talk in thirty windows");
	});
});
