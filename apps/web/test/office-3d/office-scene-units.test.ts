// The small pure parts of the 3D office: lighting by the hour, the render
// loop gate, animation level of detail, poses, the idle show, the level of
// detail by zoom, frame timing and the address switches.
import { describe, expect, it } from "vitest";
import { animationRates, type LodEntry } from "../../src/office-3d/character/animation-lod.ts";
import { clipFor, isSeatedPose, poseFor, typesWith } from "../../src/office-3d/character/anim-groups.ts";
import { ACT_MS, IDLE_AFTER_MS, idlePerformance, SLOT_MS, type IdleContext, type IdlePerson } from "../../src/office-3d/character/idle-performer.ts";
import { FrameStats } from "../../src/office-3d/engine/frame-stats.ts";
import { LOOP_START, loopShouldRun } from "../../src/office-3d/engine/render-loop-gate.ts";
import { office3DFlags } from "../../src/office-3d/office-flags.ts";
import { officeLighting } from "../../src/office-3d/scene/office-lighting.ts";
import { FAR_PIXELS_PER_METRE, NEAR_PIXELS_PER_METRE, nextFar } from "../../src/office-3d/scene/zoom-detail.ts";

describe("office lighting", () => {
	it("blends from day to night and stays within the table", () => {
		const day = officeLighting(0);
		const night = officeLighting(1);
		const dusk = officeLighting(0.5);
		expect(night.skyIntensity).toBeLessThan(day.skyIntensity);
		expect(night.screenGlow).toBeGreaterThan(day.screenGlow);
		expect(night.bloomWeight).toBeGreaterThan(day.bloomWeight);
		// Desk lamps burn only after dark, and less at dusk.
		expect(day.deskLamp).toBe(0);
		expect(night.deskLamp).toBe(1);
		expect(dusk.deskLamp).toBeCloseTo(0.5);
		expect(night.exposure).toBeLessThan(day.exposure);
		expect(dusk.skyIntensity).toBeCloseTo((day.skyIntensity + night.skyIntensity) / 2);
		expect(officeLighting(-3)).toEqual(day);
		expect(officeLighting(7)).toEqual(night);
		expect(officeLighting(Number.NaN)).toEqual(day);
	});
});

describe("render loop gate", () => {
	it("runs only while the page shows, the canvas is on screen, the app is in front and the GPU is there", () => {
		expect(loopShouldRun(LOOP_START)).toBe(true);
		expect(loopShouldRun({ ...LOOP_START, pageVisible: false })).toBe(false);
		expect(loopShouldRun({ ...LOOP_START, onScreen: false })).toBe(false);
		expect(loopShouldRun({ ...LOOP_START, appActive: false })).toBe(false);
		expect(loopShouldRun({ ...LOOP_START, contextLost: true })).toBe(false);
	});
});

describe("animation level of detail", () => {
	const entry = (key: string, over: Partial<LodEntry> = {}): LodEntry => ({ key, onScreen: true, active: false, distance: 1, ...over });

	it("gives the busiest and nearest full rate, then half, then a quarter", () => {
		const rates = animationRates([entry("far", { distance: 9 }), entry("busy", { active: true, distance: 20 }), entry("near"), entry("mid", { distance: 5 }), entry("last", { distance: 30 })], 2);
		expect(rates.get("busy")).toBe(1);
		expect(rates.get("near")).toBe(1);
		expect(rates.get("mid")).toBe(2);
		expect(rates.get("far")).toBe(2);
		expect(rates.get("last")).toBe(4);
	});

	it("stops people out of the frame, busy or not", () => {
		const rates = animationRates([entry("off", { onScreen: false }), entry("busy-off", { onScreen: false, active: true }), entry("here")], 4);
		expect(rates.get("off")).toBe(0);
		expect(rates.get("busy-off")).toBe(0);
		expect(rates.get("here")).toBe(1);
	});
});

describe("poses", () => {
	const base = { moving: false, seated: false, group: null, idle: null, cheering: false, refused: false } as const;

	it("walks while moving, before anything else", () => {
		expect(poseFor({ ...base, moving: true, group: "type", cheering: true })).toBe("walk");
	});

	it("maps each animation group to a seated or standing pose, typing for an unknown tool", () => {
		expect(poseFor({ ...base, seated: true, group: "type" })).toBe("sit-type");
		expect(poseFor({ ...base, group: "machine" })).toBe("stand-machine");
		expect(poseFor({ ...base, group: "phone" })).toBe("phone");
		expect(poseFor({ ...base, group: "hand-in" })).toBe("hand-in");
		expect(poseFor({ ...base, seated: true, group: "think" })).toBe("sit-think");
		expect(typesWith("sit-type")).toBe(true);
		expect(typesWith("stand-read")).toBe(false);
	});

	it("types at a keyboard desk, working or free; keeps the seat's own pose elsewhere and for a call or asking Advisor", () => {
		const atDesk = { ...base, seated: true, keyboard: true } as const;
		for (const group of ["read", "type", "machine", "think", "hand-in", "arrive"] as const) expect(poseFor({ ...atDesk, group }), group).toBe("sit-type");
		expect(poseFor(atDesk), "free at the desk in office hours").toBe("sit-type");
		expect(poseFor({ ...atDesk, group: "phone" })).toBe("sit-phone");
		expect(poseFor({ ...atDesk, group: "consult" })).toBe("sit-talk");
		expect(poseFor({ ...atDesk, talk: "speak" })).toBe("sit-talk");
		expect(poseFor({ ...atDesk, life: "doze" }), "dozing off hours").toBe("sit-idle");
		// No keyboard (the director's chair, the meeting table): no typing.
		expect(poseFor({ ...base, seated: true, group: "think" })).toBe("sit-think");
		expect(poseFor({ ...base, seated: true, group: "read" })).toBe("sit-read");
	});

	it("talks in turns at a seat without a keyboard, working or free; the director's chair has no talk seat", () => {
		const atTable = { ...base, seated: true, talkSeat: true } as const;
		expect(poseFor({ ...atTable, group: "read", speaking: true })).toBe("sit-talk");
		expect(poseFor({ ...atTable, group: "read", speaking: false })).toBe("sit-idle");
		expect(poseFor({ ...atTable, speaking: true }), "free at the reading table").toBe("sit-talk");
		expect(poseFor({ ...atTable, group: "phone", speaking: true })).toBe("sit-phone");
		expect(clipFor("sit-talk", new Set(["Sitting_Talking", "Sitting_Idle"]))).toBe("Sitting_Talking");
	});

	it("shakes the head when refused and cheers a pass, over the work pose", () => {
		expect(poseFor({ ...base, group: "type", refused: true })).toBe("shake-head");
		expect(poseFor({ ...base, group: "type", cheering: true })).toBe("cheer");
	});

	it("plays the idle show only when free", () => {
		expect(poseFor({ ...base, idle: "coffee" })).toBe("coffee");
		expect(poseFor({ ...base, group: "read", idle: "coffee" })).toBe("stand-read");
		expect(poseFor({ ...base, seated: true })).toBe("sit-idle");
		expect(isSeatedPose("chat")).toBe(true);
	});

	it("picks the first clip the model has, a later typing clip taking over the writing one", () => {
		const spike = new Set(["Sitting_Idle", "Walk", "Consume", "Idle_TalkingPhone", "Victory", "PickUp_Table", "Sitting Writing"]);
		expect(clipFor("sit-type", spike)).toBe("Sitting Writing");
		expect(clipFor("sit-type", new Set([...spike, "Typing"]))).toBe("Typing");
		expect(clipFor("cheer", spike)).toBe("Victory");
		expect(clipFor("stand-idle", spike)).toBe("Consume");
		expect(clipFor("walk", new Set())).toBeNull();
	});
});

describe("idle show", () => {
	const ctx: IdleContext = { enabled: true, pantry: ["pantry-coffee"], sofas: ["sofa-0", "sofa-1"], occupiedDesks: ["desk-2"] };
	const person = (over: Partial<IdlePerson> = {}): IdlePerson => ({ key: "researcher#1", kind: "employee", activityRoom: null, since: 0, ...over });
	/** Every act a person would play over a long free stretch. */
	const actsOver = (p: IdlePerson, c: IdleContext = ctx): string[] => {
		const acts: string[] = [];
		for (let t = IDLE_AFTER_MS * 2; t < IDLE_AFTER_MS * 2 + SLOT_MS * 40; t += 1000) {
			const act = idlePerformance(p, t, c);
			if (act !== null) acts.push(act.act);
		}
		return acts;
	};

	it("never takes someone at work, a machine or the chairman, nor during a power cut or after closing", () => {
		expect(actsOver(person({ activityRoom: "LIBRARY" }))).toEqual([]);
		expect(actsOver(person({ kind: "machine" }))).toEqual([]);
		expect(actsOver(person({ kind: "chairman" }))).toEqual([]);
		expect(actsOver(person(), { ...ctx, enabled: false })).toEqual([]);
	});

	it("waits until someone was free a while", () => {
		for (let t = 0; t < IDLE_AFTER_MS; t += 500) expect(idlePerformance(person({ since: 0 }), t, ctx)).toBeNull();
	});

	it("gives employees only a stretch in office hours, and coffee, sofa chats and yawns outside them, at most ACT_MS in a slot, the same for every caller", () => {
		// Office hours (the default): nobody leaves their seat for a break.
		expect(new Set(actsOver(person()))).toEqual(new Set(["yawn"]));
		const acts = actsOver(person(), { ...ctx, officeHours: false });
		expect(new Set(acts)).toEqual(new Set(["coffee", "chat", "yawn"]));
		expect(acts.length).toBeLessThanOrEqual(40 * (ACT_MS / 1000) + 1);
		const t = IDLE_AFTER_MS * 3;
		expect(idlePerformance(person(), t, ctx)).toEqual(idlePerformance(person(), t, ctx));
	});

	it("sends the director round the desks people sit at", () => {
		const acts = actsOver(person({ key: "director", kind: "director" }));
		expect(acts).toContain("patrol");
		expect(actsOver(person({ key: "director", kind: "director" }), { ...ctx, occupiedDesks: [] })).not.toContain("patrol");
	});
});

describe("level of detail by zoom", () => {
	it("goes far below the threshold measured on the plan: the zone framings stay near, the whole plan and two zones go far", () => {
		// About 40 px a metre (a zone on a desktop or a phone) keeps everything.
		expect(nextFar(false, 40)).toBe(false);
		expect(nextFar(false, 42)).toBe(false);
		// The whole plan on a desktop (about 20) and two zones on a phone (about 12) drop the details.
		expect(nextFar(false, 20)).toBe(true);
		expect(nextFar(false, 12)).toBe(true);
		expect(FAR_PIXELS_PER_METRE).toBe(25);
	});

	it("needs a little more zoom to come back than to go, so a pinch resting at the threshold does not flicker", () => {
		expect(NEAR_PIXELS_PER_METRE).toBeGreaterThan(FAR_PIXELS_PER_METRE);
		const between = (FAR_PIXELS_PER_METRE + NEAR_PIXELS_PER_METRE) / 2;
		expect(nextFar(false, between)).toBe(false);
		expect(nextFar(true, between)).toBe(true);
		expect(nextFar(true, NEAR_PIXELS_PER_METRE + 0.1)).toBe(false);
		expect(nextFar(false, FAR_PIXELS_PER_METRE - 0.1)).toBe(true);
		// A broken reading keeps what was.
		expect(nextFar(true, Number.NaN)).toBe(true);
		expect(nextFar(false, Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("frame stats", () => {
	it("reads the mean and the p95 frame rate", () => {
		const s = new FrameStats(100);
		for (let i = 0; i < 95; i += 1) s.push(10);
		for (let i = 0; i < 5; i += 1) s.push(40);
		s.push(Number.NaN);
		const summary = s.summary();
		expect(summary.frames).toBe(100);
		expect(summary.p95Fps).toBeCloseTo(100);
		expect(summary.worstMs).toBe(40);
		s.reset();
		expect(s.summary().frames).toBe(0);
	});
});

describe("address switches", () => {
	it("reads the address first, else what localStorage holds", () => {
		expect(office3DFlags("?office3d=off")).toMatchObject({ mode: "off" });
		expect(office3DFlags("?office3d-backend=webgl2&office3d-quality=low&office3d-test", "")).toEqual({ mode: "auto", preference: "webgl2", quality: "low", testApi: true });
		expect(office3DFlags("?at=machine-chat", "office3d=force&office3d-test")).toMatchObject({ mode: "force", testApi: true });
		expect(office3DFlags("", "")).toEqual({ mode: "auto", preference: "auto", quality: null, testApi: false });
	});
});
