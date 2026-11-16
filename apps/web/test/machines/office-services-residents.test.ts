// After a reload the office knows everyone who worked in the session (the
// snapshot's residents, hired back in the order they came in, so each keeps
// their name and number); an older agent's snapshot without them works as
// before. A background service an agent labelled is named by what it runs and
// says its port and how long it has run; an older agent's machine keeps
// "Máy Bash".
import { OfficeServiceKind } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { ROLE_COLORS, SERVICE_COLORS } from "../../src/machines/office/office-cast.ts";
import { markerView, personColor, personName } from "../../src/machines/office/office-names.ts";
import { EMPTY_MEMORY, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";
import { SLOW_TOOL_MS, STUCK_MS } from "../../src/machines/office/office-store.ts";
import { director, ev, machine, resident, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

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

describe("service labels", () => {
	it("names a labelled machine by what it runs, with its port and minutes running, in its kind's colour", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.DEV_SERVER, port: 5173, startedAt: BigInt(T0) })]));
		clock.now = T0 + 12 * minute + 5_000;
		store.tick(clock.now);
		const p = placed(store, "machine:m1", clock.now);
		expect(personName(t, p)).toBe("Máy chủ dev");
		expect(personColor(p)).toBe(SERVICE_COLORS["dev-server"]);
		// A dev server runs on by design: no hourglass, no dozing, however long and silent.
		expect(markerView(t, p, null)).toMatchObject({ status: "working", label: "Máy chủ dev", bubble: "Máy chủ dev · cổng 5173 · 12 phút" });
	});

	it.each([
		[OfficeServiceKind.CI_WATCH, 0, 3, "Theo dõi CI · 3 phút"],
		[OfficeServiceKind.TEST_WATCH, 0, 8, "Theo dõi test · 8 phút"],
		[OfficeServiceKind.BUILD, 0, 1, "Build · 1 phút"],
		[OfficeServiceKind.GIT, 0, 0, "Git · vừa chạy"],
		[OfficeServiceKind.DATABASE, 5432, 75, "Cơ sở dữ liệu · cổng 5432 · 1 giờ 15 phút"],
		[OfficeServiceKind.SCRIPT, 0, 2, "Script · 2 phút"],
		// An unknown kind (a newer agent's) reads as a script.
		[99 as OfficeServiceKind, 0, 2, "Script · 2 phút"],
	])("kind %i, port %i, %i minutes → %s", (kind, port, minutes, bubble) => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind, port, startedAt: BigInt(T0) })]));
		// One event ties the clocks (viewer time = machine time); none of these runs long enough to doze.
		store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
		clock.now = T0 + minutes * minute;
		store.tick(clock.now);
		expect(markerView(t, placed(store, "machine:m1", clock.now), null).bubble).toBe(bubble);
	});

	it("a build stuck long and silent dozes: Zzz instead of its label", () => {
		const { store, clock } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1", undefined, { kind: OfficeServiceKind.BUILD, startedAt: BigInt(T0) })]));
		store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
		clock.now = T0 + SLOW_TOOL_MS + STUCK_MS;
		store.tick(clock.now);
		expect(markerView(t, placed(store, "machine:m1", clock.now), null)).toMatchObject({ status: "stuck", bubble: "Zzz", label: "Build · Kẹt 7 phút" });
	});

	it("an older agent's machine stays 'Máy Bash' with its tool bubble and the machines' grey", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1")]));
		const p = placed(store, "machine:m1", T0);
		expect(p.actor?.service).toBeNull();
		expect(personName(t, p)).toBe("Máy Bash");
		expect(personColor(p)).toBe(ROLE_COLORS.machine);
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
