// The Live Map's scene as tests use it (the machine's interior, laid out in
// code), and a state built from events through the real reducer, with the
// animations it queued.
import { applyEvents, fromSnapshot, takeAnimations, type Animation, type LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../src/machines/observatory/live-map-types.ts";
import { INTERIOR, type SceneTable } from "../../src/machines/observatory/render/scene-table.ts";
import { numbered, snapshot } from "../machines/observatory/live-map-fixtures.ts";

export function fixtureScene(): SceneTable {
	return INTERIOR;
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
