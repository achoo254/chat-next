// A person of the 3D office is drawn again when what they wear changes:
// Advisor first drawn in the default look (the viewer's profile not read yet)
// changes to the profile's look once it is in, where it sits, and only then.
// Someone who arrives between two frames is seen (or not) by the camera's
// last view at once, so their first cheer sounds when it should.
// Babylon's NullEngine stands in for the GPU; the pool is a fake that records
// what it was asked to draw.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { create } from "@bufbuild/protobuf";
import { OfficeActorSchema, OfficeActorState, OfficeRole } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { EMPTY_MEMORY, officePlacement, type OfficeAdvisor, type Placement } from "../../src/machines/office/office-placement.ts";
import type { OfficeState } from "../../src/machines/office/office-store.ts";
import type { PersonLook } from "../../src/office-3d/character/character-look.ts";
import type { CharacterPool } from "../../src/office-3d/character/character-pool.ts";
import type { CharacterVisual } from "../../src/office-3d/character/character-visual.ts";
import { createOfficePeople } from "../../src/office-3d/character/office-people.ts";
import { createRouter } from "../../src/office-3d/character/office-routes.ts";
import { director, snapshot, storeAt, T0 } from "../machines/office-builders.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

const engines: NullEngine[] = [];
afterEach(() => {
	for (const engine of engines.splice(0)) engine.dispose();
});

/** A pool drawing nothing real: each visual is a bare node; `drawn` lists who was drawn in what, `disposed` who was taken down. */
function fakePool(scene: Scene): CharacterPool & { readonly drawn: { key: string; look: PersonLook }[]; readonly disposed: string[] } {
	const drawn: { key: string; look: PersonLook }[] = [];
	const disposed: string[] = [];
	const blob = CreatePlane("blob", { size: 1 }, scene);
	return {
		drawn,
		disposed,
		skinned: true,
		create(key, look): CharacterVisual {
			drawn.push({ key, look });
			const root = new TransformNode(`person-${key}`, scene);
			return {
				model: "skinned",
				root,
				meshes: () => [],
				labelHeight: 1,
				setPose: () => undefined,
				setUpdateEvery: () => undefined,
				tick: () => undefined,
				setVisible: () => undefined,
				dispose: () => {
					disposed.push(key);
					root.dispose();
				},
			};
		},
		blob: (key) => blob.createInstance(`blob-${key}`),
		load: async () => true,
		loadRobot: async () => true,
		dispose: () => undefined,
	};
}

const advisorActor = create(OfficeActorSchema, { id: "advisor", role: OfficeRole.ADVISOR, state: OfficeActorState.IDLE, enteredAt: BigInt(T0) });

function placementsFor(state: OfficeState, profile: OfficeAdvisor | null): readonly Placement[] {
	return officePlacement(state, layout(), T0, EMPTY_MEMORY, profile).placements;
}

describe("drawing Advisor again when its look changes", () => {
	it("redraws Advisor once the profile names another look, and nobody else", () => {
		const engine = new NullEngine();
		engines.push(engine);
		const scene = new Scene(engine);
		const pool = fakePool(scene);
		const people = createOfficePeople(layout(), createRouter(layout()), pool, () => undefined);
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), advisorActor]));
		const state = store.state();

		// The profile is not read yet: the default look.
		people.update(placementsFor(state, null), state, T0);
		const first = pool.drawn.find((d) => d.key === "advisor");
		expect(first?.look.accessory).toBe("glasses");
		const drawnBefore = pool.drawn.length;

		// The same look again: nothing is drawn again.
		people.update(placementsFor(state, { name: "Cố vấn", lookId: "owl" }), state, T0 + 1_000);
		expect(pool.drawn.length).toBe(drawnBefore);

		// The profile says cat: Advisor alone is taken down and drawn again in the cat's dress, at its seat.
		people.update(placementsFor(state, { name: "Mèo", lookId: "cat" }), state, T0 + 2_000);
		expect(pool.disposed).toEqual(["advisor"]);
		const again = pool.drawn.slice(drawnBefore);
		expect(again.map((d) => d.key)).toEqual(["advisor"]);
		expect(again[0]?.look.accessory).toBe("advisor-cat-ears");
		expect(people.views().find((v) => v.key === "advisor")?.target).toBe("meeting-0");
		people.dispose();
	});
});

describe("a person who arrives between frames", () => {
	it("knows from the last frame's view whether they are seen, before a frame of their own", () => {
		const engine = new NullEngine();
		engines.push(engine);
		const scene = new Scene(engine);
		const events: { event: string; inView: boolean }[] = [];
		const people = createOfficePeople(layout(), createRouter(layout()), fakePool(scene), (event, inView) => events.push({ event, inView }));
		const { store } = storeAt();
		store.applySnapshot(snapshot([director()]));
		const alone = store.state();
		people.update(placementsFor(alone, null), alone, T0);
		// The camera sees the whole plan.
		people.frame(0.016, 1, () => true, { x: 0, z: 0 });
		// Advisor arrives, then finishes a task before any frame has run since.
		store.applySnapshot(snapshot([director(), advisorActor]));
		const both = store.state();
		people.update(placementsFor(both, null), both, T0 + 1_000);
		const finished = placementsFor(both, null).map((p) => (p.key === "advisor" && p.actor !== null ? { ...p, actor: { ...p.actor, lastResult: { ok: true, at: T0 + 1_500 } } } : p));
		people.update(finished, both, T0 + 2_000);
		expect(events).toContainEqual({ event: "cheer", inView: true });
		people.dispose();
	});
});
