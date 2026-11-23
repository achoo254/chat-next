// The Live Map's shipped assets: the asset table and scene table in
// public/observatory read and checked as the renderer does (13 places, every
// point on the plate, plain file names only); the plate chosen by
// MAX_TEXTURE_SIZE, frame width and save-data; anchors projected into the
// frame and back; clicks inside a place's outline.
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	ASSET_TABLE_FILE,
	choosePlate,
	fitScene,
	insidePolygon,
	loadSceneAssets,
	parseAssetTable,
	parseSceneTable,
	PLACE_IDS,
	project,
	unproject,
} from "../../src/machines/observatory/render/scene-table.ts";
import { PUBLIC_DIR, readJson, shippedAssets } from "./render-fixtures.ts";

describe("the shipped assets", () => {
	it("name only files that exist, and a scene of all 13 places", () => {
		const { table, scene } = shippedAssets();
		for (const file of [table.plate.full.file, table.plate.half.file, table.scene, ...table.atlases.flatMap((a) => [a.sheet, a.image])]) expect(existsSync(PUBLIC_DIR + file)).toBe(true);
		expect(Object.keys(scene.places).sort()).toEqual([...PLACE_IDS].sort());
		expect(table.plate.full).toMatchObject({ width: 2560, height: 1920 });
		expect(table.plate.half).toMatchObject({ width: 1280, height: 960 });
	});

	it("loads both tables through fetch", async () => {
		const fetcher = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(readJson(url.slice("/observatory/".length))))));
		const assets = await loadSceneAssets("/observatory/", fetcher as unknown as typeof fetch);
		expect(fetcher.mock.calls.map(([u]) => u)).toEqual([`/observatory/${ASSET_TABLE_FILE}`, `/observatory/${assets.table.scene}`]);
		expect(assets.scene.places.core.label).toEqual(shippedAssets().scene.places.core.label);
	});

	it("fails on an answer that is not 200", async () => {
		const fetcher = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
		await expect(loadSceneAssets("/observatory/", fetcher as unknown as typeof fetch)).rejects.toThrow(/404/);
	});
});

describe("checking the tables", () => {
	const table = (): Record<string, unknown> => structuredClone(readJson(ASSET_TABLE_FILE)) as Record<string, unknown>;

	it("refuses a file name that is a path or a URL", () => {
		for (const scene of ["../secret.json", "https://elsewhere/x.json", "a/b.json", ".hidden"]) expect(() => parseAssetTable({ ...table(), scene })).toThrow(/file name/);
	});

	it("refuses another format", () => {
		expect(() => parseAssetTable({ ...table(), formatVersion: 2 })).toThrow(/format/);
	});

	it("refuses a scene missing a place or with a point off the plate", () => {
		const raw = structuredClone(readJson(shippedAssets().table.scene)) as { stations: { id: string; label: number[] }[] };
		expect(() => parseSceneTable({ ...raw, stations: raw.stations.filter((s) => s.id !== "monitoring") })).toThrow(/monitoring/);
		const off = structuredClone(raw);
		const first = off.stations[0];
		if (first !== undefined) first.label = [9_999, 10];
		expect(() => parseSceneTable(off)).toThrow(/outside the plate/);
	});
});

describe("choosing the plate", () => {
	const { table } = shippedAssets();
	it("takes the 2560 plate only when the GPU takes it, the frame is wide and data is not saved", () => {
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 1200, saveData: false })).toBe(table.plate.full);
		expect(choosePlate(table, { maxTextureSize: 2560, frameWidth: 900, saveData: false })).toBe(table.plate.full);
		expect(choosePlate(table, { maxTextureSize: 2048, frameWidth: 1200, saveData: false })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 899, saveData: false })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: 4096, frameWidth: 1200, saveData: true })).toBe(table.plate.half);
		expect(choosePlate(table, { maxTextureSize: null, frameWidth: 1200, saveData: false })).toBe(table.plate.full);
	});
});

describe("projecting anchors", () => {
	const space = { width: 2560, height: 1920 };
	it("fits the plate whole and centred, and maps points both ways", () => {
		const wide = fitScene(space, { width: 1000, height: 500 });
		expect(wide.scale).toBeCloseTo(500 / 1920);
		expect(wide.offsetY).toBeCloseTo(0);
		expect(wide.offsetX).toBeCloseTo((1000 - 2560 * wide.scale) / 2);
		const tall = fitScene(space, { width: 640, height: 900 });
		expect(tall.scale).toBe(0.25);
		expect(project([1280, 960], tall)).toEqual({ x: 320, y: 450 });
		expect(project([0, 0], tall)).toEqual({ x: 0, y: tall.offsetY });
		const back = unproject(320, 450, tall);
		expect(back[0]).toBeCloseTo(1280);
		expect(back[1]).toBeCloseTo(960);
		expect(fitScene(space, { width: 0, height: 500 }).scale).toBe(0);
	});

	it("tells a point inside a place's outline", () => {
		const { scene } = shippedAssets();
		expect(insidePolygon([1280, 1000], scene.places.core.hit)).toBe(true);
		expect(insidePolygon([10, 10], scene.places.core.hit)).toBe(false);
	});
});
