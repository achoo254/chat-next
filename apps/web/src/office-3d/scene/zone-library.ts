// The four zones of the plan, all shown at once (Babylon culls what the
// camera misses, instance by instance): each built at once from the layout in
// placeholder blocks under its own node, its baked shell swapped in when the
// asset file lists one, furniture placed through the prop library (from the
// layout at first, then from the places the shell's extras list, which are
// the ones its lightmap shadows were baked from). The small props of every
// zone (mugs, papers, sticky notes, desk plants, book stacks) hang under one
// node of their own, so zooming far out hides them all in one go.
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { ZoneId } from "../../machines/office/office-layout.ts";
import { loadBakedShell, type BakedShell } from "./baked-shell.ts";
import type { BlockKit } from "./block-kit.ts";
import { buildPlaceholderZone, zoneOfPoint, type ZoneRect } from "./placeholder-zone.ts";
import type { PropLibrary } from "./prop-library.ts";
import { assetUrl, lightmapPair, type LightmapSize, type SceneAssets } from "./scene-assets.ts";
import type { Place, SceneLayout } from "./scene-layout.ts";

interface ZoneEntry {
	readonly id: ZoneId;
	readonly root: TransformNode;
	readonly blocks: TransformNode;
	baked: BakedShell | null;
	loading: boolean;
}

export interface ZoneLibrary {
	/** The asset file arrived: swap in the baked shells it lists. */
	setAssets(assets: SceneAssets, lightmapSize: LightmapSize): void;
	setNightMix(nightMix: number): void;
	/** Shows or hides the small props of the whole plan. */
	setSmallProps(shown: boolean): void;
	dispose(): void;
}

export function createZoneLibrary(scene: Scene, kit: BlockKit, props: PropLibrary, layout: SceneLayout, zones: readonly ZoneRect[], signal: AbortSignal): ZoneLibrary {
	const smallRoot = new TransformNode("small-props", scene);
	const smallNames = new Set(layout.smallProps.map((p) => p.name));
	let assets: SceneAssets | null = null;
	let size: LightmapSize = 1024;
	let nightMixNow = 0;
	let smallShown = true;

	/** A zone's furniture and small props as two groups (small ones under the shared node). */
	const place = (entry: ZoneEntry, places: readonly Place[]): void => {
		props.placeGroup(entry.id, entry.root, places.filter((p) => !smallNames.has(p.name)));
		props.placeGroup(`${entry.id}-small`, smallRoot, places.filter((p) => smallNames.has(p.name)));
	};

	const bake = (entry: ZoneEntry): void => {
		const files = assets?.zones.get(entry.id);
		const pair = files === undefined ? null : lightmapPair(files, size);
		if (files?.shell == null || pair === null || entry.baked !== null || entry.loading) return;
		entry.loading = true;
		void loadBakedShell(scene, entry.root, { shell: assetUrl(files.shell), day: assetUrl(pair.day), night: assetUrl(pair.night) }, signal).then((baked) => {
			entry.loading = false;
			if (baked === null || signal.aborted) return;
			entry.baked = baked;
			baked.setNightMix(nightMixNow);
			entry.blocks.setEnabled(false);
			if (baked.places !== null) place(entry, baked.places);
		});
	};

	const entries: ZoneEntry[] = zones.map((zone) => {
		const root = new TransformNode(`zone-${zone.id}`, scene);
		const blocks = buildPlaceholderZone(scene, kit, layout, zone, zones, root);
		const entry: ZoneEntry = { id: zone.id, root, blocks, baked: null, loading: false };
		const inZone = (p: Place): boolean => zoneOfPoint(zones, p.x, p.z) === zone.id;
		place(entry, [...layout.props.filter(inZone), ...layout.smallProps.filter(inZone)]);
		return entry;
	});

	return {
		setAssets(next, lightmapSize) {
			assets = next;
			size = lightmapSize;
			for (const entry of entries) bake(entry);
		},
		setNightMix(nightMix) {
			nightMixNow = nightMix;
			for (const entry of entries) entry.baked?.setNightMix(nightMix);
		},
		setSmallProps(shown) {
			if (shown === smallShown) return;
			smallShown = shown;
			smallRoot.setEnabled(shown);
		},
		dispose() {
			for (const entry of entries) {
				entry.baked?.dispose();
				entry.root.dispose(false, false);
			}
			entries.length = 0;
			smallRoot.dispose(false, false);
		},
	};
}
