// Stored Observatory rows as devices get them (proto/remote/v1/remote.proto,
// "Observatory"; docs/observatory-wire.md): each field picked by name, so a
// column added to a table never reaches a device by itself. The timeline
// rows come without content already (store/timeline-reads.ts); nothing here
// reads a prompt's excerpt or a tool call's content either.
//
// The `earlier` cursor of a page is the place of its oldest event:
// `<at>.<kind number>.<key>`, opaque to devices and checked when it comes back.
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import {
  type ObservatoryEvent,
  ObservatoryEventSchema,
  type ObservatorySessionInfo,
  ObservatorySessionInfoSchema,
  ObservatorySessionSource,
  type ObservatorySessionState,
  ObservatorySessionStateSchema,
  ObservatorySessionTotalsSchema,
} from "@achoo254/chat-proto/remote/remote";
import type { SessionRow, SessionSource } from "../store/observatory-rows.ts";
import { type SessionTotals, TIMELINE_KINDS, type TimelineEntry, type TimelinePlace } from "../store/timeline-reads.ts";

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

export function sessionState(row: SessionRow | undefined, totals: SessionTotals): ObservatorySessionState {
  return create(ObservatorySessionStateSchema, {
    ...(row ? { info: sessionInfo(row) } : {}),
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
  }
}

/** The event of one timeline row; `seq` 0 outside ObservatoryEvents. */
export function timelineEvent(entry: TimelineEntry, seq = 0n): ObservatoryEvent {
  return create(ObservatoryEventSchema, { seq, at: BigInt(entry.at), id: eventId(entry), kind: eventKind(entry) });
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
