// A tool stuck in the dark: running long (the hourglass) with no word about
// its actor for five minutes, the person dozes off where they work ("Zzz",
// "Kẹt N phút"); any event about them wakes them; running long while events
// keep coming is only "Chạy lâu".
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { markerView } from "../../src/machines/office/office-names.ts";
import { EMPTY_MEMORY, officePlacement, type Placement } from "../../src/machines/office/office-placement.ts";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";
import { SLOW_TOOL_MS, STUCK_MS, type OfficeStore } from "../../src/machines/office/office-store.ts";
import { act, director, ev, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

const t = viMachines.office;

function tester(store: OfficeStore, now: number): Placement {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	const p = officePlacement(store.state(), OFFICE_LAYOUT.value, now, EMPTY_MEMORY).placements.find((x) => x.key === "title:qaTester");
	if (p === undefined) throw new Error("tester not placed");
	return p;
}

/** A tester whose test command started at T0 and is still running. */
function running(): { store: OfficeStore; clock: { now: number } } {
	const made = storeAt();
	made.store.applySnapshot(snapshot([director(), staff("s1", "tester", { activity: act("a1", OfficeRoom.QA, "Bash", T0) })]));
	// One event so the clocks are tied (viewer time = machine time).
	made.store.applyEvents(1n, [ev(1, { case: "turnStart", value: {} }, T0)]);
	return made;
}

describe("dozing off over a stuck tool", () => {
	it("does not doze while events about the person keep coming, even running long", () => {
		const { store, clock } = running();
		const later = T0 + SLOW_TOOL_MS + STUCK_MS;
		clock.now = later - 60_000;
		store.applyEvents(1n, [ev(2, { case: "actorUpdate", value: staff("s1", "tester", { activity: act("a1", OfficeRoom.QA, "Bash", T0) }) }, later - 60_000)]);
		clock.now = later;
		store.tick(later);
		const activity = store.state().actors.find((a) => a.id === "s1")?.activity;
		expect(activity?.slow).toBe(true);
		expect(activity?.stuckMs).toBeNull();
		const view = markerView(t, tester(store, later), null);
		expect(view.status).toBe("slow");
		expect(view.label).toBe("Kiểm thử viên · Chạy lâu");
	});

	it("dozes after five silent minutes of a slow tool, where they work, with Zzz and the minutes stuck", () => {
		const { store, clock } = running();
		clock.now = T0 + STUCK_MS + 60_000;
		store.tick(clock.now);
		const activity = store.state().actors.find((a) => a.id === "s1")?.activity;
		expect(activity?.stuckMs).toBe(STUCK_MS + 60_000);
		const p = tester(store, clock.now);
		expect(p.room).toBe("QA");
		const view = markerView(t, p, null);
		expect(view).toMatchObject({ status: "stuck", bubble: "Zzz", label: "Kiểm thử viên · Kẹt 6 phút" });
	});

	it("wakes at the next event about them", () => {
		const { store, clock } = running();
		clock.now = T0 + STUCK_MS + 60_000;
		store.tick(clock.now);
		store.applyEvents(1n, [ev(2, { case: "actorUpdate", value: staff("s1", "tester", { activity: act("a1", OfficeRoom.QA, "Bash", T0) }) }, clock.now)]);
		const activity = store.state().actors.find((a) => a.id === "s1")?.activity;
		expect(activity?.slow).toBe(true);
		expect(activity?.stuckMs).toBeNull();
		expect(markerView(t, tester(store, clock.now), null).status).toBe("slow");
	});
});
