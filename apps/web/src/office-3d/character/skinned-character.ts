// The rigged character (from the character and room spike): one GLB (mesh,
// skin, CC0 clips) loaded once into an AssetContainer, then instantiated per
// person, so every copy shares geometry and texture but owns its skeleton
// and animation groups. Poses pick clips through anim-groups.ts; typing adds
// the swing of typing-motion.ts after the clip posed the arms (restoring the
// clip pose first, since a clip without keys for a bone does not reset it).
// Level of detail runs a clip only every n-th frame at n times the speed
// (goToFrame on a paused group did not pose in this Babylon version).
// Sitting moves the model so the body rests on the seat (the CC0 clips are
// for an adult-sized rig and sit the pelvis well behind the root): for each
// sitting clip, measured once per model on its own posed skin, the pelvis and
// the lowest point of the hips and thighs around it (the model's seat
// contact); the model is lifted so that point lands on the seat's height
// (the anchor's: a cushion less its sink, a beanbag) and slid so the pelvis is
// over the seat's centre, the anchor, instead of behind the chair's back. A
// lying clip lies on the ground at the root, which the people coordinator
// puts at the bed's height. Each copy wears its skin
// cell (character-skins.ts) and its accessory on a bone; the pantry mug shows
// in the hand only while drinking. A model's own typing clip replaces the
// coded typing swing.
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Axis } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import { DEFAULT_SEAT } from "../../machines/office/office-layout.ts";
import { clipFor, isSeatedPose, typesWith, type Pose } from "./anim-groups.ts";
import type { CharacterAccessories, WornAccessory } from "./character-accessories.ts";
import { COFFEE_ITEM, skinCellFor, type PersonLook } from "./character-look.ts";
import type { CharacterSkins } from "./character-skins.ts";
import type { CharacterVisual, ScenePoint } from "./character-visual.ts";
import { typingOffsets } from "./typing-motion.ts";

/** The bones whose skin rests on a seat: the hips and the thighs. */
const SEAT_BONES: ReadonlySet<string> = new Set(["pelvis", "thigh_l", "thigh_r"]);
/** How far from the pelvis across the floor the resting skin is looked for, in the rig's units (the buttocks, not the knees). */
const SEAT_REACH = 0.15;
/** The staff model's pelvis over its resting skin, rig units (measured 17/11/2026): used only for a model without skin weights. */
const FALLBACK_SEAT_CONTACT = 0.026;
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

/** Where a sitting clip puts the pelvis (x, z) and the lowest resting skin (`bottom`), in the person's own frame (holder units, before the model is moved). */
interface ClipSeat {
	readonly x: number;
	readonly z: number;
	readonly bottom: number;
}

/** Where each sitting clip rests, shared by everyone on one model (same rig and skin): measured once per model. */
const seatsByModel = new WeakMap<AssetContainer, Map<string, ClipSeat>>();

/** How far the model moves for a sitting clip: up so the resting skin is on the seat, across so the pelvis is over the anchor. */
export function seatedOffset(rest: ClipSeat, seatHeight: number, scale: number): { readonly x: number; readonly y: number; readonly z: number } {
	return { x: -rest.x, y: seatHeight / scale - rest.bottom, z: -rest.z };
}

/** A seat bone, under its own name or with a copy's suffix (`pelvis-<person>`). */
const isSeatBone = (name: string): boolean => [...SEAT_BONES].some((bone) => name === bone || name.startsWith(`${bone}-`));

/**
 * The lowest point of the skin the hips and thighs carry, within SEAT_REACH of the pelvis across the floor, in the frame
 * `toFrame` maps the world into (each vertex counts for the bone weighing most on it); null without such skin.
 */
export function restingSkinBottom(meshes: readonly AbstractMesh[], toFrame: Matrix, pelvis: Vector3): number | null {
	let bottom = Infinity;
	const point = new Vector3();
	for (const mesh of meshes) {
		const skeleton = mesh.skeleton;
		if (skeleton == null) continue;
		// The skin follows the bones' matrices, which a frame only computes when it draws: compute them for the pose now.
		skeleton.prepare(true);
		// A vertex names its bone by the bone's matrix slot (the glTF joint), not by its place in `bones` (parents come first there).
		const bones = new Map(skeleton.bones.map((bone) => [bone.getIndex(), bone]));
		const positions = mesh.getPositionData(true, true);
		const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
		const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
		if (positions == null || indices == null || weights == null) continue;
		const toMeshFrame = mesh.computeWorldMatrix(true).multiply(toFrame);
		for (let v = 0; v * 3 < positions.length; v += 1) {
			let strongest = 0;
			for (let k = 1; k < 4; k += 1) if ((weights[v * 4 + k] ?? 0) > (weights[v * 4 + strongest] ?? 0)) strongest = k;
			const bone = bones.get(indices[v * 4 + strongest] ?? -1);
			if (bone === undefined || !isSeatBone(bone.name)) continue;
			Vector3.TransformCoordinatesFromFloatsToRef(positions[v * 3] ?? 0, positions[v * 3 + 1] ?? 0, positions[v * 3 + 2] ?? 0, toMeshFrame, point);
			if (Math.hypot(point.x - pelvis.x, point.z - pelvis.z) > SEAT_REACH) continue;
			bottom = Math.min(bottom, point.y);
		}
	}
	return Number.isFinite(bottom) ? bottom : null;
}

export function createSkinnedCharacter(scene: Scene, container: AssetContainer, key: string, index: number, look: PersonLook, dress: CharacterDress): CharacterVisual {
	// The Director's model has its own proportions, so its pelvis heights are not the staff model's.
	let seatOf = seatsByModel.get(container);
	if (seatOf === undefined) {
		seatOf = new Map<string, ClipSeat>();
		seatsByModel.set(container, seatOf);
	}
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
	if (dress.skins !== null) dress.skins.apply(meshes, skinCellFor(look, dress.skins.count, dress.skins.names));
	const worn = (name: string | null, scale = 1): WornAccessory | null =>
		name === null || dress.accessories === null ? null : dress.accessories.attach(name, key, nodes, scale);
	const accessory = worn(look.accessory, look.accessoryScale);
	const mug = look.kind === "director" || look.kind === "employee" ? worn(COFFEE_ITEM) : null;
	mug?.holder.setEnabled(false);
	const showItems = (drinking: boolean): void => {
		mug?.holder.setEnabled(drinking);
		// The mug takes the hand: a hand-held accessory steps aside meanwhile.
		accessory?.holder.setEnabled(!(drinking && mug !== null && accessory.bone === mug.bone));
	};
	let pose: Pose = "stand-idle";
	let seat = DEFAULT_SEAT;
	let clip: string | null = null;
	let every = 1;
	let frame = 0;
	let measure = false;
	const active = (): AnimationGroup | undefined => (clip === null ? undefined : groups.get(clip));
	/** Moves the model for the clip playing: resting on the seat with the pelvis over the anchor when sitting, else back to the root. */
	const placeModel = (): void => {
		const rest = clip === null || !isSeatedPose(pose) ? undefined : seatOf.get(clip);
		if (rest === undefined) model.position.set(0, 0, 0);
		else {
			const o = seatedOffset(rest, seat, CHARACTER_SCALE);
			model.position.set(o.x, o.y, o.z);
		}
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
		placeModel();
		measure = next !== null && isSeatedPose(pose) && !seatOf.has(next);
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
		probe() {
			const at = (name: string): ScenePoint | null => {
				const t = nodes.get(name);
				if (t === undefined) return null;
				const v = t.computeWorldMatrix(true).getTranslation();
				return { x: v.x, y: v.y, z: v.z };
			};
			const min = { x: Infinity, y: Infinity, z: Infinity };
			const max = { x: -Infinity, y: -Infinity, z: -Infinity };
			for (const mesh of meshes) {
				mesh.refreshBoundingInfo({ applySkeleton: true });
				const box = mesh.getBoundingInfo().boundingBox;
				min.x = Math.min(min.x, box.minimumWorld.x);
				min.y = Math.min(min.y, box.minimumWorld.y);
				min.z = Math.min(min.z, box.minimumWorld.z);
				max.x = Math.max(max.x, box.maximumWorld.x);
				max.y = Math.max(max.y, box.maximumWorld.y);
				max.z = Math.max(max.z, box.maximumWorld.z);
			}
			const root = holder.computeWorldMatrix(true).getTranslation();
			// The resting skin's lowest point over the floor (tests: whether the body rests on its seat), found the way the
			// placement finds it: in the holder's frame, then scaled back to metres over the holder.
			const pelvisNode = nodes.get("pelvis");
			const toHolder = Matrix.Invert(holder.computeWorldMatrix(true));
			const pelvisInHolder = pelvisNode === undefined ? null : Vector3.TransformCoordinates(pelvisNode.computeWorldMatrix(true).getTranslation(), toHolder);
			const bottom = pelvisInHolder === null ? null : restingSkinBottom(meshes, toHolder, pelvisInHolder);
			const seatBottom = bottom === null ? null : root.y + bottom * CHARACTER_SCALE;
			return { root: { x: root.x, y: root.y, z: root.z }, pelvis: at("pelvis"), head: at("head"), footL: at("foot_l"), footR: at("foot_r"), seatBottom, min, max };
		},
		root: holder,
		labelHeight: LABEL_HEIGHT_UNSCALED * CHARACTER_SCALE,
		meshes: () => meshes,
		setPose(next, nextSeat = DEFAULT_SEAT) {
			if (next === pose && nextSeat === seat && clip !== null) return;
			const seatChanged = nextSeat !== seat;
			pose = next;
			seat = nextSeat;
			play(clipFor(next, clips));
			if (seatChanged) placeModel();
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
					// In the holder's own frame (unscaled, unturned), without the model's current move.
					const toHolder = Matrix.Invert(holder.computeWorldMatrix(true));
					const at = Vector3.TransformCoordinates(pelvis.computeWorldMatrix(true).getTranslation(), toHolder);
					const bottom = restingSkinBottom(meshes, toHolder, at);
					at.subtractInPlace(model.position);
					// Without skin weights (never for the shipped models), the pelvis rests as high over the seat as the staff's does.
					seatOf.set(clip, { x: at.x, z: at.z, bottom: bottom === null ? at.y - FALLBACK_SEAT_CONTACT : bottom - model.position.y });
					placeModel();
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
