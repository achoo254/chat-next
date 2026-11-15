// The rigged character (from the character and room spike): one GLB (mesh,
// skin, CC0 clips) loaded once into an AssetContainer, then instantiated per
// person, so every copy shares geometry and texture but owns its skeleton
// and animation groups. Poses pick clips through anim-groups.ts; typing adds
// the swing of typing-motion.ts after the clip posed the arms (restoring the
// clip pose first, since a clip without keys for a bone does not reset it).
// Level of detail runs a clip only every n-th frame at n times the speed
// (goToFrame on a paused group did not pose in this Babylon version).
// Sitting lifts or lowers the root once per clip so the pelvis lands on the
// seat (the CC0 clips are for an adult-sized rig).
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Axis } from "@babylonjs/core/Maths/math.axis";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import { clipFor, isSeatedPose, typesWith, type Pose } from "./anim-groups.ts";
import type { CharacterVisual } from "./character-visual.ts";
import { typingOffsets } from "./typing-motion.ts";

/** Where the pelvis rests when sitting (seat of the chair model plus its cushion). */
const SEAT_PELVIS_HEIGHT = 0.5;
/** Clip offset between characters, seconds, so they do not move in unison. */
const PHASE_SECONDS = 0.83;

export async function loadCharacterContainer(scene: Scene, url: string): Promise<AssetContainer> {
	const container = await LoadAssetContainerAsync(url, scene);
	if (container.skeletons.length === 0) {
		container.dispose();
		throw new Error(`${url} has no skeleton`);
	}
	return container;
}

const clipFps = (group: AnimationGroup): number => group.targetedAnimations[0]?.animation.framePerSecond ?? 30;

/** Seat lift per sitting clip, shared by everyone (same rig): measured once. */
const seatLift = new Map<string, number>();

export function createSkinnedCharacter(scene: Scene, container: AssetContainer, key: string, index: number): CharacterVisual {
	const suffix = `-${key}`;
	const entries = container.instantiateModelsToScene((name) => `${name}${suffix}`, false, { doNotInstantiate: false });
	const holder = new TransformNode(`person-${key}`, scene);
	const model = entries.rootNodes[0] as TransformNode | undefined;
	if (model === undefined) throw new Error("character has no root node");
	model.parent = holder;
	const strip = (name: string): string => (name.endsWith(suffix) ? name.slice(0, -suffix.length) : name);
	const groups = new Map<string, AnimationGroup>();
	for (const group of entries.animationGroups) {
		group.stop();
		groups.set(strip(group.name), group);
	}
	const clips = new Set(groups.keys());
	const nodes = new Map<string, TransformNode>();
	for (const node of model.getChildTransformNodes(false)) nodes.set(strip(node.name), node);
	const swung = (["l", "r"] as const).flatMap((side) =>
		(["lowerarm", "hand"] as const).map((bone) => ({ side, bone, node: nodes.get(`${bone}_${side}`), base: new Quaternion(), written: null as Quaternion | null })),
	);
	const swing = new Quaternion();
	const meshes: AbstractMesh[] = model.getChildMeshes(false);
	let pose: Pose = "stand-idle";
	let clip: string | null = null;
	let every = 1;
	let frame = 0;
	let measure = false;
	const active = (): AnimationGroup | undefined => (clip === null ? undefined : groups.get(clip));

	const play = (next: string | null): void => {
		if (next === clip) return;
		clip = next;
		for (const [name, group] of groups) {
			if (name === next) {
				group.start(true, every > 1 ? every : 1, group.from, group.to, false);
				group.goToFrame(group.from + ((index * PHASE_SECONDS * clipFps(group)) % Math.max(1, group.to - group.from)));
				if (every === 0) group.pause();
			} else group.stop();
		}
		model.position.y = next !== null && isSeatedPose(pose) ? (seatLift.get(next) ?? 0) : 0;
		measure = next !== null && isSeatedPose(pose) && !seatLift.has(next);
	};

	return {
		root: holder,
		meshes: () => meshes,
		setPose(next) {
			if (next === pose && clip !== null) return;
			pose = next;
			play(clipFor(next, clips));
		},
		setUpdateEvery(next) {
			if (next === every) return;
			every = next;
			const group = active();
			if (group === undefined) return;
			if (next === 0) group.pause();
			else {
				group.speedRatio = next;
				group.play(true);
			}
		},
		tick(seconds) {
			frame += 1;
			const group = active();
			if (group !== undefined && every > 1) {
				if (frame % every === 0) group.play(true);
				else group.pause();
			}
			if (measure && clip !== null) {
				const pelvis = nodes.get("pelvis");
				if (pelvis !== undefined) {
					const lift = SEAT_PELVIS_HEIGHT - (pelvis.computeWorldMatrix(true).getTranslation().y - holder.position.y - model.position.y);
					seatLift.set(clip, lift);
					model.position.y = lift;
				}
				measure = false;
			}
			if (!typesWith(pose) || every === 0) return;
			const o = typingOffsets(seconds, index);
			for (const entry of swung) {
				const { side, bone, node } = entry;
				if (node?.rotationQuaternion == null) continue;
				if (entry.written !== null && node.rotationQuaternion.equalsWithEpsilon(entry.written, 1e-6)) node.rotationQuaternion.copyFrom(entry.base);
				entry.base.copyFrom(node.rotationQuaternion);
				const angle = bone === "lowerarm" ? (side === "l" ? o.lowerarmL : o.lowerarmR) : side === "l" ? o.handL : o.handR;
				Quaternion.RotationAxisToRef(Axis.X, angle, swing);
				node.rotationQuaternion.multiplyInPlace(swing);
				entry.written = node.rotationQuaternion.clone();
			}
		},
		setVisible(visible) {
			holder.setEnabled(visible);
		},
		dispose() {
			for (const group of groups.values()) group.dispose();
			for (const skeleton of entries.skeletons) skeleton.dispose();
			holder.dispose(false, false);
		},
	};
}
