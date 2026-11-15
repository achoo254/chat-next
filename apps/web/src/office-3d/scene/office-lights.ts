// The live lights of the office: a sky light for everything not baked
// (characters, furniture models, placeholder blocks), one key light that on
// the high rungs casts the characters' shadows onto a see-through catcher
// over the floor (plan decision L; furniture shadows live in the lightmaps),
// and the backdrop colour. Values come from office-lighting.ts by the hour.
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { OfficeLight, Rgb } from "./office-lighting.ts";
import type { Rect } from "./scene-layout.ts";
import { ShadowOnlyPlugin } from "./shadow-only-plugin.ts";

export interface OfficeLights {
	apply(light: OfficeLight): void;
	/** 0 turns the shadow light off (blob shadows only). */
	setShadowMapSize(size: number, casters: () => readonly AbstractMesh[]): void;
	/** New characters joined: the shadow light must draw them too. */
	refreshCasters(casters: readonly AbstractMesh[]): void;
	dispose(): void;
}

const color3 = (c: Rgb): Color3 => new Color3(c[0], c[1], c[2]);

export function createOfficeLights(scene: Scene, footprint: Rect): OfficeLights {
	const sky = new HemisphericLight("office-sky", new Vector3(0.1, 1, -0.2), scene);
	const key = new DirectionalLight("office-key", new Vector3(0.45, -0.8, 0.4), scene);
	key.position = new Vector3(-6, 14, -6);
	const [x0, z0, x1, z1] = footprint;
	const catcher = CreateGround("shadow-catcher", { width: x1 - x0, height: z1 - z0 }, scene);
	catcher.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
	catcher.isPickable = false;
	const catcherMaterial = new StandardMaterial("shadow-catcher", scene);
	catcherMaterial.diffuseColor = Color3.White();
	catcherMaterial.specularColor = Color3.Black();
	const plugin = new ShadowOnlyPlugin(catcherMaterial);
	catcherMaterial.alpha = 0.999; // routes the catcher through the transparent pass
	catcher.material = catcherMaterial;
	catcher.receiveShadows = true;
	catcher.setEnabled(false);
	// Only the shadow light reaches the catcher.
	sky.excludedMeshes.push(catcher);
	let generator: ShadowGenerator | null = null;
	const updateCatcher = (): void => {
		plugin.litLevel = Math.max(0.05, -key.direction.normalizeToNew().y) * key.intensity;
	};
	return {
		apply(light) {
			sky.intensity = light.skyIntensity;
			sky.diffuse = color3(light.skyColor);
			sky.groundColor = color3(light.groundColor);
			key.intensity = light.keyIntensity;
			key.diffuse = color3(light.keyColor);
			scene.clearColor = new Color4(light.backdrop[0], light.backdrop[1], light.backdrop[2], 1);
			updateCatcher();
		},
		setShadowMapSize(size, casters) {
			generator?.dispose();
			generator = null;
			catcher.setEnabled(size > 0);
			if (size <= 0) return;
			generator = new ShadowGenerator(size, key);
			generator.usePercentageCloserFiltering = true;
			generator.filteringQuality = ShadowGenerator.QUALITY_LOW;
			generator.bias = 0.002;
			for (const mesh of casters()) generator.addShadowCaster(mesh, false);
			key.autoUpdateExtends = true;
			updateCatcher();
		},
		refreshCasters(casters) {
			if (generator === null) return;
			const map = generator.getShadowMap();
			if (map === null) return;
			map.renderList = [...casters];
		},
		dispose() {
			generator?.dispose();
			catcher.dispose(false, true);
			sky.dispose();
			key.dispose();
		},
	};
}
