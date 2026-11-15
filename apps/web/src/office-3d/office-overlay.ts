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
}

/** Height of the label point over a person's feet, metres. */
const HEAD_HEIGHT = 1.45;

export function createOfficeOverlay(): OfficeOverlay {
	const elements = new Map<string, HTMLElement>();
	const written = new Map<string, string>();
	const screen = new Map<string, readonly [number, number]>();
	const point = new Vector3();
	const out = new Vector3();
	const matrix = new Matrix();

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
			if (el === null) {
				elements.delete(id);
				written.delete(id);
			} else elements.set(id, el);
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
			for (const p of people) {
				const el = elements.get(`person:${p.key}`);
				const at = p.visible && p.floor === shown ? project(p.x, HEAD_HEIGHT, p.z) : null;
				if (at !== null) screen.set(p.key, at);
				if (el !== undefined) place(`person:${p.key}`, el, at !== null, at?.[0] ?? 0, at?.[1] ?? 0);
			}
			for (const b of boards) {
				const el = elements.get(`board:${b.id}`);
				if (el === undefined) continue;
				const at = b.floor === shown ? project(b.x, b.y, b.z) : null;
				place(`board:${b.id}`, el, at !== null, at?.[0] ?? 0, at?.[1] ?? 0);
			}
		},
	};
}
