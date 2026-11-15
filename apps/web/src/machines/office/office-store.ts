// The office of one session on this device: the only truth the 2D and 3D
// views read (docs/office-wire.md). Pure TypeScript, no React, no socket, no
// engine: office-client.ts feeds it the machine's frames and the link's state.
// A snapshot replaces everything; events apply in seq order (a repeat or an
// old one is dropped, a gap stops and asks for a snapshot, another epoch
// too). The same snapshot and events give the same office whatever the
// viewer's clock; the clock only drives what time decides: the power cut (no
// word from the machine for 30 s), the hourglass of a tool running over two
// minutes, and the building closing after ten idle minutes. The clock is
// injected, so tests and a future replay drive it.
import type { OfficeEvent, OfficeSnapshot } from "@achoo254/chat-proto/remote/remote";
import { actorOf, activityOf, APPROVALS, EMPTY_SESSION, nestedActor, sessionOf, type ActorRecord, type OfficeState, type SessionView } from "./office-state.ts";
import { fillDesks, hire, overflowOf, release, reseat, type StaffMember } from "./office-staff.ts";

export type { ActivityView, ActorRole, ActorState, ActorView, AnimGroup, ApprovalState, OfficeState, SessionView } from "./office-state.ts";
export type { StaffMember } from "./office-staff.ts";

/** No word from the machine for this long: the power goes out. */
export const POWER_OUT_MS = 30_000;
/** A tool running this long shows an hourglass. */
export const SLOW_TOOL_MS = 120_000;
/** The session idle this long: the building closes for the day. */
export const CLOSING_MS = 10 * 60_000;
/**
 * The home desks of the shared work room as anchor ids, in the order they are
 * taken (the views pass the layout's: eight on a wide screen, six on a phone);
 * this default names the layout's eight.
 */
export const DEFAULT_DESKS: readonly string[] = ["desk-0", "desk-1", "desk-2", "desk-3", "desk-4", "desk-5", "desk-6", "desk-7"];

export type ApplyResult = "ok" | "need-snapshot";

export interface OfficeStore {
	applySnapshot(snapshot: OfficeSnapshot): void;
	applyEvents(epoch: bigint, events: readonly OfficeEvent[]): ApplyResult;
	/** The link to the machine opened or closed; `at` is when it was last heard from (viewer time). */
	linkStatus(open: boolean, at: number): void;
	tick(now: number): void;
	/** The desks the screen offers (anchor ids): people keep theirs when it is still offered. */
	setDesks(desks: readonly string[]): void;
	subscribe(listener: () => void): () => void;
	state(): OfficeState;
}

export function createOfficeStore(options: { now: () => number; desks?: readonly string[] }): OfficeStore {
	const listeners = new Set<() => void>();
	let desks: readonly string[] = options.desks ?? DEFAULT_DESKS;
	let live = false;
	let epoch: bigint | null = null;
	let seq = 0n;
	let awaiting = false;
	let reportsStaff = true;
	let actors: ActorRecord[] = [];
	let staff: StaffMember[] = [];
	let visitors: { key: string; enteredAt: number }[] = [];
	let session: SessionView = EMPTY_SESSION;
	let lastTurnStart = 0;
	let idleSince: number | null = null;
	// Viewer time minus machine time, from the latest events; 0 until one. A
	// snapshot carries no time of its own, so until the first event the two
	// clocks are taken as equal (an hourglass or closing may show a little early
	// or late on a machine whose clock is off).
	let clockOffset = 0;
	let linkOpen = true;
	let lastHeard = options.now();
	let power: "on" | "out" = "on";
	let viewerNow = options.now();
	let cached: OfficeState | null = null;

	const machineNow = (): number => viewerNow - clockOffset;

	const freeAt = (actorId: string, at: number): boolean => {
		const actor = actors.find((a) => a.id === actorId);
		return actor === undefined || (actor.state === "done" && actor.doneAt <= at);
	};

	const remember = (members: readonly StaffMember[]): void => {
		for (const m of members) {
			if (!visitors.some((v) => v.key === m.key)) visitors = [...visitors, { key: m.key, enteredAt: m.firstEnteredAt }];
		}
	};

	const hireActor = (a: ActorRecord): void => {
		if (a.role !== "employee") return;
		staff = hire(staff, { actorId: a.id, agentType: a.agentType, nested: nestedActor(a), enteredAt: a.enteredAt }, freeAt, desks);
		remember(staff);
	};

	const build = (): OfficeState => {
		const now = machineNow();
		const off = !session.busy && idleSince !== null && now - idleSince >= CLOSING_MS;
		return {
			status: live ? "live" : "loading",
			power,
			awaitingSnapshot: awaiting,
			reportsStaff,
			actors: actors.map(({ beforeApproval: _before, activity, ...rest }) => ({
				...rest,
				activity: activity === null ? null : { ...activity, slow: activity.startedAt > 0 && now - activity.startedAt >= SLOW_TOOL_MS },
			})),
			staff,
			overflow: overflowOf(staff),
			deskCount: desks.length,
			session,
			chairman: live && session.waitingForUser,
			lastTurnStart,
			idleSince,
			off,
			visitors,
			clockOffset,
		};
	};

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	const emit = (): void => {
		cached = null;
		notify();
	};

	/** The clock-driven parts of the state: emit only when one of them changed. */
	const timeKey = (s: OfficeState): string => `${s.power}|${s.off}|${s.actors.map((a) => (a.activity?.slow === true ? "1" : "0")).join("")}`;

	const state = (): OfficeState => {
		cached ??= build();
		return cached;
	};

	const update = (id: string, change: (a: ActorRecord) => ActorRecord): void => {
		actors = actors.map((a) => (a.id === id ? change(a) : a));
	};

	/** The idle edge of a snapshot: when the last thing anyone did ended (machine time). */
	const idleEdgeOf = (list: readonly ActorRecord[], s: SessionView): number =>
		Math.max(s.startedAt, ...list.map((a) => Math.max(a.enteredAt, a.doneAt, a.activity?.startedAt ?? 0)));

	const apply = (e: OfficeEvent): void => {
		const at = Number(e.at);
		const k = e.kind;
		switch (k.case) {
			case "actorEnter":
			case "actorUpdate": {
				const previous = actors.find((a) => a.id === k.value.id);
				const next = actorOf(k.value, previous);
				if (previous === undefined) {
					actors = [...actors, next];
					hireActor(next);
				} else {
					update(next.id, () => next);
					// Its agent type or nesting became known or changed: it is someone else (another name, a desk or the meeting room).
					if (next.role === "employee" && (previous.agentType !== next.agentType || nestedActor(previous) !== nestedActor(next))) {
						staff = release(staff, next.id, desks);
						hireActor(next);
					}
				}
				break;
			}
			case "actorLeave":
				actors = actors.filter((a) => a.id !== k.value.actorId);
				staff = release(staff, k.value.actorId, desks);
				break;
			case "activityStart": {
				const activity = activityOf(k.value.activity);
				update(k.value.actorId, (a) => ({ ...a, activity }));
				break;
			}
			case "activityEnd":
				update(k.value.actorId, (a) =>
					a.activity?.id === k.value.activityId ? { ...a, activity: null, lastResult: { ok: k.value.ok, at } } : a,
				);
				break;
			case "turnStart":
				lastTurnStart = at;
				break;
			case "approval": {
				const decided = APPROVALS[k.value.state] ?? "cancelled";
				update(k.value.actorId, (a) => {
					if (decided === "waiting") {
						return { ...a, state: "awaiting", beforeApproval: a.state === "awaiting" ? a.beforeApproval : a.state, approval: { state: decided, at } };
					}
					const back = a.state === "awaiting" ? (a.beforeApproval ?? "working") : a.state;
					return { ...a, state: back, beforeApproval: null, approval: { state: decided, at } };
				});
				break;
			}
			case "session": {
				const next = sessionOf(k.value);
				if (session.busy && !next.busy) {
					idleSince = at;
					// The director's turn is over; machines and background subagents work on (the agent ends theirs).
					actors = actors.map((a) => (a.role === "director" && a.activity !== null ? { ...a, activity: null } : a));
				} else if (next.busy) idleSince = null;
				else idleSince ??= at;
				session = next;
				break;
			}
			default:
				// A kind a newer agent added: nothing to show for it.
				break;
		}
	};

	return {
		applySnapshot(snapshot) {
			viewerNow = options.now();
			const s = snapshot.state;
			// The same agent run (a gap or a reconnect): the same people, at the same desks, and nobody forgotten from today.
			const same = live && snapshot.epoch === epoch;
			const before = { staff, visitors };
			epoch = snapshot.epoch;
			seq = snapshot.seq;
			awaiting = false;
			live = true;
			reportsStaff = s?.reportsStaff ?? false;
			actors = [];
			staff = [];
			visitors = same ? before.visitors : [];
			for (const a of s?.actors ?? []) {
				const record = actorOf(a, undefined);
				actors = [...actors, record];
				hireActor(record);
			}
			if (same) staff = reseat(staff, before.staff, desks);
			session = sessionOf(s?.session);
			idleSince = session.busy ? null : idleEdgeOf(actors, session);
			if (!same) lastTurnStart = 0;
			if (linkOpen) power = "on";
			emit();
		},

		applyEvents(frameEpoch, events) {
			viewerNow = options.now();
			// An older epoch's frame (sent before the agent restarted) is just dropped.
			if (live && epoch !== null && frameEpoch < epoch) return "ok";
			if (!live || awaiting || frameEpoch !== epoch) {
				// Shown as catching up once; nothing re-renders until the snapshot comes.
				if (live && !awaiting) {
					awaiting = true;
					emit();
				}
				return "need-snapshot";
			}
			let changed = false;
			let result: ApplyResult = "ok";
			for (const e of events) {
				if (e.seq <= seq) continue;
				if (e.seq !== seq + 1n) {
					awaiting = true;
					changed = true;
					result = "need-snapshot";
					break;
				}
				apply(e);
				seq = e.seq;
				changed = true;
				clockOffset = options.now() - Number(e.at);
			}
			if (changed) emit();
			return result;
		},

		linkStatus(open, at) {
			viewerNow = options.now();
			if (open === linkOpen) {
				if (!open) lastHeard = at;
				return;
			}
			linkOpen = open;
			lastHeard = at;
			// Back after the power went out: the lights stay off until the new snapshot.
			if (open && power === "out") awaiting = true;
			emit();
		},

		tick(now) {
			const before = timeKey(state());
			viewerNow = now;
			if (!linkOpen && now - lastHeard >= POWER_OUT_MS) power = "out";
			cached = build();
			if (timeKey(cached) !== before) notify();
		},

		setDesks(next) {
			if (next.length === desks.length && next.every((d, i) => d === desks[i])) return;
			desks = next;
			staff = fillDesks(staff, desks);
			emit();
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		state,
	};
}
