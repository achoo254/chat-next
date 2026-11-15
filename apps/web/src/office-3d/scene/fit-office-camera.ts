// Frames the office's isometric orthographic camera for any canvas shape.
// Pure math, no engine (shape of Chùa Nhỏ's fit-diorama-camera.ts). The
// layout's defaultCamera (yaw, pitch, target, a desktop and a phone view) is
// the same camera the 2D pictures were rendered with, so a wide canvas shows
// exactly what the desktop picture shows. A portrait phone starts on the six
// phone desks of the work room (plan: "phone portrait sees the six desks,
// drag for the rest"). The viewer may zoom, turn a little and pan within the
// floor; all of that stays inside the limits set here.
import type { LayoutCamera } from "../../machines/office/office-layout.ts";
import type { Rect } from "./scene-layout.ts";

export interface Vec3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

/** What the viewer did to the framing. */
export interface CameraUser {
	readonly zoom: number;
	/** Turn added to the default yaw, radians. */
	readonly yaw: number;
	/** Target shift on the floor, metres. */
	readonly panX: number;
	readonly panZ: number;
}

export const NO_USER: CameraUser = { zoom: 1, yaw: 0, panX: 0, panZ: 0 };
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 3.2;
/** How far the viewer may turn the building either way, radians (about 26°). */
export const YAW_RANGE = 0.45;
/** Distance of the orthographic camera from its target (only depth sorting depends on it). */
export const CAMERA_DISTANCE = 60;

export interface BaseFraming {
	readonly target: Vec3;
	/** Height of the view in metres at zoom 1. */
	readonly orthoHeight: number;
}

export interface OfficeFrame {
	readonly target: Vec3;
	readonly position: Vec3;
	readonly halfWidth: number;
	readonly halfHeight: number;
	/** Radians. */
	readonly yaw: number;
	readonly pitch: number;
}

const RAD = Math.PI / 180;
/** A portrait canvas narrower than this starts on the phone desks. */
export const PORTRAIT_ASPECT = 0.8;
/** A canvas at least this wide frames like the desktop picture. */
export const WIDE_ASPECT = 1.2;
const FOCUS_MARGIN = 1.12;

const safeAspect = (aspect: number): number => (Number.isFinite(aspect) && aspect > 0 ? aspect : 1);

/** Screen right and up (metres on a zoom-1 view) of a point relative to the target, for a yaw and pitch in radians. */
export function screenOffset(yaw: number, pitch: number, dx: number, dy: number, dz: number): { right: number; up: number } {
	const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
	const depth = dx * Math.sin(yaw) + dz * Math.cos(yaw);
	return { right, up: dy * Math.cos(pitch) + depth * Math.sin(pitch) };
}

/**
 * The framing before the viewer touches anything: the desktop picture's
 * frame on a wide canvas, the phone picture's on a squarish one, the phone
 * desks (`focus`, a floor rectangle) on a portrait one.
 */
export function baseFraming(camera: LayoutCamera, aspect: number, focus: Rect | null): BaseFraming {
	const a = safeAspect(aspect);
	const target = { x: camera.target[0], y: camera.target[1], z: camera.target[2] };
	if (a < PORTRAIT_ASPECT && focus !== null) {
		const yaw = camera.yaw * RAD;
		const pitch = camera.pitch * RAD;
		const [x0, z0, x1, z1] = focus;
		const centre = { x: (x0 + x1) / 2, y: 0.75, z: (z0 + z1) / 2 };
		let right = 0;
		let up = 0;
		for (const x of [x0, x1]) {
			for (const z of [z0, z1]) {
				for (const y of [0, 1.5]) {
					const o = screenOffset(yaw, pitch, x - centre.x, y - centre.y, z - centre.z);
					right = Math.max(right, Math.abs(o.right));
					up = Math.max(up, Math.abs(o.up));
				}
			}
		}
		return { target: centre, orthoHeight: Math.max(2 * up, (2 * right) / a) * FOCUS_MARGIN };
	}
	const view = a >= WIDE_ASPECT ? camera.views.desktop : camera.views.phone;
	const contentWidth = view.orthoHeight * view.aspect;
	return { target, orthoHeight: Math.max(view.orthoHeight, contentWidth / a) };
}

export function clampUser(user: CameraUser): CameraUser {
	const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
	return {
		zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, finite(user.zoom, 1))),
		yaw: Math.max(-YAW_RANGE, Math.min(YAW_RANGE, finite(user.yaw, 0))),
		panX: finite(user.panX, 0),
		panZ: finite(user.panZ, 0),
	};
}

/** The pan that keeps the target inside the floor's footprint. */
export function clampPan(base: BaseFraming, user: CameraUser, footprint: Rect): CameraUser {
	const [x0, z0, x1, z1] = footprint;
	const x = Math.max(x0, Math.min(x1, base.target.x + user.panX));
	const z = Math.max(z0, Math.min(z1, base.target.z + user.panZ));
	return { ...user, panX: x - base.target.x, panZ: z - base.target.z };
}

/** The camera for a base framing and what the viewer did; `lift` raises the target (the floor-change glide). */
export function frameOffice(camera: LayoutCamera, aspect: number, base: BaseFraming, user: CameraUser, lift = 0): OfficeFrame {
	const a = safeAspect(aspect);
	const u = clampUser(user);
	const yaw = camera.yaw * RAD + u.yaw;
	const pitch = camera.pitch * RAD;
	const target = { x: base.target.x + u.panX, y: base.target.y + lift, z: base.target.z + u.panZ };
	const ground = Math.cos(pitch) * CAMERA_DISTANCE;
	const position = { x: target.x - Math.sin(yaw) * ground, y: target.y + Math.sin(pitch) * CAMERA_DISTANCE, z: target.z - Math.cos(yaw) * ground };
	const halfHeight = base.orthoHeight / 2 / u.zoom;
	return { target, position, halfHeight, halfWidth: halfHeight * a, yaw, pitch };
}

/**
 * The floor shift for a drag of (dx, dy) CSS pixels on a canvas `height`
 * pixels tall: the building follows the finger. Screen up on the floor is
 * foreshortened by the pitch.
 */
export function dragToPan(frame: OfficeFrame, height: number, dx: number, dy: number): { x: number; z: number } {
	const metres = (2 * frame.halfHeight) / Math.max(1, height);
	const right = -dx * metres;
	const forward = (dy * metres) / Math.max(0.2, Math.sin(frame.pitch));
	return {
		x: right * Math.cos(frame.yaw) + forward * Math.sin(frame.yaw),
		z: -right * Math.sin(frame.yaw) + forward * Math.cos(frame.yaw),
	};
}
