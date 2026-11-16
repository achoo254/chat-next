// The office of one session on this device: the only truth the 2D and 3D
// views read (docs/office-wire.md). Pure TypeScript, no React, no socket, no
// engine: office-client.ts feeds it the machine's frames and the link's state.
// A snapshot replaces everything; events apply in seq order (a repeat or an
// old one is dropped, a gap stops and asks for a snapshot, another epoch
// too). The same snapshot and events give the same office whatever the
// viewer's clock; the clock only drives what time decides: the power cut (no
// word from the machine for 30 s) and the hourglass of a tool running over two
// minutes. Nobody goes home: an employee whose subagent left stays as an
// off-duty resident (office-staff.ts retire). The clock is injected, so tests
// and a future replay drive it.
import type { OfficeEvent, OfficeSnapshot } from "@achoo254/chat-proto/remote/remote";
import { actorOf, actorViewOf, activityOf, APPROVALS, EMPTY_SESSION, eventActor, nestedActor, sessionOf, type ActorRecord, type OfficeState, type SessionView } from "./office-state.ts";
import { formerStaffOf, hireOrder } from "./office-former-staff.ts";
import { fillDesks, hire, overflowOf, release, reseat, retire, type FreeAt, type StaffMember } from "./office-staff.ts";
import { approvalDecided, workEnded, type WorkLog } from "./office-work-log.ts";

export type { ActivityView, ActorRole, ActorState, ActorView, AnimGroup, ApprovalState, OfficeState, SessionView } from "./office-state.ts";
export type { StaffMember } from "./office-staff.ts";
export type { LastWork, PersonWork, WorkLog } from "./office-work-log.ts";

/** No word from the machine for this long: the power goes out. */
export const POWER_OUT_MS = 30_000;
export { SLOW_TOOL_MS, STUCK_MS } from "./office-state.ts";
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
	let residents: StaffMember[] = [];
	let work: WorkLog = {};
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

	const hireActor = (a: Pick<ActorRecord, "id" | "role" | "agentType" | "spawnDepth" | "parentId" | "enteredAt">, free: FreeAt = freeAt): void => {
		if (a.role !== "employee") return;
		staff = hire(staff, { actorId: a.id, agentType: a.agentType, nested: nestedActor(a), enteredAt: a.enteredAt }, free, desks, residents);
		// A resident back at work is on duty again.
		residents = residents.filter((r) => !staff.some((m) => m.key === r.key));
		remember(staff);
	};

	const build = (): OfficeState => {
		const now = machineNow();
		return {
			status: live ? "live" : "loading",
			power,
			awaitingSnapshot: awaiting,
			reportsStaff,
			actors: actors.map((a) => actorViewOf(a, now)),
			staff,
			overflow: overflowOf(staff),
			deskCount: desks.length,
			session,
			chairman: live && session.waitingForUser,
			lastTurnStart,
			idleSince,
			residents,
			work,
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
	// A dozing person's "stuck N minutes" and a service's "N minutes" running change once a minute.
	const minutes = (ms: number | null | undefined): string => (ms == null ? "" : String(Math.floor(ms / 60_000)));
	const timeKey = (s: OfficeState): string =>
		`${s.power}|${s.actors.map((a) => `${a.activity?.slow === true ? "1" : "0"}${minutes(a.activity?.stuckMs)}/${minutes(a.service?.uptimeMs)}`).join(",")}`;

	const state = (): OfficeState => {
		cached ??= build();
		return cached;
	};

	const update = (id: string, change: (a: ActorRecord) => ActorRecord): void => {
		actors = actors.map((a) => (a.id === id ? change(a) : a));
	};

	/** The person an actor is in the office: "director", an employee's staff key, or null (a machine, an unknown actor). */
	const personKey = (actorId: string): string | null => {
		if (actorId === "director") return "director";
		return staff.find((m) => m.actorId === actorId)?.key ?? null;
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
				// A role this app does not know: nobody to show (and never an employee to hire).
				if (next === null) break;
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
			case "actorLeave": {
				actors = actors.filter((a) => a.id !== k.value.actorId);
				const after = retire(staff, residents, k.value.actorId, desks);
				staff = after.staff;
				residents = after.offDuty;
				break;
			}
			case "activityStart": {
				const activity = activityOf(k.value.activity);
				update(k.value.actorId, (a) => ({ ...a, activity }));
				break;
			}
			case "activityEnd": {
				const ended = actors.find((a) => a.id === k.value.actorId)?.activity;
				const key = personKey(k.value.actorId);
				if (key !== null && ended != null && ended.id === k.value.activityId) {
					work = workEnded(work, key, { group: ended.group, room: ended.room, ok: k.value.ok, at, ms: ended.startedAt > 0 ? Math.max(0, at - ended.startedAt) : 0 });
				}
				update(k.value.actorId, (a) =>
					a.activity?.id === k.value.activityId ? { ...a, activity: null, lastResult: { ok: k.value.ok, at } } : a,
				);
				break;
			}
			case "turnStart":
				lastTurnStart = at;
				break;
			case "approval": {
				const decided = APPROVALS[k.value.state] ?? "cancelled";
				const waited = actors.find((a) => a.id === k.value.actorId)?.approval;
				const key = personKey(k.value.actorId);
				if (decided !== "waiting" && waited?.state === "waiting" && key !== null) work = approvalDecided(work, key, at - waited.at, at);
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
			const before = { staff, visitors, residents, work };
			epoch = snapshot.epoch;
			seq = snapshot.seq;
			awaiting = false;
			live = true;
			reportsStaff = s?.reportsStaff ?? false;
			actors = [];
			staff = [];
			visitors = same ? before.visitors : [];
			residents = same ? before.residents : [];
			work = same ? before.work : {};
			actors = (s?.actors ?? []).flatMap((a) => actorOf(a, undefined) ?? []);
			// Opened afresh: those who had left are hired back first in the order everyone came in (a free one makes
			// room for the next of the type from when they finished or left), then go off duty, so everyone keeps the
			// name and number they had. Ignored for the same run: this device saw them leave.
			const former = same ? [] : formerStaffOf(s?.residents ?? []);
			const freeFrom = new Map(former.map((f) => [f.id, f.freeFrom]));
			const replayFree: FreeAt = (actorId, at) => {
				const from = freeFrom.get(actorId);
				return from === undefined ? freeAt(actorId, at) : from <= at;
			};
			for (const a of hireOrder(former, actors)) hireActor(a, replayFree);
			for (const f of [...former].sort((x, y) => x.leftAt - y.leftAt)) {
				const after = retire(staff, residents, f.id, desks);
				staff = after.staff;
				residents = after.offDuty;
			}
			if (same) {
				staff = reseat(staff, before.staff, desks);
				// Whoever left while frames were missed is off duty now; whoever came back works again.
				const gone = before.staff.filter((m) => !staff.some((s) => s.key === m.key)).map((m) => ({ ...m, desk: null }));
				residents = [...residents.filter((r) => !staff.some((m) => m.key === r.key) && !gone.some((g) => g.key === r.key)), ...gone];
			}
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
				// Any word about an actor wakes them if they dozed off over a long tool.
				const about = eventActor(e);
				if (about !== null) update(about, (a) => ({ ...a, heardAt: Math.max(a.heardAt, Number(e.at)) }));
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
