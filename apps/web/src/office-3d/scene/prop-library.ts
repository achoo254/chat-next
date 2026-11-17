// Furniture and small props: every model name is loaded once and drawn as GPU
// instances wherever the plan places it (one draw call per model part however
// many desks; plan decision M as changed by the spike: only the shell is
// baked, repeated furniture is instanced). Places come in named groups (a
// zone's furniture, a zone's small props) under a parent node each, so a
// group is re-placed or hidden in one go. The asset file ships one props GLB
// per zone holding the models first used there, one
// named node per model (a node of several parts when the model has several
// materials); a GLB is fetched the first time a placed name needs it. Until a
// name's model arrives (or when it has none, or fails) its places show
// placeholder blocks; a model replaces its blocks as soon as it loads.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import type { BlockKit } from "./block-kit.ts";
import { containerModels, modelParts } from "./gltf-models.ts";
import { shapeOf } from "./placeholder-shapes.ts";
import type { Place } from "./scene-layout.ts";

interface Placed {
	readonly place: Place;
	readonly holder: TransformNode;
	nodes: (InstancedMesh | TransformNode)[];
}

export interface PropLibrary {
	/** Places (or re-places) the props of group `key` under `parent`, dropping that group's earlier ones. */
	placeGroup(key: string, parent: TransformNode, places: readonly Place[]): void;
	/** Where each model lives (name → GLB URL); placed names load their GLB on demand from now on. */
	setSources(sources: ReadonlyMap<string, string>, signal: AbortSignal): void;
	/** The meshes the live props light should reach. */
	readonly litMeshes: () => readonly Mesh[];
	dispose(): void;
}

export function createPropLibrary(scene: Scene, kit: BlockKit): PropLibrary {
	const groups = new Map<string, Placed[]>();
	const models = new Map<string, Mesh[]>();
	const containers: AssetContainer[] = [];
	const loading = new Set<string>();
	const failed = new Set<string>();
	let sources: ReadonlyMap<string, string> = new Map();
	let signal: AbortSignal | null = null;
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

	const swapIn = (name: string): void => {
		const parts = models.get(name);
		if (parts === undefined) return;
		for (const list of groups.values()) for (const p of list) if (p.place.name === name) modelFor(p, parts);
	};

	const loadFile = async (url: string, abort: AbortSignal): Promise<void> => {
		loading.add(url);
		try {
			const container = await LoadAssetContainerAsync(url, scene);
			if (abort.aborted || disposed) {
				container.dispose();
				return;
			}
			container.addAllToScene();
			containers.push(container);
			const found = containerModels(container);
			for (const [name, top] of found) {
				if (models.has(name)) continue;
				const parts = modelParts(top);
				if (parts.length === 0) continue;
				for (const part of parts) {
					// Bake the glTF root's handedness flip (and the model node's own transform) into each part so instances place in plain scene units.
					part.setParent(null);
					part.isVisible = false;
					part.isPickable = false;
				}
				models.set(name, parts);
			}
			for (const node of container.transformNodes) if (node.getChildMeshes(false).length === 0) node.setEnabled(false);
			for (const root of container.meshes) if (root.getTotalVertices() === 0) root.setEnabled(false);
			for (const [name, file] of sources) if (file === url && !models.has(name)) console.warn(`office: prop model ${name} missing from ${url}, keeping its block`);
			for (const name of found.keys()) swapIn(name);
		} catch (error) {
			failed.add(url);
			if (!abort.aborted) console.warn(`office: props ${url} not loaded, keeping blocks`, error);
		} finally {
			loading.delete(url);
		}
	};

	/** Starts the GLB fetch for any placed name whose model is listed but not in yet. */
	const ensure = (names: Iterable<string>): void => {
		if (signal === null || disposed) return;
		for (const name of names) {
			if (models.has(name)) continue;
			const url = sources.get(name);
			if (url === undefined || loading.has(url) || failed.has(url)) continue;
			void loadFile(url, signal);
		}
	};

	return {
		placeGroup(key, parent, places) {
			for (const old of groups.get(key) ?? []) old.holder.dispose(false, false);
			const list = places.map((place, i): Placed => {
				const holder = new TransformNode(`prop-${key}-${place.name}-${i}`, scene);
				holder.parent = parent;
				holder.position.set(place.x, place.y, place.z);
				holder.rotation.y = place.rotY;
				holder.computeWorldMatrix(true);
				const p: Placed = { place, holder, nodes: [] };
				const parts = models.get(place.name);
				if (parts === undefined) blockFor(p, i);
				else modelFor(p, parts);
				return p;
			});
			groups.set(key, list);
			ensure(new Set(places.map((p) => p.name)));
		},
		setSources(next, abort) {
			sources = next;
			signal = abort;
			ensure(new Set([...groups.values()].flatMap((list) => list.map((p) => p.place.name))));
		},
		litMeshes: () => [...kit.sources, ...[...models.values()].flat()],
		dispose() {
			disposed = true;
			for (const list of groups.values()) for (const p of list) p.holder.dispose(false, false);
			groups.clear();
			models.clear();
			// The containers own the model parts, their materials and textures.
			for (const container of containers) container.dispose();
			containers.length = 0;
		},
	};
}
