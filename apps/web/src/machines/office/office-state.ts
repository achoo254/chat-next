// The office as the views read it, and how the wire's actors, activities and
// session numbers become it (docs/office-wire.md): rooms by name, enums as
// words, machine times as numbers. office-store.ts keeps it up to date.
import {
	OfficeActorState,
	OfficeAnimGroup,
	OfficeApprovalState,
	OfficeRole,
	OfficeServiceKind,
	type OfficeActivity,
	type OfficeActor,
	type OfficeEvent,
	type OfficeService,
	type OfficeSession,
} from "@achoo254/chat-proto/remote/remote";
import { roomOf, type RoomCode } from "./office-rooms.ts";
import type { StaffMember } from "./office-staff.ts";
import type { Timeline } from "./office-timeline.ts";
import type { WorkLog } from "./office-work-log.ts";

/** Advisor sits in while the session's automatic Advisor is on (from tunelo 3.13.0, to a watch that says it draws Advisor). */
export type ActorRole = "director" | "employee" | "machine" | "advisor";
export type ActorState = "idle" | "working" | "done" | "awaiting";
export type AnimGroup = "read" | "type" | "machine" | "phone" | "arrive" | "hand-in" | "think" | "consult";
export type ApprovalState = "waiting" | "allowed" | "denied" | "cancelled";
/** What a machine runs, as the agent classified its command on the machine (never the command itself). */
export type ServiceKind = "dev-server" | "test-watch" | "build" | "ci-watch" | "git" | "database" | "script";

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
	/**
	 * Running long with no word about its actor for STUCK_MS: how long that
	 * silence has lasted (ms); null otherwise. The person dozes off where they
	 * work ("Zzz") until the next event about them wakes them.
	 */
	readonly stuckMs: number | null;
}

export interface ServiceView {
	readonly kind: ServiceKind;
	/** The port its command named; null when the agent does not know one. */
	readonly port: number | null;
	/** Machine time it started. */
	readonly startedAt: number;
	/** How long it has run at the view's time (ms). */
	readonly uptimeMs: number;
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
	/** Machine time of the latest event about this actor (entering, an activity, an approval). */
	readonly heardAt: number;
	/** The latest permission prompt of the actor's tool, when one came this session. */
	readonly approval: { readonly state: ApprovalState; readonly at: number } | null;
	/** How the actor's latest activity ended (pass or fail, a cheer or smoke). */
	readonly lastResult: { readonly ok: boolean; readonly at: number } | null;
	/** A machine's label from an agent that sends one; null otherwise (a person, or an older agent). */
	readonly service: ServiceView | null;
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
	/** Employees whose subagent left: off duty, they live in the building by the daily schedule (no desk), in the order they went off duty. */
	readonly residents: readonly StaffMember[];
	/** What each person did this session (normalized facts, for their conversations). */
	readonly work: WorkLog;
	/** What each person finished this session, keyed by the inspector's person key (office-timeline.ts). */
	readonly timeline: Timeline;
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
	[OfficeAnimGroup.CONSULT]: "consult",
};

const STATES: Readonly<Partial<Record<OfficeActorState, ActorState>>> = {
	[OfficeActorState.IDLE]: "idle",
	[OfficeActorState.WORKING]: "working",
	[OfficeActorState.DONE]: "done",
	[OfficeActorState.AWAITING_APPROVAL]: "awaiting",
};

const SERVICE_KINDS: Readonly<Partial<Record<OfficeServiceKind, ServiceKind>>> = {
	[OfficeServiceKind.DEV_SERVER]: "dev-server",
	[OfficeServiceKind.TEST_WATCH]: "test-watch",
	[OfficeServiceKind.BUILD]: "build",
	[OfficeServiceKind.CI_WATCH]: "ci-watch",
	[OfficeServiceKind.GIT]: "git",
	[OfficeServiceKind.DATABASE]: "database",
	[OfficeServiceKind.SCRIPT]: "script",
};

/** Services that run until stopped: their long silence is how they work, not being stuck (no hourglass, no dozing). */
const LONG_LIVED: ReadonlySet<ServiceKind> = new Set(["dev-server", "test-watch", "database"]);

export const APPROVALS: Readonly<Partial<Record<OfficeApprovalState, ApprovalState>>> = {
	[OfficeApprovalState.WAITING]: "waiting",
	[OfficeApprovalState.ALLOWED]: "allowed",
	[OfficeApprovalState.DENIED]: "denied",
	[OfficeApprovalState.CANCELLED]: "cancelled",
};

/** An actor as the store keeps it: the view without what the clock decides, plus the state an approval interrupted. */
export type ActorRecord = Omit<ActorView, "activity" | "service"> & {
	readonly activity: Omit<ActivityView, "slow" | "stuckMs"> | null;
	readonly service: Omit<ServiceView, "uptimeMs"> | null;
	readonly beforeApproval: ActorState | null;
};

/** A tool running this long shows an hourglass. */
export const SLOW_TOOL_MS = 120_000;
/** A slow tool whose actor has been silent this long: they doze off where they work. */
export const STUCK_MS = 5 * 60_000;

/** An actor as the views see it at machine time `now`: whether its work runs long, and whether they doze off over it. */
export function actorViewOf(record: ActorRecord, now: number): ActorView {
	const { beforeApproval: _before, activity, service: label, ...rest } = record;
	const service = label === null ? null : { ...label, uptimeMs: Math.max(0, now - label.startedAt) };
	if (activity === null) return { ...rest, activity: null, service };
	// Only work still going on runs long: a finished subagent keeps its hand-in spot as an activity. A dev server,
	// a test watcher or a database runs on by design.
	const runsOn = service !== null && LONG_LIVED.has(service.kind);
	const slow = !runsOn && rest.state === "working" && activity.startedAt > 0 && now - activity.startedAt >= SLOW_TOOL_MS;
	const silent = now - Math.max(rest.heardAt, activity.startedAt);
	return { ...rest, activity: { ...activity, slow, stuckMs: slow && silent >= STUCK_MS ? silent : null }, service };
}

/** The actor an event is about, or null (a turn, the session). */
export function eventActor(e: OfficeEvent): string | null {
	const k = e.kind;
	switch (k.case) {
		case "actorEnter":
		case "actorUpdate":
			return k.value.id;
		case "actorLeave":
		case "activityStart":
		case "activityEnd":
		case "approval":
			return k.value.actorId;
		default:
			return null;
	}
}

export function activityOf(a: OfficeActivity | undefined): ActorRecord["activity"] {
	if (a === undefined || a.id === "") return null;
	return { id: a.id, tool: a.tool, group: GROUPS[a.group] ?? "type", room: roomOf(a.room), subject: a.subject, startedAt: Number(a.startedAt) };
}

/** A machine's label; an unset or unknown kind (a newer agent's) reads as a script. */
export function serviceOf(s: OfficeService | undefined): ActorRecord["service"] {
	if (s === undefined) return null;
	const port = s.port >= 1 && s.port <= 65_535 ? s.port : null;
	return { kind: SERVICE_KINDS[s.kind] ?? "script", port, startedAt: Number(s.startedAt) };
}

const ROLES: Readonly<Partial<Record<OfficeRole, ActorRole>>> = {
	[OfficeRole.DIRECTOR]: "director",
	[OfficeRole.EMPLOYEE]: "employee",
	[OfficeRole.MACHINE]: "machine",
	[OfficeRole.ADVISOR]: "advisor",
};

/** The role of a wire value; null for UNSPECIFIED or a role a newer agent added (such an actor is not shown, never hired as an employee). */
export function roleOf(role: OfficeRole): ActorRole | null {
	return ROLES[role] ?? null;
}

/** The actor as the store keeps it; null for one of a role this app does not know (left out with every event about it). */
export function actorOf(a: OfficeActor, previous: ActorRecord | undefined): ActorRecord | null {
	const role = a.id === "director" ? "director" : roleOf(a.role);
	if (role === null) return null;
	return {
		id: a.id,
		role,
		agentType: a.agentType,
		description: a.description,
		parentId: a.parentId,
		spawnDepth: a.spawnDepth,
		state: STATES[a.state] ?? "working",
		activity: activityOf(a.activity),
		enteredAt: Number(a.enteredAt),
		doneAt: Number(a.doneAt),
		heardAt: previous?.heardAt ?? Math.max(Number(a.enteredAt), Number(a.activity?.startedAt ?? 0n)),
		approval: previous?.approval ?? null,
		lastResult: previous?.lastResult ?? null,
		service: role === "machine" ? serviceOf(a.service) : null,
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

