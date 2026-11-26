// Events and snapshots of a Live Map session, as live-map-types.ts reads them
// from the machine's frames.
import type { LiveMapEvent, LiveMapEventBody, LiveMapSessionInfo, LiveMapSnapshot } from "../../../src/machines/observatory/live-map-types.ts";

export const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);

export const info = (over: Partial<LiveMapSessionInfo> = {}): LiveMapSessionInfo => ({
	sessionId: "s1",
	previousSessionId: "",
	projectKey: "github.com/acme/app",
	cwd: "~/app",
	source: "cli",
	internalLabel: "",
	startedAt: T0,
	endedAt: 0,
	mainModel: "claude-opus",
	...over,
});

const at = (body: LiveMapEventBody, id: string, ms: number, seq = 0, provisional = false): LiveMapEvent => ({ ...body, id, at: T0 + ms, seq, provisional });

export const prompt = (n: number, ms: number, seq = 0): LiveMapEvent => at({ kind: "prompt", promptId: `p${n}` }, `prompt:p${n}`, ms, seq);

export function tool(
	use: string,
	ms: number,
	{ provisional = false, ...over }: Partial<Extract<LiveMapEventBody, { kind: "tool" }>> & { provisional?: boolean } = {},
	seq = 0,
): LiveMapEvent {
	return at({ kind: "tool", toolUseId: use, agentId: "", toolName: "Read", mcpServer: "", target: "", station: "FILES", stationFlags: 0, ...over }, `tool:${use}`, ms, seq, provisional);
}

export const subagent = (agent: string, ms: number, endedAt = 0, seq = 0): LiveMapEvent =>
	at({ kind: "subagent", agentId: agent, agentType: "Explore", endedAt, model: "claude-haiku" }, `subagent:${agent}`, ms, seq);

export const api = (key: string, ms: number, over: Partial<Extract<LiveMapEventBody, { kind: "api" }>> = {}, seq = 0): LiveMapEvent =>
	at({ kind: "api", agentId: "", side: false, model: "claude-opus", outputTokens: 500, durationMs: 3_000, ttftMs: 500, ...over }, `api:${key}`, ms, seq);

export const lifecycle = (name: string, key: string, ms: number, over: Partial<Extract<LiveMapEventBody, { kind: "lifecycle" }>> = {}, seq = 0): LiveMapEvent =>
	at({ kind: "lifecycle", name, agentId: "", toolUseId: "", station: "CORE", label: "", ...over }, `event:${key}`, ms, seq);

export const bottleneck = (key: string, ms: number, station: string, severity: "warn" | "alert", open: boolean, seq = 0): LiveMapEvent =>
	at(
		{ kind: "bottleneck", rule: key, subkey: "", station, severity, open, openedAt: T0 + ms, updatedAt: T0 + ms, closedAt: open ? 0 : T0 + ms + 1, evidenceIds: [] },
		`bottleneck:${key}`,
		ms,
		seq,
	);

export const unknown = (ms: number, seq: number): LiveMapEvent => at({ kind: "unknown" }, `later:${seq}`, ms, seq);

export const snapshot = (events: readonly LiveMapEvent[], over: Partial<LiveMapSnapshot> = {}): LiveMapSnapshot => ({
	sessionId: "s1",
	epoch: 1n,
	seq: 0,
	info: info(),
	live: null,
	events,
	earlier: "",
	...over,
});

/** `events` numbered from `from` (the seq the machine gives them as it sends them live). */
export const numbered = (events: readonly LiveMapEvent[], from = 1): LiveMapEvent[] => events.map((e, i) => ({ ...e, seq: from + i }));
