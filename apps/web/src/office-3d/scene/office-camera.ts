// The office's isometric camera at run time: orthographic, framed by
// fit-office-camera.ts for the canvas shape each frame, with the viewer's
// zoom (wheel, pinch), a small turn (right-drag, shift-drag, or two fingers
// sideways) that glides back to the default after a few seconds untouched,
// and drag to pan within the plan. The viewer's framing button (`work` or
// `overview`, fit-office-camera.ts) glides the camera there; nothing else
// ever moves it (it does not follow people). View only: nothing is picked.
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

/** The turn glides back to the default after this long untouched. */
const RETURN_AFTER_MS = 5_000;
const RETURN_GLIDE_MS = 900;
/** Radians of turn per CSS pixel of sideways drag. */
const TURN_PER_PIXEL = 0.006;
/** The glide to a framing the viewer asked for. */
const FRAMING_GLIDE_MS = 700;

/** `framing`: the framing to open with. */
export function createOfficeCamera(scene: Scene, canvas: HTMLCanvasElement, plan: CameraPlan, framing: Framing, reducedMotion: boolean): OfficeCamera {
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
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		canvas.setPointerCapture(e.pointerId);
	};
	const onMove = (e: PointerEvent): void => {
		const was = pointers.get(e.pointerId);
		if (was === undefined) return;
		touch();
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
	canvas.addEventListener("pointercancel", onUp);
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
			canvas.removeEventListener("pointercancel", onUp);
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("contextmenu", onMenu);
			camera.dispose();
		},
	};
}
