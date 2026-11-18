// Small pieces office-world.ts needs: what the camera frames by (the plan's
// footprint, the rectangle a portrait phone frames as `work`: the six phone
// desks of the work room with chairs and desks around them, the work zone
// other canvases frame as `work`, and the most of the plan a portrait phone
// may show: the work zone and the zone stacked behind it), and
// window.__office, the read-out tests and on-device measurement use (only
// when the address asks for it).
import type { OfficeLayout, Rect as LayoutRect } from "../machines/office/office-layout.ts";
import type { VisualProbe } from "./character/character-visual.ts";
import type { FrameSummary } from "./engine/frame-stats.ts";
import type { CameraPlan } from "./scene/fit-office-camera.ts";
import type { Rect } from "./scene/scene-layout.ts";

/** Around each desk anchor (the chair): the desk in front, room to pull the chair back. */
const DESK_REACH = 1.1;

export function phoneDeskFocus(layout: OfficeLayout): Rect | null {
	const desks = layout.phoneDeskOrder.flatMap((id) => layout.anchors.find((a) => a.id === id) ?? []);
	if (desks.length === 0) return null;
	const xs = desks.map((d) => d.x);
	const zs = desks.map((d) => d.z);
	return [Math.min(...xs) - DESK_REACH, Math.min(...zs) - DESK_REACH, Math.max(...xs) + DESK_REACH, Math.max(...zs) + DESK_REACH];
}

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) > Math.max(a0, b0);

/** The work zone: the one holding the phone desks (undefined when the layout has none). */
function workZoneOf(layout: OfficeLayout): OfficeLayout["zones"][number] | undefined {
	const desk = layout.anchors.find((a) => a.id === layout.phoneDeskOrder[0]);
	const room = layout.rooms.find((r) => r.room === desk?.room);
	return layout.zones.find((z) => z.id === room?.zone);
}

/** The work zone's rectangle, what the `work` framing shows on a canvas that is not portrait. */
export function workZoneRect(layout: OfficeLayout): Rect | null {
	return workZoneOf(layout)?.rect ?? null;
}

/**
 * The work zone and the zone stacked behind or in front of it in the same
 * column, as one rectangle: a portrait canvas is tall, so a column of two
 * zones is what it can show at once.
 */
export function portraitReach(layout: OfficeLayout): Rect | null {
	const work = workZoneOf(layout);
	if (work === undefined) return null;
	const [x0, z0, x1, z1] = work.rect;
	const centre = (r: LayoutRect): number => (r[1] + r[3]) / 2;
	const partner = layout.zones
		.filter((z) => z.id !== work.id && overlaps(x0, x1, z.rect[0], z.rect[2]))
		.sort((a, b) => Math.abs(centre(a.rect) - centre(work.rect)) - Math.abs(centre(b.rect) - centre(work.rect)))[0];
	if (partner === undefined) return work.rect;
	const [px0, pz0, px1, pz1] = partner.rect;
	return [Math.min(x0, px0), Math.min(z0, pz0), Math.max(x1, px1), Math.max(z1, pz1)];
}

/** Everything the camera frames by, from the layout. */
export function cameraPlan(layout: OfficeLayout, footprint: Rect): CameraPlan {
	return { camera: layout.camera, footprint, workFocus: phoneDeskFocus(layout), workZone: workZoneRect(layout), portraitReach: portraitReach(layout) };
}

export interface OfficeTestReadout {
	readonly backend: string;
	readonly quality: string;
	/** The viewer's zoom (1 = the `work` framing; below 1 shows more of the plan). */
	readonly zoom: number;
	/** CSS pixels a metre takes on the canvas now (below the detail threshold small props hide and idle labels shrink). */
	readonly pixelsPerMetre: number;
	/** People on the canvas whose label shows as a dot now. */
	readonly dots: number;
	readonly drawCalls: number;
	/** The ring under the person whose panel is open is drawn. */
	readonly selectionRing: boolean;
	/** Frames drawn since start (stops growing when the loop pauses). */
	readonly frames: number;
	readonly fps: number;
	readonly stats: FrameSummary;
	/** The viewer's zoom (1 = the `work` framing) and turn off the default yaw, radians. */
	readonly camera: { readonly zoom: number; readonly yaw: number };
	readonly people: readonly { readonly key: string; readonly x: number; readonly z: number; readonly visible: boolean; readonly target: string; readonly pose: string; readonly model: string; readonly dozing: boolean; readonly heading: number; readonly head: { readonly x: number; readonly z: number } | null; readonly probe: VisualProbe | null; readonly screen: readonly [number, number] | null }[];
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
