// What the bottleneck rules know of one session, in memory: its tool calls,
// API calls, subagents, prompts and session events, merged from every write
// that touched them (a batch the store took, a provisional event read from
// the spool's tail) the way the store merges them (observatory-table-specs.ts),
// so a row told by two sources in either order ends up the same. Loaded once
// from the store when the runner first meets the session.
//
// Never content: a prompt's excerpt and a tool call's content are not copied
// in, whatever the write held.
import type { SessionTimeline } from "../store/store-reads.ts";
import type { ApiRequestWrite, PromptWrite, SessionEventWrite, SessionWrite, SubagentWrite, ToolCallWrite, WriteOp } from "../store/write-ops.ts";
import { StationFlag } from "../live-map/station-map.ts";

export type ToolCallState = {
  toolUseId: string;
  promptId: string | null;
  agentId: string | null;
  /** The call's start (the earliest time told). */
  at: number;
  /** The latest time any record of the call told (its end when no duration was given). */
  lastAt: number;
  toolName: string | null;
  station: string | null;
  stationFlags: number | null;
  mcpServer: string | null;
  /** The filtered target: a shell call's program, a file's `folder/name`. */
  target: string | null;
  targetKey: string | null;
  readOffset: number | null;
  readLimit: number | null;
  durationMs: number | null;
  success: boolean | null;
  /** A fixed label (failed, interrupted, permission denied), never text from the call. */
  error: string | null;
};

export type ApiCallState = {
  dedupeKey: string;
  at: number;
  promptId: string | null;
  agentId: string | null;
  model: string | null;
  querySource: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
};

export type SubagentState = { agentId: string; promptId: string | null; startedAt: number; endedAt: number | null };
export type PromptState = { promptId: string; at: number };
export type SessionEventState = {
  dedupeKey: string;
  at: number;
  kind: string;
  agentId: string | null;
  toolUseId: string | null;
  label: string | null;
  number: number | null;
  flag: boolean | null;
};

/** The value a `fill` merge keeps: the new one when it has one. */
const fill = <T>(stored: T | null, given: T | null | undefined): T | null => (given === undefined || given === null ? stored : given);
const minOf = (a: number, b: number | undefined): number => (b === undefined ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null | undefined): number | null => (b === undefined || b === null ? a : a === null ? b : Math.max(a, b));

/** Total tokens of an API call: input, output and cache, the parts it told. */
export function apiTokens(a: ApiCallState): number {
  return (a.inputTokens ?? 0) + (a.outputTokens ?? 0) + (a.cacheReadTokens ?? 0) + (a.cacheWrite5mTokens ?? 0) + (a.cacheWrite1hTokens ?? 0);
}

/** A call has ended: its outcome or its duration is known. */
export function toolEnded(call: ToolCallState): boolean {
  return call.success !== null || call.durationMs !== null;
}

/** When a call ended; undefined while it runs. */
export function toolEndAt(call: ToolCallState): number | undefined {
  if (call.durationMs !== null) return call.at + call.durationMs;
  return call.success !== null ? call.lastAt : undefined;
}

/** A file tool that writes (the station's flag, else its name). */
export function isWriteCall(call: ToolCallState): boolean {
  return ((call.stationFlags ?? 0) & StationFlag.write) !== 0 || ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.toolName ?? "");
}

export class SessionModel {
  projectKey: string | null = null;
  internalLabel: string | null = null;
  endedAt: number | null = null;
  /** The latest time of anything the session did (an activity after its end means it was resumed). */
  lastActivityAt = 0;
  private readonly tools = new Map<string, ToolCallState>();
  private readonly apis = new Map<string, ApiCallState>();
  private readonly agents = new Map<string, SubagentState>();
  private readonly promptMap = new Map<string, PromptState>();
  private readonly eventMap = new Map<string, SessionEventState>();
  private sorted: { tools: ToolCallState[]; apis: ApiCallState[]; agents: SubagentState[]; prompts: PromptState[]; events: SessionEventState[] } | undefined;

  constructor(readonly sessionId: string) {}

  /** The session ended and did nothing since. */
  get ended(): boolean {
    return this.endedAt !== null && this.endedAt >= this.lastActivityAt;
  }

  get toolCalls(): readonly ToolCallState[] {
    return this.views().tools;
  }
  get apiCalls(): readonly ApiCallState[] {
    return this.views().apis;
  }
  get subagents(): readonly SubagentState[] {
    return this.views().agents;
  }
  get prompts(): readonly PromptState[] {
    return this.views().prompts;
  }
  get events(): readonly SessionEventState[] {
    return this.views().events;
  }

  private views(): NonNullable<SessionModel["sorted"]> {
    this.sorted ??= {
      tools: [...this.tools.values()].sort((a, b) => a.at - b.at),
      apis: [...this.apis.values()].sort((a, b) => a.at - b.at),
      agents: [...this.agents.values()].sort((a, b) => a.startedAt - b.startedAt),
      prompts: [...this.promptMap.values()].sort((a, b) => a.at - b.at),
      events: [...this.eventMap.values()].sort((a, b) => a.at - b.at),
    };
    return this.sorted;
  }

  /** Takes everything the store holds of the session (content is not copied). */
  load(t: SessionTimeline): void {
    if (t.session) this.session(t.session);
    for (const row of t.prompts) this.prompt(row);
    for (const row of t.toolCalls) {
      const { content: _content, ...meta } = row;
      this.toolCall(meta);
    }
    for (const row of t.subagents) this.subagent(row);
    for (const row of t.apiRequests) this.apiRequest(row);
    for (const row of t.sessionEvents) this.sessionEvent(row);
  }

  /** Takes one write; returns whether it was one the rules read. */
  apply(op: WriteOp): boolean {
    switch (op.kind) {
      case "session":
        this.session(op.row);
        return true;
      case "prompt":
        this.prompt(op.row);
        return true;
      case "toolCall":
        this.toolCall(op.row);
        return true;
      case "subagent":
        this.subagent(op.row);
        return true;
      case "apiRequest":
        this.apiRequest(op.row);
        return true;
      case "sessionEvent":
        this.sessionEvent(op.row);
        return true;
      default:
        return false;
    }
  }

  /** The session's end told by an event without its row (a SessionEnd read from the spool's tail). */
  endAt(at: number): void {
    this.endedAt = maxOf(this.endedAt, at);
  }

  private touch(at: number): void {
    this.sorted = undefined;
    if (at > this.lastActivityAt) this.lastActivityAt = at;
  }

  private session(row: SessionWrite): void {
    this.projectKey ??= row.projectKey ?? null;
    this.internalLabel = fill(this.internalLabel, row.internalLabel);
    this.endedAt = maxOf(this.endedAt, row.endedAt);
    this.sorted = undefined;
  }

  private prompt(row: Pick<PromptWrite, "promptId" | "at">): void {
    const p = this.promptMap.get(row.promptId);
    this.promptMap.set(row.promptId, { promptId: row.promptId, at: minOf(row.at, p?.at) });
    this.touch(row.at);
  }

  private toolCall(row: Omit<ToolCallWrite, "content">): void {
    const c = this.tools.get(row.toolUseId);
    const end = row.at + (row.durationMs ?? 0);
    const next: ToolCallState = {
      toolUseId: row.toolUseId,
      promptId: fill(c?.promptId ?? null, row.promptId),
      agentId: fill(c?.agentId ?? null, row.agentId),
      at: minOf(row.at, c?.at),
      lastAt: Math.max(end, c?.lastAt ?? end),
      toolName: fill(c?.toolName ?? null, row.toolName),
      station: c?.station ?? null,
      stationFlags: c?.stationFlags ?? null,
      mcpServer: fill(c?.mcpServer ?? null, row.mcpServer),
      target: fill(c?.target ?? null, row.target),
      targetKey: fill(c?.targetKey ?? null, row.targetKey),
      readOffset: fill(c?.readOffset ?? null, row.readOffset),
      readLimit: fill(c?.readLimit ?? null, row.readLimit),
      durationMs: fill(c?.durationMs ?? null, row.durationMs),
      success: fill(c?.success ?? null, row.success),
      error: fill(c?.error ?? null, row.error),
    };
    // The store's `exactStation` merge: an exact station always wins, an estimated one only fills.
    if (row.station != null) {
      const estimated = ((row.stationFlags ?? 0) & StationFlag.estimated) !== 0;
      if (!estimated || next.station === null) {
        next.station = row.station;
        next.stationFlags = row.stationFlags ?? null;
      }
    }
    this.tools.set(row.toolUseId, next);
    this.touch(next.lastAt);
  }

  private subagent(row: SubagentWrite): void {
    const s = this.agents.get(row.agentId);
    this.agents.set(row.agentId, {
      agentId: row.agentId,
      promptId: fill(s?.promptId ?? null, row.promptId),
      startedAt: minOf(row.startedAt, s?.startedAt),
      endedAt: maxOf(s?.endedAt ?? null, row.endedAt),
    });
    this.touch(row.endedAt ?? row.startedAt);
  }

  private apiRequest(row: ApiRequestWrite): void {
    const a = this.apis.get(row.dedupeKey);
    this.apis.set(row.dedupeKey, {
      dedupeKey: row.dedupeKey,
      at: minOf(row.at, a?.at),
      promptId: fill(a?.promptId ?? null, row.promptId),
      agentId: fill(a?.agentId ?? null, row.agentId),
      model: fill(a?.model ?? null, row.model),
      querySource: fill(a?.querySource ?? null, row.querySource),
      inputTokens: fill(a?.inputTokens ?? null, row.inputTokens),
      outputTokens: fill(a?.outputTokens ?? null, row.outputTokens),
      cacheReadTokens: fill(a?.cacheReadTokens ?? null, row.cacheReadTokens),
      cacheWrite5mTokens: fill(a?.cacheWrite5mTokens ?? null, row.cacheWrite5mTokens),
      cacheWrite1hTokens: fill(a?.cacheWrite1hTokens ?? null, row.cacheWrite1hTokens),
      costUsd: fill(a?.costUsd ?? null, row.costUsd),
      durationMs: fill(a?.durationMs ?? null, row.durationMs),
    });
    this.touch(row.at);
  }

  private sessionEvent(row: SessionEventWrite): void {
    const e = this.eventMap.get(row.dedupeKey);
    // The store keeps an event's first values and its earliest time.
    this.eventMap.set(row.dedupeKey, {
      dedupeKey: row.dedupeKey,
      at: minOf(row.at, e?.at),
      kind: e?.kind ?? row.kind,
      agentId: e ? e.agentId : (row.agentId ?? null),
      toolUseId: e ? e.toolUseId : (row.toolUseId ?? null),
      label: e ? e.label : (row.label ?? null),
      number: e ? e.number : (row.number ?? null),
      flag: e ? e.flag : (row.flag ?? null),
    });
    this.touch(row.at);
  }
}
