// The Live Map's scene table (format 2) and asset table: read and checked as
// the renderer does (13 places, every rect and point on the plate, tiers,
// frame names, plain file names only, clear errors otherwise); the plate
// chosen by MAX_TEXTURE_SIZE, frame width and save-data; points projected
// into the frame and back; a click found in a district's rect, the drones'
// area as an ellipse around the core's base.
import { describe, expect, it, vi } from "vitest";
import {
	ASSET_TABLE_FILE,
	choosePlate,
	fitScene,
	loadSceneAssets,
	parseAssetTable,
	parseSceneTable,
	PLACE_IDS,
	placeAt,
	project,
	unproject,
} from "../../src/machines/observatory/render/scene-table.ts";
import { assetJson, fixtureFile, fixtureScene, fixtureTable, SCENE_FILE, sceneJson } from "./render-fixtures.ts";

type Raw = { places: { id: string; rect: number[]; label: number[]; tier: unknown; sprite: unknown; route: unknown }[] } & Record<string, unknown>;
const raw = (): Raw => structuredClone(sceneJson()) as Raw;

describe("the scene table", () => {
	it("reads all 13 places with their rect, tier, frame, label and road", () => {
		const scene = fixtureScene();
		expect(Object.keys(scene.places).sort()).toEqual([...PLACE_IDS].sort());
		expect(scene.space).toEqual({ width: 2400, height: 1440 });
		for (const id of PLACE_IDS) {
			const p = scene.places[id];
			expect(p.rect.w).toBeGreaterThan(0);
			expect([1, 2, 3]).toContain(p.tier);
			expect(p.sprite).toMatch(/^[a-z0-9-]+$/);
		}
		expect(scene.places.files.route.length).toBeGreaterThanOrEqual(2);
		expect(scene.places.core.route).toEqual([]);
		expect(scene.core.radius).toBeGreaterThan(0);
	});

	it("loads both tables through fetch", async () => {
		const fetcher = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(fixtureFile(url.slice("/observatory/".length))))));
		const assets = await loadSceneAssets("/observatory/", fetcher as unknown as typeof fetch);
		expect(fetcher.mock.calls.map(([u]) => u)).toEqual([`/observatory/${ASSET_TABLE_FILE}`, `/observatory/${SCENE_FILE}`]);
		expect(assets.scene.places.core.label).toEqual(fixtureScene().places.core.label);
	});

	it("fails on an answer that is not 200", async () => {
		const fetcher = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
		await expect(loadSceneAssets("/observatory/", fetcher as unknown as typeof fetch)).rejects.toThrow(/404/);
	});

	it("refuses the old format 1 table, a missing place, a rect or point off the plate, a bad tier or frame name", () => {
		expect(() => parseSceneTable({ ...raw(), formatVersion: 1 })).toThrow(/format 1 is not 2/);
		const r = raw();
		expect(() => parseSceneTable({ ...r, places: r.places.filter((p) => p.id !== "monitoring") })).toThrow(/places missing: monitoring/);
		const off = raw();
		const first = off.places[0];
		if (first !== undefined) first.rect = [2300, 10, 200, 10];
		expect(() => parseSceneTable(off)).toThrow(/rect is outside the plate/);
		const label = raw();
		if (label.places[1] !== undefined) label.places[1].label = [9_999, 10];
		expect(() => parseSceneTable(label)).toThrow(/label is outside the plate/);
		const tier = raw();
		if (tier.places[0] !== undefined) tier.places[0].tier = 4;
		expect(() => parseSceneTable(tier)).toThrow(/tier is not 1, 2 or 3/);
		const frame = raw();
		if (frame.places[0] !== undefined) frame.places[0].sprite = "../x";
		expect(() => parseSceneTable(frame)).toThrow(/sprite is not a frame name/);
		const road = raw();
		if (road.places[3] !== undefined) road.places[3].route = [[10, 10]];
		expect(() => parseSceneTable(road)).toThrow(/route has a single point/);
		expect(() => parseSceneTable({ ...raw(), core: undefined })).toThrow(/core is missing/);
	});

	it("refuses an asset file name that is a path or a URL, and another asset format", () => {
		for (const scene of ["../secret.json", "https://elsewhere/x.json", "a/b.json", ".hidden"]) expect(() => parseAssetTable({ ...assetJson(), scene })).toThrow(/file name/);
		expect(() => parseAssetTable({ ...assetJson(), formatVersion: 2 })).toThrow(/format/);
	});
});

describe("choosing the plate", () => {
	const table = fixtureTable();
	it("takes the full plate only when the GPU takes it, the frame is wide and data is not saved", () => {
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 1200, saveData: false })).toBe(table.plate.full);
		expect(choosePlate(table, { maxTextureSize: 2400, frameWidth: 900, saveData: false })).toBe(table.plate.full);
		expect(choosePlate(table, { maxTextureSize: 2048, frameWidth: 1200, saveData: false })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 899, saveData: false })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 1200, saveData: true })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: null, frameWidth: 1200, saveData: false })).toBe(table.plate.full);
	});
});

describe("projecting and hitting", () => {
	const space = { width: 2400, height: 1440 };
	it("fits the scene whole and centred, and maps points both ways", () => {
		const tall = fitScene(space, { width: 600, height: 900 });
		expect(tall.scale).toBe(0.25);
		expect(project([1200, 720], tall)).toEqual({ x: 300, y: 450 });
		const back = unproject(300, 450, tall);
		expect(back[0]).toBeCloseTo(1200);
		expect(back[1]).toBeCloseTo(720);
		expect(fitScene(space, { width: 0, height: 500 }).scale).toBe(0);
	});

	it("finds a district by its rect, and the drones' area around the core's base", () => {
		const scene = fixtureScene();
		const r = scene.places.files.rect;
		expect(placeAt(scene, [r.x + r.w / 2, r.y + r.h / 2])).toBe("files");
		const s = scene.places.security.rect;
		expect(placeAt(scene, [s.x + 2, s.y + 2])).toBe("security");
		expect(placeAt(scene, [2399, 1439])).toBeNull();
		const [cx, cy] = scene.core.centre;
		const [rx] = scene.core.orbit;
		// On the drones' ellipse, right of the tower and in no district's rect.
		expect(placeAt(scene, [cx + rx * 0.9, cy])).toBe("orchestrator");
		expect(placeAt(scene, [cx + rx * 1.2, cy - 400])).not.toBe("orchestrator");
	});
});
