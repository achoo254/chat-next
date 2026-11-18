// The ring on the floor under the person whose inspector panel is open: one
// small unlit mesh, made the first time someone is chosen and switched off when
// none is, so with nobody chosen it costs nothing. It is translucent on purpose:
// the depth pass of the depth-of-field effect skips translucent meshes, and it
// is never added to the shadow casters, so it is one draw call and no more.
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

/** Across the ring, metres: wider than a person standing. */
const DIAMETER_M = 1.1;
const THICKNESS_M = 0.07;
/** Just over the floor and its shadow blobs. */
const FLOOR_Y = 0.03;

export interface SelectionRing {
	/** Puts the ring under (x, z), drawn. */
	show(x: number, z: number): void;
	/** Switches it off. */
	hide(): void;
	/** Whether it is drawn now, for tests. */
	readonly visible: boolean;
	dispose(): void;
}

export function createSelectionRing(scene: Scene): SelectionRing {
	let mesh: Mesh | null = null;
	let material: StandardMaterial | null = null;
	const build = (): Mesh => {
		const m = CreateTorus("selection-ring", { diameter: DIAMETER_M, thickness: THICKNESS_M, tessellation: 24 }, scene);
		const mat = new StandardMaterial("selection-ring", scene);
		mat.diffuseColor = Color3.Black();
		mat.specularColor = Color3.Black();
		mat.emissiveColor = Color3.FromHexString("#8f7cff");
		mat.disableLighting = true;
		mat.alpha = 0.9;
		m.material = mat;
		m.isPickable = false;
		m.receiveShadows = false;
		m.doNotSyncBoundingInfo = true;
		m.alwaysSelectAsActiveMesh = true;
		material = mat;
		return m;
	};
	return {
		show(x, z) {
			mesh ??= build();
			mesh.position.set(x, FLOOR_Y, z);
			if (!mesh.isEnabled()) mesh.setEnabled(true);
		},
		hide() {
			if (mesh !== null && mesh.isEnabled()) mesh.setEnabled(false);
		},
		get visible() {
			return mesh !== null && mesh.isEnabled();
		},
		dispose() {
			mesh?.dispose();
			material?.dispose();
			mesh = null;
			material = null;
		},
	};
}
