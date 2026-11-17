// Frames the office's isometric orthographic camera for any canvas shape.
// Pure math, no engine (shape of Chùa Nhỏ's fit-diorama-camera.ts). The
// layout's defaultCamera (yaw, pitch, target, a desktop and a phone view) is
// the same camera the 2D picture was rendered with and frames the whole plan,
// so a wide canvas's overview shows exactly what the desktop picture shows.
// Two framings a viewer can ask for: `work` (the six phone desks of the work
// room on a portrait phone, the whole work zone elsewhere) and `overview`, the
// most of the plan the screen may show at once (the whole plan; on a portrait
// phone the work zone and the zone stacked behind it, which is as far out as a
// phone stays under its draw-call budget). The viewer may zoom, turn a little
// and pan within the plan; all of that stays inside the limits set here. The
// zoom is relative to the `work` framing.
import type { LayoutCamera } from "../../machines/office/office-layout.ts";
import type { Rect } from "./scene-layout.ts";

export interface Vec3 {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

/** What the viewer did to the framing. */
export interface CameraUser {
	/** 1 = the `work` framing; below 1 shows more of the plan. */
	readonly zoom: number;
	/** Turn added to the default yaw, radians. */
	readonly yaw: number;
	/** Target shift on the plan, metres. */
	readonly panX: number;
	readonly panZ: number;
}

export type Framing = "work" | "overview";

/** The parts of the layout the camera frames by. */
export interface CameraPlan {
	readonly camera: LayoutCamera;
	/** The whole plan; the camera's target stays inside it. */
	readonly footprint: Rect;
	/** The phone desks, where a portrait canvas opens (null: it opens like any other). */
	readonly workFocus: Rect | null;
	/** The work zone, what `work` frames on any canvas that is not portrait (null: the whole plan). */
	readonly workZone: Rect | null;
	/** The most a portrait canvas may show (null: the whole plan). */
	readonly portraitReach: Rect | null;
}

export interface ZoomLimits {
	readonly min: number;
	readonly max: number;
}

export const NO_USER: CameraUser = { zoom: 1, yaw: 0, panX: 0, panZ: 0 };
/** The closest view, metres of plan from the top to the bottom of the canvas (a desk and the people at it). */
export const MIN_VIEW_HEIGHT = 4.5;
/**
 * A screen that may see the whole plan may zoom out this much past it (a
 * margin of backdrop); a portrait phone stops at its reach.
 */
export const OVERVIEW_SLACK = 0.85;
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
/** A portrait canvas narrower than this opens on the phone desks and stops at its reach. */
export const PORTRAIT_ASPECT = 0.8;
/** A canvas at least this wide frames like the desktop picture. */
export const WIDE_ASPECT = 1.2;
const FOCUS_MARGIN = 1.12;
const ZONE_MARGIN = 1.06;
const REACH_MARGIN = 1.04;

const safeAspect = (aspect: number): number => (Number.isFinite(aspect) && aspect > 0 ? aspect : 1);

/** Screen right and up (metres on a zoom-1 view) of a point relative to the target, for a yaw and pitch in radians. */
export function screenOffset(yaw: number, pitch: number, dx: number, dy: number, dz: number): { right: number; up: number } {
	const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
	const depth = dx * Math.sin(yaw) + dz * Math.cos(yaw);
	return { right, up: dy * Math.cos(pitch) + depth * Math.sin(pitch) };
}

/** The framing that just holds a rectangle of the plan (people standing in it included) on a canvas of `aspect`. */
export function fitRect(camera: LayoutCamera, aspect: number, rect: Rect, margin: number): BaseFraming {
	const a = safeAspect(aspect);
	const yaw = camera.yaw * RAD;
	const pitch = camera.pitch * RAD;
	const [x0, z0, x1, z1] = rect;
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
	return { target: centre, orthoHeight: Math.max(2 * up, (2 * right) / a) * margin };
}

/** The whole plan as the 2D pictures frame it: the desktop picture's frame on a wide canvas, the phone picture's otherwise. */
function wholePlan(camera: LayoutCamera, aspect: number): BaseFraming {
	const a = safeAspect(aspect);
	const view = a >= WIDE_ASPECT ? camera.views.desktop : camera.views.phone;
	const contentWidth = view.orthoHeight * view.aspect;
	return { target: { x: camera.target[0], y: camera.target[1], z: camera.target[2] }, orthoHeight: Math.max(view.orthoHeight, contentWidth / a) };
}

const isPortrait = (plan: CameraPlan, aspect: number): boolean => safeAspect(aspect) < PORTRAIT_ASPECT && plan.workFocus !== null;

/** The framing of `work` or `overview` for a canvas of `aspect`, before the viewer touches anything. */
export function baseFraming(plan: CameraPlan, aspect: number, framing: Framing): BaseFraming {
	if (!isPortrait(plan, aspect) || plan.workFocus === null) {
		return framing === "work" && plan.workZone !== null ? fitRect(plan.camera, aspect, plan.workZone, ZONE_MARGIN) : wholePlan(plan.camera, aspect);
	}
	if (framing === "work") return fitRect(plan.camera, aspect, plan.workFocus, FOCUS_MARGIN);
	return plan.portraitReach === null ? wholePlan(plan.camera, aspect) : fitRect(plan.camera, aspect, plan.portraitReach, REACH_MARGIN);
}

/** What the viewer's state is when `framing` is shown on a canvas of `aspect` (zoom and pan relative to `work`). */
export function framingUser(plan: CameraPlan, aspect: number, framing: Framing): CameraUser {
	if (framing === "work") return NO_USER;
	const work = baseFraming(plan, aspect, "work");
	const overview = baseFraming(plan, aspect, "overview");
	return { zoom: work.orthoHeight / overview.orthoHeight, yaw: 0, panX: overview.target.x - work.target.x, panZ: overview.target.z - work.target.z };
}

/** How far the viewer may zoom on a canvas of `aspect`: out to the overview (a little past it where that is the whole plan), in to MIN_VIEW_HEIGHT. */
export function zoomLimits(plan: CameraPlan, aspect: number): ZoomLimits {
	const work = baseFraming(plan, aspect, "work");
	const overview = baseFraming(plan, aspect, "overview");
	const slack = isPortrait(plan, aspect) && plan.portraitReach !== null ? 1 : OVERVIEW_SLACK;
	const min = Math.min(1, (work.orthoHeight / overview.orthoHeight) * slack);
	return { min, max: Math.max(1, work.orthoHeight / MIN_VIEW_HEIGHT) };
}

export function clampUser(user: CameraUser, limits: ZoomLimits): CameraUser {
	const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
	return {
		zoom: Math.max(limits.min, Math.min(limits.max, finite(user.zoom, 1))),
		yaw: Math.max(-YAW_RANGE, Math.min(YAW_RANGE, finite(user.yaw, 0))),
		panX: finite(user.panX, 0),
		panZ: finite(user.panZ, 0),
	};
}

/** The pan that keeps the target inside the plan's footprint. */
export function clampPan(base: BaseFraming, user: CameraUser, footprint: Rect): CameraUser {
	const [x0, z0, x1, z1] = footprint;
	const x = Math.max(x0, Math.min(x1, base.target.x + user.panX));
	const z = Math.max(z0, Math.min(z1, base.target.z + user.panZ));
	return { ...user, panX: x - base.target.x, panZ: z - base.target.z };
}

/** The camera for a base framing and what the viewer did (already clamped by the caller). */
export function frameOffice(camera: LayoutCamera, aspect: number, base: BaseFraming, user: CameraUser): OfficeFrame {
	const a = safeAspect(aspect);
	const zoom = Number.isFinite(user.zoom) && user.zoom > 0 ? user.zoom : 1;
	const yaw = camera.yaw * RAD + (Number.isFinite(user.yaw) ? user.yaw : 0);
	const pitch = camera.pitch * RAD;
	const target = { x: base.target.x + user.panX, y: base.target.y, z: base.target.z + user.panZ };
	const ground = Math.cos(pitch) * CAMERA_DISTANCE;
	const position = { x: target.x - Math.sin(yaw) * ground, y: target.y + Math.sin(pitch) * CAMERA_DISTANCE, z: target.z - Math.cos(yaw) * ground };
	const halfHeight = base.orthoHeight / 2 / zoom;
	return { target, position, halfHeight, halfWidth: halfHeight * a, yaw, pitch };
}

/** CSS pixels one metre of height takes on a canvas `height` pixels tall (the zoom level of detail reads it). */
export function pixelsPerMetre(frame: OfficeFrame, height: number): number {
	return height / Math.max(1e-6, 2 * frame.halfHeight);
}

/** Between two viewer states, `t` from 0 to 1 of the way (zoom on a log scale, so the glide feels even). */
export function blendUser(from: CameraUser, to: CameraUser, t: number): CameraUser {
	const k = Math.max(0, Math.min(1, t));
	const lerp = (a: number, b: number): number => a + (b - a) * k;
	return { zoom: Math.exp(lerp(Math.log(from.zoom), Math.log(to.zoom))), yaw: lerp(from.yaw, to.yaw), panX: lerp(from.panX, to.panX), panZ: lerp(from.panZ, to.panZ) };
}

/**
 * The plan shift for a drag of (dx, dy) CSS pixels on a canvas `height`
 * pixels tall: the building follows the finger. Screen up on the plan is
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
