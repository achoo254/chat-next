// The layout's scene parts and the 3D part of the asset file.
import { describe, expect, it } from "vitest";
import { layoutHash } from "../../src/machines/office/office-assets.ts";
import { lightmapPair, NO_SCENE_ASSETS, parseSceneAssets } from "../../src/office-3d/scene/scene-assets.ts";
import { parseSceneLayout, SCENE_LAYOUT, segmentsMinusDoors, type Door } from "../../src/office-3d/scene/scene-layout.ts";
import { PROP_SHAPES } from "../../src/office-3d/scene/placeholder-shapes.ts";

describe("scene layout", () => {
	it("reads all three floors of the shipped layout with their glass, doors and furniture", () => {
		expect(SCENE_LAYOUT.floors.map((f) => f.level)).toEqual([1, 2, 3]);
		for (const floor of SCENE_LAYOUT.floors) {
			expect(floor.rooms.length, `floor ${floor.level}`).toBeGreaterThan(0);
			expect(floor.glass.length).toBeGreaterThan(0);
			expect(floor.doors.length).toBeGreaterThan(0);
			expect(floor.props.length).toBeGreaterThan(0);
		}
		expect(SCENE_LAYOUT.wallHeight).toBeGreaterThan(2);
	});

	it("has a placeholder shape for every furniture and small-prop name of the layout", () => {
		const names = new Set(SCENE_LAYOUT.floors.flatMap((f) => [...f.props, ...f.smallProps].map((p) => p.name)));
		const missing = [...names].filter((n) => PROP_SHAPES[n] === undefined);
		expect(missing).toEqual([]);
	});

	it("reads a broken or empty file as an empty building instead of throwing", () => {
		const empty = parseSceneLayout(null);
		expect(empty.floors).toEqual([]);
		expect(empty.footprint).toHaveLength(4);
		const odd = parseSceneLayout({ floors: [{ level: 1, glass: [[0, 0, 1], "x"], props: [{ name: "desk" }], rooms: [{ room: "NOPE", rect: [0, 0, 1, 1] }] }] });
		expect(odd.floors[0]).toMatchObject({ glass: [], props: [], rooms: [] });
	});

	it("cuts doorways out of a wall run along its axis, and leaves other runs alone", () => {
		const doors: Door[] = [
			{ id: "a", at: [0, -5], width: 1.6, axis: "x" },
			{ id: "b", at: [6, -5], width: 1, axis: "x" },
			{ id: "side", at: [-4.5, 0], width: 1, axis: "z" },
		];
		expect(segmentsMinusDoors([-4.5, -5, 9, -5], doors)).toEqual([
			[-4.5, -5, -0.8, -5],
			[0.8, -5, 5.5, -5],
			[6.5, -5, 9, -5],
		]);
		expect(segmentsMinusDoors([-4.5, -5, -4.5, 5], doors)).toEqual([
			[-4.5, -5, -4.5, -0.5],
			[-4.5, 0.5, -4.5, 5],
		]);
		expect(segmentsMinusDoors([0, 0, 3, 3], doors)).toEqual([[0, 0, 3, 3]]);
	});
});

describe("scene assets", () => {
	const hash = "abc";
	const file = {
		formatVersion: 1,
		layoutSha256: hash,
		floors: [
			{ level: 1, shell: "office-floor-1.1a2b.glb", lightmaps: { day: { 1024: "lm-1-day-1024.webp", 2048: "lm-1-day-2048.webp" }, night: { 1024: "lm-1-night-1024.webp" } } },
			{ level: 2, shell: "../secret.glb", lightmaps: {} },
			{ level: 7, shell: "x.glb" },
		],
		props: { desk: "prop-desk.9f.glb", "Bad Name": "x.glb", chair: "../../etc" },
		character: { model: "character.77.glb", skins: ["skin-a.webp", "../no.webp"] },
		sounds: { cheer: "sfx/cheer.mp3" },
	};

	it("reads shells, lightmaps, furniture, the character and sounds, refusing paths that climb out", () => {
		const assets = parseSceneAssets(file, hash);
		expect(assets.floors.get(1)?.shell).toBe("office-floor-1.1a2b.glb");
		expect(assets.floors.get(2)?.shell).toBeNull();
		expect(assets.floors.has(3)).toBe(false);
		expect([...assets.props]).toEqual([["desk", "prop-desk.9f.glb"]]);
		expect(assets.character).toEqual({ model: "character.77.glb", skins: ["skin-a.webp"] });
		expect(assets.sounds.get("cheer")).toBe("sfx/cheer.mp3");
	});

	it("picks the lightmap size asked for, else the other one, and needs both times of day", () => {
		const floor = parseSceneAssets(file, hash).floors.get(1);
		if (floor === undefined) throw new Error("floor 1 missing");
		expect(lightmapPair(floor, 2048)).toEqual({ day: "lm-1-day-2048.webp", night: "lm-1-night-1024.webp" });
		expect(lightmapPair(floor, 1024)).toEqual({ day: "lm-1-day-1024.webp", night: "lm-1-night-1024.webp" });
		expect(lightmapPair({ shell: null, lightmaps: { day: { 1024: "d" }, night: {} } }, 1024)).toBeNull();
	});

	it("uses nothing from a file baked for another layout or of another version", () => {
		expect(parseSceneAssets(file, "other")).toBe(NO_SCENE_ASSETS);
		expect(parseSceneAssets({ ...file, formatVersion: 2 }, hash)).toBe(NO_SCENE_ASSETS);
		expect(parseSceneAssets("nope", hash)).toBe(NO_SCENE_ASSETS);
	});

	it("checks against the hash of the shipped layout", async () => {
		const shipped = await layoutHash();
		expect(parseSceneAssets({ ...file, layoutSha256: shipped }, shipped).floors.size).toBe(2);
	});
});
