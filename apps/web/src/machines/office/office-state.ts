// The office as the views read it, and how the wire's actors, activities and
// session numbers become it (docs/office-wire.md): rooms by name, enums as
// words, machine times as numbers. office-store.ts keeps it up to date.
import {
	OfficeActorState,
	OfficeAnimGroup,
	OfficeApprovalState,
	OfficeRole,
	type OfficeActivity,
	type OfficeActor,
	type OfficeSession,
} from "@achoo254/chat-proto/remote/remote";
import { roomOf, type RoomCode } from "./office-rooms.ts";
import type { StaffMember } from "./office-staff.ts";

export type ActorRole = "director" | "employee" | "machine";
export type ActorState = "idle" | "working" | "done" | "awaiting";
export type AnimGroup = "read" | "type" | "machine" | "phone" | "arrive" | "hand-in" | "think";
export type ApprovalState = "waiting" | "allowed" | "denied" | "cancelled";

export interface ActivityView {
	readonly id: string;
	readonly tool: string;
	readonly group: AnimGroup;
	readonly room: RoomCode;
	readonly subject: string;
	/** Machine time. */
	readonly startedAt: number;
	/** Running over two minutes (an hourglass). */
	readonly slow: boolean;
}

export interface ActorView {
	readonly id: string;
	readonly role: ActorRole;
	readonly agentType: string;
	readonly description: string;
	readonly parentId: string;
	readonly spawnDepth: number;
	readonly state: ActorState;
	readonly activity: ActivityView | null;
	readonly enteredAt: number;
	readonly doneAt: number;
	/** The latest permission prompt of the actor's tool, when one came this session. */
	readonly approval: { readonly state: ApprovalState; readonly at: number } | null;
	/** How the actor's latest activity ended (pass or fail, a cheer or smoke). */
	readonly lastResult: { readonly ok: boolean; readonly at: number } | null;
}

export interface SessionView {
	readonly busy: boolean;
	readonly waitingForUser: boolean;
	readonly startedAt: number;
	readonly tasksDone: number;
	readonly backgroundMachines: number;
	readonly todo: { readonly pending: number; readonly inProgress: number; readonly done: number };
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly hasCost: boolean; readonly available: boolean };
	readonly checks: { readonly passed: number; readonly failed: number; readonly lastOk: boolean };
	readonly hiddenActors: number;
}

export interface OfficeState {
	/** "loading" until the first snapshot. */
	readonly status: "loading" | "live";
	readonly power: "on" | "out";
	/** A gap, another epoch or a reconnect: what shows waits for a new snapshot. */
	readonly awaitingSnapshot: boolean;
	readonly reportsStaff: boolean;
	/** Director first, then in the order they came in. */
	readonly actors: readonly ActorView[];
	readonly staff: readonly StaffMember[];
	/** Employees waiting for a desk in the meeting room ("+N"). */
	readonly overflow: number;
	readonly deskCount: number;
	readonly session: SessionView;
	/** The user stands in the lobby: the AI waits for them. */
	readonly chairman: boolean;
	/** Machine time of the latest turn start (a visitor in the lobby); 0 before one. */
	readonly lastTurnStart: number;
	/** Machine time the session went idle; null while busy. */
	readonly idleSince: number | null;
	/** Idle for ten minutes: lights off, people gone home. */
	readonly off: boolean;
	/** Employees who came in this session (key and first entry, machine time), for "staff today". */
	readonly visitors: readonly { readonly key: string; readonly enteredAt: number }[];
	/** Viewer time minus machine time (from the latest events; 0 before any): a machine time plus this is when it happened on the viewer's clock. */
	readonly clockOffset: number;
}

export const EMPTY_SESSION: SessionView = {
	busy: false,
	waitingForUser: false,
	startedAt: 0,
	tasksDone: 0,
	backgroundMachines: 0,
	todo: { pending: 0, inProgress: 0, done: 0 },
	usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false, available: false },
	checks: { passed: 0, failed: 0, lastOk: false },
	hiddenActors: 0,
};

const GROUPS: Readonly<Partial<Record<OfficeAnimGroup, AnimGroup>>> = {
	[OfficeAnimGroup.READ]: "read",
	[OfficeAnimGroup.TYPE]: "type",
	[OfficeAnimGroup.MACHINE]: "machine",
	[OfficeAnimGroup.PHONE]: "phone",
	[OfficeAnimGroup.ARRIVE]: "arrive",
	[OfficeAnimGroup.HAND_IN]: "hand-in",
	[OfficeAnimGroup.THINK]: "think",
};

const STATES: Readonly<Partial<Record<OfficeActorState, ActorState>>> = {
	[OfficeActorState.IDLE]: "idle",
	[OfficeActorState.WORKING]: "working",
	[OfficeActorState.DONE]: "done",
	[OfficeActorState.AWAITING_APPROVAL]: "awaiting",
};

export const APPROVALS: Readonly<Partial<Record<OfficeApprovalState, ApprovalState>>> = {
	[OfficeApprovalState.WAITING]: "waiting",
	[OfficeApprovalState.ALLOWED]: "allowed",
	[OfficeApprovalState.DENIED]: "denied",
	[OfficeApprovalState.CANCELLED]: "cancelled",
};

/** An actor as the store keeps it: the view without what the clock decides, plus the state an approval interrupted. */
export type ActorRecord = Omit<ActorView, "activity"> & { readonly activity: Omit<ActivityView, "slow"> | null; readonly beforeApproval: ActorState | null };

export function activityOf(a: OfficeActivity | undefined): ActorRecord["activity"] {
	if (a === undefined || a.id === "") return null;
	return { id: a.id, tool: a.tool, group: GROUPS[a.group] ?? "type", room: roomOf(a.room), subject: a.subject, startedAt: Number(a.startedAt) };
}

function roleOf(role: OfficeRole): ActorRole {
	if (role === OfficeRole.DIRECTOR) return "director";
	return role === OfficeRole.MACHINE ? "machine" : "employee";
}

export function actorOf(a: OfficeActor, previous: ActorRecord | undefined): ActorRecord {
	return {
		id: a.id,
		role: a.id === "director" ? "director" : roleOf(a.role),
		agentType: a.agentType,
		description: a.description,
		parentId: a.parentId,
		spawnDepth: a.spawnDepth,
		state: STATES[a.state] ?? "working",
		activity: activityOf(a.activity),
		enteredAt: Number(a.enteredAt),
		doneAt: Number(a.doneAt),
		approval: previous?.approval ?? null,
		lastResult: previous?.lastResult ?? null,
		beforeApproval: previous?.beforeApproval ?? null,
	};
}

export function sessionOf(s: OfficeSession | undefined): SessionView {
	if (s === undefined) return EMPTY_SESSION;
	return {
		busy: s.busy,
		waitingForUser: s.waitingForUser,
		startedAt: Number(s.startedAt),
		tasksDone: s.tasksDone,
		backgroundMachines: s.backgroundMachines,
		todo: { pending: s.todo?.pending ?? 0, inProgress: s.todo?.inProgress ?? 0, done: s.todo?.done ?? 0 },
		usage: {
			inputTokens: Number(s.usage?.inputTokens ?? 0n),
			outputTokens: Number(s.usage?.outputTokens ?? 0n),
			costUsd: s.usage?.costUsdEstimate ?? 0,
			hasCost: s.usage?.hasCost ?? false,
			available: s.usage?.available ?? false,
		},
		checks: { passed: s.checks?.passed ?? 0, failed: s.checks?.failed ?? 0, lastOk: s.checks?.lastOk ?? false },
		hiddenActors: s.hiddenActors,
	};
}

/** An employee of the meeting room: a nested subagent, or an agent of a workflow. */
export function nestedActor(a: Pick<ActorRecord, "spawnDepth" | "parentId">): boolean {
	return a.spawnDepth > 1 || a.parentId !== "";
}

