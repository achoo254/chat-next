// Dragging the Advisor mascot: it follows the finger or the mouse, then
// snaps to the nearer side edge at the height it was let go, inside a band
// clear of the headers above and the composers below (the main buttons live
// there). The band's edges and the safe areas are applied in CSS
// (advisor.css), so the dock stored per device is only a side and a share
// of the band. A press that moves less than DRAG_SLOP is a tap.
import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Dock } from "./advisor-store.ts";

/** The mascot's box, CSS pixels. */
export const MASCOT_SIZE = 56;
/** The band's top: below the screen's header. */
export const BAND_TOP = 72;
/** The band's bottom margin: above a composer and its send button. */
export const BAND_BOTTOM = 132;
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
