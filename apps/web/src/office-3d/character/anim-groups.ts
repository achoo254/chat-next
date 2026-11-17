// What a character does with its body: from walking or standing still, sitting
// or not, the animation group of its activity (plan decision 3: read, type,
// machine, phone, arrive, hand-in, think; asking Advisor talks: the asker
// standing beside Advisor's seat, Advisor seated; an unknown tool types), a recent
// pass (a cheer) or a refusal at Security (a head shake), a conversation
// (talking, listening, clapping), life on the living floor (sleeping in a
// bed and getting up, the gym, meals, the TV, dancing) and the idle show.
// Each pose names the clips it prefers, first one the model has wins, so a
// clip phase 4 adds later (a typing clip, a standing idle) takes over without
// code changes. Pure, no engine.
import type { LifeAct } from "../../machines/office/office-life-schedule.ts";
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
	| "yawn"
	| "sleep"
	| "lounge"
	| "wake"
	| "run"
	| "pushup"
	| "jacks"
	| "punch"
	| "eat"
	| "sit-eat"
	| "watch"
	| "watch-low"
	| "dance"
	| "talk"
	| "sit-talk"
	| "listen"
	| "clap";

/** A person's part in a conversation now. */
export type TalkRole = "speak" | "listen" | "clap";

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
	/** What they do on the living floor (once there); null or absent elsewhere. */
	readonly life?: LifeAct | null;
	/** Their part in a conversation; null or absent when not talking. */
	readonly talk?: TalkRole | null;
	/** Getting out of bed before walking off. */
	readonly waking?: boolean;
	/** Sitting low (a beanbag). */
	readonly low?: boolean;
}

const SEATED: Readonly<Record<AnimGroup, Pose>> = {
	read: "sit-read",
	type: "sit-type",
	machine: "sit-type",
	phone: "sit-phone",
	arrive: "sit-idle",
	"hand-in": "sit-read",
	think: "sit-think",
	consult: "sit-talk",
};

const STANDING: Readonly<Record<AnimGroup, Pose>> = {
	read: "stand-read",
	type: "stand-type",
	machine: "stand-machine",
	phone: "phone",
	arrive: "stand-idle",
	"hand-in": "hand-in",
	think: "stand-think",
	consult: "talk",
};

function lifePose(act: LifeAct, seated: boolean, low: boolean): Pose {
	switch (act) {
		case "sleep":
			return "sleep";
		case "lounge":
			return "lounge";
		case "doze":
			return seated ? "sit-idle" : "stand-idle";
		case "eat":
			return seated ? "sit-eat" : "eat";
		case "watch":
			return low ? "watch-low" : seated ? "watch" : "stand-idle";
		case "chat":
			return seated ? "sit-talk" : "talk";
		default:
			// run, pushup, jacks, punch and dance are poses of the same name.
			return act;
	}
}

export function poseFor(input: PoseInput): Pose {
	if (input.waking === true) return "wake";
	if (input.moving) return "walk";
	if (input.refused) return "shake-head";
	if (input.cheering) return "cheer";
	if (input.group !== null) return input.seated ? SEATED[input.group] : STANDING[input.group];
	const talk = input.talk ?? null;
	if (talk === "clap") return "clap";
	if (talk === "speak") return input.seated ? "sit-talk" : "talk";
	if (talk === "listen") return input.seated ? (input.low === true ? "watch-low" : "sit-idle") : "listen";
	const life = input.life ?? null;
	if (life !== null) return lifePose(life, input.seated, input.low === true);
	if (input.idle === "coffee") return "coffee";
	if (input.idle === "chat") return "chat";
	if (input.idle === "yawn") return "yawn";
	return input.seated ? "sit-idle" : "stand-idle";
}

/** Clips each pose prefers, best first (names as in the character GLB). */
export const POSE_CLIPS: Readonly<Record<Pose, readonly string[]>> = {
	walk: ["Walk"],
	"sit-idle": ["Sitting_Idle"],
	"sit-type": ["Sitting_Typing", "Typing", "Sitting_Writing", "Sitting Writing", "Sitting_Idle"],
	"sit-read": ["Sitting_Writing", "Sitting Writing", "Sitting_Idle"],
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
	sleep: ["Sleeping", "Sitting_Idle"],
	lounge: ["Lying_Lounge", "Sleeping", "Sitting_Idle"],
	wake: ["LayToIdle", "Idle_A"],
	run: ["Jog", "Run", "Walk"],
	// The rig's push-up sinks the big chibi head into the floor: the mat's exercise is jumping jacks.
	pushup: ["Jumping_Jacks", "Pushup", "Idle_A"],
	jacks: ["Jumping_Jacks", "Idle_A"],
	punch: ["Punch_Jab", "Interact"],
	eat: ["Consume_Item", "Eating", "Consume"],
	"sit-eat": ["Sitting_Writing", "Sitting Writing", "Sitting_Idle"],
	watch: ["Sitting_Idle"],
	"watch-low": ["Sit_Ground_Idle", "Sitting_Idle"],
	dance: ["Dance_Simple", "Dance", "Victory"],
	talk: ["Idle_Talking", "Idle_TalkingPhone", "Idle_A"],
	"sit-talk": ["Sitting_Talking", "Sitting_Idle"],
	listen: ["Idle_Listening", "Idle_A"],
	clap: ["Clapping", "Victory"],
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
	return pose.startsWith("sit-") || pose === "chat" || pose === "watch" || pose === "watch-low";
}

/** Lying down: the clip lies on the ground at the model's root, which goes to the bed's height. */
export function isLyingPose(pose: Pose): boolean {
	return pose === "sleep" || pose === "lounge";
}
