// A floor's baked shell (office-floor-N.glb from the bake: slab, walls,
// glass, elevator, stairs, rugs, wall art, joined per material, lightmap UVs
// in the second UV set) with its day and night lightmaps. Every mesh with
// lightmap UVs gets an unlit StandardMaterial with the blend plugin; glass
// gets a plain see-through material; the panes behind the windows glow,
// tinted by the hour (the colours from the shell's extras when given). The
// shell's asset.extras also say where the floor's props stand and how bright
// the lightmap was stored (shell-extras.ts). Loaded into the floor's node;
// the caller hides the placeholder shell once it is in.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { Material } from "@babylonjs/core/Materials/material";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import { LIGHTMAP_HALF_BAKE_SCALE, LightmapBlendPlugin } from "./lightmap-blend.ts";
import { createNightCityTexture } from "./night-city.ts";
import type { Place } from "./scene-layout.ts";
import { gammaScale, NO_SHELL_EXTRAS, parseShellExtras, type Rgb, type ShellExtras } from "./shell-extras.ts";

export interface BakedShell {
	/** Where the floor's props stand per the shell's extras, or null (use the layout's). */
	readonly places: readonly Place[] | null;
	setNightMix(nightMix: number, closed: boolean): void;
	dispose(): void;
}

/** Window panes by day and at night when the shell does not say. */
const WINDOW_DEFAULT: { readonly day: Rgb; readonly night: Rgb } = { day: [1, 1, 1], night: [0.35, 0.38, 0.65] };

/** The baked wood reads orange next to the concept's light brown: calmed this far (lightmap-blend.ts). */
const WOOD_TONE = 1;

/** Things that shine by themselves: [day, night] glow by mesh name. */
const GLOW: readonly (readonly [RegExp, number, number])[] = [
	[/monitor|screen|cctv/i, 0.12, 0.55],
	[/lamp/i, 0, 0.7],
];

function albedoTexture(material: Material | null): Texture | null {
	const pbr = material as Partial<PBRMaterial> | null;
	const texture = pbr?.albedoTexture;
	return texture instanceof Texture ? texture : null;
}

function albedoColor(material: Material | null): Color3 {
	const pbr = material as Partial<PBRMaterial> | null;
	return pbr?.albedoColor?.clone() ?? new Color3(0.8, 0.8, 0.8);
}

export async function loadBakedShell(scene: Scene, parent: TransformNode, urls: { shell: string; day: string; night: string }, signal: AbortSignal): Promise<BakedShell | null> {
	const lightmap = (url: string): Texture => {
		// glTF UVs run v down; the bake wrote the lightmaps for that, so no flip.
		const t = new Texture(url, scene, { noMipmap: false, invertY: false });
		t.wrapU = Texture.CLAMP_ADDRESSMODE;
		t.wrapV = Texture.CLAMP_ADDRESSMODE;
		return t;
	};
	let container: AssetContainer;
	let extras: ShellExtras = NO_SHELL_EXTRAS;
	try {
		container = await LoadAssetContainerAsync(urls.shell, scene, {
			pluginOptions: {
				gltf: {
					onParsed: (data) => {
						extras = parseShellExtras(data.json);
					},
				},
			},
		});
	} catch (error) {
		if (!signal.aborted) console.warn("office: floor shell not loaded, keeping blocks", error);
		return null;
	}
	if (signal.aborted) {
		container.dispose();
		return null;
	}
	const day = lightmap(urls.day);
	const night = lightmap(urls.night);
	const plugins: { plugin: LightmapBlendPlugin; glow: readonly [number, number] | null }[] = [];
	const made = new Map<number, StandardMaterial>();
	const windows: StandardMaterial[] = [];
	const panes: AbstractMesh[] = [];
	for (const mesh of container.meshes) {
		const source = mesh.material;
		if (source === null) continue;
		if (/glass/i.test(mesh.name)) {
			const glass = new StandardMaterial(`glass-${mesh.name}`, scene);
			glass.diffuseColor = new Color3(0.72, 0.8, 0.95);
			glass.specularColor = new Color3(0.3, 0.3, 0.35);
			glass.alpha = 0.26;
			mesh.material = glass;
			continue;
		}
		if (/window-view|window_view/i.test(mesh.name)) {
			const view = new StandardMaterial(`window-${mesh.name}`, scene);
			view.disableLighting = true;
			view.emissiveTexture = albedoTexture(source);
			view.emissiveColor = Color3.White();
			mesh.material = view;
			windows.push(view);
			panes.push(mesh);
			continue;
		}
		if (!mesh.isVerticesDataPresent(VertexBuffer.UV2Kind)) continue;
		let material = made.get(source.uniqueId);
		if (material === undefined) {
			material = new StandardMaterial(`baked-${source.name}`, scene);
			material.disableLighting = true;
			material.specularColor = Color3.Black();
			const texture = albedoTexture(source);
			if (texture !== null) {
				material.diffuseTexture = texture;
				material.emissiveColor = Color3.White();
			} else material.emissiveColor = albedoColor(source);
			const glow = GLOW.find(([re]) => re.test(mesh.name) || re.test(source.name));
			const plugin = new LightmapBlendPlugin(material, day, night);
			plugin.woodTone = WOOD_TONE;
			plugins.push({ plugin, glow: glow === undefined ? null : [glow[1], glow[2]] });
			made.set(source.uniqueId, material);
		}
		mesh.material = material;
	}
	const lightScale = extras.intensityScale === null ? LIGHTMAP_HALF_BAKE_SCALE : gammaScale(extras.intensityScale);
	const windowColours = extras.windowColours ?? WINDOW_DEFAULT;
	const windowDay = Color3.FromArray(windowColours.day);
	const windowNight = Color3.FromArray(windowColours.night);
	container.addAllToScene();
	for (const node of container.rootNodes) node.parent = parent;
	// The lit city over the panes, faded in with the night (drawn just in front of them: no depth fight).
	const city = panes.length === 0 ? null : createNightCityTexture(scene);
	const cityMaterial = new StandardMaterial("window-city", scene);
	// Unlit like the baked materials: a white emissive shows the diffuse texture as drawn.
	cityMaterial.disableLighting = true;
	cityMaterial.diffuseTexture = city;
	cityMaterial.specularColor = Color3.Black();
	cityMaterial.emissiveColor = Color3.White();
	cityMaterial.zOffset = -2;
	cityMaterial.alpha = 0;
	const cityPanes = panes.map((pane) => {
		const copy = pane.clone(`${pane.name}-city`, pane.parent);
		if (copy !== null) copy.material = cityMaterial;
		return copy;
	});
	for (const mesh of container.meshes) {
		mesh.isPickable = false;
		mesh.computeWorldMatrix(true);
		mesh.freezeWorldMatrix();
	}
	return {
		places: extras.places,
		setNightMix(nightMix, closed) {
			for (const { plugin, glow } of plugins) {
				plugin.nightMix = nightMix;
				plugin.scale = lightScale * (closed ? 0.45 : 1);
				plugin.glow = glow === null || closed ? 0 : glow[0] + (glow[1] - glow[0]) * nightMix;
			}
			// Daylight outside by day, the city's dusk blue at night.
			for (const view of windows) view.emissiveColor = Color3.Lerp(windowDay, windowNight, nightMix);
			cityMaterial.alpha = nightMix;
			for (const pane of cityPanes) pane?.setEnabled(nightMix > 0.02);
		},
		dispose() {
			for (const pane of cityPanes) pane?.dispose();
			cityMaterial.dispose();
			city?.dispose();
			container.dispose();
			day.dispose();
			night.dispose();
		},
	};
}
