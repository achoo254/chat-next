// A background service drawn as a toy robot (the asset file's serviceRobot):
// one GLB loaded once, copied per service (shared geometry, own nodes). Its
// body wears its kind's colour (office-cast.ts SERVICE_COLORS, the same as
// the 2D marker; one material per colour, shared), its antenna light blinks
// while it runs, and when it dozes over stuck work its screen dims, its eyes
// close and only the "Zzz" bubble says so. No clips: it stands at its server
// room spot with a slow hover.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { Material } from "@babylonjs/core/Materials/material";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0";
import type { RobotAssets } from "../scene/scene-assets.ts";
import type { PersonLook } from "./character-look.ts";
import type { CharacterVisual } from "./character-visual.ts";

/** Antenna blink: one cycle this long (seconds), lit for the first BLINK_ON of it. */
const BLINK_SECONDS = 1.2;
const BLINK_ON = 0.7;
/** How much of its glow a dozing robot's screen keeps. */
const DIM_SCREEN = 0.12;
/** Hover while awake, metres and radians per second. */
const HOVER_M = 0.012;
const HOVER_SPEED = 2.2;
/** The name label sits this far over the robot's top (its antenna). */
const LABEL_GAP_M = 0.25;

export interface RobotModel {
	create(key: string, look: PersonLook, index: number): CharacterVisual;
	dispose(): void;
}

/** A node and every mesh under it. */
function meshesOf(node: Node): AbstractMesh[] {
	const own = node instanceof AbstractMesh ? [node] : [];
	return [...own, ...node.getChildMeshes(false)];
}

export async function loadRobotModel(scene: Scene, url: string, robot: RobotAssets): Promise<RobotModel> {
	const container: AssetContainer = await LoadAssetContainerAsync(url, scene);
	const known = new Set([...container.transformNodes, ...container.meshes].map((n) => n.name));
	const missing = Object.values(robot.parts).filter((name) => !known.has(name));
	if (missing.length > 0) {
		container.dispose();
		throw new Error(`${url} has no ${missing.join(", ")}`);
	}
	/** Body materials by colour, and the dim screens by source material: shared by every robot. */
	const bodies = new Map<string, Material>();
	const dims = new Map<Material, Material>();

	const bodyMaterial = (source: Material, color: string): Material => {
		const found = bodies.get(color);
		if (found !== undefined) return found;
		const made = source.clone(`robot-body-${color}`);
		if (made === null) return source;
		if (made instanceof PBRMaterial) made.albedoColor = Color3.FromHexString(color).toLinearSpace();
		bodies.set(color, made);
		return made;
	};

	const dimMaterial = (source: Material): Material => {
		const found = dims.get(source);
		if (found !== undefined) return found;
		const made = source.clone(`${source.name}-dim`);
		if (made === null) return source;
		if (made instanceof PBRMaterial) {
			made.emissiveColor = made.emissiveColor.scale(DIM_SCREEN);
			made.emissiveIntensity *= DIM_SCREEN;
			made.albedoColor = made.albedoColor.scale(0.3);
		}
		dims.set(source, made);
		return made;
	};

	return {
		create(key, look, index) {
			const suffix = `-${key}`;
			const entries = container.instantiateModelsToScene((name) => `${name}${suffix}`, false, { doNotInstantiate: true });
			const holder = new TransformNode(`person-${key}`, scene);
			const model = new TransformNode(`person-${key}-model`, scene);
			model.parent = holder;
			for (const node of entries.rootNodes) node.parent = model;
			const part = (name: string): AbstractMesh[] =>
				model.getDescendants(false, (n) => n.name === `${name}${suffix}`).flatMap((n) => meshesOf(n));
			const body = part(robot.parts.body);
			const screen = part(robot.parts.screen);
			const eyes = part(robot.parts.eyes);
			const light = part(robot.parts.light);
			// The body's largest piece is its shell: it takes the kind's colour; trims and the face keep theirs.
			const shell = [...body].sort((a, b) => b.getTotalVertices() - a.getTotalVertices())[0];
			if (shell?.material != null) shell.material = bodyMaterial(shell.material, look.color);
			const screenLit = new Map(screen.flatMap((m) => (m.material === null ? [] : [[m, m.material] as const])));
			const meshes = model.getChildMeshes(false);
			for (const m of meshes) m.isPickable = false;
			const top = model.getHierarchyBoundingVectors(true).max.y;
			const phase = (index * 0.37) % 1;
			let dozing = false;
			let lit = true;
			return {
				model: "robot",
				root: holder,
				labelHeight: (Number.isFinite(top) && top > 0 ? top : robot.heightM) + LABEL_GAP_M,
				meshes: () => meshes,
				setPose() {
					// A robot has no poses: it stands and hovers.
				},
				setUpdateEvery() {
					// Its motion is a hover and a blink, cheap enough every frame.
				},
				tick(seconds) {
					const t = seconds + phase * BLINK_SECONDS;
					model.position.y = dozing ? 0 : Math.sin(t * HOVER_SPEED) * HOVER_M;
					const on = !dozing && t % BLINK_SECONDS < BLINK_ON;
					if (on === lit) return;
					lit = on;
					for (const m of light) m.setEnabled(on);
				},
				setDozing(next) {
					if (next === dozing) return;
					dozing = next;
					for (const m of eyes) m.setEnabled(!next);
					for (const [m, material] of screenLit) m.material = next ? dimMaterial(material) : material;
				},
				setVisible(visible) {
					holder.setEnabled(visible);
				},
				dispose() {
					holder.dispose(false, false);
				},
			};
		},
		dispose() {
			// Only the clones made here; the model's own materials go with the container.
			for (const m of [...bodies.values(), ...dims.values()]) m.dispose();
			container.dispose();
		},
	};
}
