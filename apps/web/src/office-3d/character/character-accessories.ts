// What people hold or wear (office-cast.ts accessories, the pantry mug): the
// asset file ships one GLB with a named node per accessory, each with its
// offset from the bone it hangs from, plus that bone and a scale (the models
// are real-sized, the chibi head is much larger). Every accessory is drawn as
// GPU instances (one draw call per accessory part for everyone wearing it),
// each instance parented to its wearer's bone node so it follows the clips.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { containerModels, modelParts } from "../scene/gltf-models.ts";
import type { AccessoryItem } from "../scene/scene-assets.ts";

interface LocalTransform {
	readonly position: Vector3;
	readonly rotation: Quaternion;
	readonly scaling: Vector3;
}

interface AccessoryModel {
	readonly bone: string;
	/** The accessory node's offset from the bone, its scale times the item's. */
	readonly offset: LocalTransform;
	/** Parts relative to the accessory node. */
	readonly parts: readonly { readonly mesh: Mesh; readonly local: LocalTransform }[];
}

export interface WornAccessory {
	readonly name: string;
	readonly bone: string;
	readonly holder: TransformNode;
}

export interface CharacterAccessories {
	readonly names: ReadonlySet<string>;
	/** Hangs accessory `name` on the matching bone node of one person, or null when the item or bone is missing. */
	attach(name: string, key: string, bones: ReadonlyMap<string, TransformNode>): WornAccessory | null;
	dispose(): void;
}

const IDENTITY: LocalTransform = { position: Vector3.Zero(), rotation: Quaternion.Identity(), scaling: Vector3.One() };

function localOf(node: TransformNode): LocalTransform {
	return {
		position: node.position.clone(),
		rotation: node.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(node.rotation),
		scaling: node.scaling.clone(),
	};
}

function apply(node: TransformNode, t: LocalTransform): void {
	node.position.copyFrom(t.position);
	node.rotationQuaternion = t.rotation.clone();
	node.scaling.copyFrom(t.scaling);
}

export function createCharacterAccessories(scene: Scene, container: AssetContainer, items: ReadonlyMap<string, AccessoryItem>): CharacterAccessories {
	const models = new Map<string, AccessoryModel>();
	const tops = containerModels(container);
	container.addAllToScene();
	for (const [name, item] of items) {
		const top = tops.get(name);
		if (top === undefined) continue;
		const meshes = modelParts(top);
		if (meshes.length === 0) continue;
		// Offsets in the GLB's own (glTF) axes: the bone nodes of the character are in the same axes under its own root.
		const offset = localOf(top);
		offset.scaling.scaleInPlace(item.scale);
		const parts = meshes.map((mesh) => ({ mesh, local: mesh === top ? IDENTITY : localOf(mesh) }));
		for (const { mesh } of parts) {
			mesh.setParent(null);
			mesh.isVisible = false;
			mesh.isPickable = false;
		}
		models.set(name, { bone: item.bone, offset, parts });
	}
	for (const node of container.transformNodes) if (node.getChildMeshes(false).length === 0) node.setEnabled(false);
	for (const root of container.meshes) if (root.getTotalVertices() === 0) root.setEnabled(false);
	const unknown = [...items.keys()].filter((name) => !models.has(name));
	if (unknown.length > 0) console.info(`office: accessories without a model: ${unknown.join(", ")}`);

	return {
		names: new Set(models.keys()),
		attach(name, key, bones) {
			const model = models.get(name);
			const bone = model === undefined ? undefined : bones.get(model.bone);
			if (model === undefined || bone === undefined) return null;
			const holder = new TransformNode(`accessory-${name}-${key}`, scene);
			holder.parent = bone;
			apply(holder, model.offset);
			for (const { mesh, local } of model.parts) {
				const instance = mesh.createInstance(`${mesh.name}-${key}`);
				instance.parent = holder;
				apply(instance, local);
				instance.isPickable = false;
			}
			return { name, bone: model.bone, holder };
		},
		dispose() {
			models.clear();
			container.dispose();
		},
	};
}
