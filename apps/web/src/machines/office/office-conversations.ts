// Residents talking to each other, shared by the 2D and 3D views. Time runs
// in windows of TALK_WINDOW_MS. A person may start a talk in a window picked
// by a hash of their key and the hour, never in two windows within
// TALK_COOLDOWN_WINDOWS (so nobody talks twice inside three minutes); two
// such people in one zone of the plan, free (no work, not asleep), settled
// where they are since before the window and in the same or a neighbouring
// room, pair up, at most MAX_TALKS_PER_ZONE pairs a zone. The visitor walks over during
// WALK_LEAD_MS, then they speak two to four lines in turn (dialogue in
// office-dialogue-vi.ts filled with facts of office-talk-facts.ts), each
// 2.5 to 4 s by its length. Real work ends a talk at once: a person pulled
// away is no longer free, so the pair is gone at the next frame. Everything
// follows from the people, their places and the time: every viewer sees the
// same talk. Pure.
import { viMachines } from "../copy-vi.ts";
import { castOf, nameHash } from "./office-cast.ts";
import { DIALOGUE_VI, fillLine, QUIRKS, slotsOf, type DialogueSlot, type QuirkKey, type TalkTopic } from "./office-dialogue-vi.ts";
import { anchorById, zoneOfRoom } from "./office-geometry.ts";
import type { OfficeLayout, Rect, ZoneId } from "./office-layout.ts";
import { awakeAct, localHour, slotAt } from "./office-life-schedule.ts";
import { personName } from "./office-names.ts";
import type { Placement } from "./office-placement.ts";
import type { RoomCode } from "./office-rooms.ts";
import type { OfficeState } from "./office-store.ts";
import { talkFacts } from "./office-talk-facts.ts";
import { EMPTY_WORK } from "./office-work-log.ts";

export const TALK_WINDOW_MS = 60_000;
export const TALK_COOLDOWN_WINDOWS = 3;
export const MAX_TALKS_PER_ZONE = 2;
/** The visitor's walk before the first line. */
export const WALK_LEAD_MS = 6_000;
export const LINE_MIN_MS = 2_500;
export const LINE_MAX_MS = 4_000;

export interface TalkLine {
	/** The key of who says it. */
	readonly speaker: string;
	readonly text: string;
	/** Viewer times the bubble shows. */
	readonly from: number;
	readonly to: number;
}

export interface Talk {
	/** Stays put; the visitor comes to stand beside them. */
	readonly host: string;
	readonly visitor: string;
	readonly hostAnchor: string;
	/** The zone both are in. */
	readonly zone: ZoneId;
	readonly topic: TalkTopic;
	/** Viewer times: the window's start (the visitor sets off) and the last line's end. */
	readonly start: number;
	readonly end: number;
	readonly lines: readonly TalkLine[];
}

/** Whether `key` may start a talk in window `w` (before the cooldown is applied). */
function opensIn(key: string, w: number): boolean {
	const hour = Math.floor((w * TALK_WINDOW_MS) / 3_600_000);
	return nameHash(`talk:${key}#${hour}`) % TALK_COOLDOWN_WINDOWS === w % TALK_COOLDOWN_WINDOWS;
}

/** `key` talks in window `w`: it is their window, and neither of the windows before it was. */
export function talkWindowOf(key: string, w: number): boolean {
	for (let back = 1; back < TALK_COOLDOWN_WINDOWS; back += 1) if (opensIn(key, w - back)) return false;
	return opensIn(key, w);
}

function touching(a: Rect, b: Rect): boolean {
	const eps = 0.05;
	const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const overlapZ = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	return (overlapX > eps && Math.abs(overlapZ) <= eps) || (overlapZ > eps && Math.abs(overlapX) <= eps);
}

/** The same room, or two rooms of one zone sharing a wall (zones are apart, across the corridors). */
export function neighbourRooms(layout: OfficeLayout, a: RoomCode, b: RoomCode): boolean {
	if (a === b) return true;
	const ra = layout.rooms.find((r) => r.room === a);
	const rb = layout.rooms.find((r) => r.room === b);
	return ra !== undefined && rb !== undefined && ra.zone === rb.zone && touching(ra.rect, rb.rect);
}

/**
 * Free to talk at the start of `windowStart`: off duty (the director while the
 * session rests, an employee whose subagent finished or left; never someone
 * between two tools of running work), awake, settled where they are.
 */
function free(p: Placement, sessionBusy: boolean, windowStart: number): boolean {
	if (p.activityRoom !== null || p.since > windowStart) return false;
	if (p.life !== null && !awakeAct(p.life.act)) return false;
	if (p.kind === "director") return !sessionBusy && p.actor?.activity == null;
	if (p.kind !== "employee") return false;
	return p.actor === null || ((p.actor.state === "done" || p.actor.state === "idle") && p.actor.activity === null);
}

function quirkKey(p: Placement): QuirkKey {
	if (p.kind === "director") return "director";
	return castOf(p.member?.agentType ?? p.actor?.agentType ?? "").key ?? "other";
}

function pick<T>(list: readonly T[], seed: number): T | undefined {
	return list.length === 0 ? undefined : list[seed % list.length];
}

/** The lines of a talk, timed from `from`. */
function linesOf(state: OfficeState, visitor: Placement, host: Placement, now: number, from: number, seed: string): { topic: TalkTopic; lines: TalkLine[] } {
	const facts = talkFacts({
		work: state.work[visitor.workKey] ?? EMPTY_WORK,
		session: state.session,
		clockOffset: state.clockOffset,
		now,
		slot: slotAt(localHour(now)),
		acts: [visitor.life?.act ?? null, host.life?.act ?? null],
	});
	const topic = pick(facts.topics, nameHash(`topic:${seed}`)) ?? "smallTalk";
	const pool = DIALOGUE_VI[topic];
	const names = new Map([
		[visitor.key, personName(viMachines.office, visitor)],
		[host.key, personName(viMachines.office, host)],
	]);
	const count = 2 + (nameHash(`count:${seed}`) % 3);
	const roles = [pool.opener, pool.reply, pool.follow, pool.close].slice(0, count);
	const lines: TalkLine[] = [];
	let at = from;
	roles.forEach((role, i) => {
		const speaker = i % 2 === 0 ? visitor : host;
		const listener = i % 2 === 0 ? host : visitor;
		const values: Partial<Record<DialogueSlot, string>> = { ...facts.values, ten: names.get(listener.key) ?? "" };
		const usable = role.filter((line) => slotsOf(line).every((s) => values[s] !== undefined && values[s] !== ""));
		// The last line, now and then, in the speaker's own voice.
		const quirk = i === count - 1 && i > 0 && nameHash(`quirk:${seed}`) % 3 === 0 ? QUIRKS[quirkKey(speaker)] : null;
		const template = pick(quirk ?? usable, nameHash(`line:${seed}#${i}`));
		if (template === undefined) return;
		const text = fillLine(template, values);
		const ms = Math.min(LINE_MAX_MS, Math.max(LINE_MIN_MS, 1_500 + text.length * 45));
		lines.push({ speaker: speaker.key, text, from: at, to: at + ms });
		at += ms;
	});
	return { topic, lines };
}

/** The talks going on at `now` (viewer time). */
export function officeTalks(placements: readonly Placement[], state: OfficeState, layout: OfficeLayout, now: number): readonly Talk[] {
	if (state.power === "out") return [];
	const w = Math.floor(now / TALK_WINDOW_MS);
	const windowStart = w * TALK_WINDOW_MS;
	const talks: Talk[] = [];
	const ready = placements
		.filter((p) => free(p, state.session.busy, windowStart) && talkWindowOf(p.key, w))
		.sort((a, b) => nameHash(`pair:${a.key}#${w}`) - nameHash(`pair:${b.key}#${w}`) || a.key.localeCompare(b.key));
	const paired = new Set<string>();
	const perZone = new Map<ZoneId, number>();
	for (const a of ready) {
		const zone = zoneOfRoom(layout, a.room);
		if (paired.has(a.key) || (perZone.get(zone) ?? 0) >= MAX_TALKS_PER_ZONE) continue;
		const b = ready.find((o) => o.key !== a.key && !paired.has(o.key) && neighbourRooms(layout, a.room, o.room));
		if (b === undefined) continue;
		paired.add(a.key);
		paired.add(b.key);
		perZone.set(zone, (perZone.get(zone) ?? 0) + 1);
		// A seated (or lying) person stays; else the first of the pair does.
		const seated = (p: Placement): boolean => {
			const anchor = anchorById(layout, p.anchorId);
			return anchor !== undefined && (anchor.sit || anchor.lie || ["desk", "director", "sofa", "meeting"].includes(anchor.kind));
		};
		const [host, visitor] = seated(b) && !seated(a) ? [b, a] : [a, b];
		const seed = `${[a.key, b.key].sort().join("+")}#${w}`;
		const { topic, lines } = linesOf(state, visitor, host, now, windowStart + WALK_LEAD_MS, seed);
		const end = lines[lines.length - 1]?.to ?? windowStart;
		if (now >= end) continue;
		talks.push({ host: host.key, visitor: visitor.key, hostAnchor: host.anchorId, zone, topic, start: windowStart, end, lines });
	}
	return talks;
}

/** What `key` says at `now`, or null. */
export function lineOf(talks: readonly Talk[], key: string, now: number): string | null {
	for (const talk of talks) {
		const line = talk.lines.find((l) => l.speaker === key && now >= l.from && now < l.to);
		if (line !== undefined) return line.text;
	}
	return null;
}

/** The talk `key` is in, or null. */
export function talkOf(talks: readonly Talk[], key: string): Talk | null {
	return talks.find((t) => t.host === key || t.visitor === key) ?? null;
}
