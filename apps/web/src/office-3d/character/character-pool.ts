// Makes the drawn people: placeholder blocks until the character model is
// loaded, the rigged model after (the coordinator rebuilds everyone when it
// arrives), and under each one a soft blob shadow (one instanced quad, every
// quality rung; plan decision L).
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Scene } from "@babylonjs/core/scene";
import { createBlockBodies, createBlockCharacter } from "./block-character.ts";
import type { CharacterVisual } from "./character-visual.ts";
import { createSkinnedCharacter, loadCharacterContainer } from "./skinned-character.ts";

export interface CharacterPool {
	create(key: string, color: string, index: number): CharacterVisual;
	/** A blob shadow quad for one person. */
	blob(key: string): InstancedMesh;
	readonly skinned: boolean;
	/** Loads the character model; true when it is in (callers then rebuild their visuals). */
	load(url: string, signal: AbortSignal): Promise<boolean>;
	dispose(): void;
}

const BLOB_SIZE = 0.8;

function blobTexture(scene: Scene): RawTexture {
	const size = 64;
	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const d = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
			data.set([0, 0, 0, Math.round(Math.max(0, 1 - d) ** 1.6 * 255)], (y * size + x) * 4);
		}
	}
	return RawTexture.CreateRGBATexture(data, size, size, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
}

export function createCharacterPool(scene: Scene): CharacterPool {
	const bodies = createBlockBodies(scene);
	let container: AssetContainer | null = null;
	const blobMaterial = new StandardMaterial("blob", scene);
	const blobMap = blobTexture(scene);
	blobMaterial.diffuseTexture = blobMap;
	blobMap.hasAlpha = true;
	blobMaterial.useAlphaFromDiffuseTexture = true;
	blobMaterial.disableLighting = true;
	blobMaterial.emissiveColor = Color3.Black();
	blobMaterial.alpha = 0.5;
	const blob = CreatePlane("blob", { size: BLOB_SIZE }, scene);
	blob.material = blobMaterial;
	blob.rotation.x = Math.PI / 2;
	blob.isVisible = false;
	blob.isPickable = false;
	return {
		get skinned() {
			return container !== null;
		},
		create(key, color, index) {
			if (container !== null) {
				try {
					return createSkinnedCharacter(scene, container, key, index);
				} catch (error) {
					console.warn("office: character copy failed, using a block", error);
				}
			}
			return createBlockCharacter(scene, bodies, key, color);
		},
		blob(key) {
			const instance = blob.createInstance(`blob-${key}`);
			instance.rotation.x = Math.PI / 2;
			instance.isPickable = false;
			return instance;
		},
		async load(url, signal) {
			try {
				const loaded = await loadCharacterContainer(scene, url);
				if (signal.aborted) {
					loaded.dispose();
					return false;
				}
				container = loaded;
				return true;
			} catch (error) {
				if (!signal.aborted) console.warn("office: character model not loaded, keeping blocks", error);
				return false;
			}
		},
		dispose() {
			container?.dispose();
			bodies.dispose();
			blob.dispose(false, true);
		},
	};
}
