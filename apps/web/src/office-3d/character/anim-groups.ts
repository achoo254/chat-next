// What a character does with its body: from walking or standing still, sitting
// or not, the animation group of its activity (plan decision 3: read, type,
// machine, phone, arrive, hand-in, think; an unknown tool types), a recent
// pass (a cheer) or a refusal at Security (a head shake), and the idle show.
// Each pose names the clips it prefers, first one the model has wins, so a
// clip phase 4 adds later (a typing clip, a standing idle) takes over without
// code changes. Pure, no engine.
import type { AnimGroup } from "../../machines/office/office-state.ts";
import type { IdleAct } from "./idle-performer.ts";

export type Pose =
	| "walk"
	| "sit-idle"
	| "sit-type"
	| "sit-read"
	| "sit-think"
	| "sit-phone"
	| "stand-idle"
	| "stand-read"
	| "stand-type"
	| "stand-machine"
	| "stand-think"
	| "phone"
	| "hand-in"
	| "cheer"
	| "shake-head"
	| "coffee"
	| "chat"
	| "yawn";

export interface PoseInput {
	readonly moving: boolean;
	readonly seated: boolean;
	/** The group of the activity being done now; null when free. */
	readonly group: AnimGroup | null;
	readonly idle: IdleAct | null;
	/** The latest activity passed a moment ago. */
	readonly cheering: boolean;
	/** Refused at Security a moment ago. */
	readonly refused: boolean;
}

const SEATED: Readonly<Record<AnimGroup, Pose>> = {
	read: "sit-read",
	type: "sit-type",
	machine: "sit-type",
	phone: "sit-phone",
	arrive: "sit-idle",
	"hand-in": "sit-read",
	think: "sit-think",
};

const STANDING: Readonly<Record<AnimGroup, Pose>> = {
	read: "stand-read",
	type: "stand-type",
	machine: "stand-machine",
	phone: "phone",
	arrive: "stand-idle",
	"hand-in": "hand-in",
	think: "stand-think",
};

export function poseFor(input: PoseInput): Pose {
	if (input.moving) return "walk";
	if (input.refused) return "shake-head";
	if (input.cheering) return "cheer";
	if (input.group !== null) return input.seated ? SEATED[input.group] : STANDING[input.group];
	if (input.idle === "coffee") return "coffee";
	if (input.idle === "chat") return "chat";
	if (input.idle === "yawn") return "yawn";
	return input.seated ? "sit-idle" : "stand-idle";
}

/** Clips each pose prefers, best first (names as in the character GLB). */
export const POSE_CLIPS: Readonly<Record<Pose, readonly string[]>> = {
	walk: ["Walk"],
	"sit-idle": ["Sitting_Idle"],
	"sit-type": ["Sitting_Typing", "Typing", "Sitting Writing", "Sitting_Idle"],
	"sit-read": ["Sitting Writing", "Sitting_Idle"],
	"sit-think": ["Sitting_Idle"],
	"sit-phone": ["Sitting_Talking", "Sitting_Idle"],
	"stand-idle": ["Idle_A", "Idle", "Consume"],
	"stand-read": ["Interact", "PickUp_Table"],
	"stand-type": ["Interact", "PickUp_Table"],
	"stand-machine": ["Interact", "PickUp_Table"],
	"stand-think": ["Head Nod", "Idle_A", "Consume"],
	phone: ["Idle_TalkingPhone"],
	"hand-in": ["PickUp_Table", "Interact"],
	cheer: ["Cheering_Two_Hands", "Victory"],
	"shake-head": ["Idle_A", "Idle", "Consume"],
	coffee: ["Consume"],
	chat: ["Sitting_Talking", "Sitting_Idle"],
	yawn: ["Idle_A", "Idle", "Sitting_Idle"],
};

/** The clip to play for a pose with the clips the model has, or null (code motion only). */
export function clipFor(pose: Pose, available: ReadonlySet<string>): string | null {
	return POSE_CLIPS[pose].find((name) => available.has(name)) ?? null;
}

/** Poses that add the typing swing on top of the clip. */
export function typesWith(pose: Pose): boolean {
	return pose === "sit-type";
}

export function isSeatedPose(pose: Pose): boolean {
	return pose.startsWith("sit-") || pose === "chat";
}
