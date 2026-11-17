// What a placed person sets out to do in the 3D scene, before any walking:
// the anchor to go to and how to stand there. Work follows the placement; a
// free person may join the idle show (office hours only, never while living
// by the schedule or talking); a conversation's visitor stands beside the
// host facing them, and a standing host turns to the visitor; whoever dozes
// off over a stuck tool stays put. Someone asleep (in bed, or dozing on a
// sofa) takes no part in a talk picked while they were awake: they lie or sit
// at their own place exactly as the anchor faces, never turned or beside it.
// Whoever asks Advisor stands beside Advisor's seat (the placement sends them
// there) facing it while the call runs.
// Pure, no engine.
import { lineOf, talkOf, type Talk } from "../../machines/office/office-conversations.ts";
import { awakeAct, isOfficeHours } from "../../machines/office/office-life-schedule.ts";
import type { Placement } from "../../machines/office/office-placement.ts";
import type { TalkRole } from "./anim-groups.ts";
import { idlePerformance, type IdleContext, type IdleTarget } from "./idle-performer.ts";

export interface PersonIntent {
	readonly placement: Placement;
	readonly idle: IdleTarget | null;
	/** The anchor walked to. */
	readonly anchorId: string;
	/** Stand beside the anchor facing it (the director's round, a talk's visitor). */
	readonly beside: boolean;
	/** A standing host turns this much from the anchor's facing to look at the visitor. */
	readonly turn: number;
	readonly talk: TalkRole | null;
}

/** Topics the listener claps at on the last line. */
const CLAPPED: ReadonlySet<Talk["topic"]> = new Set<Talk["topic"]>(["testsPass", "workDone"]);

function roleIn(talk: Talk, key: string, now: number): TalkRole {
	if (lineOf([talk], key, now) !== null) return "speak";
	const last = talk.lines[talk.lines.length - 1];
	if (last !== undefined && last.speaker !== key && now >= last.from && CLAPPED.has(talk.topic)) return "clap";
	return "listen";
}

export function personIntent(placement: Placement, talks: readonly Talk[], now: number, ctx: IdleContext): PersonIntent {
	const asleep = placement.life !== null && !awakeAct(placement.life.act);
	const talk = asleep ? null : talkOf(talks, placement.key);
	if (talk !== null && now < talk.end) {
		const visitor = talk.visitor === placement.key;
		return {
			placement,
			idle: null,
			anchorId: visitor ? talk.hostAnchor : placement.anchorId,
			beside: visitor,
			turn: visitor ? 0 : Math.PI / 2,
			talk: now >= (talk.lines[0]?.from ?? talk.end) ? roleIn(talk, placement.key, now) : null,
		};
	}
	const idle =
		placement.life === null
			? idlePerformance({ key: placement.key, kind: placement.kind, activityRoom: placement.activityRoom, since: placement.since }, now, { ...ctx, officeHours: isOfficeHours(placement.key, now) })
			: null;
	const consulting = placement.kind !== "advisor" && placement.activityRoom !== null && placement.actor?.activity?.group === "consult";
	return { placement, idle, anchorId: idle?.anchorId ?? placement.anchorId, beside: idle?.act === "patrol" || consulting, turn: 0, talk: null };
}
