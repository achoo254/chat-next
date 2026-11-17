// Makes the drawn people: placeholder blocks until the character model is
// loaded, the rigged model after (the coordinator rebuilds everyone when it
// arrives) dressed in a skin cell of the atlas and their accessory when those
// load too (each is optional), and under each one a soft blob shadow (one
// instanced quad, every quality rung; plan decision L). A background service
// is drawn as the toy robot once its model is loaded (robot-character.ts),
// as a person until then or when it fails.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import type { AccessoryItem, RobotAssets, SkinAtlas } from "../scene/scene-assets.ts";
import { createBlockBodies, createBlockCharacter } from "./block-character.ts";
import { createCharacterAccessories, type CharacterAccessories } from "./character-accessories.ts";
import type { PersonLook } from "./character-look.ts";
import { createCharacterSkins, loadTexture, type CharacterSkins } from "./character-skins.ts";
import type { CharacterVisual } from "./character-visual.ts";
import { loadRobotModel, type RobotModel } from "./robot-character.ts";
import { createSkinnedCharacter, loadCharacterContainer } from "./skinned-character.ts";

/** The character's files as URLs: the model, and optionally the Director's own model, its skin atlas and the accessories GLB. */
export interface CharacterFiles {
	readonly model: string;
	/** The Director's own model (same skeleton), or null: the Director then wears the staff model. */
	readonly director: string | null;
	readonly skins: { readonly url: string; readonly atlas: SkinAtlas } | null;
	readonly accessories: { readonly url: string; readonly items: ReadonlyMap<string, AccessoryItem> } | null;
}

export interface CharacterPool {
	create(key: string, look: PersonLook, index: number): CharacterVisual;
	/** A blob shadow quad for one person. */
	blob(key: string): InstancedMesh;
	readonly skinned: boolean;
	/** Loads the character model (with skins and accessories when listed); true when the model is in (callers then rebuild their visuals). */
	load(files: CharacterFiles, signal: AbortSignal): Promise<boolean>;
	/** Loads the services' robot; true when it is in (callers then rebuild their visuals). */
	loadRobot(url: string, robot: RobotAssets, signal: AbortSignal): Promise<boolean>;
	dispose(): void;
}

async function loadSkins(scene: Scene, container: AssetContainer, files: CharacterFiles): Promise<CharacterSkins | null> {
	if (files.skins === null) return null;
	try {
		return createCharacterSkins(container, files.skins.atlas, await loadTexture(scene, files.skins.url));
	} catch (error) {
		console.warn("office: skin atlas not loaded, everyone wears the model's own skin", error);
		return null;
	}
}

/** The Director's model: it is optional, so a model that fails to load leaves the Director on the staff model. */
async function loadDirector(scene: Scene, files: CharacterFiles): Promise<AssetContainer | null> {
	if (files.director === null) return null;
	try {
		return await loadCharacterContainer(scene, files.director);
	} catch (error) {
		console.warn("office: director model not loaded, the director wears the staff model", error);
		return null;
	}
}

async function loadAccessories(scene: Scene, files: CharacterFiles): Promise<CharacterAccessories | null> {
	if (files.accessories === null) return null;
	try {
		return createCharacterAccessories(scene, await LoadAssetContainerAsync(files.accessories.url, scene), files.accessories.items);
	} catch (error) {
		console.warn("office: accessories not loaded", error);
		return null;
	}
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
	let directorContainer: AssetContainer | null = null;
	let skins: CharacterSkins | null = null;
	let accessories: CharacterAccessories | null = null;
	let robot: RobotModel | null = null;
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
		create(key, look, index) {
			if (look.kind === "machine" && robot !== null) {
				try {
					return robot.create(key, look, index);
				} catch (error) {
					console.warn("office: robot copy failed, drawing the service as a person", error);
				}
			}
			if (look.kind === "director" && directorContainer !== null) {
				try {
					// Its own texture is the whole look: no skin cell on top.
					return createSkinnedCharacter(scene, directorContainer, key, index, look, { skins: null, accessories });
				} catch (error) {
					console.warn("office: director copy failed, using the staff model", error);
				}
			}
			if (container !== null) {
				try {
					return createSkinnedCharacter(scene, container, key, index, look, { skins, accessories });
				} catch (error) {
					console.warn("office: character copy failed, using a block", error);
				}
			}
			return createBlockCharacter(scene, bodies, key, look.color);
		},
		blob(key) {
			const instance = blob.createInstance(`blob-${key}`);
			instance.rotation.x = Math.PI / 2;
			instance.isPickable = false;
			return instance;
		},
		async load(files, signal) {
			try {
				const loaded = await loadCharacterContainer(scene, files.model);
				const [dressSkins, dressAccessories, loadedDirector] = await Promise.all([
					loadSkins(scene, loaded, files),
					loadAccessories(scene, files),
					loadDirector(scene, files),
				]);
				if (signal.aborted) {
					dressSkins?.dispose();
					dressAccessories?.dispose();
					loadedDirector?.dispose();
					loaded.dispose();
					return false;
				}
				container = loaded;
				directorContainer = loadedDirector;
				skins = dressSkins;
				accessories = dressAccessories;
				return true;
			} catch (error) {
				if (!signal.aborted) console.warn("office: character model not loaded, keeping blocks", error);
				return false;
			}
		},
		async loadRobot(url, assets, signal) {
			try {
				const loaded = await loadRobotModel(scene, url, assets);
				if (signal.aborted) {
					loaded.dispose();
					return false;
				}
				robot = loaded;
				return true;
			} catch (error) {
				if (!signal.aborted) console.warn("office: service robot not loaded, services stay people", error);
				return false;
			}
		},
		dispose() {
			robot?.dispose();
			skins?.dispose();
			accessories?.dispose();
			directorContainer?.dispose();
			container?.dispose();
			bodies.dispose();
			blob.dispose(false, true);
		},
	};
}
