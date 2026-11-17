// Where placements land in the 3D building (the 2D view's placement, shared).
import { describe, expect, it } from "vitest";
import { anchorById } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { EMPTY_MEMORY, officePlacement } from "../../src/machines/office/office-placement.ts";
import { nearestNode, personTarget, SHARE_STEP, shareIndices } from "../../src/office-3d/character/person-target.ts";
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { act, director, snapshot, staff, storeAt, T0 } from "../machines/office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

describe("person target", () => {
	const l = layout();

	it("puts every placement of a busy office on its anchor's spot, seated at desks and the director's chair", () => {
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), staff("a1", "researcher", { activity: act("a1-1", OfficeRoom.LIBRARY) }), staff("a2", "tester")]));
		const { placements } = officePlacement(store.state(), l, T0, EMPTY_MEMORY);
		expect(placements.length).toBe(3);
		for (const p of placements) {
			const t = personTarget(l, p.anchorId, 0, false);
			const a = anchorById(l, p.anchorId);
			expect(t, p.key).not.toBeNull();
			expect(t).toMatchObject({ x: a?.x, z: a?.z, face: a?.face, node: a?.node });
		}
		expect(personTarget(l, "desk-1", 0, false)?.seated).toBe(true);
		expect(personTarget(l, "director", 0, false)?.seated).toBe(true);
		const library = anchorById(l, "library-work-0");
		expect(personTarget(l, "library-work-0", 0, false)).toMatchObject({ x: library?.x, z: library?.z, seated: false });
	});

	it("steps people sharing an anchor aside, alternating right and left, standing", () => {
		const a = anchorById(l, "meeting-0");
		if (a === undefined) throw new Error("meeting-0 missing");
		const first = personTarget(l, "meeting-0", 0, false);
		const second = personTarget(l, "meeting-0", 1, false);
		const third = personTarget(l, "meeting-0", 2, false);
		expect(first?.seated).toBe(true);
		expect(second?.seated).toBe(false);
		expect(Math.hypot((second?.x ?? 0) - a.x, (second?.z ?? 0) - a.z)).toBeCloseTo(SHARE_STEP);
		expect(Math.hypot((third?.x ?? 0) - a.x, (third?.z ?? 0) - a.z)).toBeCloseTo(SHARE_STEP);
		expect(Math.hypot((second?.x ?? 0) - (third?.x ?? 0), (second?.z ?? 0) - (third?.z ?? 0))).toBeCloseTo(2 * SHARE_STEP);
		expect(shareIndices(["a", "b", "a", "a"])).toEqual([0, 0, 1, 2]);
	});

	it("stands beside a desk facing it on the director's round", () => {
		const desk = anchorById(l, "desk-2");
		const t = personTarget(l, "desk-2", 0, true);
		if (desk === undefined || t === null) throw new Error("desk-2 missing");
		expect(t.seated).toBe(false);
		// Facing the desk anchor from where they stand.
		expect(Math.atan2(desk.x - t.x, desk.z - t.z)).toBeCloseTo(Math.atan2(Math.sin(t.face), Math.cos(t.face)));
	});

	it("knows no unknown anchor and finds the nearest walkway node", () => {
		expect(personTarget(l, "nowhere", 0, false)).toBeNull();
		// Any node of the plan, in any zone: a point just beside it rejoins the walkways there.
		for (const node of [l.graph.nodes[0], l.graph.nodes[l.graph.nodes.length - 1]]) {
			if (node === undefined) throw new Error("the plan has no walkway nodes");
			expect(nearestNode(l, node.x + 0.1, node.z)).toBe(node.id);
		}
	});
});
