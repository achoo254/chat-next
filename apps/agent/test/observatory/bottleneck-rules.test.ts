// Each bottleneck rule on real-shaped writes (the ops the ingest makes from
// hooks and OpenTelemetry): under the line, warning, alert, too little history,
// the absolute floor, the close condition, and the rule's own pitfalls (pages
// of a file, two files of one name, Grep, a hook-blocked call, a waiting
// permission). Every rule is pure: one session model, a time, thresholds, a
// history stub.
import { describe, expect, it } from "vitest";
import { ThresholdTable } from "../../src/observatory/bottlenecks/bottleneck-thresholds.ts";
import type { HistoryView, Percentile, TurnCost } from "../../src/observatory/bottlenecks/history-percentiles.ts";
import { p95 } from "../../src/observatory/bottlenecks/history-percentiles.ts";
import { apiSlowOrLimited } from "../../src/observatory/bottlenecks/rules/api-slow-or-limited.ts";
import { contextHigh } from "../../src/observatory/bottlenecks/rules/context-high.ts";
import { costSpike } from "../../src/observatory/bottlenecks/rules/cost-spike.ts";
import { mcpErrors } from "../../src/observatory/bottlenecks/rules/mcp-errors.ts";
import { repeatRead } from "../../src/observatory/bottlenecks/rules/repeat-read.ts";
import { apiEventId, sessionEventId, subagentEventId, toolEventId } from "../../src/observatory/bottlenecks/rules/rule-support.ts";
import type { Prior, Rule, Verdict } from "../../src/observatory/bottlenecks/rules/rule-types.ts";
import { subagentIdle } from "../../src/observatory/bottlenecks/rules/subagent-idle.ts";
import { toolKeyOf } from "../../src/observatory/bottlenecks/rules/tool-key.ts";
import { toolSlow } from "../../src/observatory/bottlenecks/rules/tool-slow.ts";
import { SessionModel } from "../../src/observatory/bottlenecks/session-model.ts";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import { eventId } from "../../src/observatory/hub/observatory-wire.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";

const S = "sess-rules-0001";
const T = 1_790_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;

type HistoryStub = { tools?: Record<string, Percentile>; models?: Record<string, Percentile>; turns?: TurnCost[] };

function history(h: HistoryStub = {}): HistoryView {
  return {
    toolP95: (_tool, key) => h.tools?.[key],
    apiMsPerTokenP95: (model) => h.models?.[model],
    projectTurns: (_p, before, exclude) => (h.turns ?? []).filter((t) => t.at < before && t.promptId !== exclude),
  };
}

function model(ops: WriteOp[]): SessionModel {
  const m = new SessionModel(S);
  m.apply({ kind: "session", row: { sessionId: S, source: "cli", startedAt: T, projectKey: "github.com/acme/app" } });
  for (const op of ops) m.apply(op);
  return m;
}

type Run = { now: number; h?: HistoryStub; priors?: Record<string, Prior>; config?: ConstructorParameters<typeof ThresholdTable>[0]; window?: number };
function run(rule: Rule, m: SessionModel, r: Run): Verdict[] {
  return rule.evaluate({
    now: r.now,
    session: m,
    thresholds: new ThresholdTable(r.config, () => undefined),
    history: history(r.h),
    prior: (subkey) => r.priors?.[subkey],
    contextWindow: () => r.window,
  });
}

/** A tool call's Pre and Post as the hook normalizer writes them. */
function tool(id: string, name: string, at: number, durationMs: number | undefined, extra: Partial<Extract<WriteOp, { kind: "toolCall" }>["row"]> = {}): WriteOp[] {
  const pre: WriteOp = { kind: "toolCall", row: { toolUseId: id, sessionId: S, promptId: "p1", at, toolName: name, ...extra } };
  if (durationMs === undefined) return [pre];
  return [pre, { kind: "toolCall", row: { toolUseId: id, sessionId: S, promptId: "p1", at, toolName: name, durationMs, success: extra.success ?? true, ...extra } }];
}
const bash = (id: string, at: number, ms: number | undefined, program = "pnpm"): WriteOp[] => tool(id, "Bash", at, ms, { station: "TESTING", stationFlags: 0, target: program });
const ev = (kind: Extract<WriteOp, { kind: "sessionEvent" }>["row"]["kind"], at: number, extra: Partial<Extract<WriteOp, { kind: "sessionEvent" }>["row"]> = {}): WriteOp => ({
  kind: "sessionEvent",
  row: { dedupeKey: `${kind}:${at}:${extra.label ?? ""}`, sessionId: S, at, kind, ...extra },
});
const api = (key: string, at: number, row: Partial<Extract<WriteOp, { kind: "apiRequest" }>["row"]>): WriteOp => ({ kind: "apiRequest", row: { dedupeKey: key, sessionId: S, at, ...row } });

describe("evidence ids", () => {
  it("are the ids devices get for the same rows", () => {
    expect(toolEventId("toolu_01")).toBe(eventId({ kind: "toolCall", key: "toolu_01" }));
    expect(apiEventId("req:r1")).toBe(eventId({ kind: "apiRequest", key: "req:r1" }));
    expect(sessionEventId("stop:x")).toBe(eventId({ kind: "sessionEvent", key: "stop:x" }));
    expect(subagentEventId("agent-1")).toBe(eventId({ kind: "subagent", key: "agent-1" }));
  });

  it("p95 is the nearest rank", () => {
    expect(p95([])).toBeUndefined();
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([7])).toBe(7);
  });
});

describe("tool_slow", () => {
  const key = toolKeyOf({ toolName: "Bash", station: "TESTING", target: "pnpm", mcpServer: null });
  const h = { tools: { [key]: { p95: 10 * SEC, n: 40 } } };

  it("keys by tool, station and program; a file does not split the key", () => {
    expect(key).toBe("Bash|TESTING|pnpm");
    expect(toolKeyOf({ toolName: "Read", station: "FILES", target: "src/a.ts", mcpServer: null })).toBe("Read|FILES|");
    expect(toolKeyOf({ toolName: "mcp__gh__search", station: "MCP", target: null, mcpServer: "gh" })).toBe("mcp__gh__search|MCP|gh");
  });

  it("stays quiet under the line, warns past 1.5×, alerts past 3×", () => {
    const end = (ms: number): number => T + ms + 5 * SEC;
    expect(run(toolSlow, model(bash("t1", T, 14 * SEC)), { now: end(14 * SEC), h })).toEqual([]);
    const warn = run(toolSlow, model(bash("t1", T, 16 * SEC)), { now: end(16 * SEC), h });
    expect(warn).toMatchObject([{ subkey: key, station: "TESTING", severity: "warn", value: 16 * SEC, threshold: 15 * SEC, n: 40, evidence: ["tool:t1"] }]);
    expect(run(toolSlow, model(bash("t1", T, 31 * SEC)), { now: end(31 * SEC), h })[0]?.severity).toBe("alert");
  });

  it("is quiet with too little history for the key", () => {
    expect(run(toolSlow, model(bash("t1", T, 60 * SEC)), { now: T + 61 * SEC, h: { tools: { [key]: { p95: 10 * SEC, n: 19 } } } })).toEqual([]);
    expect(run(toolSlow, model(bash("t1", T, 60 * SEC, "cargo")), { now: T + 61 * SEC, h })).toEqual([]);
  });

  it("needs the call to be at least 5 s over the p95 (the absolute floor)", () => {
    const fast = { tools: { "Read|FILES|": { p95: 20, n: 500 } } };
    expect(run(toolSlow, model(tool("r1", "Read", T, 4_000, { station: "FILES" })), { now: T + 5 * SEC, h: fast })).toEqual([]);
    expect(run(toolSlow, model(tool("r1", "Read", T, 6_000, { station: "FILES" })), { now: T + 7 * SEC, h: fast })[0]?.severity).toBe("alert");
  });

  it("closes 60 s after the slow call ended", () => {
    const m = model(bash("t1", T, 20 * SEC));
    expect(run(toolSlow, m, { now: T + 20 * SEC + 59 * SEC, h })).toHaveLength(1);
    expect(run(toolSlow, m, { now: T + 20 * SEC + 61 * SEC, h })).toEqual([]);
  });

  it("opens on a call still running past the line, without any new event", () => {
    const m = model([{ kind: "prompt", row: { promptId: "p1", sessionId: S, at: T - SEC } }, ...bash("t1", T, undefined)]);
    expect(run(toolSlow, m, { now: T + 12 * SEC, h })).toEqual([]);
    expect(run(toolSlow, m, { now: T + 31 * SEC, h })).toMatchObject([{ severity: "alert", measures: { running: 1 } }]);
  });

  it("does not judge a call a hook blocked, a call of a finished turn, or one waiting for a permission", () => {
    const blocked = model([...bash("t1", T, undefined), ev("hook_block", T + 10, { toolUseId: "t1", label: "Bash" })]);
    expect(run(toolSlow, blocked, { now: T + 5 * MIN, h })).toEqual([]);
    const turnOver = model([...bash("t1", T, undefined), ev("stop", T + SEC)]);
    expect(run(toolSlow, turnOver, { now: T + 5 * MIN, h })).toEqual([]);
    const asked = model([...bash("t1", T, undefined), ev("permission_request", T + 20, { label: "Bash" })]);
    expect(run(toolSlow, asked, { now: T + 5 * MIN, h })).toEqual([]);
  });
});

describe("api_slow_or_limited", () => {
  const M = "claude-opus-5-5";
  const h = { models: { [M]: { p95: 40, n: 50 } } };

  it("warns on a call slower per token than the model's p95 and over 10 s", () => {
    const m = model([api("req:1", T, { model: M, durationMs: 30 * SEC, outputTokens: 500 })]);
    expect(run(apiSlowOrLimited, m, { now: T, h })).toMatchObject([{ subkey: M, station: "EXTERNAL", severity: "warn", value: 60, threshold: 40, n: 50, evidence: ["api:req:1"] }]);
  });

  it("is quiet under 10 s (floor), under the p95, or with thin history", () => {
    expect(run(apiSlowOrLimited, model([api("req:1", T, { model: M, durationMs: 9 * SEC, outputTokens: 100 })]), { now: T, h })).toEqual([]);
    expect(run(apiSlowOrLimited, model([api("req:1", T, { model: M, durationMs: 20 * SEC, outputTokens: 1000 })]), { now: T, h })).toEqual([]);
    expect(run(apiSlowOrLimited, model([api("req:1", T, { model: M, durationMs: 30 * SEC, outputTokens: 500 })]), { now: T, h: { models: { [M]: { p95: 40, n: 10 } } } })).toEqual([]);
  });

  it("alerts on a 429 after the model's latest call and closes on the next normal call", () => {
    const limited = [api("req:1", T, { model: M, durationMs: 3 * SEC, outputTokens: 300 }), ev("api_error", T + SEC, { label: M, number: 429, flag: true })];
    expect(run(apiSlowOrLimited, model(limited), { now: T + SEC, h })).toMatchObject([{ severity: "alert", evidence: [`event:api_error:${T + SEC}:${M}`] }]);
    const retried = [...limited, api("req:2", T + 5 * SEC, { model: M, durationMs: 3 * SEC, outputTokens: 300 })];
    expect(run(apiSlowOrLimited, model(retried), { now: T + 5 * SEC, h })).toEqual([]);
    // Another status is not a rate limit.
    expect(run(apiSlowOrLimited, model([ev("api_error", T, { label: M, number: 500, flag: false })]), { now: T, h })).toEqual([]);
  });
});

describe("repeat_read", () => {
  const read = (id: string, at: number, key: string, page: { readOffset?: number; readLimit?: number } = {}): WriteOp[] =>
    tool(id, "Read", at, 10, { station: "FILES", stationFlags: 0, target: "src/index.ts", targetKey: key, ...page });
  const edit = (id: string, at: number, key: string): WriteOp[] => tool(id, "Edit", at, 10, { station: "FILES", stationFlags: StationFlag.write, target: "src/index.ts", targetKey: key });

  it("warns at 3 reads of one page, alerts at 5", () => {
    const three = [1, 2, 3].flatMap((i) => read(`r${i}`, T + i * SEC, "k-app"));
    expect(run(repeatRead, model(three.slice(0, 4)), { now: T })).toEqual([]);
    expect(run(repeatRead, model(three), { now: T })).toMatchObject([{ subkey: "k-app", station: "FILES", severity: "warn", value: 3, evidence: ["tool:r3", "tool:r2", "tool:r1"] }]);
    const five = [1, 2, 3, 4, 5].flatMap((i) => read(`r${i}`, T + i * SEC, "k-app"));
    expect(run(repeatRead, model(five), { now: T })[0]?.severity).toBe("alert");
  });

  it("does not count other pages of the file, Grep or Glob, or calls without a key", () => {
    const paged = [0, 200, 400].flatMap((o, i) => read(`r${i}`, T + i * SEC, "k-app", { readOffset: o, readLimit: 200 }));
    expect(run(repeatRead, model(paged), { now: T })).toEqual([]);
    const greps = [1, 2, 3].flatMap((i) => tool(`g${i}`, "Grep", T + i * SEC, 10, { station: "FILES", target: "src" }));
    expect(run(repeatRead, model(greps), { now: T })).toEqual([]);
    const keyless = [1, 2, 3].flatMap((i) => tool(`r${i}`, "Read", T + i * SEC, 10, { station: "FILES", target: "src/.env" }));
    expect(run(repeatRead, model(keyless), { now: T })).toEqual([]);
  });

  it("keeps two index.ts of a monorepo apart (two keys)", () => {
    const ops = [1, 2, 3].flatMap((i) => [...read(`a${i}`, T + i * SEC, "k-pkg-a"), ...read(`b${i}`, T + i * SEC + 1, i < 3 ? "k-pkg-b" : "k-pkg-a2")]);
    expect(run(repeatRead, model(ops), { now: T }).map((v) => v.subkey)).toEqual(["k-pkg-a"]);
  });

  it("starts again after a shell command, which may have changed the file", () => {
    const ops = [...read("r1", T + SEC, "k-app"), ...tool("b1", "Bash", T + 2 * SEC, 300, { station: "SANDBOX", target: "python3" }), ...read("r2", T + 3 * SEC, "k-app"), ...read("r3", T + 4 * SEC, "k-app")];
    expect(run(repeatRead, model(ops), { now: T })).toEqual([]);
  });

  it("closes when the file is written: the count starts again", () => {
    const ops = [...[1, 2, 3].flatMap((i) => read(`r${i}`, T + i * SEC, "k-app")), ...edit("e1", T + 4 * SEC, "k-app"), ...read("r4", T + 5 * SEC, "k-app")];
    expect(run(repeatRead, model(ops), { now: T })).toEqual([]);
  });
});

describe("context_high", () => {
  const M = "claude-opus-5-5";
  const call = (key: string, at: number, cached: number, extra: Partial<Extract<WriteOp, { kind: "apiRequest" }>["row"]> = {}): WriteOp =>
    api(key, at, { model: M, inputTokens: 10, cacheReadTokens: cached, cacheWrite5mTokens: 0, outputTokens: 500, querySource: "repl_main_thread", ...extra });

  it("warns past 80% of the window, alerts past 95%, on the main thread's latest call", () => {
    expect(run(contextHigh, model([call("req:1", T, 150_000)]), { now: T, window: 200_000 })).toEqual([]);
    expect(run(contextHigh, model([call("req:1", T, 170_000)]), { now: T, window: 200_000 })).toMatchObject([{ subkey: "", station: "CORE", severity: "warn", evidence: ["api:req:1"] }]);
    expect(run(contextHigh, model([call("req:1", T, 195_000)]), { now: T, window: 200_000 })[0]?.severity).toBe("alert");
  });

  it("is quiet when the model's window is not known, and ignores a subagent's calls", () => {
    expect(run(contextHigh, model([call("req:1", T, 195_000)]), { now: T })).toEqual([]);
    expect(run(contextHigh, model([call("req:1", T, 195_000, { agentId: "agent-1", querySource: "agent:builtin:Explore" })]), { now: T, window: 200_000 })).toEqual([]);
  });

  it("closes when a later call is under 80% or a compaction ended", () => {
    expect(run(contextHigh, model([call("req:1", T, 170_000), call("req:2", T + SEC, 100_000)]), { now: T, window: 200_000 })).toEqual([]);
    expect(run(contextHigh, model([call("req:1", T, 170_000), ev("compact_end", T + SEC, { label: "auto" })]), { now: T, window: 200_000 })).toEqual([]);
  });
});

describe("mcp_errors", () => {
  const mcp = (id: string, at: number, ok: boolean, error?: string): WriteOp[] =>
    tool(id, "mcp__gh__search", at, 300, { station: "MCP", mcpServer: "gh", success: ok, ...(ok ? {} : { error: error ?? "failed" }) });
  const seq = (oks: boolean[]): WriteOp[] => oks.flatMap((ok, i) => mcp(`m${i}`, T + i * SEC, ok));

  it("needs 3 errors that are 30% of the server's calls; alerts at 50%", () => {
    expect(run(mcpErrors, model(seq([false, false, true, true])), { now: T })).toEqual([]);
    expect(run(mcpErrors, model(seq([false, false, false, true, true, true, true, true, true, true])), { now: T })).toMatchObject([{ subkey: "gh", station: "MCP", severity: "warn", n: 10 }]);
    expect(run(mcpErrors, model(seq([false, false, false, true, true])), { now: T })[0]?.severity).toBe("alert");
    expect(run(mcpErrors, model(seq([false, false, false, ...Array<boolean>(10).fill(true)])), { now: T })).toEqual([]);
  });

  it("does not count denials or interruptions as the server's errors", () => {
    const ops = [0, 1, 2].flatMap((i) => mcp(`m${i}`, T + i * SEC, false, i === 0 ? "permission denied" : "interrupted"));
    expect(run(mcpErrors, model(ops), { now: T })).toEqual([]);
  });

  it("stays open until 5 successes in a row, then counts from the close", () => {
    const prior: Prior = { status: "open", severity: "alert", openedAt: T, closedAt: null };
    const four = model(seq([false, false, false, true, true, true, true]));
    expect(run(mcpErrors, four, { now: T, priors: { gh: prior } })).toHaveLength(1);
    const five = model(seq([false, false, false, true, true, true, true, true]));
    expect(run(mcpErrors, five, { now: T, priors: { gh: prior } })).toEqual([]);
    const closed: Prior = { ...prior, status: "closed", closedAt: T + 8 * SEC };
    expect(run(mcpErrors, five, { now: T, priors: { gh: closed } })).toEqual([]);
  });
});

describe("subagent_idle", () => {
  const start: WriteOp = { kind: "subagent", row: { sessionId: S, agentId: "agent-1", promptId: "p1", startedAt: T } };

  it("warns on a subagent running over 5 minutes under 2 000 tokens a minute, alerts past 15", () => {
    expect(run(subagentIdle, model([start]), { now: T + 4 * MIN })).toEqual([]);
    expect(run(subagentIdle, model([start]), { now: T + 6 * MIN })).toMatchObject([{ subkey: "agent-1", station: "ORCHESTRATOR", severity: "warn", evidence: ["subagent:agent-1"] }]);
    expect(run(subagentIdle, model([start]), { now: T + 16 * MIN })[0]?.severity).toBe("alert");
  });

  it("closes when it works (tokens over the line) or stops", () => {
    const busy = [start, api("req:1", T + MIN, { agentId: "agent-1", model: "m", inputTokens: 10, cacheReadTokens: 20_000, outputTokens: 400 })];
    expect(run(subagentIdle, model(busy), { now: T + 6 * MIN })).toEqual([]);
    const stopped: WriteOp = { kind: "subagent", row: { sessionId: S, agentId: "agent-1", startedAt: T + 6 * MIN, endedAt: T + 6 * MIN } };
    expect(run(subagentIdle, model([start, stopped]), { now: T + 7 * MIN })).toEqual([]);
  });
});

describe("cost_spike", () => {
  const turns = (n: number, cost: number | null, tokens = 1_000_000): TurnCost[] => Array.from({ length: n }, (_, i) => ({ promptId: `old-${i}`, at: T - (i + 1) * MIN, costUsd: cost, tokens }));
  const turn = (cost: number | null, tokens = 1_000_000): WriteOp[] => [
    { kind: "prompt", row: { promptId: "p1", sessionId: S, at: T } },
    api("req:1", T + SEC, { promptId: "p1", model: "m", costUsd: cost, inputTokens: tokens }),
  ];

  it("warns past 2× the p95 of the project's earlier turns, alerts past 4×", () => {
    const h = { turns: [...turns(18, 0.5), ...turns(2, 1)] };
    expect(run(costSpike, model(turn(1.9)), { now: T + 2 * SEC, h })).toEqual([]);
    expect(run(costSpike, model(turn(2.1)), { now: T + 2 * SEC, h })).toMatchObject([{ subkey: "p1", station: "CORE", severity: "warn", n: 20, measures: { unit: "usd", baselineP95: 1 } }]);
    expect(run(costSpike, model(turn(4.1)), { now: T + 2 * SEC, h })[0]?.severity).toBe("alert");
  });

  it("needs 20 earlier turns and a turn over the floor", () => {
    expect(run(costSpike, model(turn(9)), { now: T, h: { turns: turns(19, 0.5) } })).toEqual([]);
    expect(run(costSpike, model(turn(0.9)), { now: T, h: { turns: turns(20, 0.01) } })).toEqual([]);
  });

  it("compares tokens, and says so, when a cost is missing", () => {
    const v = run(costSpike, model(turn(null, 9_000_000)), { now: T, h: { turns: turns(20, 0.3, 2_000_000) } });
    expect(v).toMatchObject([{ severity: "alert", value: 9_000_000, measures: { unit: "tokens" } }]);
  });

  it("closes 60 s after the turn ended", () => {
    const ops = [...turn(5), ev("stop", T + 10 * SEC)];
    expect(run(costSpike, model(ops), { now: T + 60 * SEC, h: { turns: turns(20, 0.5) } })).toHaveLength(1);
    expect(run(costSpike, model(ops), { now: T + 71 * SEC, h: { turns: turns(20, 0.5) } })).toEqual([]);
  });
});
