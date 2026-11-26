// Stored Observatory rows as devices get them (proto/remote/v1/remote.proto,
// "Observatory"; docs/observatory-wire.md): each field picked by name, so a
// column added to a table never reaches a device by itself. The timeline
// rows come without content already (store/timeline-reads.ts); nothing here
// reads a prompt's excerpt or a tool call's content either.
//
// The `earlier` cursor of a page is the place of its oldest event:
// `<at>.<kind number>.<key>`, opaque to devices and checked when it comes back.
//
// A bottleneck finding's evidence goes out as the event ids its JSON lists
// under `eventIds` (at most MAX_EVIDENCE, each one shaped as an event id):
// the measures beside them stay in the store.
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import {
  type ObservatoryBottleneck,
  ObservatoryBottleneckSchema,
  ObservatoryCoreState,
  type ObservatoryEvent,
  ObservatoryEventSchema,
  ObservatoryLiveStateSchema,
  type ObservatorySessionInfo,
  ObservatorySessionInfoSchema,
  ObservatorySessionSource,
  type ObservatorySessionState,
  ObservatorySessionStateSchema,
  ObservatorySessionTotalsSchema,
  type ObservatoryStationNumbers,
  ObservatoryStationNumbersSchema,
  type ObservatoryStationResult,
  ObservatoryStationResultSchema,
} from "@achoo254/chat-proto/remote/remote";
import type { BottleneckRow, SessionRow, SessionSource } from "../store/observatory-rows.ts";
import type { StationDrill, StationNumbers } from "../store/live-map-reads.ts";
import { type SessionTotals, TIMELINE_KINDS, type TimelineEntry, type TimelineKind, type TimelinePlace } from "../store/timeline-reads.ts";
import type { CoreState, LiveState } from "./live-state.ts";

/** The id of the `session` event (the session's row and totals). */
export const SESSION_EVENT_ID = "session";

/** The longest cursor taken back (a key is an id or a file path, both bounded well below). */
const MAX_CURSOR_LENGTH = 2_048;

const SOURCES: Record<SessionSource, ObservatorySessionSource> = {
  sdk: ObservatorySessionSource.SDK,
  terminal: ObservatorySessionSource.TERMINAL,
  cli: ObservatorySessionSource.CLI,
};

/** The prefix of each kind's event ids. */
const ID_PREFIX: Record<TimelineEntry["kind"], string> = {
  prompt: "prompt",
  toolCall: "tool",
  subagent: "subagent",
  apiRequest: "api",
  instructionLoaded: "instruction",
  gitOp: "git",
  sessionEvent: "event",
  bottleneck: "bottleneck",
};

const KIND_OF_PREFIX = new Map(Object.entries(ID_PREFIX).map(([kind, prefix]) => [prefix, kind as TimelineKind]));

/** Evidence ids a finding carries on the wire at most. */
const MAX_EVIDENCE = 20;
/** The longest evidence id taken (a key is an id or a file path, both bounded well below). */
const MAX_EVIDENCE_ID = 320;

/** True when `s` has a control character. */
export function hasControl(s: string): boolean {
  return [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

/** An event id as evidence: the id of a timeline row, short, without control characters. */
function isEvidenceId(id: string): boolean {
  return id.length <= MAX_EVIDENCE_ID && !hasControl(id) && parseEventId(id) !== undefined;
}

const CORE_STATES: Record<CoreState, ObservatoryCoreState> = {
  idle: ObservatoryCoreState.IDLE,
  thinking: ObservatoryCoreState.THINKING,
  waiting_permission: ObservatoryCoreState.WAITING_PERMISSION,
  waiting_user: ObservatoryCoreState.WAITING_USER,
  compacting: ObservatoryCoreState.COMPACTING,
  failed: ObservatoryCoreState.FAILED,
};

const MAX_U32 = 0xffff_ffff;

/** A count as uint32: whole, 0 or more, capped. */
function u32(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_U32, Math.max(0, Math.trunc(n))) : 0;
}

/** A count as uint64: whole, 0 or more. */
function u64(n: number): bigint {
  return Number.isFinite(n) ? BigInt(Math.max(0, Math.trunc(n))) : 0n;
}

/**
 * `{ [key]: value }`, or no key at all when the column holds NULL: the
 * optional field stays unset (the proto types leave no room for `undefined`).
 */
function opt<K extends string, T>(key: K, value: T | null): Partial<Record<K, T>> {
  // A computed key widens to `string`; the object has exactly `key`.
  return value === null ? {} : ({ [key]: value } as Record<K, T>);
}

const optU32 = <K extends string>(key: K, n: number | null) => opt(key, n === null ? null : u32(n));
const optU64 = <K extends string>(key: K, n: number | null) => opt(key, n === null ? null : u64(n));
const optNum = <K extends string>(key: K, n: number | null) => opt(key, n !== null && Number.isFinite(n) ? n : null);
const text = (s: string | null): string => s ?? "";

export function sessionInfo(row: SessionRow): ObservatorySessionInfo {
  return create(ObservatorySessionInfoSchema, {
    sessionId: row.sessionId,
    previousSessionId: text(row.previousSessionId),
    previousSessionInferred: row.previousSessionInferred === true,
    projectKey: text(row.projectKey),
    cwd: text(row.cwd),
    source: SOURCES[row.source] ?? ObservatorySessionSource.UNSPECIFIED,
    internalLabel: text(row.internalLabel),
    startedAt: BigInt(row.startedAt),
    endedAt: BigInt(row.endedAt ?? 0),
    mainModel: text(row.mainModel),
  });
}

export function sessionState(row: SessionRow | undefined, totals: SessionTotals, live?: LiveState): ObservatorySessionState {
  return create(ObservatorySessionStateSchema, {
    ...(row ? { info: sessionInfo(row) } : {}),
    ...(live
      ? {
          live: create(ObservatoryLiveStateSchema, {
            core: CORE_STATES[live.core],
            ...optNum("tokensPerSecond", live.tokensPerSecond),
            ...optNum("contextPercent", live.contextPercent),
            contextTokens: u64(live.contextTokens),
            contextWindow: u64(live.contextWindow),
            contextWindowAssumed: live.contextWindowAssumed,
            mainModel: live.mainModel,
            running: live.running.map((r) => ({ station: r.station, count: u32(r.count) })),
            openBottlenecks: u32(live.openBottlenecks),
            subagents: live.subagents,
          }),
        }
      : {}),
    totals: create(ObservatorySessionTotalsSchema, {
      prompts: u32(totals.prompts),
      toolCalls: u32(totals.toolCalls),
      toolFailures: u32(totals.toolFailures),
      subagents: u32(totals.subagents),
      apiRequests: u32(totals.apiRequests),
      inputTokens: u64(totals.inputTokens),
      outputTokens: u64(totals.outputTokens),
      cacheReadTokens: u64(totals.cacheReadTokens),
      cacheWriteTokens: u64(totals.cacheWriteTokens),
      costUsdEstimate: totals.costUsd ?? 0,
      hasCost: totals.costUsd !== null,
      gitOps: u32(totals.gitOps),
      sessionEvents: u32(totals.sessionEvents),
      lastEventAt: BigInt(totals.lastEventAt ?? 0),
    }),
  });
}

/** The event id of a timeline row: its kind's prefix and its key. */
export function eventId(entry: Pick<TimelineEntry, "kind" | "key">): string {
  return `${ID_PREFIX[entry.kind]}:${entry.key}`;
}

/** The kind and key an event id names; undefined for one this agent does not make. */
export function parseEventId(id: string): { kind: TimelineKind; key: string } | undefined {
  const colon = id.indexOf(":");
  const kind = colon > 0 ? KIND_OF_PREFIX.get(id.slice(0, colon)) : undefined;
  const key = id.slice(colon + 1);
  return kind === undefined || key === "" ? undefined : { kind, key };
}

/** The event ids a finding's evidence JSON lists under `eventIds`; [] when it lists none or is not JSON. */
function evidenceIds(json: string | null): string[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const ids = typeof parsed === "object" && parsed !== null && "eventIds" in parsed ? parsed.eventIds : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && isEvidenceId(id)).slice(0, MAX_EVIDENCE) : [];
}

export function bottleneck(r: BottleneckRow): ObservatoryBottleneck {
  return create(ObservatoryBottleneckSchema, {
    rule: r.rule,
    subkey: r.subkey,
    station: text(r.station),
    severity: r.severity,
    status: r.status,
    openedAt: BigInt(r.openedAt),
    updatedAt: BigInt(r.updatedAt),
    closedAt: BigInt(r.closedAt ?? 0),
    ...optNum("value", r.value),
    ...optNum("threshold", r.threshold),
    ...optU32("n", r.n),
    evidenceIds: evidenceIds(r.evidenceJson),
  });
}

/** The `kind` of the event of one timeline row: every field by name, never content. */
function eventKind(entry: TimelineEntry): NonNullable<MessageInitShape<typeof ObservatoryEventSchema>["kind"]> {
  switch (entry.kind) {
    case "prompt": {
      const r = entry.row;
      return { case: "prompt", value: { promptId: r.promptId, ...optU32("length", r.length) } };
    }
    case "toolCall": {
      const r = entry.row;
      return {
        case: "toolCall",
        value: {
          toolUseId: r.toolUseId,
          promptId: text(r.promptId),
          agentId: text(r.agentId),
          toolName: text(r.toolName),
          mcpServer: text(r.mcpServer),
          target: text(r.target),
          ...optU32("durationMs", r.durationMs),
          ...optU64("inputBytes", r.inputBytes),
          ...optU64("outputBytes", r.outputBytes),
          ...opt("success", r.success),
          error: text(r.error),
          station: text(r.station),
          stationFlags: u32(r.stationFlags ?? 0),
          targetKey: text(r.targetKey),
          ...optU32("readOffset", r.readOffset),
          ...optU32("readLimit", r.readLimit),
        },
      };
    }
    case "subagent": {
      const r = entry.row;
      return {
        case: "subagent",
        value: {
          agentId: r.agentId,
          promptId: text(r.promptId),
          agentType: text(r.agentType),
          startedAt: BigInt(r.startedAt),
          endedAt: BigInt(r.endedAt ?? 0),
          model: text(r.model),
          ...optU64("totalTokens", r.totalTokens),
          ...optU32("toolCount", r.toolCount),
        },
      };
    }
    case "apiRequest": {
      const r = entry.row;
      return {
        case: "apiRequest",
        value: {
          promptId: text(r.promptId),
          agentId: text(r.agentId),
          model: text(r.model),
          ...optU64("inputTokens", r.inputTokens),
          ...optU64("outputTokens", r.outputTokens),
          ...optU64("cacheReadTokens", r.cacheReadTokens),
          ...optU64("cacheWrite5mTokens", r.cacheWrite5mTokens),
          ...optU64("cacheWrite1hTokens", r.cacheWrite1hTokens),
          ...optNum("costUsdEstimate", r.costUsd),
          ...optU32("durationMs", r.durationMs),
          ...optU32("ttftMs", r.ttftMs),
          querySource: text(r.querySource),
        },
      };
    }
    case "instructionLoaded": {
      const r = entry.row;
      return {
        case: "instructionLoaded",
        value: { filePath: r.filePath, memoryType: text(r.memoryType), loadReason: r.loadReason, loadSeq: u32(r.seq) },
      };
    }
    case "gitOp": {
      const r = entry.row;
      return { case: "gitOp", value: { promptId: text(r.promptId), sha: text(r.sha), branch: text(r.branch), kind: r.kind } };
    }
    case "sessionEvent": {
      const r = entry.row;
      return {
        case: "sessionEvent",
        value: {
          kind: r.kind,
          agentId: text(r.agentId),
          toolUseId: text(r.toolUseId),
          station: text(r.station),
          label: text(r.label),
          ...optNum("number", r.number),
          ...opt("flag", r.flag),
        },
      };
    }
    case "bottleneck":
      return { case: "bottleneck", value: bottleneck(entry.row) };
  }
}

/** The event of one timeline row; `seq` 0 outside ObservatoryEvents; `provisional` for one read from the spool's tail. */
export function timelineEvent(entry: TimelineEntry, seq = 0n, provisional = false): ObservatoryEvent {
  return create(ObservatoryEventSchema, { seq, at: BigInt(entry.at), id: eventId(entry), kind: eventKind(entry), provisional });
}

function stationNumbers(n: StationNumbers): ObservatoryStationNumbers {
  return create(ObservatoryStationNumbersSchema, {
    calls: u32(n.calls),
    failures: u32(n.failures),
    ended: u32(n.ended),
    ...optU32("p50Ms", n.p50Ms),
    ...optU32("p95Ms", n.p95Ms),
    sampled: n.sampled,
    apiRequests: u32(n.apiRequests),
    inputTokens: u64(n.inputTokens),
    outputTokens: u64(n.outputTokens),
    cacheReadTokens: u64(n.cacheReadTokens),
    cacheWriteTokens: u64(n.cacheWriteTokens),
    costUsdEstimate: n.hasCost ? n.costUsd : 0,
    hasCost: n.hasCost,
    requestsWithoutCost: u32(n.requestsWithoutCost),
  });
}

/** A station's numbers as a device gets them: events without content, findings by their row. */
export function stationResult(sessionId: string, station: string, at: number, d: StationDrill): ObservatoryStationResult {
  return create(ObservatoryStationResultSchema, {
    sessionId,
    station,
    at: BigInt(at),
    numbers: stationNumbers(d.numbers),
    parts: d.parts.map((p) => ({ kind: p.kind, key: p.key, numbers: stationNumbers(p.numbers) })),
    slowest: d.slowest.map((e) => timelineEvent(e)),
    recent: d.recent.map((e) => timelineEvent(e)),
    previous: d.previous.map((p) => ({ sessionId: p.sessionId, startedAt: BigInt(p.startedAt), numbers: stationNumbers(p.numbers) })),
    bottlenecks: d.bottlenecks.flatMap((e) => (e.kind === "bottleneck" ? [bottleneck(e.row)] : [])),
  });
}

/** The `session` event: the session's row and totals replaced. */
export function sessionEvent(state: ObservatorySessionState, seq: bigint, at: number): ObservatoryEvent {
  return create(ObservatoryEventSchema, { seq, at: BigInt(at), id: SESSION_EVENT_ID, kind: { case: "session", value: state } });
}

/** The cursor a device sends back for the events before `place`. */
export function encodeCursor(place: TimelinePlace): string {
  return `${place.at}.${TIMELINE_KINDS.indexOf(place.kind)}.${place.key}`;
}

/** The place a cursor names; undefined for one this agent did not make. */
export function decodeCursor(cursor: string): TimelinePlace | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH) return undefined;
  const m = /^(\d{1,15})\.(\d)\.(.+)$/s.exec(cursor);
  if (!m) return undefined;
  const [, at, kindIndex, key] = m;
  const kind = TIMELINE_KINDS[Number(kindIndex)];
  if (kind === undefined || at === undefined || key === undefined) return undefined;
  return { at: Number(at), kind, key };
}
