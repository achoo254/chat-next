// Keeps the HTML over the canvas on the 3D points it belongs to: each
// person's name, status dot and speech bubble over their head, and the meeting
// room's "+N" over its table. React renders the elements
// (office-canvas.tsx) and binds them here by key; every frame this moves
// them with a transform (no React render per frame) and hides those off the
// canvas. Zoomed far out (`far`), the label of an idle person (its element
// carries `data-idle`) shrinks to its status dot (`data-dot`, office-3d.css);
// people at work keep their name and speech bubble.
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { PersonView } from "./character/office-people.ts";

/** A pin over a point of the plan (the meeting room's "+N"), bound as `board:<id>`. */
export interface OverlayPin {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface OfficeOverlay {
	bind(id: string, el: HTMLElement | null): void;
	/** Positions every bound element; `width`/`height`: the canvas in CSS pixels; `far`: idle people show as dots. */
	update(scene: Scene, width: number, height: number, people: readonly PersonView[], pins: readonly OverlayPin[], far: boolean): void;
	/** Screen position (CSS px) of each person shown, for tests. */
	readonly screen: ReadonlyMap<string, readonly [number, number]>;
	/** How many people on the canvas show as a dot now, for tests. */
	readonly dots: number;
	dispose(): void;
}

/** Size of a label not measured yet (a name tag alone), CSS px. */
const LABEL_SIZE: LabelSize = { w: 150, h: 26 };
const LABEL_GAP = 2;

interface LabelSize {
	readonly w: number;
	readonly h: number;
}

/** A label anchored at its bottom centre (x, y), `w` wide and `h` tall. */
export interface StackedLabel extends LabelSize {
	readonly x: number;
	readonly y: number;
}

/**
 * Lifts labels that would cover one another: front to back (lower on screen
 * first), a label overlapping one already placed moves up to sit just above
 * it, until it is clear. Only the drawn spot moves; the person's projected
 * point stays.
 */
export function stackLabels<T extends StackedLabel>(labels: readonly T[]): T[] {
	const placed: T[] = [];
	for (const label of [...labels].sort((a, b) => b.y - a.y)) {
		let y = label.y;
		for (let tries = 0; tries <= placed.length; tries += 1) {
			const hit = placed.find((o) => Math.abs(o.x - label.x) < (o.w + label.w) / 2 && y > o.y - o.h && y - label.h < o.y);
			if (hit === undefined) break;
			y = hit.y - hit.h - LABEL_GAP;
		}
		placed.push({ ...label, y });
	}
	return placed;
}

export function createOfficeOverlay(): OfficeOverlay {
	const elements = new Map<string, HTMLElement>();
	const written = new Map<string, string>();
	const dotted = new Set<string>();
	let dots = 0;
	const screen = new Map<string, readonly [number, number]>();
	const point = new Vector3();
	const out = new Vector3();
	const matrix = new Matrix();
	// Label sizes come from a ResizeObserver (a bubble comes and goes), never read in the frame loop: no forced layout.
	// A hidden label measures 0 and keeps its last size.
	const sizes = new WeakMap<Element, LabelSize>();
	const sizer =
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver((entries) => {
					for (const e of entries) {
						const box = e.borderBoxSize[0];
						const w = box?.inlineSize ?? e.contentRect.width;
						const h = box?.blockSize ?? e.contentRect.height;
						if (w > 0 && h > 0) sizes.set(e.target, { w, h });
					}
				});

	/** Moves an element to (x, y), scaled about its anchor by `scale`; written only on a change. */
	const place = (id: string, el: HTMLElement, visible: boolean, x: number, y: number, scale = 1): void => {
		const move = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
		const value = visible ? (scale === 1 ? move : `${move} scale(${scale})`) : "hidden";
		if (written.get(id) === value) return;
		written.set(id, value);
		el.hidden = !visible;
		if (visible) el.style.transform = value;
	};

	/** Shrinks (or restores) a person's label; written only on a change. */
	const dot = (id: string, el: HTMLElement, on: boolean): void => {
		if (dotted.has(id) === on) return;
		if (on) dotted.add(id);
		else dotted.delete(id);
		el.toggleAttribute("data-dot", on);
	};

	return {
		screen,
		get dots() {
			return dots;
		},
		bind(id, el) {
			const before = elements.get(id);
			if (before !== undefined && before !== el && id.startsWith("person:")) sizer?.unobserve(before);
			if (el === null) {
				elements.delete(id);
				written.delete(id);
				dotted.delete(id);
			} else {
				// A new element for the id starts hidden and full size: write it afresh.
				if (before !== el) {
					written.delete(id);
					dotted.delete(id);
				}
				elements.set(id, el);
				if (id.startsWith("person:")) sizer?.observe(el);
			}
		},
		update(scene, width, height, people, pins, far) {
			matrix.copyFrom(scene.getTransformMatrix());
			const project = (x: number, y: number, z: number): readonly [number, number] | null => {
				point.set(x, y, z);
				Vector3.TransformCoordinatesToRef(point, matrix, out);
				if (out.x < -1.15 || out.x > 1.15 || out.y < -1.15 || out.y > 1.15) return null;
				return [((out.x + 1) / 2) * width, ((1 - out.y) / 2) * height];
			};
			screen.clear();
			dots = 0;
			const labels: (StackedLabel & { key: string; el: HTMLElement | undefined })[] = [];
			for (const p of people) {
				const el = elements.get(`person:${p.key}`);
				const at = project(p.x, p.labelHeight, p.z);
				if (at === null) {
					if (el !== undefined) place(`person:${p.key}`, el, false, 0, 0);
					continue;
				}
				screen.set(p.key, at);
				if (el !== undefined) {
					const small = far && el.hasAttribute("data-idle");
					dot(`person:${p.key}`, el, small);
					if (small) dots += 1;
				}
				labels.push({ key: p.key, el, x: at[0], y: at[1], ...((el === undefined ? undefined : sizes.get(el)) ?? LABEL_SIZE) });
			}
			for (const label of stackLabels(labels)) {
				if (label.el !== undefined) place(`person:${label.key}`, label.el, true, label.x, label.y);
			}
			for (const b of pins) {
				const el = elements.get(`board:${b.id}`);
				if (el === undefined) continue;
				const at = project(b.x, b.y, b.z);
				place(`board:${b.id}`, el, at !== null, at?.[0] ?? 0, at?.[1] ?? 0);
			}
		},
		dispose() {
			sizer?.disconnect();
		},
	};
}
