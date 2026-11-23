// The Live Map's own view of a watched Claude Code session, and the one place
// that reads Observatory's frames into it (docs/observatory-wire.md). The rest
// of the Live Map (live-map-state.ts, the client, the hook) sees only these
// types, so the frames the machine adds for the Live Map (provisional events
// from the spool's tail, bottleneck findings) change this file alone: today
// `provisional` is always false and no frame carries a bottleneck yet.
import { ObservatorySessionSource, type ObservatoryEvent, type ObservatorySessionInfo, type ObservatorySnapshot } from "@achoo254/chat-proto/remote/remote";

/** How the session runs: through tunelo's Agent SDK, in tunelo's terminal, or as a Claude Code CLI with Observatory's hooks. */
export type SessionSource = "sdk" | "terminal" | "cli" | "unknown";

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
			/** The station code as the machine sent it (station-catalog.ts reads an unknown one as CORE). */
			readonly station: string;
			readonly stationFlags: number;
			/** Unset while the call runs. */
			readonly success?: boolean;
			readonly durationMs?: number;
			/** Read from the spool's tail before the machine stored it: the stored version with the same id replaces it. */
			readonly provisional: boolean;
	  }
	| { readonly kind: "subagent"; readonly agentId: string; readonly agentType: string; readonly endedAt: number; readonly model: string }
	| {
			readonly kind: "api";
			readonly agentId: string;
			readonly model: string;
			readonly outputTokens?: number;
			readonly durationMs?: number;
			readonly ttftMs?: number;
	  }
	| { readonly kind: "instruction"; readonly memoryType: string; readonly loadReason: string }
	| { readonly kind: "git"; readonly gitKind: string }
	| {
			readonly kind: "lifecycle";
			/** `permission_request`, `stop`, `compact_start`… (docs/observatory-wire.md section 3); an unknown one changes nothing. */
			readonly name: string;
			readonly agentId: string;
			readonly toolUseId: string;
			readonly station: string;
			readonly label: string;
			readonly number?: number;
			readonly flag?: boolean;
	  }
	| {
			readonly kind: "bottleneck";
			readonly station: string;
			readonly severity: "warn" | "alert";
			readonly open: boolean;
	  }
	/** The session's own row changed. */
	| { readonly kind: "session"; readonly info: LiveMapSessionInfo | null }
	/** A kind this app does not know (a newer machine): it only moves `seq` on. */
	| { readonly kind: "unknown" };

export type LiveMapEvent = LiveMapEventBody & {
	/** 0 in a snapshot or a page of older events. */
	readonly seq: number;
	/** Unix milliseconds on the machine. */
	readonly at: number;
	/** Stable for the stored row: a later event with the same id replaces it. */
	readonly id: string;
};

/** A watch's starting point: the newest events, oldest first. */
export interface LiveMapSnapshot {
	readonly sessionId: string;
	readonly epoch: bigint;
	readonly seq: number;
	readonly info: LiveMapSessionInfo | null;
	readonly events: readonly LiveMapEvent[];
	/** Where older events start; "" when none is older. */
	readonly earlier: string;
}

const SOURCES: Readonly<Record<ObservatorySessionSource, SessionSource>> = {
	[ObservatorySessionSource.UNSPECIFIED]: "unknown",
	[ObservatorySessionSource.SDK]: "sdk",
	[ObservatorySessionSource.TERMINAL]: "terminal",
	[ObservatorySessionSource.CLI]: "cli",
};

/** A uint64/int64 of the wire as a number: milliseconds, counts and tokens stay far below 2^53. */
const num = (value: bigint): number => Number(value);
const optNum = (value: bigint | number | undefined): number | undefined => (value === undefined ? undefined : Number(value));

export function sessionInfoFromWire(info: ObservatorySessionInfo): LiveMapSessionInfo {
	return {
		sessionId: info.sessionId,
		previousSessionId: info.previousSessionId,
		projectKey: info.projectKey,
		cwd: info.cwd,
		source: SOURCES[info.source] ?? "unknown",
		internalLabel: info.internalLabel,
		startedAt: num(info.startedAt),
		endedAt: num(info.endedAt),
		mainModel: info.mainModel,
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
				station: v.station,
				stationFlags: v.stationFlags,
				...(v.success === undefined ? {} : { success: v.success }),
				...(v.durationMs === undefined ? {} : { durationMs: v.durationMs }),
				provisional: false,
			};
		}
		case "subagent":
			return { kind: "subagent", agentId: kind.value.agentId, agentType: kind.value.agentType, endedAt: num(kind.value.endedAt), model: kind.value.model };
		case "apiRequest": {
			const v = kind.value;
			const outputTokens = optNum(v.outputTokens);
			return {
				kind: "api",
				agentId: v.agentId,
				model: v.model,
				...(outputTokens === undefined ? {} : { outputTokens }),
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
		case "session":
			return { kind: "session", info: kind.value.info === undefined ? null : sessionInfoFromWire(kind.value.info) };
		default:
			return { kind: "unknown" };
	}
}

export function eventFromWire(event: ObservatoryEvent): LiveMapEvent {
	return { ...bodyFromWire(event.kind), seq: num(event.seq), at: num(event.at), id: event.id };
}

export function snapshotFromWire(snapshot: ObservatorySnapshot): LiveMapSnapshot {
	const info = snapshot.session?.info;
	return {
		sessionId: snapshot.sessionId,
		epoch: snapshot.epoch,
		seq: num(snapshot.seq),
		info: info === undefined ? null : sessionInfoFromWire(info),
		events: snapshot.events.map(eventFromWire),
		earlier: snapshot.earlier,
	};
}
