// Advisor in the 3D office: dressed by its look (the look's own skin cell
// once the atlas has it, else the nearest existing one; its accessory only
// when the asset file has a model for it, the owl's glasses made larger);
// talking at its seat while asked, the asker standing beside it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKS } from "../../src/advisor/looks.ts";
import type { Placement } from "../../src/machines/office/office-placement.ts";
import { poseFor, type PoseInput } from "../../src/office-3d/character/anim-groups.ts";
import { ADVISOR_DRESS, personLook, skinCellFor } from "../../src/office-3d/character/character-look.ts";
import { personIntent } from "../../src/office-3d/character/person-intent.ts";

/** The shipped asset file: the skin atlas's names and the accessories packed. */
const shipped = JSON.parse(readFileSync(resolve(process.cwd(), "public/office/office-assets.json"), "utf8")) as {
	character: { skins: { names: string[]; count: number } };
	accessories: { items: Record<string, unknown> };
};

const advisorAt = (lookId: string): Parameters<typeof personLook>[0] => ({ key: "advisor", kind: "advisor", actor: null, member: null, advisor: { name: "Cố vấn", lookId } });

describe("Advisor's dress", () => {
	it("has a dress for every look of the mascot, and an unknown look dresses as the first", () => {
		expect(Object.keys(ADVISOR_DRESS).sort()).toEqual(LOOKS.map((l) => l.id).sort());
		expect(personLook(advisorAt("dragon"))).toMatchObject({ accessory: "glasses", skins: ADVISOR_DRESS.owl.skins });
	});

	it("wears a skin the shipped atlas has (its own once made, the nearest colour meanwhile)", () => {
		const { names, count } = shipped.character.skins;
		for (const look of LOOKS) {
			const dress = personLook(advisorAt(look.id));
			const cell = skinCellFor(dress, count, names);
			expect(dress.skins).toContain(names[cell]);
			// Never the director's concept skin.
			expect(cell).toBeGreaterThan(0);
		}
		// The look's own cell is in the shipped atlas and wins over the nearest-colour one.
		for (const look of LOOKS) expect(names[skinCellFor(personLook(advisorAt(look.id)), count, names)]).toBe(`advisor-${look.id}`);
		// An atlas without the own cells falls back to the nearest colour.
		const plain = names.filter((n) => !n.startsWith("advisor-"));
		expect(plain[skinCellFor(personLook(advisorAt("cat")), plain.length, plain)]).toBe("mustard");
	});

	it("the owl wears the staff's glasses made larger; the other accessories come with the accessories GLB", () => {
		expect(personLook(advisorAt("owl"))).toMatchObject({ accessory: "glasses" });
		expect(personLook(advisorAt("owl")).accessoryScale).toBeGreaterThan(1);
		expect(Object.keys(shipped.accessories.items)).toContain("glasses");
		for (const look of ["robot", "suit", "cat"] as const) expect(personLook(advisorAt(look)).accessory).toMatch(/^advisor-/);
		// Employees keep theirs at their own size.
		expect(personLook({ key: "director", kind: "director", actor: null, member: null })).toMatchObject({ accessory: null, accessoryScale: 1, skins: [] });
	});
});

describe("asking Advisor in 3D", () => {
	const base: PoseInput = { moving: false, seated: false, group: null, idle: null, cheering: false, refused: false };

	it("Advisor talks seated at its seat, the asker talks standing", () => {
		expect(poseFor({ ...base, seated: true, group: "consult" })).toBe("sit-talk");
		expect(poseFor({ ...base, group: "consult" })).toBe("talk");
		expect(poseFor({ ...base, moving: true, group: "consult" })).toBe("walk");
	});

	it("the asker stands beside Advisor's seat; Advisor stays in it", () => {
		const consult = { id: "w1", tool: "mcp", group: "consult" as const, room: "MEETING" as const, subject: "", startedAt: 0, slow: false, stuckMs: null };
		const person = (key: string, kind: Placement["kind"]): Placement => ({
			key,
			kind,
			actor: {
				id: key,
				role: kind === "advisor" ? "advisor" : "director",
				agentType: "",
				description: "",
				parentId: "",
				spawnDepth: 0,
				state: "working",
				activity: consult,
				enteredAt: 0,
				doneAt: 0,
				heardAt: 0,
				approval: null,
				lastResult: null,
				service: null,
			},
			member: null,
			room: "MEETING",
			anchorId: "meeting-0",
			since: 0,
			activityRoom: "MEETING",
			life: null,
			advisor: null,
		});
		const ctx = { enabled: true, pantry: [], sofas: [], occupiedDesks: [] };
		expect(personIntent(person("director", "director"), [], 0, ctx)).toMatchObject({ anchorId: "meeting-0", beside: true });
		expect(personIntent(person("advisor", "advisor"), [], 0, ctx)).toMatchObject({ anchorId: "meeting-0", beside: false });
	});
});
