// How the user's pointer, keys and gestures on the picture of the machine's
// browser become BrowserInput: points in the page's CSS pixels, keys as the
// browser names them, wheel deltas in pixels. Pure, so it is tested alone.

export interface Rect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface PageSize {
	readonly width: number;
	readonly height: number;
}

/** A point on the shown picture (it may be zoomed: the rect says where it is now) in page pixels. */
export function pagePoint(clientX: number, clientY: number, rect: Rect, page: PageSize): { x: number; y: number } | null {
	if (rect.width <= 0 || rect.height <= 0 || page.width <= 0 || page.height <= 0) return null;
	const fx = (clientX - rect.left) / rect.width;
	const fy = (clientY - rect.top) / rect.height;
	if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
	return { x: Math.round(fx * page.width), y: Math.round(fy * page.height) };
}

/** Page pixels per pixel on screen (to turn a finger's drag into a scroll of the page). */
export function pageScale(rect: Rect, page: PageSize): number {
	return rect.width > 0 && page.width > 0 ? page.width / rect.width : 1;
}

interface Modifiers {
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
}

/** Alt 1, Control 2, Meta 4, Shift 8 (as the machine takes them). */
export function modifiersOf(e: Modifiers): number {
	return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export interface KeyPress {
	readonly key: string;
	readonly code: string;
	readonly text: string;
	readonly modifiers: number;
}

interface KeyLike extends Modifiers {
	readonly key: string;
	readonly code: string;
	readonly isComposing?: boolean;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph"]);

/**
 * A key pressed on the picture (desktop), as the machine takes it; null when
 * it is not for the page: a modifier alone, an input method composing, or
 * the paste shortcut (the paste event brings the text itself).
 */
export function keyPress(e: KeyLike): KeyPress | null {
	if (e.isComposing === true || e.key === "Process" || e.key === "Unidentified" || e.key === "Dead") return null;
	if (MODIFIER_KEYS.has(e.key)) return null;
	const shortcut = e.ctrlKey || e.metaKey;
	if (shortcut && e.key.toLowerCase() === "v") return null;
	const text = e.key.length === 1 && !shortcut ? e.key : "";
	return { key: e.key, code: e.code, text, modifiers: modifiersOf(e) };
}

/** The key the phone keyboard's special keys stand for (its letters arrive as text). */
export function phoneKey(key: string): KeyPress | null {
	return key === "Enter" || key === "Backspace" || key === "Tab" || key === "Escape" || key.startsWith("Arrow")
		? { key, code: key, text: "", modifiers: 0 }
		: null;
}

/** A wheel event's delta in pixels (lines and pages turned into pixels). */
export function wheelPixels(delta: number, mode: number): number {
	return mode === 1 ? delta * 40 : mode === 2 ? delta * 800 : delta;
}

/** Fingers closer than this to where they went down, and up within TAP_MS: a tap (a click on the page). */
export const TAP_SLOP = 10;
export const TAP_MS = 500;
export const MAX_ZOOM = 4;

export interface Zoom {
	readonly scale: number;
	readonly x: number;
	readonly y: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/**
 * Two fingers moved from `from` to `to` (each a pair of points): the zoom
 * scales around their middle and follows it; never below 1 or above 4.
 */
export function pinch(start: Zoom, from: readonly [Point, Point], to: readonly [Point, Point]): Zoom {
	const d0 = distance(from[0], from[1]);
	const d1 = distance(to[0], to[1]);
	if (d0 < 1) return start;
	const scale = Math.min(Math.max(start.scale * (d1 / d0), 1), MAX_ZOOM);
	if (scale === 1) return NO_ZOOM;
	const m0 = middle(from[0], from[1]);
	const m1 = middle(to[0], to[1]);
	// The content point under the first middle stays under the fingers' middle now.
	const k = scale / start.scale;
	return { scale, x: m1.x - (m0.x - start.x) * k, y: m1.y - (m0.y - start.y) * k };
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function middle(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
