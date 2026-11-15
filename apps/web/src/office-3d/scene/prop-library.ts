// Furniture and small props: every name of the layout is one model loaded
// once and drawn as GPU instances wherever the layout places it, on every
// floor (one draw call per model part however many desks; plan decision M as
// changed by the spike: only the shell is baked, repeated furniture is
// instanced). Until a name's model arrives (or when it fails) its places show
// placeholder blocks; a model replaces its blocks as soon as it loads.
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import type { BlockKit } from "./block-kit.ts";
import { shapeOf } from "./placeholder-shapes.ts";
import type { Place } from "./scene-layout.ts";

interface Placed {
	readonly place: Place;
	readonly holder: TransformNode;
	nodes: (InstancedMesh | TransformNode)[];
}

export interface PropLibrary {
	/** Places a floor's props under `parent`. */
	placeFloor(parent: TransformNode, places: readonly Place[]): void;
	/** Loads the models of `files` (name → URL) and swaps them in as they come. */
	loadModels(files: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void>;
	/** The meshes the live props light should reach. */
	readonly litMeshes: () => readonly Mesh[];
	dispose(): void;
}

export function createPropLibrary(scene: Scene, kit: BlockKit): PropLibrary {
	const placed = new Map<string, Placed[]>();
	const models = new Map<string, Mesh[]>();
	let disposed = false;

	const blockFor = (p: Placed, i: number): void => {
		const s = shapeOf(p.place.name);
		p.nodes = [kit.block(p.holder, `${p.place.name}-${i}`, { x: 0, y: p.place.y > 0 ? 0 : (s.lift ?? 0), z: 0, w: s.w, h: s.h, d: s.d, color: s.color })];
	};

	const modelFor = (p: Placed, parts: readonly Mesh[]): void => {
		for (const node of p.nodes) node.dispose();
		p.nodes = parts.map((part) => {
			const instance = part.createInstance(`${part.name}-${p.holder.name}`);
			instance.parent = p.holder;
			instance.position.copyFrom(part.position);
			instance.scaling.copyFrom(part.scaling);
			instance.rotationQuaternion = part.rotationQuaternion?.clone() ?? null;
			if (instance.rotationQuaternion === null) instance.rotation.copyFrom(part.rotation);
			instance.isPickable = false;
			instance.computeWorldMatrix(true);
			instance.freezeWorldMatrix();
			return instance;
		});
	};

	return {
		placeFloor(parent, places) {
			places.forEach((place, i) => {
				const holder = new TransformNode(`prop-${place.name}-${i}`, scene);
				holder.parent = parent;
				holder.position.set(place.x, place.y, place.z);
				holder.rotation.y = place.rotY;
				holder.computeWorldMatrix(true);
				const p: Placed = { place, holder, nodes: [] };
				const parts = models.get(place.name);
				if (parts === undefined) blockFor(p, i);
				else modelFor(p, parts);
				const list = placed.get(place.name) ?? [];
				list.push(p);
				placed.set(place.name, list);
			});
		},
		async loadModels(files, signal) {
			await Promise.all(
				[...files].map(async ([name, url]) => {
					if (models.has(name)) return;
					try {
						const container = await LoadAssetContainerAsync(url, scene);
						if (signal.aborted || disposed) {
							container.dispose();
							return;
						}
						container.addAllToScene();
						const parts = container.meshes.filter((m): m is Mesh => m.getTotalVertices() > 0 && "createInstance" in m);
						if (parts.length === 0) throw new Error("no geometry");
						for (const part of parts) {
							// Bake the glTF root's handedness flip into each part so instances place in plain scene units.
							part.setParent(null);
							part.isVisible = false;
							part.isPickable = false;
						}
						for (const root of container.meshes) if (root.getTotalVertices() === 0) root.setEnabled(false);
						models.set(name, parts);
						for (const p of placed.get(name) ?? []) modelFor(p, parts);
					} catch (error) {
						if (!signal.aborted) console.warn(`office: prop model ${name} not loaded, keeping its block`, error);
					}
				}),
			);
		},
		litMeshes: () => [...kit.sources, ...[...models.values()].flat()],
		dispose() {
			disposed = true;
			for (const parts of models.values()) for (const part of parts) part.dispose(false, true);
			models.clear();
			placed.clear();
		},
	};
}
