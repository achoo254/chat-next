// The living rooms in the 3D scene, without an engine: the poses of life,
// talk and waking and the clips they pick from the delivered character (with
// fallbacks), where a person lies, runs or sits low, a talk's visitor beside
// the host, and the sounds the people in the camera's view call for.
import { describe, expect, it } from "vitest";
import type { Talk } from "../../src/machines/office/office-conversations.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import type { Placement } from "../../src/machines/office/office-placement.ts";
import { lifeSoundsWanted } from "../../src/office-3d/audio/life-sounds.ts";
import { clipFor, isLyingPose, isSeatedPose, poseFor, type PoseInput } from "../../src/office-3d/character/anim-groups.ts";
import { personIntent } from "../../src/office-3d/character/person-intent.ts";
import { personTarget } from "../../src/office-3d/character/person-target.ts";

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

/** The clips of the delivered character (character.*.glb). */
const DELIVERED = new Set([
	"Clapping",
	"Consume",
	"Consume_Item",
	"Dance_Simple",
	"Idle_Listening",
	"Idle_A",
	"Idle_Talking",
	"Idle_TalkingPhone",
	"Interact",
	"Jog",
	"Jumping_Jacks",
	"LayToIdle",
	"PickUp_Table",
	"Punch_Jab",
	"Pushup",
	"Sit_Ground_Idle",
	"Sleeping",
	"Victory",
	"Walk",
	"Sitting_Idle",
	"Sitting_Talking",
	"Sitting_Writing",
	"Typing",
]);
/** The character before the living clips. */
const OLDER = new Set(["Walk", "Sitting_Idle", "Sitting_Writing", "Sitting_Talking", "Idle_A", "Interact", "Idle_TalkingPhone", "Consume", "Victory", "PickUp_Table"]);

const base: PoseInput = { moving: false, seated: false, group: null, idle: null, cheering: false, refused: false };

describe("poses of life", () => {
	it("sleeps, trains, eats, watches and dances, and work or a walk always comes first", () => {
		expect(poseFor({ ...base, life: "sleep" })).toBe("sleep");
		expect(poseFor({ ...base, life: "run" })).toBe("run");
		expect(poseFor({ ...base, life: "pushup" })).toBe("pushup");
		expect(poseFor({ ...base, life: "punch" })).toBe("punch");
		expect(poseFor({ ...base, seated: true, life: "eat" })).toBe("sit-eat");
		expect(poseFor({ ...base, life: "eat" })).toBe("eat");
		expect(poseFor({ ...base, seated: true, life: "watch" })).toBe("watch");
		expect(poseFor({ ...base, seated: true, low: true, life: "watch" })).toBe("watch-low");
		expect(poseFor({ ...base, life: "dance" })).toBe("dance");
		expect(poseFor({ ...base, life: "lounge" })).toBe("lounge");
		expect(poseFor({ ...base, moving: true, life: "lounge" })).toBe("walk");
		expect(poseFor({ ...base, seated: true, life: "doze" })).toBe("sit-idle");
		expect(poseFor({ ...base, moving: true, life: "sleep" })).toBe("walk");
		expect(poseFor({ ...base, group: "type", life: "sleep" })).toBe("stand-type");
		expect(poseFor({ ...base, moving: true, waking: true })).toBe("wake");
	});

	it("talks, listens and claps", () => {
		expect(poseFor({ ...base, talk: "speak" })).toBe("talk");
		expect(poseFor({ ...base, seated: true, talk: "speak" })).toBe("sit-talk");
		expect(poseFor({ ...base, talk: "listen", life: "watch" })).toBe("listen");
		expect(poseFor({ ...base, talk: "clap" })).toBe("clap");
	});

	it("picks the delivered clips, push-ups as jumping jacks, and falls back on an older character", () => {
		const clip = (pose: Parameters<typeof clipFor>[0], set: ReadonlySet<string>) => clipFor(pose, set);
		expect(clip("sleep", DELIVERED)).toBe("Sleeping");
		expect(clip("wake", DELIVERED)).toBe("LayToIdle");
		// Lying back has its own clip; a model without it lies as the sleeper does.
		expect(clip("lounge", new Set([...DELIVERED, "Lying_Lounge"]))).toBe("Lying_Lounge");
		expect(clip("lounge", DELIVERED)).toBe("Sleeping");
		expect(clip("run", DELIVERED)).toBe("Jog");
		expect(clip("pushup", DELIVERED)).toBe("Jumping_Jacks");
		expect(clip("punch", DELIVERED)).toBe("Punch_Jab");
		expect(clip("eat", DELIVERED)).toBe("Consume_Item");
		expect(clip("watch-low", DELIVERED)).toBe("Sit_Ground_Idle");
		expect(clip("dance", DELIVERED)).toBe("Dance_Simple");
		expect(clip("talk", DELIVERED)).toBe("Idle_Talking");
		expect(clip("listen", DELIVERED)).toBe("Idle_Listening");
		expect(clip("clap", DELIVERED)).toBe("Clapping");
		for (const pose of ["sleep", "wake", "run", "pushup", "jacks", "punch", "eat", "sit-eat", "watch", "watch-low", "dance", "talk", "sit-talk", "listen", "clap"] as const) {
			expect(clip(pose, OLDER), pose).not.toBeNull();
		}
		expect(isLyingPose("sleep")).toBe(true);
		expect(isLyingPose("lounge")).toBe(true);
		expect(isSeatedPose("watch-low")).toBe(true);
		expect(isSeatedPose("run")).toBe(false);
	});
});

describe("places of the living rooms", () => {
	it("lies on the bed's mattress, runs on the treadmill's belt, sits low on a beanbag", () => {
		expect(personTarget(layout(), "bed-0", 0, false)).toMatchObject({ y: 0.5, seated: false });
		expect(personTarget(layout(), "gym-run-0", 0, false)?.y).toBeCloseTo(0.17);
		// The seat's height is the anchor's, from the furniture under it: a beanbag near the floor, a hard dining chair at its top.
		expect(personTarget(layout(), "tv-5", 0, false)).toMatchObject({ seated: true, low: true, seat: 0.225 });
		expect(personTarget(layout(), "dine-2", 0, false)).toMatchObject({ seated: true, low: false, seat: 0.519 });
		// A second person at a bed stands beside it on the floor.
		expect(personTarget(layout(), "bed-0", 1, false)?.y).toBe(0);
	});

	it("sends a talk's visitor beside the host, the standing host turning to them, and no idle show meanwhile", () => {
		const placement = (key: string, anchorId: string): Placement => ({
			key,
			kind: "employee",
			actor: null,
			member: null,
			room: "LOUNGE",
			anchorId,
			since: 0,
			activityRoom: null,
			life: { slot: "evening", act: "watch" },
			advisor: null,
			concurrent: 0,
			workKey: key,
		});
		const talk: Talk = {
			host: "a#1",
			visitor: "b#1",
			hostAnchor: "counter-0",
			zone: "d",
			topic: "testsPass",
			start: 0,
			end: 20_000,
			lines: [
				{ speaker: "b#1", text: "Một", from: 6_000, to: 9_000 },
				{ speaker: "a#1", text: "Hai", from: 9_000, to: 12_000 },
			],
		};
		const ctx = { enabled: true, pantry: [], sofas: [], occupiedDesks: [] };
		const visitor = personIntent(placement("b#1", "tv-0"), [talk], 7_000, ctx);
		expect(visitor).toMatchObject({ anchorId: "counter-0", beside: true, talk: "speak", idle: null });
		const host = personIntent(placement("a#1", "counter-0"), [talk], 7_000, ctx);
		expect(host).toMatchObject({ anchorId: "counter-0", beside: false, talk: "listen" });
		expect(host.turn).toBeCloseTo(Math.PI / 2);
		// The visitor claps at the host's last line of good news.
		expect(personIntent(placement("b#1", "tv-0"), [talk], 10_000, ctx).talk).toBe("clap");
		// Before the first line they only walk over.
		expect(personIntent(placement("b#1", "tv-0"), [talk], 1_000, ctx).talk).toBeNull();
		// After it, back to their own place.
		expect(personIntent(placement("b#1", "tv-0"), [talk], 21_000, ctx).anchorId).toBe("tv-0");
		// Gone to bed meanwhile (the talk was picked while they were awake): they lie at their bed as it faces.
		const asleep = (key: string): Placement => ({ ...placement(key, "bed-0"), room: "DORM", life: { slot: "sleep", act: "sleep" } });
		expect(personIntent(asleep("a#1"), [talk], 7_000, ctx)).toMatchObject({ anchorId: "bed-0", beside: false, turn: 0, talk: null });
		expect(personIntent(asleep("b#1"), [talk], 1_000, ctx)).toMatchObject({ anchorId: "bed-0", beside: false, turn: 0, talk: null });
	});
});

describe("sounds of life", () => {
	it("loops the treadmill, the TV and snoring, and cues punches, cutlery and TV cheers, for people in view only", () => {
		const living = [
			{ visible: true, pose: "run" as const, dozing: false },
			{ visible: true, pose: "sleep" as const, dozing: false },
			{ visible: true, pose: "watch" as const, dozing: false },
			{ visible: true, pose: "punch" as const, dozing: false },
			{ visible: true, pose: "sit-eat" as const, dozing: false },
		];
		const dozer = { visible: true, pose: "stand-idle" as const, dozing: true };
		const all = lifeSoundsWanted([...living, dozer]);
		expect([...all.loops].sort()).toEqual(["snore", "treadmill", "tv-show"]);
		expect([...all.cues].sort()).toEqual(["cheer-tv", "cutlery", "punch"]);
		// The living rooms panned out of view: only the dozer at work is heard.
		const away = lifeSoundsWanted([...living.map((p) => ({ ...p, visible: false })), dozer]);
		expect([...away.loops]).toEqual(["snore"]);
		expect(away.cues.size).toBe(0);
		expect(lifeSoundsWanted([{ ...dozer, visible: false }]).loops.size).toBe(0);
	});
});
