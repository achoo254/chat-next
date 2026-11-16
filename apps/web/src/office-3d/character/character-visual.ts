// What every drawn person offers the people coordinator, whatever draws it:
// a placeholder of blocks (until the character model arrives) or the rigged
// character model. Both stand with their root on the floor at the person's
// position and turn to their heading.
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { UpdateEvery } from "./animation-lod.ts";
import type { Pose } from "./anim-groups.ts";

export interface CharacterVisual {
	readonly root: TransformNode;
	readonly meshes: () => readonly AbstractMesh[];
	/** Where the name label sits over the feet, metres: just clear of the head. */
	readonly labelHeight: number;
	setPose(pose: Pose): void;
	/** Animation level of detail (0 stops the clip). */
	setUpdateEvery(every: UpdateEvery): void;
	/** Per frame: code motion (bobbing, typing swing, head shake) at `seconds` of the scene clock. */
	tick(seconds: number): void;
	setVisible(visible: boolean): void;
	dispose(): void;
}
