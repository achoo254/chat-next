// The handle on the right edge of the chat list column (mockups/chat.html#app):
// drag it, or focus it and press ←/→ (Home/End for the limits), to make the
// list 280–420px wide. The width is kept on this device. Narrow screens have
// one column at a time and no handle.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useCopy } from "../copy/use-copy.ts";

export const LIST_MIN = 280;
export const LIST_MAX = 420;
const STEP = 10;
const KEY = "chat:list-width";

export function clampListWidth(width: number): number {
	return Math.round(Math.min(LIST_MAX, Math.max(LIST_MIN, width)));
}

function storedWidth(): number | null {
	try {
		const value = Number(window.localStorage.getItem(KEY));
		return Number.isFinite(value) && value > 0 ? clampListWidth(value) : null;
	} catch {
		return null;
	}
}

function store(width: number): void {
	try {
		window.localStorage.setItem(KEY, String(width));
	} catch {
		// Storage off: the width lasts until the tab closes.
	}
}

/** Sets --list-w on the app grid and renders the handle at the list's edge. */
export function ListResizer({ app }: { app: RefObject<HTMLDivElement | null> }) {
	const copy = useCopy();
	const [width, setWidth] = useState<number | null>(storedWidth);
	// The width the layout gave the list, for aria-valuenow while no width is kept.
	const [measured, setMeasured] = useState<number>(LIST_MIN);
	const drag = useRef<{ left: number; pointer: number } | null>(null);

	useLayoutEffect(() => {
		const element = app.current;
		if (element === null) return;
		if (width === null) element.style.removeProperty("--list-w");
		else element.style.setProperty("--list-w", `${width}px`);
	}, [app, width]);

	// Watch the grid, not one list: contacts and topic lists take the column in turn.
	useEffect(() => {
		const element = app.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			const list = element.querySelector<HTMLElement>(":scope > .list");
			if (list !== null) setMeasured(clampListWidth(list.getBoundingClientRect().width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [app]);

	const apply = (next: number) => {
		const clamped = clampListWidth(next);
		setWidth(clamped);
		store(clamped);
	};

	const shown = width ?? measured;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const base = shown;
		let next: number | null = null;
		if (event.key === "ArrowLeft") next = base - STEP;
		else if (event.key === "ArrowRight") next = base + STEP;
		else if (event.key === "Home") next = LIST_MIN;
		else if (event.key === "End") next = LIST_MAX;
		if (next === null) return;
		event.preventDefault();
		apply(next);
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const list = app.current?.querySelector<HTMLElement>(":scope > .list");
		if (list === null || list === undefined) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { left: list.getBoundingClientRect().left, pointer: event.pointerId };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const active = drag.current;
		if (active === null || active.pointer !== event.pointerId) return;
		const next = clampListWidth(event.clientX - active.left);
		setWidth(next);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current?.pointer !== event.pointerId) return;
		drag.current = null;
		if (width !== null) store(width);
	};

	return (
		// A focusable separator with a value is a widget in ARIA 1.2 (window splitter); the plugin treats separator as structure only.
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
		<div
			className="list-resize"
			role="separator"
			aria-orientation="vertical"
			aria-label={copy.list.resize}
			aria-valuemin={LIST_MIN}
			aria-valuemax={LIST_MAX}
			aria-valuenow={shown}
			// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the window splitter is operated with the keyboard, so it is in the tab order
			tabIndex={0}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		/>
	);
}
