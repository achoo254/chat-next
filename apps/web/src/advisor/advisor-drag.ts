// Where the Advisor mascot and its bubble sit. Dragging: the mascot follows
// the finger or the mouse, then snaps to the nearer side edge at the height
// it was let go, anywhere from below the screen's header down to the bottom
// edge (the user places it over a composer if they want). The band's edges
// and the safe areas are applied in CSS (advisor.css), so the dock stored per
// device is only a side and a share of the band (a dock stored before keeps
// its meaning: 0 top, 1 bottom). A press that moves less than DRAG_SLOP is a
// tap. The bubble and its menu open beside what opened them, toward the
// room there is, always whole on screen (bubblePlacement, menuPlacement).
import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Dock } from "./advisor-store.ts";

/** The mascot's box, CSS pixels. */
export const MASCOT_SIZE = 56;
/** The band's top: below the screen's header. */
export const BAND_TOP = 72;
/** The band's bottom margin: a hair off the bottom edge (CSS adds the safe area). */
export const BAND_BOTTOM = 8;
/** Movement (px) past which a press is a drag, not a tap. */
export const DRAG_SLOP = 6;

export interface Viewport {
	readonly width: number;
	readonly height: number;
}

/** The highest and lowest top (px) the mascot may have in this viewport. */
export function bandOf(view: Viewport): { readonly top: number; readonly bottom: number } {
	const bottom = Math.max(BAND_TOP, view.height - BAND_BOTTOM - MASCOT_SIZE);
	return { top: BAND_TOP, bottom };
}

/** Where a mascot let go with its centre at (x, y) docks: the nearer side, its height as a share of the band. */
export function dockFor(x: number, y: number, view: Viewport): Dock {
	const side = x < view.width / 2 ? "left" : "right";
	const band = bandOf(view);
	const top = Math.min(band.bottom, Math.max(band.top, y - MASCOT_SIZE / 2));
	const span = band.bottom - band.top;
	return { side, y: span === 0 ? 0 : (top - band.top) / span };
}

export function isDrag(dx: number, dy: number): boolean {
	return Math.hypot(dx, dy) > DRAG_SLOP;
}

interface Press {
	readonly x: number;
	readonly y: number;
	readonly offsetX: number;
	readonly offsetY: number;
	dragging: boolean;
}

export interface Drag {
	/** The mascot's position while dragged; null when docked. */
	readonly live: { readonly left: number; readonly top: number } | null;
	readonly handlers: {
		onPointerDown: (event: PointerEvent<HTMLElement>) => void;
		onPointerMove: (event: PointerEvent<HTMLElement>) => void;
		onPointerUp: (event: PointerEvent<HTMLElement>) => void;
		onPointerCancel: () => void;
		onClick: (event: MouseEvent<HTMLElement>) => void;
	};
}

/** Pointer handling of the mascot: `onTap` for a tap (or Enter), `onDock` when a drag ends. */
export function useMascotDrag(onTap: () => void, onDock: (dock: Dock) => void): Drag {
	const press = useRef<Press | null>(null);
	/** The click that follows a drag's pointerup is no tap. */
	const dragged = useRef(false);
	const [live, setLive] = useState<Drag["live"]>(null);
	return {
		live,
		handlers: {
			onPointerDown: (event) => {
				if (event.button !== 0) return;
				// A touch that moved fires no click: the flag of the last drag ends with the next press.
				dragged.current = false;
				const rect = event.currentTarget.getBoundingClientRect();
				event.currentTarget.setPointerCapture?.(event.pointerId);
				press.current = { x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, dragging: false };
			},
			onPointerMove: (event) => {
				const p = press.current;
				if (p === null) return;
				if (!p.dragging && !isDrag(event.clientX - p.x, event.clientY - p.y)) return;
				p.dragging = true;
				setLive({ left: event.clientX - p.offsetX, top: event.clientY - p.offsetY });
			},
			onPointerUp: (event) => {
				const p = press.current;
				press.current = null;
				if (p === null || !p.dragging) return;
				dragged.current = true;
				setLive(null);
				const left = event.clientX - p.offsetX;
				const top = event.clientY - p.offsetY;
				onDock(dockFor(left + MASCOT_SIZE / 2, top + MASCOT_SIZE / 2, { width: window.innerWidth, height: window.innerHeight }));
			},
			onPointerCancel: () => {
				press.current = null;
				setLive(null);
			},
			onClick: (event) => {
				event.preventDefault();
				if (dragged.current) {
					dragged.current = false;
					return;
				}
				onTap();
			},
		},
	};
}

/** A box on screen, CSS pixels (a DOMRect's fields). */
export interface Box {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** Where a floating panel goes: its left and width, and its top or its bottom (from the viewport's bottom), with its height cap. */
export interface Placement {
	readonly left: number;
	readonly width: number;
	readonly top?: number;
	readonly bottom?: number;
	readonly maxHeight: number;
}

/** The bubble's width and height caps on a wide screen. */
export const BUBBLE_WIDTH = 400;
export const BUBBLE_MAX_HEIGHT = 600;
/** Space kept between a panel and what opened it, and between a panel and the viewport's edges. */
export const PANEL_GAP = 8;
export const VIEW_MARGIN = 12;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The bubble beside the mascot: on its inner side (left of a mascot docked
 * right), opening upward from the mascot's bottom when the mascot is in the
 * lower half and downward from its top otherwise; moved and capped to stay
 * whole in the viewport.
 */
export function bubblePlacement(mascot: Box, view: Viewport, side: "left" | "right"): Placement {
	const width = Math.min(BUBBLE_WIDTH, view.width - 2 * VIEW_MARGIN);
	const beside = side === "right" ? mascot.left - PANEL_GAP - width : mascot.left + mascot.width + PANEL_GAP;
	const left = clamp(beside, VIEW_MARGIN, view.width - VIEW_MARGIN - width);
	const below = mascot.top + mascot.height / 2 > view.height / 2;
	if (below) {
		const bottom = clamp(view.height - (mascot.top + mascot.height), VIEW_MARGIN, view.height - 2 * VIEW_MARGIN);
		return { left, width, bottom, maxHeight: Math.min(BUBBLE_MAX_HEIGHT, view.height - bottom - VIEW_MARGIN) };
	}
	const top = clamp(mascot.top, VIEW_MARGIN, view.height - 2 * VIEW_MARGIN);
	return { left, width, top, maxHeight: Math.min(BUBBLE_MAX_HEIGHT, view.height - top - VIEW_MARGIN) };
}

/** Room under a menu's button that is enough to open it there. */
export const MENU_ROOM = 160;

/**
 * A menu under the button that opened it, its right edge on the button's;
 * above the button only when there is not MENU_ROOM below and more room
 * above. Moved and capped to stay whole in the viewport.
 */
export function menuPlacement(button: Box, view: Viewport, width: number): Placement {
	const w = Math.min(width, view.width - 2 * VIEW_MARGIN);
	const left = clamp(button.left + button.width - w, VIEW_MARGIN, view.width - VIEW_MARGIN - w);
	const roomBelow = view.height - (button.top + button.height) - PANEL_GAP - VIEW_MARGIN;
	const roomAbove = button.top - PANEL_GAP - VIEW_MARGIN;
	if (roomBelow >= MENU_ROOM || roomBelow >= roomAbove) return { left, width: w, top: button.top + button.height + PANEL_GAP, maxHeight: Math.max(0, roomBelow) };
	return { left, width: w, bottom: view.height - button.top + PANEL_GAP, maxHeight: Math.max(0, roomAbove) };
}

/** The inline style of a placement (position: fixed in CSS). */
export function placementStyle(p: Placement): { left: string; width: string; top: string; bottom: string; maxHeight: string } {
	// The edge not used is "auto", or the stylesheet's own bottom would stretch a panel placed by its top down to it.
	return {
		left: `${p.left}px`,
		width: `${p.width}px`,
		top: p.top !== undefined ? `${p.top}px` : "auto",
		bottom: p.bottom !== undefined ? `${p.bottom}px` : "auto",
		maxHeight: `${p.maxHeight}px`,
	};
}
