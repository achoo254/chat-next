// A person as placeholder blocks until the character model arrives: a
// capsule body in the person's colour (office-cast.ts, the same as in 2D) and
// a round head, drawn as GPU instances (two draw calls for everyone). The
// poses are code motion only: a walking bob, sitting lower, a lean at work,
// a tilt on the phone, a jump for a cheer, a head shake when refused.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { colorOf } from "../scene/block-kit.ts";
import type { Pose } from "./anim-groups.ts";
import { isSeatedPose } from "./anim-groups.ts";
import type { CharacterVisual } from "./character-visual.ts";

export interface BlockBodies {
	readonly body: Mesh;
	readonly head: Mesh;
	dispose(): void;
}

const BODY_HEIGHT = 0.78;
const HEAD = 0.44;
const SKIN = "#f2cfb3";

export function createBlockBodies(scene: Scene): BlockBodies {
	const material = new StandardMaterial("person-block", scene);
	material.diffuseColor = Color3.White();
	material.specularColor = new Color3(0.12, 0.12, 0.12);
	const body = CreateCapsule("person-body", { height: BODY_HEIGHT, radius: 0.22, tessellation: 12, subdivisions: 2 }, scene);
	const head = CreateSphere("person-head", { diameter: HEAD, segments: 10 }, scene);
	for (const mesh of [body, head]) {
		mesh.material = material;
		mesh.registerInstancedBuffer("color", 4);
		mesh.instancedBuffers.color = new Color4(1, 1, 1, 1);
		mesh.isVisible = false;
		mesh.isPickable = false;
	}
	return {
		body,
		head,
		dispose() {
			body.dispose(false, true);
			head.dispose(false, true);
		},
	};
}

export function createBlockCharacter(scene: Scene, bodies: BlockBodies, key: string, color: string): CharacterVisual {
	const root = new TransformNode(`person-${key}`, scene);
	const torso = new TransformNode(`person-${key}-torso`, scene);
	torso.parent = root;
	const body = bodies.body.createInstance(`person-${key}-body`);
	body.parent = torso;
	body.position.y = BODY_HEIGHT / 2;
	body.instancedBuffers.color = colorOf(color);
	const head = bodies.head.createInstance(`person-${key}-head`);
	head.parent = torso;
	head.position.y = BODY_HEIGHT + HEAD * 0.38;
	head.instancedBuffers.color = colorOf(SKIN);
	let pose: Pose = "stand-idle";
	let every = 1;
	let frame = 0;
	const phase = (key.length * 0.37) % 1;
	return {
		model: "block",
		root,
		meshes: () => [body, head],
		labelHeight: 1.4,
		setPose(next) {
			pose = next;
		},
		setUpdateEvery(next) {
			every = next;
		},
		tick(seconds) {
			frame += 1;
			if (every === 0 || frame % every !== 0) return;
			const t = seconds + phase * 10;
			const seated = isSeatedPose(pose);
			torso.position.y = seated ? 0.28 : 0;
			torso.scaling.y = seated ? 0.82 : 1;
			torso.rotation.set(0, 0, 0);
			head.rotation.set(0, 0, 0);
			switch (pose) {
				case "walk":
					torso.position.y = Math.abs(Math.sin(t * 9)) * 0.05;
					torso.rotation.z = Math.sin(t * 9) * 0.05;
					break;
				case "sit-type":
				case "stand-type":
					head.rotation.x = 0.15 + Math.sin(t * 14) * 0.03;
					torso.rotation.x = 0.1;
					break;
				case "sit-read":
				case "stand-read":
				case "hand-in":
					head.rotation.x = 0.3;
					break;
				case "stand-machine":
					torso.rotation.x = 0.16;
					break;
				case "phone":
				case "sit-phone":
					head.rotation.z = 0.3;
					break;
				case "sit-think":
				case "stand-think":
					head.rotation.z = Math.sin(t * 0.8) * 0.15;
					head.rotation.x = -0.1;
					break;
				case "cheer":
					torso.position.y = Math.abs(Math.sin(t * 7)) * 0.25;
					break;
				case "shake-head":
					head.rotation.y = Math.sin(t * 12) * 0.5;
					break;
				case "coffee":
					head.rotation.x = -0.2 + Math.max(0, Math.sin(t * 1.2)) * -0.2;
					break;
				case "chat":
					head.rotation.y = Math.sin(t * 0.9) * 0.3;
					break;
				case "sleep":
					// Lying on the bed (the root is at the mattress).
					torso.rotation.x = -Math.PI / 2;
					torso.position.y = 0.22;
					break;
				case "run":
				case "jacks":
				case "pushup":
				case "dance":
					torso.position.y = Math.abs(Math.sin(t * (pose === "dance" ? 4 : 8))) * 0.12;
					torso.rotation.z = pose === "dance" ? Math.sin(t * 4) * 0.2 : 0;
					break;
				case "talk":
				case "sit-talk":
				case "clap":
					head.rotation.x = Math.sin(t * 5) * 0.08;
					break;
				case "listen":
					head.rotation.z = 0.15;
					break;
				case "yawn":
					torso.scaling.y = (seated ? 0.82 : 1) * (1 + Math.max(0, Math.sin(t * 1.5)) * 0.07);
					break;
				default:
					torso.position.y += Math.sin(t * 1.6) * 0.008;
			}
		},
		setVisible(visible) {
			root.setEnabled(visible);
		},
		dispose() {
			root.dispose(false, false);
		},
	};
}
