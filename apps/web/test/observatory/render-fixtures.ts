// The Live Map's shipped asset table and scene table (public/observatory), read
// as the renderer reads them, and a state built from events through the real
// reducer, with the animations it queued.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyEvents, fromSnapshot, takeAnimations, type Animation, type LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../src/machines/observatory/live-map-types.ts";
import { ASSET_TABLE_FILE, parseAssetTable, parseSceneTable, type SceneAssets } from "../../src/machines/observatory/render/scene-table.ts";
import { numbered, snapshot } from "../machines/observatory/live-map-fixtures.ts";

/** Tests run from apps/web. */
export const PUBLIC_DIR = `${resolve(process.cwd(), "public/observatory")}/`;

export function readJson(name: string): unknown {
	return JSON.parse(readFileSync(PUBLIC_DIR + name, "utf8"));
}

export function shippedAssets(): SceneAssets {
	const table = parseAssetTable(readJson(ASSET_TABLE_FILE));
	return { base: "/observatory/", table, scene: parseSceneTable(readJson(table.scene)) };
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
