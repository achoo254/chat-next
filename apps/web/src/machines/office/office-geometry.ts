// What the views ask of the layout: the zone of a room, the desk order of a
// screen size, the places to stand in a room, and the projection of the
// default isometric camera onto a picture (the 2D pictures are rendered with
// this camera, so a point of the plan lands at the same percent of the
// picture the asset file lists; the test fixture is made with it).
import { SPOT_KINDS, type CameraView, type LayoutAnchor, type LayoutCamera, type OfficeLayout, type ZoneId } from "./office-layout.ts";
import type { RoomCode } from "./office-rooms.ts";

export type ScreenSize = "desktop" | "phone";

/** The zone `room` is in (the checked layout puts every room in one; "a" for a room it does not have). */
export function zoneOfRoom(layout: OfficeLayout, room: RoomCode): ZoneId {
	return layout.rooms.find((r) => r.room === room)?.zone ?? "a";
}

export function anchorById(layout: OfficeLayout, id: string): LayoutAnchor | undefined {
	return layout.anchors.find((a) => a.id === id);
}

/** The home desks in the order employees take them: the file's order on a wide screen, the phone order on a phone. */
export function deskOrder(layout: OfficeLayout, size: ScreenSize): readonly string[] {
	return size === "phone" ? layout.phoneDeskOrder : layout.anchors.filter((a) => a.kind === "desk" && a.room === "WORK").map((a) => a.id);
}

/** Places to stand while working in `room`, in the file's order. */
export function spotsOf(layout: OfficeLayout, room: RoomCode): readonly LayoutAnchor[] {
	return layout.anchors.filter((a) => a.room === room && SPOT_KINDS.includes(a.kind));
}

/** The first anchor of `kind` in `room` (the director's chair, the chairman's spot, a board). */
export function anchorOfKind(layout: OfficeLayout, room: RoomCode, kind: LayoutAnchor["kind"]): LayoutAnchor | undefined {
	return layout.anchors.find((a) => a.room === room && a.kind === kind);
}

const RAD = Math.PI / 180;

/**
 * Where a point of the plan (metres) lands on a picture taken by the
 * default camera, in percent of its width and height from the top left.
 * Orthographic: the camera looks at `target` from `yaw` degrees around the
 * vertical (0 from the lobby side, looking at the back wall) and `pitch`
 * degrees above the floor.
 */
export function projectPoint(camera: LayoutCamera, view: CameraView, x: number, y: number, z: number): readonly [number, number] {
	const yaw = camera.yaw * RAD;
	const pitch = camera.pitch * RAD;
	const dx = x - camera.target[0];
	const dy = y - camera.target[1];
	const dz = z - camera.target[2];
	// Screen right lies on the floor plane; screen up tilts back with the pitch.
	const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
	const depth = dx * Math.sin(yaw) + dz * Math.cos(yaw);
	const up = dy * Math.cos(pitch) + depth * Math.sin(pitch);
	const width = view.orthoHeight * view.aspect;
	return [50 + (100 * right) / width, 50 - (100 * up) / view.orthoHeight];
}
