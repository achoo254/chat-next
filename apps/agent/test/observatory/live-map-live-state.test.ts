// The Live Map's view of a session as a whole, from its events only: the
// core's state through a turn (thinking, a permission asked and decided, a
// compaction, the turn's end or failure, the session's end), the tool calls
// running by station (a denied one never runs, a turn's end stops them all),
// tokens per second and the context's fill of the main thread; and the
// context window of a model: unknown models get none, `[1m]` and a context
// past the standard window get the long one, the rest the standard one,
// marked assumed.
import { describe, expect, it } from "vitest";
import { type LiveInput, liveStateOf } from "../../src/observatory/hub/live-state.ts";
import { LONG_WINDOW, STANDARD_WINDOW, contextWindowOf } from "../../src/observatory/live-map/model-window.ts";
import type { TimelineEntry } from "../../src/observatory/store/timeline-reads.ts";
import { timelineEntryOfWrite } from "../../src/observatory/store/timeline-reads.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import type { SessionEventKind } from "../../src/observatory/store/observatory-rows.ts";

const T = 1_790_000_000_000;
const S = "s";

function entry(op: WriteOp): TimelineEntry {
  const e = timelineEntryOfWrite(op);
  if (!e) throw new Error(`no entry for ${op.kind}`);
  return e;
}

const prompt = (at: number): TimelineEntry => entry({ kind: "prompt", row: { promptId: `p${at}`, sessionId: S, at } });
const tool = (id: string, at: number, station: string, success?: boolean): TimelineEntry =>
  entry({ kind: "toolCall", row: { toolUseId: id, sessionId: S, at, toolName: "Bash", station, stationFlags: 0, ...(success === undefined ? {} : { success }) } });
const event = (kind: SessionEventKind, at: number, extra: { label?: string; toolUseId?: string } = {}): TimelineEntry =>
  entry({ kind: "sessionEvent", row: { dedupeKey: `${kind}:${at}`, sessionId: S, at, kind, ...extra } });
const api = (at: number, row: Partial<{ model: string; agentId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; durationMs: number; ttftMs: number }>): TimelineEntry =>
  entry({ kind: "apiRequest", row: { dedupeKey: `r${at}`, sessionId: S, at, ...row } });

function live(entries: TimelineEntry[], extra: Partial<LiveInput> = {}) {
  return liveStateOf({ entries, endedAt: null, mainModel: null, openBottlenecks: 0, largestContext: 0, ...extra });
}

describe("the core's state", () => {
  it("is idle with no event, thinking in a turn, waiting for permission until decided, waiting for the user after the turn", () => {
    expect(live([]).core).toBe("idle");
    expect(live([prompt(T)]).core).toBe("thinking");
    expect(live([prompt(T), event("permission_request", T + 1)]).core).toBe("waiting_permission");
    expect(live([prompt(T), event("permission_request", T + 1), event("permission_decision", T + 2)]).core).toBe("thinking");
    expect(live([prompt(T), tool("t1", T + 1, "FILES", true), event("stop", T + 2)]).core).toBe("waiting_user");
    expect(live([prompt(T), event("stop_failure", T + 2)]).core).toBe("failed");
    // A notification is a signal too.
    expect(live([prompt(T), event("notification", T + 1, { label: "permission_prompt" })]).core).toBe("waiting_permission");
    expect(live([prompt(T), event("notification", T + 1, { label: "idle_prompt" })]).core).toBe("waiting_user");
  });

  it("compacts and comes back to where it was; the session's end makes it idle", () => {
    expect(live([prompt(T), event("compact_start", T + 1)]).core).toBe("compacting");
    expect(live([prompt(T), event("compact_start", T + 1), event("compact_end", T + 2)]).core).toBe("thinking");
    expect(live([prompt(T), event("stop", T + 1), event("compact_start", T + 2), event("compact_end", T + 3)]).core).toBe("waiting_user");
    expect(live([prompt(T), tool("t1", T + 1, "FILES")], { endedAt: T + 5 })).toMatchObject({ core: "idle", running: [] });
  });

  it("waits for the user once a tool call ends interrupted (Esc or Ctrl+C sends no Stop), not after a call that failed on its own", () => {
    const ended = (id: string, at: number, error: string): TimelineEntry =>
      entry({ kind: "toolCall", row: { toolUseId: id, sessionId: S, at, toolName: "Bash", station: "TESTING", stationFlags: 0, success: false, durationMs: 50, error } });
    expect(live([prompt(T), tool("t1", T + 1, "FILES"), ended("t2", T + 2, "interrupted")])).toMatchObject({ core: "waiting_user", running: [] });
    expect(live([prompt(T), tool("t1", T + 1, "FILES"), ended("t2", T + 2, "failed")])).toMatchObject({ core: "thinking", running: [{ station: "FILES", count: 1 }] });
    // The next prompt starts a turn again.
    expect(live([prompt(T), ended("t2", T + 2, "interrupted"), prompt(T + 9)]).core).toBe("thinking");
  });
});

describe("the running tool calls", () => {
  it("count the calls not ended since the turn began, by station, without the denied ones", () => {
    const entries = [prompt(T), tool("t1", T + 1, "FILES"), tool("t2", T + 2, "FILES"), tool("t3", T + 3, "TESTING"), tool("t4", T + 4, "GIT", true), tool("t5", T + 5, "MCP"), event("permission_denied", T + 6, { toolUseId: "t5" })];
    expect(live(entries).running).toEqual([
      { station: "FILES", count: 2 },
      { station: "TESTING", count: 1 },
    ]);
    expect(live([...entries, event("stop", T + 9)]).running).toEqual([]);
  });
});

describe("tokens and context", () => {
  it("take the main thread's newest API request: tokens per second after the first token, context against the model's window", () => {
    const entries = [
      prompt(T),
      api(T + 1, { model: "claude-sonnet-5-5", inputTokens: 10, cacheReadTokens: 49_990, outputTokens: 100, durationMs: 3_000, ttftMs: 1_000 }),
      // A subagent's request changes neither.
      api(T + 2, { model: "claude-haiku-4-5", agentId: "a1", inputTokens: 999_999, outputTokens: 5, durationMs: 10 }),
    ];
    const s = live(entries);
    expect(s.tokensPerSecond).toBe(50);
    expect(s.contextTokens).toBe(50_000);
    expect(s.contextWindow).toBe(STANDARD_WINDOW);
    expect(s.contextWindowAssumed).toBe(true);
    expect(s.contextPercent).toBe(25);
    expect(s.mainModel).toBe("claude-sonnet-5-5");
  });

  it("has no percent for a model it does not know, and the long window once the context passed the standard one", () => {
    expect(live([api(T, { model: "gpt-9", inputTokens: 100 })]).contextPercent).toBeNull();
    const long = live([api(T, { model: "claude-sonnet-5-5", inputTokens: 250_000 })]);
    expect([long.contextWindow, long.contextWindowAssumed, long.contextPercent]).toEqual([LONG_WINDOW, false, 25]);
    // The session's largest context, older than these events, counts as well.
    expect(live([api(T, { model: "claude-sonnet-5-5", inputTokens: 100_000 })], { largestContext: 300_000 }).contextPercent).toBe(10);
  });
});

describe("contextWindowOf", () => {
  it("knows Claude model ids by their family, and [1m]", () => {
    expect(contextWindowOf("claude-sonnet-5-5")).toEqual({ tokens: STANDARD_WINDOW, assumed: true });
    expect(contextWindowOf("claude-haiku-4-5-20251001")).toEqual({ tokens: STANDARD_WINDOW, assumed: true });
    expect(contextWindowOf("claude-opus-5-5[1m]")).toEqual({ tokens: LONG_WINDOW, assumed: false });
    expect(contextWindowOf("claude-sonnet-5-5", STANDARD_WINDOW + 1)).toEqual({ tokens: LONG_WINDOW, assumed: false });
    for (const unknown of ["", null, "sonnet", "gpt-5", "claude-opus-4-6-thinking", "claude-sonnet-x"]) expect(contextWindowOf(unknown)).toBeUndefined();
  });
});
