// Facts several rules read the same way: event ids as devices know them, when
// a turn ended (a Stop, or a tool call interrupted by the person), whether a tool call or subagent still runs, a severity from
// two thresholds.
import { TOOL_ERROR } from "../../ingest/normalize-hook-record.ts";
import type { BottleneckSeverity } from "../../store/observatory-rows.ts";
import { type PromptState, type SessionModel, type SubagentState, type ToolCallState, toolEndAt, toolEnded } from "../session-model.ts";

/** Evidence ids kept per finding at most. */
export const MAX_EVIDENCE = 20;

// The ids devices get for timeline rows (hub/observatory-wire.ts eventId: the
// kind's prefix and the row's timeline key), so evidence found on a
// provisional event names the row stored later under the same id.
export const toolEventId = (toolUseId: string): string => `tool:${toolUseId}`;
export const apiEventId = (dedupeKey: string): string => `api:${dedupeKey}`;
export const sessionEventId = (dedupeKey: string): string => `event:${dedupeKey}`;
export const subagentEventId = (agentId: string): string => `subagent:${agentId}`;

/** `alert` past `alert`, `warn` past `warn`, else nothing (both compared with `>`). */
export function severityOf(value: number, warn: number, alert: number): BottleneckSeverity | undefined {
  if (value > alert) return "alert";
  return value > warn ? "warn" : undefined;
}

export function maxSeverity(a: BottleneckSeverity | undefined, b: BottleneckSeverity | undefined): BottleneckSeverity | undefined {
  return a === "alert" || b === "alert" ? "alert" : (a ?? b);
}

/** The newest `n` of `ids`, newest first. */
export function newest(ids: readonly string[], n = MAX_EVIDENCE): string[] {
  return ids.slice(-n).reverse();
}

const TURN_END_KINDS = new Set(["stop", "stop_failure"]);
/** Events that end a tool call that never told its end (blocked by a hook, denied). */
const CALL_END_KINDS = new Set(["hook_block", "permission_denied", "permission_decision"]);

/**
 * The times the session's turns ended: each Stop or StopFailure, and the end
 * of each tool call that ended interrupted (the person stopped the turn with
 * Esc or Ctrl+C, and Claude Code tells no Stop then).
 */
function turnEnds(session: SessionModel): number[] {
  const ends: number[] = [];
  for (const e of session.events) if (TURN_END_KINDS.has(e.kind)) ends.push(e.at);
  for (const c of session.toolCalls) {
    if (c.error !== TOOL_ERROR.interrupted) continue;
    const end = toolEndAt(c);
    if (end !== undefined) ends.push(end);
  }
  return ends;
}

/** The time of the session's latest turn end (turnEnds); -Infinity when none. */
export function lastTurnEndAt(session: SessionModel): number {
  let at = Number.NEGATIVE_INFINITY;
  for (const end of turnEnds(session)) if (end > at) at = end;
  return at;
}

/** When the turn of `prompt` ended: its first turn end (turnEnds) after it, the next prompt, or the session's end; undefined while it runs. */
export function turnEndAt(session: SessionModel, prompt: PromptState): number | undefined {
  const ends: number[] = [];
  const stops = turnEnds(session).filter((at) => at >= prompt.at);
  if (stops.length > 0) ends.push(Math.min(...stops));
  const next = session.prompts.find((p) => p.at > prompt.at);
  if (next) ends.push(next.at);
  if (session.endedAt !== null && session.endedAt >= prompt.at) ends.push(session.endedAt);
  return ends.length > 0 ? Math.min(...ends) : undefined;
}

/**
 * Tool calls still running: no end told, no event ending them (a hook's block,
 * a denial), and no turn end after their start (a turn's Stop ends what ran in
 * it, so a call whose end was lost is not hung forever).
 */
export function runningToolCalls(session: SessionModel): ToolCallState[] {
  if (session.ended) return [];
  const endedByEvent = new Set(session.events.flatMap((e) => (CALL_END_KINDS.has(e.kind) && e.toolUseId ? [e.toolUseId] : [])));
  const turnEnd = lastTurnEndAt(session);
  return session.toolCalls.filter((c) => !toolEnded(c) && !endedByEvent.has(c.toolUseId) && c.at > turnEnd);
}

/** Subagents still running: no end told and no turn end after their start. */
export function runningSubagents(session: SessionModel): SubagentState[] {
  if (session.ended) return [];
  const turnEnd = lastTurnEndAt(session);
  return session.subagents.filter((s) => s.endedAt === null && s.startedAt > turnEnd);
}

/** The latest prompt's turn is still running. */
export function turnRunning(session: SessionModel): boolean {
  const last = session.prompts.at(-1);
  return !session.ended && last !== undefined && turnEndAt(session, last) === undefined;
}
