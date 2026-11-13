// Dragging a project to another place in the sidebar, by its header row: a
// mouse drags once it moves a few pixels; a finger first holds still
// (moving at once scrolls the list as before). A press on the row's ⋮ is
// never a drag, and the click ending a drag does not open or close the
// project. Keyboard and screen readers use "Lên trên"/"Xuống dưới" in the
// row's menu instead.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** A finger held this long without moving picks the project up. */
export const HOLD_MS = 350;
/** A mouse moved this far picks it up. */
const MOUSE_SLOP = 5;
/** A finger moved this far before the hold is a scroll. */
const TOUCH_SLOP = 8;
/** Near the list's top or bottom edge the list scrolls while dragging. */
const EDGE = 40;
const EDGE_STEP = 8;

/** Where the dragged project would go: before the project at `index` of the list (`ids.length`: last). */
export interface ProjectDrag {
	readonly id: number;
	readonly index: number;
}

/** `ids` with `id` taken out and put back before the one at `index` of `ids`. */
export function movedTo(ids: readonly number[], id: number, index: number): number[] {
	const from = ids.indexOf(id);
	const rest = ids.filter((x) => x !== id);
	const at = from !== -1 && from < index ? index - 1 : index;
	rest.splice(at, 0, id);
	return rest;
}

interface Pending {
	readonly id: number;
	readonly pointerId: number;
	readonly x: number;
	readonly y: number;
	readonly touch: boolean;
	active: boolean;
	index: number;
	timer: number;
}

/**
 * The drag over `list` (its project rows carry data-project-id, in the
 * order of `ids`). `onDrop` gets the new order when it changed.
 */
export function useProjectDrag(list: RefObject<HTMLElement | null>, ids: readonly number[], enabled: boolean, onDrop: (ids: number[]) => void) {
	const [drag, setDrag] = useState<ProjectDrag | null>(null);
	const pending = useRef<Pending | null>(null);
	const latest = useRef({ ids, onDrop });
	useEffect(() => {
		latest.current = { ids, onDrop };
	});
	const stop = useRef<() => void>(() => undefined);
	useEffect(() => () => stop.current(), []);

	const indexAt = (y: number): number => {
		const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-project-id]") ?? [])];
		const below = rows.findIndex((row) => {
			const box = row.getBoundingClientRect();
			return y < box.top + box.height / 2;
		});
		return below === -1 ? rows.length : below;
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
		if (!enabled || e.button !== 0 || pending.current !== null) return;
		const target = e.target as HTMLElement;
		if (target.closest(".mx-row-menu") !== null) return;
		const row = target.closest(".mx-project-head")?.closest<HTMLElement>("[data-project-id]");
		const id = Number(row?.dataset.projectId);
		if (row == null || !Number.isFinite(id)) return;
		const p: Pending = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", active: false, index: ids.indexOf(id), timer: 0 };
		pending.current = p;

		const activate = () => {
			p.active = true;
			p.index = latest.current.ids.indexOf(p.id);
			setDrag({ id: p.id, index: p.index });
			navigator.vibrate?.(10);
		};
		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== p.pointerId) return;
			const far = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
			if (!p.active) {
				if (p.touch && far > TOUCH_SLOP) end(false);
				else if (!p.touch && far > MOUSE_SLOP) activate();
				if (!p.active) return;
			}
			const box = list.current?.getBoundingClientRect();
			if (box !== undefined && list.current !== null) {
				if (ev.clientY < box.top + EDGE) list.current.scrollTop -= EDGE_STEP;
				else if (ev.clientY > box.bottom - EDGE) list.current.scrollTop += EDGE_STEP;
			}
			const index = indexAt(ev.clientY);
			if (index !== p.index) {
				p.index = index;
				setDrag({ id: p.id, index });
			}
		};
		// While dragging with a finger the list does not scroll under it.
		const noScroll = (ev: TouchEvent) => {
			if (p.active) ev.preventDefault();
		};
		const swallowClick = (ev: MouseEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
		};
		const end = (drop: boolean) => {
			window.clearTimeout(p.timer);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("touchmove", noScroll);
			pending.current = null;
			stop.current = () => undefined;
			if (!p.active) return;
			setDrag(null);
			// The click that ends a drag neither opens nor closes the project.
			window.addEventListener("click", swallowClick, { capture: true, once: true });
			window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
			if (!drop) return;
			const { ids: now, onDrop: done } = latest.current;
			const next = movedTo(now, p.id, p.index);
			if (next.some((x, i) => x !== now[i])) done(next);
		};
		const up = (ev: PointerEvent) => {
			if (ev.pointerId === p.pointerId) end(true);
		};
		const cancel = (ev: PointerEvent) => {
			if (ev.pointerId === p.pointerId) end(false);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("touchmove", noScroll, { passive: false });
		if (p.touch) p.timer = window.setTimeout(activate, HOLD_MS);
		stop.current = () => end(false);
	};

	return { drag, onPointerDown };
}
