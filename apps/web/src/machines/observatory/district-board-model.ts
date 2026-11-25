// What a module shows when the camera is on it, and what its detail reads
// (pure): the module's last calls, newest first, the running ones first and
// marked (files: 4, terminal: 4, tests: 3, MCP: the last call per server,
// internet: 3 domains, others: 3), each with its tool, target and runtime;
// for the model, its API turns; for the subagents' ring, the running
// subagents; for the context reservoir, the context's fill; for the
// permission lock, what waits; for the input port, the prompt count.
import { agentTypeOf } from "./activity-card-model.ts";
import { coreStateOf, runningCalls, toolCalls, type ToolCall } from "./call-history.ts";
import type { LiveMapState } from "./live-map-state.ts";
import { STATION_PLACE, type PlaceId } from "./render/scene-table.ts";
import { STATION_CODES } from "./station-catalog.ts";

export interface BoardRow {
	readonly eventId: string;
	readonly tool: string;
	/** The MCP server of an MCP tool; "" otherwise. */
	readonly mcpServer: string;
	/** Filtered target; "" when none. */
	readonly target: string;
	/** The subagent's type; null for the main agent, "" for a subagent whose type is not known. */
	readonly agent: string | null;
	readonly running: boolean;
	readonly ok: boolean | undefined;
	readonly runtimeMs: number;
}

export type DistrictBoard =
	| { readonly kind: "calls"; readonly rows: readonly BoardRow[] }
	| { readonly kind: "model"; readonly apiTurns: number; readonly contextPercent: number | null; readonly tokensPerSecond: number | null; readonly model: string }
	/** The running subagents' types ("" when not known: the view names it). */
	| { readonly kind: "subagents"; readonly running: readonly string[] }
	| { readonly kind: "context"; readonly percent: number | null; readonly tokens: number; readonly window: number }
	| { readonly kind: "permission"; readonly waiting: boolean; readonly what: string }
	| { readonly kind: "prompts"; readonly count: number };

const ROWS: Partial<Record<PlaceId, number>> = { files: 4, sandbox: 4, testing: 3, external: 3, mcp: 3, git: 3 };

function row(state: LiveMapState, c: ToolCall, now: number): BoardRow {
	const running = c.endAt === undefined;
	return {
		eventId: c.event.id,
		tool: c.event.toolName,
		mcpServer: c.event.mcpServer,
		target: c.event.target,
		agent: agentTypeOf(state, c.event.agentId),
		running,
		ok: c.ok,
		runtimeMs: Math.max(0, running ? now - c.event.at : (c.event.durationMs ?? 0)),
	};
}

export function districtBoardOf(state: LiveMapState, place: PlaceId, now: number): DistrictBoard {
	switch (place) {
		case "core":
			return {
				kind: "model",
				apiTurns: state.log.filter((e) => e.kind === "api" && e.agentId === "").length,
				contextPercent: state.live?.contextPercent ?? null,
				tokensPerSecond: state.live?.tokensPerSecond ?? state.scene.tokensPerSecond,
				model: state.live?.mainModel || state.scene.model,
			};
		case "orchestrator":
			return { kind: "subagents", running: Object.values(state.scene.subagents).filter((s) => s.running).map((s) => s.agentType) };
		case "monitoring":
			return { kind: "context", percent: state.live?.contextPercent ?? null, tokens: state.live?.contextTokens ?? 0, window: state.live?.contextWindow ?? 0 };
		case "security": {
			const waiting = coreStateOf(state) === "waiting_permission";
			const request = [...state.log].reverse().find((e) => e.kind === "lifecycle" && e.name === "permission_request");
			return { kind: "permission", waiting, what: waiting && request?.kind === "lifecycle" ? request.label : "" };
		}
		case "user-desk":
			return { kind: "prompts", count: state.log.filter((e) => e.kind === "prompt").length };
		default:
			break;
	}
	const station = STATION_CODES.find((code) => STATION_PLACE[code] === place);
	const calls = toolCalls(state).filter((c) => c.station === station);
	const running = runningCalls(state).filter((c) => c.station === station).reverse();
	const ended = calls.filter((c) => c.endAt !== undefined).sort((a, b) => (b.endAt ?? 0) - (a.endAt ?? 0));
	let recent: ToolCall[] = [...running, ...ended];
	if (place === "mcp") {
		// The last call of each server.
		const seen = new Set<string>();
		recent = recent.filter((c) => (seen.has(c.event.mcpServer) ? false : (seen.add(c.event.mcpServer), true)));
	}
	const rows = recent.slice(0, ROWS[place] ?? 3).map((c) => row(state, c, now));
	return { kind: "calls", rows };
}
