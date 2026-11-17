// What every drawn person offers the people coordinator, whatever draws it:
// a placeholder of blocks (until the character model arrives), the rigged
// character model, or a background service's robot. All stand with their
// root on the floor at the person's position and turn to their heading.
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { UpdateEvery } from "./animation-lod.ts";
import type { Pose } from "./anim-groups.ts";

/** A point in the scene, metres. */
export interface ScenePoint {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

/** Where the body is as drawn now: key bones and the box round the skinned meshes, in scene coordinates (tests only). */
export interface VisualProbe {
	/** The person's root: on the floor, or on the bed's mattress. */
	readonly root: ScenePoint;
	readonly pelvis: ScenePoint | null;
	readonly head: ScenePoint | null;
	readonly footL: ScenePoint | null;
	readonly footR: ScenePoint | null;
	readonly min: ScenePoint;
	readonly max: ScenePoint;
}

export interface CharacterVisual {
	/** What draws it: placeholder blocks, the rigged person, or the service robot. */
	readonly model: "block" | "skinned" | "robot";
	readonly root: TransformNode;
	readonly meshes: () => readonly AbstractMesh[];
	/** Where the name label sits over the feet, metres: just clear of the head. */
	readonly labelHeight: number;
	/** `seat`: where the pelvis rests over the person's root when the pose sits, metres (a chair's height by default). */
	setPose(pose: Pose, seat?: number): void;
	/** Animation level of detail (0 stops the clip). */
	setUpdateEvery(every: UpdateEvery): void;
	/** Per frame: code motion (bobbing, typing swing, head shake) at `seconds` of the scene clock. */
	tick(seconds: number): void;
	setVisible(visible: boolean): void;
	/** A robot dozing over stuck work dims its screen and closes its eyes; people doze by their pose. */
	setDozing?(dozing: boolean): void;
	/** Where the head is from the root on the floor plane, metres, as drawn now (tests: which way a body lies); absent without a head bone. */
	headOffset?(): { readonly x: number; readonly z: number } | null;
	/** Key bones and the body's box as drawn now (tests: whether a body sits on its seat or lies inside its bed); absent for blocks and robots. */
	probe?(): VisualProbe | null;
	dispose(): void;
}
