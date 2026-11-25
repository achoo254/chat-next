// The Live Map's assets as tests use them: a fixture asset table and the
// scene table (format 2) in fixtures/, never the shipped public folder (its
// art changes on its own schedule), read as the renderer reads them; a
// fixture spritesheet naming the atlas frames; and a state built from events
// through the real reducer, with the animations it queued.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyEvents, fromSnapshot, takeAnimations, type Animation, type LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../src/machines/observatory/live-map-types.ts";
import { parseAssetTable, parseSceneTable, type AssetTable, type SceneAssets, type SceneTable } from "../../src/machines/observatory/render/scene-table.ts";
import { numbered, snapshot } from "../machines/observatory/live-map-fixtures.ts";

export const SCENE_FILE = "live-map-scene.test.json";
export const SHEET_FILE = "observatory-city.test.json";

/** The scene table fixture as JSON (a copy of tools/observatory-art/scene/live-map-scene.json); tests run from apps/web. */
export function sceneJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(resolve(process.cwd(), "test/observatory/fixtures/live-map-scene.json"), "utf8")) as Record<string, unknown>;
}

/** Frames the fixture atlas holds. */
export const FRAMES = ["lit-core", "lit-files", "lit-sandbox", "lit-testing", "lit-monitoring", "lit-security", "core-halo", "context-fill", "holo-panel", "portal-swirl", "drone", "packet", "glow"];

export function assetJson(): Record<string, unknown> {
	return {
		formatVersion: 1,
		space: { width: 2400, height: 1440 },
		plate: { full: { file: "plate-2400.test.webp", width: 2400, height: 1440 }, half: { file: "plate-1200.test.webp", width: 1200, height: 720 } },
		scene: SCENE_FILE,
		atlases: [{ name: "city", sheet: SHEET_FILE, image: "observatory-city.test.webp", sprites: FRAMES }],
	};
}

/** A PixiJS spritesheet JSON for the fixture atlas. */
export function sheetJson(): Record<string, unknown> {
	const frames = Object.fromEntries(FRAMES.map((name, i) => [name, { frame: { x: i * 10, y: 0, w: 10, h: 10 }, sourceSize: { w: 10, h: 10 } }]));
	return { frames, meta: { size: { w: 200, h: 10 }, scale: 1 } };
}

/** A fixture file by name, as the page's server would answer. */
export function fixtureFile(name: string): unknown {
	if (name === SCENE_FILE) return sceneJson();
	if (name === SHEET_FILE) return sheetJson();
	if (name === "observatory-assets.json") return assetJson();
	throw new Error(`no fixture ${name}`);
}

export function fixtureScene(): SceneTable {
	return parseSceneTable(sceneJson());
}

export function fixtureTable(): AssetTable {
	return parseAssetTable(assetJson());
}

export function fixtureAssets(): SceneAssets {
	return { base: "/observatory/", table: fixtureTable(), scene: fixtureScene() };
}

/** `events` applied live one frame each after an empty snapshot; each frame's animations kept in order. */
export function played(events: readonly LiveMapEvent[]): { state: LiveMapState; animations: Animation[]; perEvent: Animation[][] } {
	let state = fromSnapshot(snapshot([]));
	const perEvent: Animation[][] = [];
	for (const e of numbered(events)) {
		state = applyEvents(state, state.epoch, [e]).state;
		const [taken, rest] = takeAnimations(state);
		perEvent.push([...taken]);
		state = rest;
	}
	return { state, animations: perEvent.flat(), perEvent };
}
