// The office's isometric camera at run time: orthographic, framed by
// fit-office-camera.ts for the canvas shape each frame, with the viewer's
// zoom (wheel, pinch), a small turn (right-drag, shift-drag, or two fingers
// sideways) that glides back to the default after a few seconds untouched,
// and drag to pan within the plan. The viewer's framing button (`work` or
// `overview`, fit-office-camera.ts) glides the camera there; nothing else
// ever moves it (it does not follow people). It also tells a tap from a drag (isTap) and reports a tap to the
// view, which finds the name under it (pick-tag.ts); the camera itself picks nothing.
import { Camera } from "@babylonjs/core/Cameras/camera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { baseFraming, blendUser, clampPan, clampUser, dragToPan, frameOffice, framingUser, NO_USER, zoomLimits, type CameraPlan, type CameraUser, type Framing, type OfficeFrame } from "./fit-office-camera.ts";

export interface OfficeCamera {
	readonly camera: TargetCamera;
	/** Re-frames for the canvas (CSS pixels). Returns the frame. */
	update(width: number, height: number, timeMs: number): OfficeFrame;
	/** The viewer asked for a framing: glide there (at once with reduced motion), dropping their own pan and zoom. */
	setFraming(framing: Framing): void;
	readonly frame: OfficeFrame | null;
	/** What the viewer did to the framing (zoom, turn, pan), for tests. */
	readonly user: CameraUser;
	dispose(): void;
}

/** A press that moves this far (CSS px) is a drag of the camera, not a tap. */
export const TAP_SLOP_PX = 6;

/** What a press did from its first finger down to its last one up. */
export interface PointerGesture {
	/** The most fingers or pointers down at once. */
	readonly maxPointers: number;
	/** The button of the first press: 0 is the primary one (a finger or the left button). */
	readonly button: number;
	/** Shift was held (a drag with it turns the camera). */
	readonly shift: boolean;
	/** The farthest the press got from where it began, px. */
	readonly travel: number;
}

/**
 * Whether a press was a tap: one pointer the whole time, the primary button, no
 * shift, hardly moved. A pan (left drag), a turn (right or shift drag), a pinch
 * (two fingers) and a wheel are not taps, so they never choose anyone or close
 * the panel.
 */
export function isTap(g: PointerGesture): boolean {
	return g.maxPointers === 1 && g.button === 0 && !g.shift && g.travel < TAP_SLOP_PX;
}

/** The turn glides back to the default after this long untouched. */
const RETURN_AFTER_MS = 5_000;
const RETURN_GLIDE_MS = 900;
/** Radians of turn per CSS pixel of sideways drag. */
const TURN_PER_PIXEL = 0.006;
/** The glide to a framing the viewer asked for. */
const FRAMING_GLIDE_MS = 700;

/** `framing`: the framing to open with. */
export function createOfficeCamera(scene: Scene, canvas: HTMLCanvasElement, plan: CameraPlan, framing: Framing, reducedMotion: boolean, onTap?: (clientX: number, clientY: number) => void): OfficeCamera {
	const camera = new TargetCamera("office-camera", new Vector3(0, 30, -30), scene);
	camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
	camera.minZ = 1;
	camera.maxZ = 200;
	let user: CameraUser = NO_USER;
	let lastInput = -Infinity;
	let lastTime: number | null = null;
	let frame: OfficeFrame | null = null;
	let size = { width: 1, height: 1 };
	let wanted: Framing = framing;
	/** The framing to jump to on the first frame (the canvas size is not known before). */
	let opening = true;
	/** The glide under way to `wanted`, from the viewer's state at the press. */
	let glide: { readonly from: CameraUser; readonly start: number } | null = null;
	const pointers = new Map<number, { x: number; y: number }>();
	/** The press under way, from its first pointer down to its last one up. */
	let gesture: { startX: number; startY: number; maxPointers: number; button: number; shift: boolean; travel: number } | null = null;
	const target = new Vector3();

	const aspect = (): number => size.width / Math.max(1, size.height);
	const base = () => baseFraming(plan, aspect(), "work");
	const limits = () => zoomLimits(plan, aspect());
	const touch = (): void => {
		lastInput = performance.now();
		// The viewer takes over from wherever the glide got to.
		glide = null;
	};
	const pan = (dx: number, dy: number): void => {
		if (frame === null) return;
		const d = dragToPan(frame, size.height, dx, dy);
		user = clampPan(base(), { ...user, panX: user.panX + d.x, panZ: user.panZ + d.z }, plan.footprint);
	};
	const turn = (dx: number): void => {
		user = clampUser({ ...user, yaw: user.yaw - dx * TURN_PER_PIXEL }, limits());
	};
	const zoomBy = (factor: number): void => {
		user = clampUser({ ...user, zoom: user.zoom * factor }, limits());
	};

	const onDown = (e: PointerEvent): void => {
		touch();
		if (pointers.size === 0) gesture = { startX: e.clientX, startY: e.clientY, maxPointers: 1, button: e.button, shift: e.shiftKey, travel: 0 };
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (gesture !== null) gesture.maxPointers = Math.max(gesture.maxPointers, pointers.size);
		canvas.setPointerCapture(e.pointerId);
	};
	const onMove = (e: PointerEvent): void => {
		const was = pointers.get(e.pointerId);
		if (was === undefined) return;
		touch();
		if (gesture !== null) {
			gesture.travel = Math.max(gesture.travel, Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY));
			gesture.shift ||= e.shiftKey;
		}
		const dx = e.clientX - was.x;
		const dy = e.clientY - was.y;
		if (pointers.size >= 2) {
			const others = [...pointers].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
			const other = others[0];
			if (other !== undefined) {
				const before = Math.hypot(was.x - other.x, was.y - other.y);
				const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
				if (before > 4) zoomBy(after / before);
				turn(dx / 2);
			}
		} else if (e.button === 2 || (e.buttons & 2) !== 0 || e.shiftKey) turn(dx);
		else pan(dx, dy);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	};
	const onUp = (e: PointerEvent): void => {
		pointers.delete(e.pointerId);
		if (pointers.size > 0) return;
		const done = gesture;
		gesture = null;
		if (done !== null && isTap(done)) onTap?.(e.clientX, e.clientY);
	};
	const onCancel = (e: PointerEvent): void => {
		pointers.delete(e.pointerId);
		if (pointers.size === 0) gesture = null;
	};
	const onWheel = (e: WheelEvent): void => {
		e.preventDefault();
		touch();
		zoomBy(Math.exp(-e.deltaY * 0.0015));
	};
	const onMenu = (e: Event): void => e.preventDefault();
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	canvas.addEventListener("pointercancel", onCancel);
	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("contextmenu", onMenu);

	return {
		camera,
		get frame() {
			return frame;
		},
		update(width, height, timeMs) {
			size = { width: Math.max(1, width), height: Math.max(1, height) };
			const delta = lastTime === null ? 0 : Math.max(0, timeMs - lastTime);
			lastTime = timeMs;
			if (opening) {
				opening = false;
				user = framingUser(plan, aspect(), wanted);
			}
			if (glide !== null) {
				const t = reducedMotion ? 1 : (timeMs - glide.start) / FRAMING_GLIDE_MS;
				const to = framingUser(plan, aspect(), wanted);
				// Eased in and out.
				user = t >= 1 ? to : blendUser(glide.from, to, t * t * (3 - 2 * t));
				if (t >= 1) glide = null;
			} else if (pointers.size === 0 && timeMs - lastInput > RETURN_AFTER_MS && user.yaw !== 0) {
				const yaw = reducedMotion ? 0 : user.yaw * Math.exp(-delta / RETURN_GLIDE_MS);
				user = { ...user, yaw: Math.abs(yaw) < 1e-3 ? 0 : yaw };
			}
			const b = base();
			user = clampPan(b, clampUser(user, limits()), plan.footprint);
			const f = frameOffice(plan.camera, aspect(), b, user);
			frame = f;
			camera.position.set(f.position.x, f.position.y, f.position.z);
			target.set(f.target.x, f.target.y, f.target.z);
			camera.setTarget(target);
			camera.orthoLeft = -f.halfWidth;
			camera.orthoRight = f.halfWidth;
			camera.orthoTop = f.halfHeight;
			camera.orthoBottom = -f.halfHeight;
			return f;
		},
		get user() {
			return user;
		},
		setFraming(next) {
			if (next === wanted) return;
			wanted = next;
			if (opening) return;
			glide = { from: user, start: lastTime ?? 0 };
		},
		dispose() {
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointercancel", onCancel);
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("contextmenu", onMenu);
			camera.dispose();
		},
	};
}
