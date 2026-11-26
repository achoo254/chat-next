// The Live Map's view of a watched Claude Code session, read from
// Observatory's frames (docs/observatory-wire.md sections 2, 3 and 6). This is
// the one file that reads the generated types: the rest of the Live Map works
// on these plain values (milliseconds and counts as numbers, enums as words),
// so a field the machine adds changes this file and the code that uses it.
import {
	ObservatoryContentState,
	ObservatoryCoreState,
	ObservatorySessionSource,
	type ObservatoryBottleneck,
	type ObservatoryContentResult,
	type ObservatoryEvent,
	type ObservatoryLiveState,
	type ObservatorySessionInfo,
	type ObservatorySnapshot,
	type ObservatoryStationNumbers,
	type ObservatoryStationResult,
} from "@achoo254/chat-proto/remote/remote";

/** How the session runs: through tunelo's Agent SDK, in tunelo's terminal, or as a Claude Code CLI with Observatory's hooks. */
export type SessionSource = "sdk" | "terminal" | "cli" | "unknown";

export type CoreState = "idle" | "thinking" | "waiting_permission" | "waiting_user" | "compacting" | "failed";

/** A session as the machine lists it (no content, no account). */
export interface LiveMapSessionInfo {
	readonly sessionId: string;
	readonly previousSessionId: string;
	/** The repository key (`github.com/acme/app`, `local:<folder>`, `scratch`). */
	readonly projectKey: string;
	/** The working folder, the home folder as `~`. */
	readonly cwd: string;
	readonly source: SessionSource;
	/** "" for a user's session; Advisor's own sessions carry a label. */
	readonly internalLabel: string;
	/** Unix milliseconds on the machine. */
	readonly startedAt: number;
	/** 0 while it runs. */
	readonly endedAt: number;
	readonly mainModel: string;
}

/** The session as a whole as the machine works it out (section 6.3): what a live view shows. */
export interface LiveMapLiveState {
	readonly core: CoreState;
	readonly tokensPerSecond: number | null;
	/** null when the model's window is unknown. */
	readonly contextPercent: number | null;
	readonly contextTokens: number;
	/** 0 when unknown. */
	readonly contextWindow: number;
	/** The standard window was taken for a model that may have the long one: the percent is approximate. */
	readonly contextWindowAssumed: boolean;
	readonly mainModel: string;
	/** Tool calls running now, by station code as sent. */
	readonly running: readonly { readonly station: string; readonly count: number }[];
	readonly openBottlenecks: number;
	/** Subagents started and not stopped in the whole session (tunelo 3.30.0+; empty before), however old their start. */
	readonly subagents: readonly { readonly agentId: string; readonly agentType: string }[];
}

/** A bottleneck finding (section 6.4). */
export interface LiveMapBottleneck {
	readonly rule: string;
	readonly subkey: string;
	readonly station: string;
	readonly severity: "warn" | "alert";
	readonly open: boolean;
	readonly openedAt: number;
	readonly updatedAt: number;
	/** 0 while open. */
	readonly closedAt: number;
	readonly value?: number;
	readonly threshold?: number;
	readonly n?: number;
	/** Ids of the events behind it. */
	readonly evidenceIds: readonly string[];
}

/** What happened, by kind; never content. */
export type LiveMapEventBody =
	| { readonly kind: "prompt"; readonly promptId: string }
	| {
			readonly kind: "tool";
			readonly toolUseId: string;
			/** "" for the main agent. */
			readonly agentId: string;
			readonly toolName: string;
			/** "" unless an MCP tool. */
			readonly mcpServer: string;
			/** What the privacy filter kept of it: a file as `folder/name`, a domain, a command's program, `server › tool`; "" when none. */
			readonly target: string;
			/** The station code as the machine sent it (station-catalog.ts reads an unknown one as CORE). */
			readonly station: string;
			readonly stationFlags: number;
			/** Unset while the call runs. */
			readonly success?: boolean;
			readonly durationMs?: number;
			/** Why it did not succeed, a fixed label (`failed`, `interrupted`, `permission denied`); unset when none was sent. */
			readonly error?: string;
	  }
	| { readonly kind: "subagent"; readonly agentId: string; readonly agentType: string; readonly endedAt: number; readonly model: string }
	| {
			readonly kind: "api";
			readonly agentId: string;
			/** One of Claude Code's side features after a turn (SIDE_REQUESTS), not the AI working. */
			readonly side: boolean;
			readonly model: string;
			readonly outputTokens?: number;
			/** The context the request carried (input, cache read, both cache writes); unset when the event gave none of them. */
			readonly contextTokens?: number;
			readonly durationMs?: number;
			readonly ttftMs?: number;
	  }
	| { readonly kind: "instruction"; readonly memoryType: string; readonly loadReason: string }
	| { readonly kind: "git"; readonly gitKind: string }
	| {
			readonly kind: "lifecycle";
			/** `permission_request`, `stop`, `compact_start`… (section 3); an unknown one changes nothing. */
			readonly name: string;
			readonly agentId: string;
			readonly toolUseId: string;
			readonly station: string;
			readonly label: string;
			readonly number?: number;
			readonly flag?: boolean;
	  }
	| ({ readonly kind: "bottleneck" } & LiveMapBottleneck)
	/** The session's own row and live state changed. */
	| { readonly kind: "session"; readonly info: LiveMapSessionInfo | null; readonly live: LiveMapLiveState | null }
	/** A kind this app does not know (a newer machine): it only moves `seq` on. */
	| { readonly kind: "unknown" };

export type LiveMapEvent = LiveMapEventBody & {
	/** 0 in a snapshot or a page of older events. */
	readonly seq: number;
	/** Unix milliseconds on the machine. */
	readonly at: number;
	/** Stable for the stored row: a later event with the same id replaces it. */
	readonly id: string;
	/** Read from the spool's tail before the machine stored it in full: the stored version with the same id replaces it. */
	readonly provisional: boolean;
};

/** A watch's starting point: the newest events, oldest first. */
export interface LiveMapSnapshot {
	readonly sessionId: string;
	readonly epoch: bigint;
	readonly seq: number;
	readonly info: LiveMapSessionInfo | null;
	readonly live: LiveMapLiveState | null;
	readonly events: readonly LiveMapEvent[];
	/** Where older events start; "" when none is older. */
	readonly earlier: string;
}

/** An event's content (section 6.5): stored, switched off for its project, none kept, or not stored yet (a provisional event). */
export type ContentState = "stored" | "off" | "none" | "not_yet" | "unknown";

export interface LiveMapContent {
	readonly eventId: string;
	readonly state: ContentState;
	/** "" unless stored. */
	readonly text: string;
}

/** A station's numbers (section 6.6); the failure rate is failures / ended. */
export interface StationNumbers {
	readonly calls: number;
	readonly failures: number;
	readonly ended: number;
	readonly p50Ms?: number;
	readonly p95Ms?: number;
	/** p50/p95 were worked out on a sample. */
	readonly sampled: boolean;
	readonly apiRequests: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** Only meaningful when `hasCost`. */
	readonly costUsdEstimate: number;
	readonly hasCost: boolean;
	readonly requestsWithoutCost: number;
}

/** A station's drill-down (ObservatoryStationResult). */
export interface StationDrill {
	readonly sessionId: string;
	readonly station: string;
	/** 0: the whole session; else up to this moment. */
	readonly at: number;
	readonly numbers: StationNumbers;
	/** By sub-key (`mcp_server`, `file`, `domain`, `program`, `tool`, `model`), most called first. */
	readonly parts: readonly { readonly kind: string; readonly key: string; readonly numbers: StationNumbers }[];
	readonly slowest: readonly LiveMapEvent[];
	readonly recent: readonly LiveMapEvent[];
	/** Up to 5 earlier sessions of the same repository, newest first. */
	readonly previous: readonly { readonly sessionId: string; readonly startedAt: number; readonly numbers: StationNumbers }[];
	readonly bottlenecks: readonly LiveMapBottleneck[];
}

const SOURCES: Readonly<Record<ObservatorySessionSource, SessionSource>> = {
	[ObservatorySessionSource.UNSPECIFIED]: "unknown",
	[ObservatorySessionSource.SDK]: "sdk",
	[ObservatorySessionSource.TERMINAL]: "terminal",
	[ObservatorySessionSource.CLI]: "cli",
};

const CORE_STATES: Readonly<Record<ObservatoryCoreState, CoreState>> = {
	[ObservatoryCoreState.UNSPECIFIED]: "idle",
	[ObservatoryCoreState.IDLE]: "idle",
	[ObservatoryCoreState.THINKING]: "thinking",
	[ObservatoryCoreState.WAITING_PERMISSION]: "waiting_permission",
	[ObservatoryCoreState.WAITING_USER]: "waiting_user",
	[ObservatoryCoreState.COMPACTING]: "compacting",
	[ObservatoryCoreState.FAILED]: "failed",
};

const CONTENT_STATES: Readonly<Record<ObservatoryContentState, ContentState>> = {
	[ObservatoryContentState.UNSPECIFIED]: "unknown",
	[ObservatoryContentState.STORED]: "stored",
	[ObservatoryContentState.OFF]: "off",
	[ObservatoryContentState.NONE]: "none",
	[ObservatoryContentState.NOT_YET]: "not_yet",
};

/** A uint64/int64 of the wire as a number: milliseconds, counts and tokens stay far below 2^53. */
const num = (value: bigint): number => Number(value);
const optNum = (value: bigint | number | undefined): number | undefined => (value === undefined ? undefined : Number(value));

/** An enum value a newer machine may send that this app does not know. */
function known<K extends number, V>(table: Readonly<Record<K, V>>, value: K, fallback: V): V {
	return Object.hasOwn(table, value) ? table[value] : fallback;
}

export function sessionInfoFromWire(info: ObservatorySessionInfo): LiveMapSessionInfo {
	return {
		sessionId: info.sessionId,
		previousSessionId: info.previousSessionId,
		projectKey: info.projectKey,
		cwd: info.cwd,
		source: known(SOURCES, info.source, "unknown"),
		internalLabel: info.internalLabel,
		startedAt: num(info.startedAt),
		endedAt: num(info.endedAt),
		mainModel: info.mainModel,
	};
}

/**
 * Requests Claude Code makes on the session's own thread for its side
 * features once a turn ends (the next prompt it suggests, the session's
 * title): no agent, but not the AI working either. The machine leaves them
 * out the same way (apps/agent observatory store/live-map-reads.ts).
 */
export const SIDE_REQUESTS: readonly string[] = ["prompt_suggestion", "generate_session_title"];

/** A request of the main thread doing the session's work: no agent, and not a side feature. */
export const isMainRequest = (e: { readonly agentId: string; readonly side: boolean }): boolean => e.agentId === "" && !e.side;

export function liveStateFromWire(live: ObservatoryLiveState): LiveMapLiveState {
	return {
		core: known(CORE_STATES, live.core, "idle"),
		tokensPerSecond: live.tokensPerSecond ?? null,
		contextPercent: live.contextPercent ?? null,
		contextTokens: num(live.contextTokens),
		contextWindow: num(live.contextWindow),
		contextWindowAssumed: live.contextWindowAssumed,
		mainModel: live.mainModel,
		running: live.running.map((r) => ({ station: r.station, count: r.count })),
		openBottlenecks: live.openBottlenecks,
		subagents: live.subagents.map((s) => ({ agentId: s.agentId, agentType: s.agentType })),
	};
}

export function bottleneckFromWire(b: ObservatoryBottleneck): LiveMapBottleneck {
	return {
		rule: b.rule,
		subkey: b.subkey,
		station: b.station,
		severity: b.severity === "alert" ? "alert" : "warn",
		open: b.status === "open",
		openedAt: num(b.openedAt),
		updatedAt: num(b.updatedAt),
		closedAt: num(b.closedAt),
		...(b.value === undefined ? {} : { value: b.value }),
		...(b.threshold === undefined ? {} : { threshold: b.threshold }),
		...(b.n === undefined ? {} : { n: b.n }),
		evidenceIds: [...b.evidenceIds],
	};
}

function bodyFromWire(kind: ObservatoryEvent["kind"]): LiveMapEventBody {
	switch (kind.case) {
		case "prompt":
			return { kind: "prompt", promptId: kind.value.promptId };
		case "toolCall": {
			const v = kind.value;
			return {
				kind: "tool",
				toolUseId: v.toolUseId,
				agentId: v.agentId,
				toolName: v.toolName,
				mcpServer: v.mcpServer,
				target: v.target,
				station: v.station,
				stationFlags: v.stationFlags,
				...(v.success === undefined ? {} : { success: v.success }),
				...(v.durationMs === undefined ? {} : { durationMs: v.durationMs }),
				...(v.error === "" ? {} : { error: v.error }),
			};
		}
		case "subagent":
			return { kind: "subagent", agentId: kind.value.agentId, agentType: kind.value.agentType, endedAt: num(kind.value.endedAt), model: kind.value.model };
		case "apiRequest": {
			const v = kind.value;
			const outputTokens = optNum(v.outputTokens);
			const carried = [v.inputTokens, v.cacheReadTokens, v.cacheWrite5mTokens, v.cacheWrite1hTokens].map(optNum);
			const contextTokens = carried.some((n) => n !== undefined) ? carried.reduce<number>((sum, n) => sum + (n ?? 0), 0) : undefined;
			return {
				kind: "api",
				agentId: v.agentId,
				side: v.agentId === "" && SIDE_REQUESTS.includes(v.querySource),
				model: v.model,
				...(outputTokens === undefined ? {} : { outputTokens }),
				...(contextTokens === undefined ? {} : { contextTokens }),
				...(v.durationMs === undefined ? {} : { durationMs: v.durationMs }),
				...(v.ttftMs === undefined ? {} : { ttftMs: v.ttftMs }),
			};
		}
		case "instructionLoaded":
			return { kind: "instruction", memoryType: kind.value.memoryType, loadReason: kind.value.loadReason };
		case "gitOp":
			return { kind: "git", gitKind: kind.value.kind };
		case "sessionEvent": {
			const v = kind.value;
			return {
				kind: "lifecycle",
				name: v.kind,
				agentId: v.agentId,
				toolUseId: v.toolUseId,
				station: v.station,
				label: v.label,
				...(v.number === undefined ? {} : { number: v.number }),
				...(v.flag === undefined ? {} : { flag: v.flag }),
			};
		}
		case "bottleneck":
			return { kind: "bottleneck", ...bottleneckFromWire(kind.value) };
		case "session":
			return {
				kind: "session",
				info: kind.value.info === undefined ? null : sessionInfoFromWire(kind.value.info),
				live: kind.value.live === undefined ? null : liveStateFromWire(kind.value.live),
			};
		default:
			return { kind: "unknown" };
	}
}

export function eventFromWire(event: ObservatoryEvent): LiveMapEvent {
	return { ...bodyFromWire(event.kind), seq: num(event.seq), at: num(event.at), id: event.id, provisional: event.provisional };
}

export function snapshotFromWire(snapshot: ObservatorySnapshot): LiveMapSnapshot {
	const info = snapshot.session?.info;
	const live = snapshot.session?.live;
	return {
		sessionId: snapshot.sessionId,
		epoch: snapshot.epoch,
		seq: num(snapshot.seq),
		info: info === undefined ? null : sessionInfoFromWire(info),
		live: live === undefined ? null : liveStateFromWire(live),
		events: snapshot.events.map(eventFromWire),
		earlier: snapshot.earlier,
	};
}

export function contentFromWire(result: ObservatoryContentResult): LiveMapContent {
	const state = known(CONTENT_STATES, result.state, "unknown");
	return { eventId: result.eventId, state, text: state === "stored" ? result.text : "" };
}

const EMPTY_NUMBERS: StationNumbers = {
	calls: 0,
	failures: 0,
	ended: 0,
	sampled: false,
	apiRequests: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsdEstimate: 0,
	hasCost: false,
	requestsWithoutCost: 0,
};

export function stationNumbersFromWire(n: ObservatoryStationNumbers | undefined): StationNumbers {
	if (n === undefined) return EMPTY_NUMBERS;
	return {
		calls: n.calls,
		failures: n.failures,
		ended: n.ended,
		...(n.p50Ms === undefined ? {} : { p50Ms: n.p50Ms }),
		...(n.p95Ms === undefined ? {} : { p95Ms: n.p95Ms }),
		sampled: n.sampled,
		apiRequests: n.apiRequests,
		inputTokens: num(n.inputTokens),
		outputTokens: num(n.outputTokens),
		cacheReadTokens: num(n.cacheReadTokens),
		cacheWriteTokens: num(n.cacheWriteTokens),
		costUsdEstimate: n.costUsdEstimate,
		hasCost: n.hasCost,
		requestsWithoutCost: n.requestsWithoutCost,
	};
}

export function stationDrillFromWire(r: ObservatoryStationResult): StationDrill {
	return {
		sessionId: r.sessionId,
		station: r.station,
		at: num(r.at),
		numbers: stationNumbersFromWire(r.numbers),
		parts: r.parts.map((p) => ({ kind: p.kind, key: p.key, numbers: stationNumbersFromWire(p.numbers) })),
		slowest: r.slowest.map(eventFromWire),
		recent: r.recent.map(eventFromWire),
		previous: r.previous.map((p) => ({ sessionId: p.sessionId, startedAt: num(p.startedAt), numbers: stationNumbersFromWire(p.numbers) })),
		bottlenecks: r.bottlenecks.map(bottleneckFromWire),
	};
}
