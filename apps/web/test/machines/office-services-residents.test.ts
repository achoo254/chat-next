// After a reload the office knows everyone who worked in the session (the
// snapshot's residents, hired back in the order they came in, so each keeps
// their name and number); an older agent's snapshot without them works as
// before. A background service is no person of its own: it is the work of the
// job title that owns its kind, done at their desk, and their bubble says what
// it runs, its port and how long it has run (an older agent's unlabelled one
// shows its tool).
import { OfficeActorState, OfficeRoom, OfficeServiceKind } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { castOf, type CastKey } from "../../src/machines/office/office-cast.ts";
import { markerView, personColor, personName } from "../../src/machines/office/office-names.ts";
import { EMPTY_MEMORY, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";
import { SLOW_TOOL_MS, STUCK_MS } from "../../src/machines/office/office-store.ts";
import { act, director, ev, localAt, machine, resident, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

const t = viMachines.office;
const minute = 60_000;

function placed(store: ReturnType<typeof storeAt>["store"], key: string, now: number): Placement {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	const p = officePlacement(store.state(), OFFICE_LAYOUT.value, now, EMPTY_MEMORY).placements.find((x) => x.key === key);
	if (p === undefined) throw new Error(`${key} not placed`);
	return p;
}

describe("residents after a reload", () => {
	it("hires back those who left, in the order everyone came in, with the names a device watching all along gave", () => {
		// Watching all along: scout 1 and 2 at once, scout 1 leaves, a tester, then another scout takes scout 1's place.
		const live = storeAt();
		live.store.applySnapshot(snapshot([director()]));
		live.store.applyEvents(1n, [
			ev(1, { case: "actorEnter", value: staff("a", "scout", { enteredAt: BigInt(T0 + 1_000) }) }),
			ev(2, { case: "actorEnter", value: staff("b", "scout", { enteredAt: BigInt(T0 + 2_000) }) }),
			ev(3, { case: "actorLeave", value: { actorId: "a" } }),
			ev(4, { case: "actorEnter", value: staff("c", "tester", { enteredAt: BigInt(T0 + 4_000) }) }),
			ev(5, { case: "actorEnter", value: staff("d", "scout", { enteredAt: BigInt(T0 + 5_000) }) }),
			ev(6, { case: "actorLeave", value: { actorId: "b" } }),
			ev(7, { case: "actorLeave", value: { actorId: "c" } }),
		]);
		const watched = live.store.state();

		// Reloaded: the snapshot has the director and d; a, b and c are residents.
		const fresh = storeAt();
		fresh.store.applySnapshot(
			snapshot([director(), staff("d", "scout", { enteredAt: BigInt(T0 + 5_000) })], {
				residents: [
					resident("a", "scout", { enteredAt: T0 + 1_000, leftAt: T0 + 3_000 }),
					resident("b", "scout", { enteredAt: T0 + 2_000, leftAt: T0 + 6_000 }),
					resident("c", "tester", { enteredAt: T0 + 4_000, leftAt: T0 + 7_000 }),
				],
			}),
		);
		const reloaded = fresh.store.state();
		expect(reloaded.staff.map((m) => [m.key, m.actorId])).toEqual(watched.staff.map((m) => [m.key, m.actorId]));
		expect(reloaded.residents.map((m) => m.key)).toEqual(watched.residents.map((m) => m.key));
		expect(reloaded.residents.map((m) => m.key)).toEqual(["scout#2", "tester#1"]);
		expect(reloaded.visitors).toEqual(watched.visitors);
	});

	it("an older agent's snapshot (no residents) knows only its actors, as before", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "scout")]));
		expect(store.state().staff.map((m) => m.key)).toEqual(["scout#1"]);
		expect(store.state().residents).toEqual([]);
	});

	it("a snapshot of the same run keeps what this device saw, residents list or not", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("s1", "scout")]));
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "s1" } })]);
		store.applySnapshot(snapshot([director()], { seq: 1n, residents: [resident("s1", "scout", { enteredAt: T0, leftAt: T0 + 1_000 })] }));
		expect(store.state().residents.map((m) => m.key)).toEqual(["scout#1"]);
	});
});

describe("background services", () => {
	const places = (store: ReturnType<typeof storeAt>["store"], now: number): readonly Placement[] => {
		if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
		return officePlacement(store.state(), OFFICE_LAYOUT.value, now, EMPTY_MEMORY).placements;
	};

	it("are no people of their own: the fifteen stay fifteen, and none is placed by the machine's key", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.DEV_SERVER, startedAt: BigInt(T0) }), machine("m2")]));
		const list = places(store, T0);
		expect(list).toHaveLength(15);
		expect(list.some((p) => p.key.startsWith("machine:"))).toBe(false);
		expect(new Set(list.map((p) => p.kind))).toEqual(new Set(["director", "advisor", "employee"]));
	});

	it.each<[string, OfficeServiceKind | null, CastKey, string, string]>([
		["the dev server is Backend & DevOps's", OfficeServiceKind.DEV_SERVER, "backendDevops", "SERVER", "backend-devops"],
		["a build is Backend & DevOps's", OfficeServiceKind.BUILD, "backendDevops", "SERVER", "backend-devops"],
		["a database is Backend & DevOps's", OfficeServiceKind.DATABASE, "backendDevops", "SERVER", "backend-devops"],
		["a test watcher is QA's", OfficeServiceKind.TEST_WATCH, "qaTester", "WORK", "qa-tester"],
		["CI watching is the Tech Lead's", OfficeServiceKind.CI_WATCH, "techLead", "WORK", "tech-lead"],
		["git is the Gameplay Developer's", OfficeServiceKind.GIT, "gameplayDeveloper", "WORK", "gameplay-developer"],
		["a script is the Gameplay Developer's", OfficeServiceKind.SCRIPT, "gameplayDeveloper", "WORK", "gameplay-developer"],
		["an unknown kind (a newer agent's) is the Gameplay Developer's", 99 as OfficeServiceKind, "gameplayDeveloper", "WORK", "gameplay-developer"],
		["an unlabelled one (an older agent's) is the Gameplay Developer's", null, "gameplayDeveloper", "WORK", "gameplay-developer"],
	])("%s, at work at their own desk", (_name, kind, owner, room, home) => {
		if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
		const { store } = storeAt();
		// Started in the QA room: the work is still done at the owner's desk.
		store.applySnapshot(snapshot([director(), machine("m1", OfficeRoom.QA, kind === null ? undefined : { kind, startedAt: BigInt(T0) })]));
		const p = placed(store, `title:${owner}`, T0);
		expect(p).toMatchObject({ kind: "employee", room, activityRoom: room, concurrent: 0 });
		expect(p.actor?.id).toBe("m1");
		expect(p.actor?.activity?.group).toBe("machine");
		expect(OFFICE_LAYOUT.value.anchors.find((a) => a.id === p.anchorId)?.home).toBe(home);
		// Their own name and colour, not the service's.
		expect(personName(t, p)).toBe(t.cast[owner]);
		expect(personColor(p)).toBe(castOf(p.actor?.agentType ?? "").color);
		// Nobody else works on it.
		for (const other of places(store, T0)) if (other.key !== p.key && other.kind === "employee") expect(other.activityRoom, other.key).toBeNull();
	});

	it("leave their owner free when they stop", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.TEST_WATCH, startedAt: BigInt(T0) })]));
		expect(placed(store, "title:qaTester", T0).activityRoom).toBe("WORK");
		store.applyEvents(1n, [ev(1, { case: "actorLeave", value: { actorId: "m1" } }, T0)]);
		expect(placed(store, "title:qaTester", T0)).toMatchObject({ activityRoom: null, actor: null });
	});

	it("never count as an agent running: off hours with only a service at work, its owner works and the rest of the office rests", () => {
		const night = localAt(23, 30);
		const { store } = storeAt(night);
		store.applySnapshot(
			snapshot([director({ state: OfficeActorState.IDLE }), machine("m1", undefined, { kind: OfficeServiceKind.DEV_SERVER, startedAt: BigInt(night) })], { session: session({ busy: false }) }),
		);
		const list = places(store, night);
		expect(list.find((p) => p.key === "title:backendDevops")?.activityRoom).toBe("SERVER");
		expect(list.filter((p) => p.life !== null).length).toBeGreaterThan(0);
	});

	it("give way to a subagent of the title at work, who is shown over the service", () => {
		const { store } = storeAt();
		store.applySnapshot(
			snapshot([director(), staff("s1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", T0 + 1_000) }), machine("m1", undefined, { kind: OfficeServiceKind.TEST_WATCH, startedAt: BigInt(T0) })]),
		);
		const p = placed(store, "title:qaTester", T0 + 1_000);
		expect(p.actor?.id).toBe("s1");
		expect(p.concurrent).toBe(1);
	});

	it("say what runs in the owner's bubble, with its port and minutes running", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.DEV_SERVER, port: 5173, startedAt: BigInt(T0) })]));
		clock.now = T0 + 12 * minute + 5_000;
		store.tick(clock.now);
		const p = placed(store, "title:backendDevops", clock.now);
		expect(p.actor?.service).toMatchObject({ kind: "dev-server", port: 5173 });
		// A dev server runs on by design: no hourglass, no dozing, however long and silent.
		expect(markerView(t, p, null)).toMatchObject({ status: "working", label: "Backend & Hạ tầng", bubble: "Máy chủ dev · cổng 5173 · 12 phút" });
	});

	it.each<[OfficeServiceKind, number, number, CastKey, string]>([
		[OfficeServiceKind.CI_WATCH, 0, 3, "techLead", "Theo dõi CI · 3 phút"],
		[OfficeServiceKind.TEST_WATCH, 0, 8, "qaTester", "Theo dõi test · 8 phút"],
		[OfficeServiceKind.BUILD, 0, 1, "backendDevops", "Build · 1 phút"],
		[OfficeServiceKind.GIT, 0, 0, "gameplayDeveloper", "Git · vừa chạy"],
		[OfficeServiceKind.DATABASE, 5432, 75, "backendDevops", "Cơ sở dữ liệu · cổng 5432 · 1 giờ 15 phút"],
		[OfficeServiceKind.SCRIPT, 0, 2, "gameplayDeveloper", "Script · 2 phút"],
		// An unknown kind (a newer agent's) reads as a script.
		[99 as OfficeServiceKind, 0, 2, "gameplayDeveloper", "Script · 2 phút"],
	])("kind %i, port %i, %i minutes: %s says %s", (kind, port, minutes, owner, bubble) => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind, port, startedAt: BigInt(T0) })]));
		// One event ties the clocks (viewer time = machine time); none of these runs long enough to doze.
		store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
		clock.now = T0 + minutes * minute;
		store.tick(clock.now);
		expect(markerView(t, placed(store, `title:${owner}`, clock.now), null).bubble).toBe(bubble);
	});

	it("a build stuck long and silent dozes its owner: Zzz instead of its label", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.BUILD, startedAt: BigInt(T0) })]));
		store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
		clock.now = T0 + SLOW_TOOL_MS + STUCK_MS;
		store.tick(clock.now);
		expect(markerView(t, placed(store, "title:backendDevops", clock.now), null)).toMatchObject({ status: "stuck", bubble: "Zzz", label: "Backend & Hạ tầng · Kẹt 7 phút" });
	});

	it("an older agent's unlabelled service shows its tool in the Gameplay Developer's bubble", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1")]));
		const p = placed(store, "title:gameplayDeveloper", T0);
		expect(p.actor?.service).toBeNull();
		expect(personName(t, p)).toBe("Lập trình viên");
		expect(markerView(t, p, null).bubble).toBe("Bash");
	});

	it("says it in English and Chinese too", () => {
		expect(enMachines.office.service.names["dev-server"]).toBe("Dev server");
		expect(enMachines.office.service.port(5173)).toBe("port 5173");
		expect(enMachines.office.service.uptime(65)).toBe("1 h 5 min");
		expect(zhCNMachines.office.service.names.database).toBe("数据库");
		expect(zhCNMachines.office.service.uptime(12)).toBe("12 分钟");
	});
});
