// Effects tied to the rooms: a glowing screen at each desk where someone
// works (and, after dark, a warm desk lamp beside it), blinking lights on the server racks while background machines run,
// a puff of smoke over someone whose last tool failed, and a letter flying
// from the lobby door to the reception desk when a new turn starts, and the
// lounge's TV screen glowing in shifting colours while someone watches. All
// blocks from the shared kit (instances: a draw call or two in all) but the
// TV's screen (its own material: one more draw call while it glows). Placed
// in plan coordinates under one node; Babylon culls what the camera misses.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { OfficeState } from "../../machines/office/office-store.ts";
import type { PersonView } from "../character/office-people.ts";
import type { BlockKit } from "./block-kit.ts";
import type { SceneLayout } from "./scene-layout.ts";

export interface RoomFx {
	update(state: OfficeState): void;
	/** `lampGlow`: how bright the desk lamps burn (0 by day, office-lighting.ts). */
	frame(seconds: number, people: readonly PersonView[], screenGlow: number, lampGlow: number): void;
	dispose(): void;
}

const PUFFS = 3;
/** The warm light of a desk lamp at night (the concept's yellow pools of light). */
const LAMP_COLOR = new Color3(1, 0.72, 0.38);
/** Beside the monitor along the desk, and up at a lamp head's height, metres. */
const LAMP_SIDE = 0.38;
const LAMP_UP = 0.3;
const MAIL_SECONDS = 1.6;
/** The TV's screen over its stand: size, height of its centre, and how far in front of the stand, metres. */
const TV_SCREEN = { w: 1.5, h: 0.84, y: 1.12, front: 0.14 } as const;
/** Poses of someone watching the TV. */
const WATCHING: ReadonlySet<string> = new Set(["watch", "watch-low", "dance"]);

export function createRoomFx(scene: Scene, kit: BlockKit, layout: SceneLayout): RoomFx {
	const root = new TransformNode("room-fx", scene);
	const screens = new Map<string, InstancedMesh>();
	const lamps = new Map<string, InstancedMesh>();
	const lampMaterial = new StandardMaterial("desk-lamp", scene);
	lampMaterial.diffuseColor = Color3.Black();
	lampMaterial.specularColor = Color3.Black();
	lampMaterial.disableLighting = true;
	const lamp = CreateSphere("desk-lamp", { diameter: 0.18, segments: 8 }, scene);
	lamp.material = lampMaterial;
	lamp.isVisible = false;
	lamp.isPickable = false;
	const leds: { mesh: InstancedMesh; phase: number }[] = [];
	const tvMaterial = new StandardMaterial("tv-screen", scene);
	tvMaterial.diffuseColor = Color3.Black();
	tvMaterial.specularColor = Color3.Black();
	tvMaterial.disableLighting = true;
	tvMaterial.backFaceCulling = false;
	const tvs: ReturnType<typeof CreatePlane>[] = [];
	layout.props.forEach((p, i) => {
		if (p.name === "monitor" && p.anchor !== "") {
			const screen = kit.block(root, `screen-${p.anchor}`, { x: p.x + Math.sin(p.rotY) * 0.05, y: p.y + 0.08, z: p.z + Math.cos(p.rotY) * 0.05, w: 0.48, h: 0.3, d: 0.01, rotY: p.rotY, color: "#ffffff", look: "screen" });
			screen.setEnabled(false);
			screens.set(p.anchor, screen);
			const bulb = lamp.createInstance(`lamp-${p.anchor}`);
			bulb.parent = root;
			bulb.position.set(p.x + Math.cos(p.rotY) * LAMP_SIDE, p.y + LAMP_UP, p.z - Math.sin(p.rotY) * LAMP_SIDE);
			bulb.isPickable = false;
			bulb.setEnabled(false);
			lamps.set(p.anchor, bulb);
		}
		if (p.name === "tv-stand") {
			const screen = CreatePlane(`tv-screen-${i}`, { width: TV_SCREEN.w, height: TV_SCREEN.h }, scene);
			screen.material = tvMaterial;
			screen.parent = root;
			screen.isPickable = false;
			// The plane faces -z by default; the stand's rotY turns it to the room.
			screen.position.set(p.x + Math.sin(p.rotY) * TV_SCREEN.front, TV_SCREEN.y, p.z + Math.cos(p.rotY) * TV_SCREEN.front);
			screen.rotation.y = p.rotY + Math.PI;
			screen.setEnabled(false);
			tvs.push(screen);
		}
		if (p.name === "server-rack") {
			for (let k = 0; k < 3; k += 1) {
				const led = kit.block(root, `led-${i}-${k}`, { x: p.x + Math.sin(p.rotY) * 0.46, y: 0.9 + k * 0.32, z: p.z + Math.cos(p.rotY) * 0.46, w: 0.3, h: 0.04, d: 0.01, rotY: p.rotY, color: "#ffffff", look: "screen" });
				leds.push({ mesh: led, phase: i * 1.7 + k * 0.9 });
			}
		}
	});
	const smokeMaterial = new StandardMaterial("smoke", scene);
	smokeMaterial.diffuseColor = new Color3(0.42, 0.42, 0.46);
	smokeMaterial.specularColor = Color3.Black();
	smokeMaterial.alpha = 0.55;
	const puff = CreateSphere("smoke-puff", { diameter: 0.3, segments: 6 }, scene);
	puff.material = smokeMaterial;
	puff.isVisible = false;
	puff.isPickable = false;
	const puffs = new Map<string, InstancedMesh[]>();
	const door = layout.doors.find((d) => d.id === "entrance");
	const desk = layout.props.find((p) => p.name === "reception-desk");
	const mail = kit.block(root, "mail", { x: 0, y: 0, z: 0, w: 0.3, h: 0.02, d: 0.2, color: "#fff4d6" }, true);
	mail.setEnabled(false);
	let lastTurn = -1;
	let mailStart: number | null = null;
	let machines = 0;
	let now = 0;
	return {
		update(state) {
			machines = state.session.backgroundMachines;
			if (lastTurn >= 0 && state.lastTurnStart > lastTurn) mailStart = now;
			lastTurn = state.lastTurnStart;
		},
		frame(seconds, people, screenGlow, lampGlow) {
			now = seconds;
			const working = new Set(people.filter((p) => p.working && p.deskAnchor !== null).map((p) => p.deskAnchor));
			for (const [anchor, screen] of screens) screen.setEnabled(screenGlow > 0 && working.has(anchor));
			for (const [anchor, bulb] of lamps) bulb.setEnabled(lampGlow > 0.05 && working.has(anchor));
			lampMaterial.emissiveColor.copyFrom(LAMP_COLOR).scaleInPlace(Math.min(1, lampGlow) * 1.6);
			kit.screenMaterial.emissiveColor.set(0.55 * (0.4 + screenGlow), 0.78 * (0.4 + screenGlow), 1 * (0.4 + screenGlow));
			const watched = people.some((p) => WATCHING.has(p.pose));
			for (const tv of tvs) tv.setEnabled(watched);
			if (watched) {
				// A programme's light: slow shifts of hue with a flicker of cuts.
				const cut = Math.floor(seconds / 2.7);
				const hue = (Math.sin(cut * 12.9898) * 43758.5453) % 1;
				const h = Math.abs(hue);
				tvMaterial.emissiveColor.set(0.45 + 0.4 * Math.sin(h * 6.28), 0.5 + 0.35 * Math.sin(h * 6.28 + 2.1), 0.6 + 0.35 * Math.sin(h * 6.28 + 4.2));
			}
			const rate = machines > 0 ? 2 + Math.min(6, machines) : 0.4;
			for (const led of leds) led.mesh.setEnabled(Math.sin(seconds * rate * Math.PI + led.phase) > -0.2);
			const smoking = new Set<string>();
			for (const p of people) {
				if (!p.smoking) continue;
				smoking.add(p.key);
				let list = puffs.get(p.key);
				if (list === undefined) {
					list = Array.from({ length: PUFFS }, (_, k) => {
						const m = puff.createInstance(`puff-${p.key}-${k}`);
						m.isPickable = false;
						return m;
					});
					puffs.set(p.key, list);
				}
				list.forEach((m, k) => {
					const t = (seconds * 0.6 + k / PUFFS) % 1;
					m.position.set(p.x + Math.sin(t * 6 + k) * 0.12, 1.3 + t * 0.9, p.z);
					m.scaling.setAll(0.6 + t * 1.2);
				});
			}
			for (const [key, list] of puffs) {
				if (smoking.has(key)) continue;
				for (const m of list) m.dispose();
				puffs.delete(key);
			}
			if (door !== undefined && desk !== undefined) {
				const t = mailStart === null ? 1 : (seconds - mailStart) / MAIL_SECONDS;
				mail.setEnabled(t < 1);
				if (t < 1) mail.position.set(door.at[0] + (desk.x - door.at[0]) * t, 1.1 + Math.sin(t * Math.PI) * 0.8, door.at[1] + (desk.z - door.at[1]) * t);
				else mailStart = null;
			}
		},
		dispose() {
			for (const list of puffs.values()) for (const m of list) m.dispose();
			puff.dispose(false, true);
			for (const tv of tvs) tv.dispose(false, false);
			tvMaterial.dispose();
			lamp.dispose(false, true);
			root.dispose(false, false);
		},
	};
}
