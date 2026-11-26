// The handle on the right edge of a list column: the chat list
// (mockups/chat.html#app) and the AI Agent column of sessions. Drag it, or
// focus it and press ←/→ (Home/End for the limits), to change the list's
// width (the chat list 280–420px by default); the width is kept on this
// device, one per list. Narrow screens have one column at a time and no handle.

// The React Compiler leaves this file alone: its memoization only grew the startup bundle (about 0.5 KB gzip
// for this file) and changed no timing in test/perf.
"use no memo";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useCopy } from "../copy/use-copy.ts";

export const LIST_MIN = 280;
export const LIST_MAX = 420;
const STEP = 10;
const KEY = "chat:list-width";

export function clampListWidth(width: number): number {
	return clampTo(width, LIST_MIN, LIST_MAX);
}

/** A width within `min`–`max` (whole pixels). */
function clampTo(width: number, min: number, max: number): number {
	return Math.round(Math.min(max, Math.max(min, width)));
}

function storedWidth(key: string, min: number, max: number): number | null {
	try {
		const value = Number(window.localStorage.getItem(key));
		return Number.isFinite(value) && value > 0 ? clampTo(value, min, max) : null;
	} catch {
		return null;
	}
}

function store(key: string, width: number): void {
	try {
		window.localStorage.setItem(key, String(width));
	} catch {
		// Storage off: the width lasts until the tab closes.
	}
}

interface ListResizerProps {
	/** The grid whose --list-w sizes the list column. */
	app: RefObject<HTMLDivElement | null>;
	/** The list column inside the grid (the chat list by default). */
	list?: string;
	/** Where this device keeps the width. */
	storageKey?: string;
	min?: number;
	max?: number;
	/** The handle's name for screen readers (the chat list's by default). */
	label?: string;
	className?: string;
}

/** Sets --list-w on the grid and renders the handle at the list's edge. */
export function ListResizer({ app, list: listSelector = ":scope > .list", storageKey = KEY, min = LIST_MIN, max = LIST_MAX, label, className = "list-resize" }: ListResizerProps) {
	const copy = useCopy();
	const clamp = (width: number) => clampTo(width, min, max);
	const [width, setWidth] = useState<number | null>(() => storedWidth(storageKey, min, max));
	// The width the layout gave the list, for aria-valuenow while no width is kept.
	const [measured, setMeasured] = useState<number>(min);
	const drag = useRef<{ left: number; pointer: number } | null>(null);

	const handle = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		// On mount the grid's ref is not set yet (React sets a parent's ref after its children's layout effects):
		// the handle sits in the grid, so its parent is the grid, and a kept width shows from the first paint.
		const element = app.current ?? handle.current?.parentElement ?? null;
		if (element === null) return;
		if (width === null) element.style.removeProperty("--list-w");
		else element.style.setProperty("--list-w", `${width}px`);
	}, [app, width]);

	// Watch the grid, not one list: contacts and topic lists take the column in turn.
	useEffect(() => {
		const element = app.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			const list = element.querySelector<HTMLElement>(listSelector);
			if (list !== null) setMeasured(clampTo(list.getBoundingClientRect().width, min, max));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [app, listSelector, min, max]);

	const apply = (next: number) => {
		const clamped = clamp(next);
		setWidth(clamped);
		store(storageKey, clamped);
	};

	const shown = width ?? measured;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const base = shown;
		let next: number | null = null;
		if (event.key === "ArrowLeft") next = base - STEP;
		else if (event.key === "ArrowRight") next = base + STEP;
		else if (event.key === "Home") next = min;
		else if (event.key === "End") next = max;
		if (next === null) return;
		event.preventDefault();
		apply(next);
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const list = app.current?.querySelector<HTMLElement>(listSelector);
		if (list === null || list === undefined) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { left: list.getBoundingClientRect().left, pointer: event.pointerId };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const active = drag.current;
		if (active === null || active.pointer !== event.pointerId) return;
		const next = clamp(event.clientX - active.left);
		setWidth(next);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (drag.current?.pointer !== event.pointerId) return;
		drag.current = null;
		if (width !== null) store(storageKey, width);
	};

	return (
		// A focusable separator with a value is a widget in ARIA 1.2 (window splitter); the plugin treats separator as structure only.
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
		<div
			ref={handle}
			className={className}
			role="separator"
			aria-orientation="vertical"
			aria-label={label ?? copy.list.resize}
			aria-valuemin={min}
			aria-valuemax={max}
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
