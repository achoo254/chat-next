// Keeps the HTML over the canvas on the 3D points it belongs to: each
// person's name, status dot and speech bubble over their head, and the room
// boards at their board anchors. React renders the elements
// (office-canvas.tsx) and binds them here by key; every frame this moves
// them with a transform (no React render per frame) and hides those on
// another floor or off the canvas.
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { FloorLevel } from "../machines/office/office-rooms.ts";
import type { PersonView } from "./character/office-people.ts";

export interface BoardPin {
	readonly id: string;
	readonly floor: FloorLevel;
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface OfficeOverlay {
	bind(id: string, el: HTMLElement | null): void;
	/** Positions every bound element; `width`/`height`: the canvas in CSS pixels. */
	update(scene: Scene, width: number, height: number, shown: FloorLevel, people: readonly PersonView[], boards: readonly BoardPin[]): void;
	/** Screen position (CSS px) of each person shown, for tests. */
	readonly screen: ReadonlyMap<string, readonly [number, number]>;
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

	const place = (id: string, el: HTMLElement, visible: boolean, x: number, y: number): void => {
		const value = visible ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)` : "hidden";
		if (written.get(id) === value) return;
		written.set(id, value);
		el.hidden = !visible;
		if (visible) el.style.transform = value;
	};

	return {
		screen,
		bind(id, el) {
			const before = elements.get(id);
			if (before !== undefined && before !== el && id.startsWith("person:")) sizer?.unobserve(before);
			if (el === null) {
				elements.delete(id);
				written.delete(id);
			} else {
				elements.set(id, el);
				if (id.startsWith("person:")) sizer?.observe(el);
			}
		},
		update(scene, width, height, shown, people, boards) {
			matrix.copyFrom(scene.getTransformMatrix());
			const project = (x: number, y: number, z: number): readonly [number, number] | null => {
				point.set(x, y, z);
				Vector3.TransformCoordinatesToRef(point, matrix, out);
				if (out.x < -1.15 || out.x > 1.15 || out.y < -1.15 || out.y > 1.15) return null;
				return [((out.x + 1) / 2) * width, ((1 - out.y) / 2) * height];
			};
			screen.clear();
			const labels: (StackedLabel & { key: string; el: HTMLElement | undefined })[] = [];
			for (const p of people) {
				const el = elements.get(`person:${p.key}`);
				const at = p.visible && p.floor === shown ? project(p.x, p.labelHeight, p.z) : null;
				if (at === null) {
					if (el !== undefined) place(`person:${p.key}`, el, false, 0, 0);
					continue;
				}
				screen.set(p.key, at);
				labels.push({ key: p.key, el, x: at[0], y: at[1], ...((el === undefined ? undefined : sizes.get(el)) ?? LABEL_SIZE) });
			}
			for (const label of stackLabels(labels)) {
				if (label.el !== undefined) place(`person:${label.key}`, label.el, true, label.x, label.y);
			}
			for (const b of boards) {
				const el = elements.get(`board:${b.id}`);
				if (el === undefined) continue;
				const at = b.floor === shown ? project(b.x, b.y, b.z) : null;
				place(`board:${b.id}`, el, at !== null, at?.[0] ?? 0, at?.[1] ?? 0);
			}
		},
		dispose() {
			sizer?.disconnect();
		},
	};
}
