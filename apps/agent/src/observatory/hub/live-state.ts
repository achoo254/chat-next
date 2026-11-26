// The Live Map's view of a session as a whole (ObservatoryLiveState), worked
// out from its events in timeline order and nothing else, so a device
// replaying the events up to a time gets what a device watching live got at
// that time (docs/observatory-wire.md, "Trạng thái lõi"). The hub runs it over
// the session's newest events, provisional ones included, after the older
// rows that still change the result (store/live-map-reads.ts readLiveCarry),
// so it gives what the whole session gives; the open findings
// and the largest context come from the store (they may be older than those
// events), and a device replaying keeps them from the events it has.
//
// The core's state follows the last event that says something about it:
// - a prompt, a tool call, a subagent, a main-thread API request, a
//   permission decided or denied, a hook blocking a call: thinking (the
//   records cannot tell thinking from writing);
// - a permission asked (or a `permission_prompt` notification): waiting for
//   permission;
// - a compaction started: compacting; ended: back to thinking inside a turn,
//   else waiting for the user;
// - the turn stopped (or an `idle_prompt` notification): waiting for the
//   user; stopped with a failure: failed;
// - a tool call that ended interrupted: waiting for the user (the person
//   stopped the turn with Esc or Ctrl+C, and Claude Code tells no Stop then);
// - waiting for the user while a subagent started and not stopped yet runs
//   (Claude Code stops the main turn and waits for the background agent):
//   thinking, as the work goes on;
// - waiting for the user while a shell started with `run_in_background` may
//   still run: thinking, until a new turn begins (Claude Code opens one with the
//   shell's completion notice) or a KillShell call; Claude Code sends no event
//   for a shell's end, so this is a best effort;
// - no event, or the session ended after its last event: idle.
import { TOOL_ERROR } from "../ingest/normalize-hook-record.ts";
import { type Station, StationFlag } from "../live-map/station-map.ts";
import { contextTokensOf, contextWindowOf } from "../live-map/model-window.ts";
import type { TimelineEntry } from "../store/timeline-reads.ts";

export type CoreState = "idle" | "thinking" | "waiting_permission" | "waiting_user" | "compacting" | "failed";

export type LiveState = {
  core: CoreState;
  tokensPerSecond: number | null;
  contextPercent: number | null;
  contextTokens: number;
  contextWindow: number;
  contextWindowAssumed: boolean;
  mainModel: string;
  /** Tool calls running now, by station, the stations in name order. */
  running: { station: Station | string; count: number }[];
  openBottlenecks: number;
  /** Subagents started and not stopped, by id; none once the session ended. */
  subagents: { agentId: string; agentType: string }[];
};

export type LiveInput = {
  /** The session's newest events, oldest first (timeline order). */
  entries: readonly TimelineEntry[];
  /** When the session ended; null while it runs. */
  endedAt: number | null;
  /** The session's own main model, when its row has one. */
  mainModel: string | null;
  openBottlenecks: number;
  /** The largest main-thread context of the session so far (model-window.ts). */
  largestContext: number;
};

/** Tool calls that never ran: denied, or blocked by a hook. */
const NOT_RUN = new Set(["permission_denied", "hook_block"]);

const isMainThread = (agentId: string | null): boolean => agentId === null || agentId === "";

export function liveStateOf(input: LiveInput): LiveState {
  let core: CoreState = "idle";
  let inTurn = false;
  let beforeCompact: CoreState = "idle";
  /** Tool calls started since the last turn ended, by id: their station while they run. */
  let running = new Map<string, string>();
  const notRun = new Set<string>();
  let lastApi: Extract<TimelineEntry, { kind: "apiRequest" }>["row"] | undefined;
  let lastTimed: Extract<TimelineEntry, { kind: "apiRequest" }>["row"] | undefined;
  let largest = input.largestContext;
  let lastAt = 0;
  /** Subagents that started and have not stopped: id → type ("" when not told). */
  const runningSubagents = new Map<string, string>();
  /** Shell calls started in the background and not known to have ended. */
  const backgroundShells = new Set<string>();

  const active = (): void => {
    core = "thinking";
    inTurn = true;
  };
  const endTurn = (state: CoreState): void => {
    core = state;
    inTurn = false;
    running = new Map();
  };

  for (const e of input.entries) {
    lastAt = Math.max(lastAt, e.at);
    switch (e.kind) {
      case "prompt":
        active();
        backgroundShells.clear();
        break;
      case "subagent":
        active();
        if (e.row.endedAt === null || e.row.endedAt === 0) runningSubagents.set(e.row.agentId, e.row.agentType ?? "");
        else runningSubagents.delete(e.row.agentId);
        break;
      case "toolCall":
        active();
        if (e.row.success === null && !notRun.has(e.row.toolUseId)) running.set(e.row.toolUseId, e.row.station ?? "CORE");
        else running.delete(e.row.toolUseId);
        if (e.row.error === TOOL_ERROR.interrupted) endTurn("waiting_user");
        if (e.row.toolName === "KillShell") backgroundShells.clear();
        else if (((e.row.stationFlags ?? 0) & StationFlag.background) !== 0 && e.row.success !== false && !notRun.has(e.row.toolUseId)) backgroundShells.add(e.row.toolUseId);
        break;
      case "apiRequest":
        if (!isMainThread(e.row.agentId)) break;
        active();
        lastApi = e.row;
        largest = Math.max(largest, contextTokensOf(e.row));
        if ((e.row.outputTokens ?? 0) > 0 && (e.row.durationMs ?? 0) > 0) lastTimed = e.row;
        break;
      case "sessionEvent": {
        const r = e.row;
        if (NOT_RUN.has(r.kind) && r.toolUseId) {
          notRun.add(r.toolUseId);
          running.delete(r.toolUseId);
        }
        switch (r.kind) {
          case "permission_request":
            core = "waiting_permission";
            inTurn = true;
            break;
          case "permission_decision":
          case "permission_denied":
          case "hook_block":
            active();
            break;
          case "compact_start":
            if (core !== "compacting") beforeCompact = core;
            core = "compacting";
            break;
          case "compact_end":
            core = inTurn ? "thinking" : beforeCompact === "idle" ? "idle" : "waiting_user";
            break;
          case "stop":
            endTurn("waiting_user");
            break;
          case "stop_failure":
            endTurn("failed");
            break;
          case "notification":
            if (r.label === "permission_prompt") core = "waiting_permission";
            else if (r.label === "idle_prompt") endTurn("waiting_user");
            break;
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }
  if (core === "waiting_user" && (runningSubagents.size > 0 || backgroundShells.size > 0)) core = "thinking";
  const ended = input.endedAt !== null && input.endedAt >= lastAt;
  if (ended) endTurn("idle");

  const mainModel = lastApi?.model ?? input.mainModel ?? "";
  const window = contextWindowOf(mainModel, largest);
  const contextTokens = lastApi ? contextTokensOf(lastApi) : 0;
  const byStation = new Map<string, number>();
  for (const station of running.values()) byStation.set(station, (byStation.get(station) ?? 0) + 1);
  return {
    core,
    tokensPerSecond: lastTimed ? tokensPerSecond(lastTimed) : null,
    contextPercent: window && lastApi ? (contextTokens / window.tokens) * 100 : null,
    contextTokens,
    contextWindow: window?.tokens ?? 0,
    contextWindowAssumed: window?.assumed ?? false,
    mainModel,
    running: [...byStation].sort(([a], [b]) => (a < b ? -1 : 1)).map(([station, count]) => ({ station, count })),
    openBottlenecks: input.openBottlenecks,
    subagents: ended ? [] : [...runningSubagents].sort(([a], [b]) => (a < b ? -1 : 1)).map(([agentId, agentType]) => ({ agentId, agentType })),
  };
}

/** The shortest stretch a speed is read from: a request streaming for a few milliseconds says nothing about how fast the model writes. */
const MIN_STREAM_MS = 200;

/**
 * Output tokens per second of one request: over its time after the first token
 * when that is long enough to read, else over its whole duration, else none.
 */
function tokensPerSecond(r: { outputTokens: number | null; durationMs: number | null; ttftMs: number | null }): number | null {
  const output = r.outputTokens ?? 0;
  const total = r.durationMs ?? 0;
  const writing = total - (r.ttftMs ?? 0);
  const ms = writing >= MIN_STREAM_MS ? writing : total;
  return output > 0 && ms >= MIN_STREAM_MS ? (output * 1000) / ms : null;
}
