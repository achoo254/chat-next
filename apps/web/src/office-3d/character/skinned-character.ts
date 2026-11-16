// The rigged character (from the character and room spike): one GLB (mesh,
// skin, CC0 clips) loaded once into an AssetContainer, then instantiated per
// person, so every copy shares geometry and texture but owns its skeleton
// and animation groups. Poses pick clips through anim-groups.ts; typing adds
// the swing of typing-motion.ts after the clip posed the arms (restoring the
// clip pose first, since a clip without keys for a bone does not reset it).
// Level of detail runs a clip only every n-th frame at n times the speed
// (goToFrame on a paused group did not pose in this Babylon version).
// Sitting lifts or lowers the model so the pelvis lands on the seat (the CC0
// clips are for an adult-sized rig): the pelvis height of each sitting clip
// is measured once, the lift follows the seat (a chair, a low beanbag). A
// lying clip lies on the ground at the root, which the people coordinator
// puts at the bed's height. Each copy wears its skin
// cell (character-skins.ts) and its accessory on a bone; the pantry mug shows
// in the hand only while drinking. A model's own typing clip replaces the
// coded typing swing.
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
import type { CharacterAccessories, WornAccessory } from "./character-accessories.ts";
import { COFFEE_ITEM, skinCellFor, type PersonLook } from "./character-look.ts";
import type { CharacterSkins } from "./character-skins.ts";
import type { CharacterVisual } from "./character-visual.ts";
import { typingOffsets } from "./typing-motion.ts";

/** Where the pelvis rests when sitting (seat of the chair model plus its cushion), unless the pose says otherwise. */
const SEAT_PELVIS_HEIGHT = 0.5;
/**
 * Size of the model in the room: the concept draws big-headed chibi staff
 * about as tall as a desk and its monitor, so the rig (built near adult desk
 * scale) is enlarged to stay readable in the whole-floor view.
 */
export const CHARACTER_SCALE = 1.35;
/** Name label height over the feet for the rig at its own size, metres (clear of the hair). */
const LABEL_HEIGHT_UNSCALED = 1.4;
/** Clip offset between characters, seconds, so they do not move in unison. */
const PHASE_SECONDS = 0.83;
/** A clip that animates the typing hands itself (no coded swing on top). */
const TYPING_CLIP = "Typing";

/** What dresses a copy of the model: the skins and accessories loaded with it (either may be missing). */
export interface CharacterDress {
	readonly skins: CharacterSkins | null;
	readonly accessories: CharacterAccessories | null;
}

export async function loadCharacterContainer(scene: Scene, url: string): Promise<AssetContainer> {
	const container = await LoadAssetContainerAsync(url, scene);
	if (container.skeletons.length === 0) {
		container.dispose();
		throw new Error(`${url} has no skeleton`);
	}
	return container;
}

const clipFps = (group: AnimationGroup): number => group.targetedAnimations[0]?.animation.framePerSecond ?? 30;

/** Pelvis height of each sitting clip in the model's own units with no lift, shared by everyone (same rig): measured once. */
const pelvisOf = new Map<string, number>();

export function createSkinnedCharacter(scene: Scene, container: AssetContainer, key: string, index: number, look: PersonLook, dress: CharacterDress): CharacterVisual {
	const suffix = `-${key}`;
	const entries = container.instantiateModelsToScene((name) => `${name}${suffix}`, false, { doNotInstantiate: false });
	const holder = new TransformNode(`person-${key}`, scene);
	holder.scaling.setAll(CHARACTER_SCALE);
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
	if (dress.skins !== null) dress.skins.apply(meshes, skinCellFor(look, dress.skins.count));
	const worn = (name: string | null): WornAccessory | null => (name === null || dress.accessories === null ? null : dress.accessories.attach(name, key, nodes));
	const accessory = worn(look.accessory);
	const mug = look.kind === "director" || look.kind === "employee" ? worn(COFFEE_ITEM) : null;
	mug?.holder.setEnabled(false);
	const showItems = (drinking: boolean): void => {
		mug?.holder.setEnabled(drinking);
		// The mug takes the hand: a hand-held accessory steps aside meanwhile.
		accessory?.holder.setEnabled(!(drinking && mug !== null && accessory.bone === mug.bone));
	};
	let pose: Pose = "stand-idle";
	let seat = SEAT_PELVIS_HEIGHT;
	let clip: string | null = null;
	let every = 1;
	let frame = 0;
	let measure = false;
	const active = (): AnimationGroup | undefined => (clip === null ? undefined : groups.get(clip));
	/** The model's lift for the clip playing: the seat over the clip's pelvis when sitting, else none. */
	const liftNow = (): number => {
		if (clip === null || !isSeatedPose(pose)) return 0;
		const pelvis = pelvisOf.get(clip);
		return pelvis === undefined ? 0 : seat / CHARACTER_SCALE - pelvis;
	};

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
		model.position.y = liftNow();
		measure = next !== null && isSeatedPose(pose) && !pelvisOf.has(next);
	};

	const head = nodes.get("head");
	return {
		model: "skinned",
		headOffset() {
			if (head === undefined) return null;
			const at = head.computeWorldMatrix(true).getTranslation();
			const root = holder.computeWorldMatrix(true).getTranslation();
			return { x: at.x - root.x, z: at.z - root.z };
		},
		root: holder,
		labelHeight: LABEL_HEIGHT_UNSCALED * CHARACTER_SCALE,
		meshes: () => meshes,
		setPose(next, nextSeat = SEAT_PELVIS_HEIGHT) {
			if (next === pose && nextSeat === seat && clip !== null) return;
			const seatChanged = nextSeat !== seat;
			pose = next;
			seat = nextSeat;
			play(clipFor(next, clips));
			if (seatChanged) model.position.y = liftNow();
			showItems(next === "coffee" || next === "eat");
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
					// In the model's own (unscaled) units: the pelvis height over the holder, without the current lift.
					const pelvisInModel = (pelvis.computeWorldMatrix(true).getTranslation().y - holder.position.y) / CHARACTER_SCALE - model.position.y;
					pelvisOf.set(clip, pelvisInModel);
					model.position.y = liftNow();
				}
				measure = false;
			}
			if (!typesWith(pose) || every === 0 || clip === TYPING_CLIP) return;
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
