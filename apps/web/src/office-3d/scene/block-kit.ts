// Placeholder blocks for everything the bake has not delivered yet (plan:
// build with blocks from the layout first, swap in the real models as they
// come, like Chùa Nhỏ's placeholder kit). One unit box drawn as GPU instances
// with a colour per instance, one see-through box for glass and one glowing
// box for screens: a whole placeholder floor costs three draw calls.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

export type BlockLook = "solid" | "glass" | "screen";

export interface BlockSpec {
	readonly x: number;
	/** Bottom of the block. */
	readonly y: number;
	readonly z: number;
	readonly w: number;
	readonly h: number;
	readonly d: number;
	readonly rotY?: number;
	readonly color: string;
	readonly look?: BlockLook;
}

export interface BlockKit {
	/** A block under `parent`; static unless `moving`. */
	block(parent: TransformNode, name: string, spec: BlockSpec, moving?: boolean): InstancedMesh;
	/** The source meshes (for lights and shadow lists). */
	readonly sources: readonly Mesh[];
	readonly screenMaterial: StandardMaterial;
	dispose(): void;
}

const colorCache = new Map<string, Color4>();

export function colorOf(hex: string, alpha = 1): Color4 {
	const key = `${hex}/${alpha}`;
	let c = colorCache.get(key);
	if (c === undefined) {
		const rgb = Color3.FromHexString(/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#999999");
		c = new Color4(rgb.r, rgb.g, rgb.b, alpha);
		colorCache.set(key, c);
	}
	return c;
}

function source(scene: Scene, name: string, material: StandardMaterial): Mesh {
	const mesh = CreateBox(name, { size: 1 }, scene);
	mesh.material = material;
	mesh.registerInstancedBuffer("color", 4);
	mesh.instancedBuffers.color = new Color4(1, 1, 1, 1);
	// The source itself draws nothing; only its instances do.
	mesh.isVisible = false;
	mesh.isPickable = false;
	return mesh;
}

export function createBlockKit(scene: Scene): BlockKit {
	const solidMaterial = new StandardMaterial("block-solid", scene);
	solidMaterial.diffuseColor = Color3.White();
	solidMaterial.specularColor = new Color3(0.08, 0.08, 0.08);
	const glassMaterial = new StandardMaterial("block-glass", scene);
	glassMaterial.diffuseColor = Color3.White();
	glassMaterial.specularColor = new Color3(0.4, 0.4, 0.45);
	glassMaterial.alpha = 0.22;
	glassMaterial.backFaceCulling = false;
	const screenMaterial = new StandardMaterial("block-screen", scene);
	screenMaterial.diffuseColor = Color3.Black();
	screenMaterial.specularColor = Color3.Black();
	screenMaterial.emissiveColor = new Color3(0.55, 0.78, 1);
	screenMaterial.disableLighting = true;
	const meshes: Record<BlockLook, Mesh> = {
		solid: source(scene, "block-solid", solidMaterial),
		glass: source(scene, "block-glass", glassMaterial),
		screen: source(scene, "block-screen", screenMaterial),
	};
	return {
		sources: Object.values(meshes),
		screenMaterial,
		block(parent, name, spec, moving = false) {
			const look = spec.look ?? "solid";
			const instance = meshes[look].createInstance(name);
			instance.parent = parent;
			instance.position.set(spec.x, spec.y + spec.h / 2, spec.z);
			instance.scaling.set(Math.max(0.005, spec.w), Math.max(0.005, spec.h), Math.max(0.005, spec.d));
			instance.rotation.y = spec.rotY ?? 0;
			instance.instancedBuffers.color = colorOf(spec.color, look === "glass" ? 0.3 : 1);
			instance.isPickable = false;
			if (!moving) {
				instance.computeWorldMatrix(true);
				instance.freezeWorldMatrix();
			}
			return instance;
		},
		dispose() {
			for (const mesh of Object.values(meshes)) mesh.dispose(false, true);
		},
	};
}
