// The panel's left edge: drag it (mouse, pen or touch) or use the arrow keys
// on it to change the panel's width; the width is kept when the drag ends.
// The panel sits on the right, so moving the edge left widens it.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clampWidth, PANEL_WIDTH } from "./panel-prefs.ts";

const STEP = 16;

interface ResizeHandleProps {
	width: number;
	label: string;
	/** While dragging (not kept yet). */
	onResize: (width: number) => void;
	/** The final width, to keep. */
	onDone: (width: number) => void;
}

/** The width after a key on the handle; null for other keys. */
export function widthForKey(width: number, key: string): number | null {
	switch (key) {
		case "ArrowLeft":
			return clampWidth(width + STEP);
		case "ArrowRight":
			return clampWidth(width - STEP);
		case "Home":
			return PANEL_WIDTH.min;
		case "End":
			return PANEL_WIDTH.max;
		default:
			return null;
	}
}

export function ResizeHandle({ width, label, onResize, onDone }: ResizeHandleProps) {
	const drag = useRef<{ x: number; width: number; last: number } | null>(null);
	const down = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, width, last: width };
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (d === null) return;
		const next = clampWidth(d.width + (d.x - event.clientX));
		if (next === d.last) return;
		d.last = next;
		onResize(next);
	};
	const up = (event: PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (d === null) return;
		drag.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		onDone(d.last);
	};
	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const next = widthForKey(width, event.key);
		if (next === null) return;
		event.preventDefault();
		onDone(next);
	};
	// A focusable separator is the WAI-ARIA window splitter (an interactive widget); jsx-a11y counts every separator as static.
	/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
	return (
		<div
			className="ws-resize"
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuemin={PANEL_WIDTH.min}
			aria-valuemax={PANEL_WIDTH.max}
			aria-valuenow={width}
			tabIndex={0}
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={up}
			onKeyDown={key}
		/>
	);
	/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
