// Small pieces office-world.ts needs: the floor rectangle a portrait phone
// starts on (the six phone desks of the work room, chairs and desks around
// them), and window.__office, the read-out tests and on-device measurement
// use (only when the address asks for it).
import type { OfficeLayout } from "../machines/office/office-layout.ts";
import type { FrameSummary } from "./engine/frame-stats.ts";
import type { Rect } from "./scene/scene-layout.ts";

/** Around each desk anchor (the chair): the desk in front, room to pull the chair back. */
const DESK_REACH = 1.1;

export function phoneDeskFocus(layout: OfficeLayout): Rect | null {
	const first = layout.floors.find((f) => f.level === 1);
	const desks = (first?.phoneDeskOrder ?? []).flatMap((id) => first?.anchors.find((a) => a.id === id) ?? []);
	if (desks.length === 0) return null;
	const xs = desks.map((d) => d.x);
	const zs = desks.map((d) => d.z);
	return [Math.min(...xs) - DESK_REACH, Math.min(...zs) - DESK_REACH, Math.max(...xs) + DESK_REACH, Math.max(...zs) + DESK_REACH];
}

export interface OfficeTestReadout {
	readonly backend: string;
	readonly quality: string;
	readonly floor: number;
	readonly drawCalls: number;
	/** Frames drawn since start (stops growing when the loop pauses). */
	readonly frames: number;
	readonly fps: number;
	readonly stats: FrameSummary;
	readonly people: readonly { readonly key: string; readonly floor: number; readonly x: number; readonly z: number; readonly visible: boolean; readonly target: string; readonly pose: string; readonly screen: readonly [number, number] | null }[];
	resetStats(): void;
}

export interface OfficeTestApi {
	readonly ready: true;
	read(): OfficeTestReadout;
}

declare global {
	interface Window {
		__office?: OfficeTestApi;
	}
}

export function exposeTestApi(read: () => OfficeTestReadout): () => void {
	const api: OfficeTestApi = { ready: true, read };
	window.__office = api;
	return () => {
		if (window.__office === api) delete window.__office;
	};
}
