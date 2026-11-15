// The three floors of the building, each a diorama under its own node: built
// from the layout in blocks the first time it is needed (floor 1 at start,
// the others when shown or when the scene is idle), its baked shell swapped
// in when the asset file lists one, furniture placed through the prop
// library (from the layout at first, then from the places the shell's extras
// list, which are the ones its lightmap shadows were baked from). Only the
// floor shown is enabled (plan decision P): the others cost no draw calls.
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { FloorLevel } from "../../machines/office/office-rooms.ts";
import { loadBakedShell, type BakedShell } from "./baked-shell.ts";
import type { BlockKit } from "./block-kit.ts";
import { buildPlaceholderShell } from "./placeholder-floor.ts";
import type { PropLibrary } from "./prop-library.ts";
import { assetUrl, lightmapPair, type LightmapSize, type SceneAssets } from "./scene-assets.ts";
import { sceneFloor, type SceneLayout } from "./scene-layout.ts";

interface FloorEntry {
	readonly root: TransformNode;
	readonly blocks: TransformNode;
	baked: BakedShell | null;
	loading: boolean;
}

export interface FloorLibrary {
	/** Builds the floor if needed and shows only it. */
	show(level: FloorLevel): void;
	readonly shown: FloorLevel;
	/** Builds a floor ahead of time (hidden). */
	prepare(level: FloorLevel): void;
	/** The asset file arrived: swap in baked shells (built floors now, others when built). */
	setAssets(assets: SceneAssets, lightmapSize: LightmapSize): void;
	setNightMix(nightMix: number, closed: boolean): void;
	dispose(): void;
}

export function createFloorLibrary(scene: Scene, kit: BlockKit, props: PropLibrary, layout: SceneLayout, signal: AbortSignal): FloorLibrary {
	const floors = new Map<FloorLevel, FloorEntry>();
	let shown: FloorLevel = 1;
	let assets: SceneAssets | null = null;
	let size: LightmapSize = 1024;
	let light = { nightMix: 0, closed: false };

	const bake = (level: FloorLevel, entry: FloorEntry): void => {
		const files = assets?.floors.get(level);
		const pair = files === undefined ? null : lightmapPair(files, size);
		if (files?.shell == null || pair === null || entry.baked !== null || entry.loading) return;
		entry.loading = true;
		void loadBakedShell(scene, entry.root, { shell: assetUrl(files.shell), day: assetUrl(pair.day), night: assetUrl(pair.night) }, signal).then((baked) => {
			entry.loading = false;
			if (baked === null || signal.aborted) return;
			entry.baked = baked;
			baked.setNightMix(light.nightMix, light.closed);
			entry.blocks.setEnabled(false);
			if (baked.places !== null) props.placeFloor(level, entry.root, baked.places);
		});
	};

	const build = (level: FloorLevel): FloorEntry | null => {
		const existing = floors.get(level);
		if (existing !== undefined) return existing;
		const floor = sceneFloor(layout, level);
		if (floor === undefined) return null;
		const root = new TransformNode(`floor-${level}`, scene);
		root.setEnabled(false);
		const blocks = buildPlaceholderShell(scene, kit, layout, floor, root);
		props.placeFloor(level, root, [...floor.props, ...floor.smallProps]);
		const entry: FloorEntry = { root, blocks, baked: null, loading: false };
		floors.set(level, entry);
		bake(level, entry);
		return entry;
	};

	return {
		get shown() {
			return shown;
		},
		show(level) {
			shown = level;
			build(level);
			for (const [l, entry] of floors) entry.root.setEnabled(l === level);
		},
		prepare(level) {
			build(level);
		},
		setAssets(next, lightmapSize) {
			assets = next;
			size = lightmapSize;
			for (const [level, entry] of floors) bake(level, entry);
		},
		setNightMix(nightMix, closed) {
			light = { nightMix, closed };
			for (const entry of floors.values()) entry.baked?.setNightMix(nightMix, closed);
		},
		dispose() {
			for (const entry of floors.values()) {
				entry.baked?.dispose();
				entry.root.dispose(false, false);
			}
			floors.clear();
		},
	};
}
