// Skin variants of the one character model (plan decision 6: one mesh, many
// textures): the asset file ships every skin in one atlas; each cell in use
// gets a copy of the model's material whose colour texture reads that cell
// (a texture transform over the shared atlas: one picture on the GPU, one
// material per skin). People wearing the same skin share its material.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Material } from "@babylonjs/core/Materials/material";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { skinCell, type SkinAtlas } from "../scene/scene-assets.ts";

export interface CharacterSkins {
	/** Skins available (0 or 1 means only the model's own texture). */
	readonly count: number;
	/** Dresses one person's meshes in skin `cell` (the model's own look when there is no atlas). */
	apply(meshes: readonly AbstractMesh[], cell: number): void;
	dispose(): void;
}

/** A material whose colour texture can be swapped (PBR from the glTF loader, or standard). */
interface Textured {
	albedoTexture?: unknown;
	diffuseTexture?: unknown;
}

/** Loads a texture and resolves once its picture is on the GPU. */
export function loadTexture(scene: Scene, url: string): Promise<Texture> {
	return new Promise((resolve, reject) => {
		// With an options object the constructor reads the callbacks from it, not from its later arguments.
		const texture: Texture = new Texture(url, scene, {
			invertY: false,
			noMipmap: false,
			onLoad: () => resolve(texture),
			onError: (message) => {
				texture.dispose();
				reject(new Error(message ?? `texture ${url} not loaded`));
			},
		});
	});
}

export function createCharacterSkins(container: AssetContainer, atlas: SkinAtlas | null, picture: Texture | null): CharacterSkins {
	const source: Material | undefined = container.materials[0];
	const made = new Map<number, Material>();
	const textures: Texture[] = [];
	const usable = atlas !== null && picture !== null && source !== undefined;

	const materialFor = (cell: number): Material | null => {
		if (!usable) return null;
		const existing = made.get(cell);
		if (existing !== undefined) return existing;
		const material = source.clone(`${source.name}-skin-${cell}`);
		if (material === null) return null;
		const t = skinCell(atlas, cell);
		const texture = picture.clone();
		texture.uScale = t.uScale;
		texture.vScale = t.vScale;
		texture.uOffset = t.uOffset;
		texture.vOffset = t.vOffset;
		textures.push(texture);
		const slot = material as Material & Textured;
		if ("albedoTexture" in slot) {
			const old = slot.albedoTexture;
			slot.albedoTexture = texture;
			if (old instanceof Texture && old !== (source as Material & Textured).albedoTexture) old.dispose();
		} else slot.diffuseTexture = texture;
		made.set(cell, material);
		return material;
	};

	return {
		count: usable ? atlas.count : 0,
		apply(meshes, cell) {
			const material = materialFor(cell);
			if (material === null || source === undefined) return;
			for (const mesh of meshes) if (mesh.material === source) mesh.material = material;
		},
		dispose() {
			for (const material of made.values()) material.dispose(false, false);
			for (const texture of textures) texture.dispose();
			picture?.dispose();
			made.clear();
		},
	};
}
