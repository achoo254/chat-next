// The usage rules at their thresholds: each fires once, at the call where it
// first held, and only when switched on.
import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/usage/ledger.ts";
import { USAGE_RULES, evaluate, groupSessions, isMechanical, ruleSwitches } from "../../src/usage/rules.ts";

const T0 = Date.parse("2026-11-10T03:00:00.000Z");
let seq = 0;

/** A call of session `s` at minute `n`, with `ctx` context tokens (all input). */
function call(n: number, ctx: number, extra: Partial<Turn> = {}): Turn {
  return {
    provider: "claude",
    key: `k${seq++}`,
    sessionId: "s1",
    subagent: false,
    at: T0 + n * 60_000,
    model: "claude-sonnet-x",
    cwd: "/work/app",
    input: ctx,
    cacheRead: 0,
    cacheWrite: 0,
    output: 100,
    tools: [],
    ...extra,
  };
}

const rules = (turns: Turn[], on = ruleSwitches(undefined)) => evaluate(turns, on);
const only = (rule: string, turns: Turn[]) => rules(turns).filter((s) => s.rule === rule);

describe("context over the limit", () => {
  it("fires above 300K, at the first such main-session call, not at 300K", () => {
    expect(USAGE_RULES.context.maxContext).toBe(300_000);
    expect(only("context", [call(0, 100_000), call(1, 300_000)])).toEqual([]);
    const fired = only("context", [call(0, 100_000), call(1, 300_000), call(2, 300_001), call(3, 500_000)]);
    expect(fired).toEqual([expect.objectContaining({ rule: "context", sessionId: "s1", turn: 3, at: T0 + 2 * 60_000, value: 300_001, experimental: false })]);
  });

  it("counts cache reads and writes as context, and leaves subagent calls out", () => {
    expect(only("context", [call(0, 0, { input: 1, cacheRead: 250_000, cacheWrite: 50_000 })])).toEqual([expect.objectContaining({ value: 300_001 })]);
    expect(only("context", [call(0, 10), call(1, 900_000, { subagent: true, agentId: "a" })])).toEqual([]);
  });

  it("orders calls by time, whatever order they come in", () => {
    const fired = only("context", [call(5, 400_000), call(1, 10), call(3, 350_000)]);
    expect(fired[0]).toMatchObject({ turn: 2, value: 350_000 });
  });
});

describe("too many calls", () => {
  it("fires past 300 main-session calls, at call 301", () => {
    const main = Array.from({ length: 300 }, (_, i) => call(i, 1000));
    const sub = Array.from({ length: 50 }, (_, i) => call(i, 1000, { subagent: true, agentId: "a" }));
    expect(only("turns", [...main, ...sub])).toEqual([]);
    const fired = only("turns", [...main, call(300, 1000), call(301, 1000)]);
    expect(fired).toEqual([expect.objectContaining({ turn: 301, at: T0 + 300 * 60_000, value: 302 })]);
  });
});

describe("a strong model on mechanical work (experimental)", () => {
  const strong = { model: "claude-opus-4-x" };
  const mech = (n: number, extra: Partial<Turn> = {}) => call(n, 50_000, { ...strong, tools: ["Read"], output: 200, ...extra });
  const think = (n: number) => call(n, 50_000, { ...strong, tools: ["Edit"], output: 2000 });

  it("knows a mechanical call: tools that only read, search or run, and little output", () => {
    expect(isMechanical({ tools: ["Read", "Grep", "Glob", "Bash"], output: 500 })).toBe(true);
    expect(isMechanical({ tools: ["Bash"], output: 501 })).toBe(false);
    expect(isMechanical({ tools: [], output: 10 })).toBe(false);
    expect(isMechanical({ tools: ["Read", "Edit"], output: 10 })).toBe(false);
    expect(isMechanical({ tools: ["mcp__docs__search"], output: 10 })).toBe(false);
    expect(isMechanical({ tools: ["Skill:example"], output: 10 })).toBe(false);
  });

  it("needs 30 strong-model calls", () => {
    expect(only("mechanical", Array.from({ length: 29 }, (_, i) => mech(i)))).toEqual([]);
    const fired = only("mechanical", Array.from({ length: 30 }, (_, i) => mech(i)));
    expect(fired).toEqual([expect.objectContaining({ turn: 30, value: 1000, experimental: true })]);
  });

  it("fires once at least 75% of them were mechanical", () => {
    // 10 calls that write, then mechanical ones: 29 of 39 is 74.4%, 30 of 40 is 75%.
    const turns = [...Array.from({ length: 10 }, (_, i) => think(i)), ...Array.from({ length: 29 }, (_, i) => mech(10 + i))];
    expect(only("mechanical", turns)).toEqual([]);
    expect(only("mechanical", [...turns, mech(39)])).toEqual([expect.objectContaining({ turn: 40, value: 750 })]);
  });

  it("does not count other models, whose calls still count as turns of the session", () => {
    expect(only("mechanical", Array.from({ length: 60 }, (_, i) => mech(i, { model: "claude-sonnet-x" })))).toEqual([]);
    const mixed = [...Array.from({ length: 5 }, (_, i) => call(i, 1000)), ...Array.from({ length: 30 }, (_, i) => mech(5 + i))];
    expect(only("mechanical", mixed)).toEqual([expect.objectContaining({ turn: 35 })]);
  });
});

describe("subagents carrying the session", () => {
  const sub = (n: number, ctx: number) => call(n, ctx, { subagent: true, agentId: "a1" });

  it("fires above half of the session's context, once it reached 1M", () => {
    expect(USAGE_RULES.subagents).toMatchObject({ maxShare: 0.5, minContext: 1_000_000 });
    // Exactly half: no.
    expect(only("subagents", [call(0, 500_000), sub(1, 500_000)])).toEqual([]);
    const fired = only("subagents", [call(0, 500_000), sub(1, 500_001)]);
    expect(fired).toEqual([expect.objectContaining({ turn: 1, at: T0 + 60_000, value: 500 })]);
    expect(fired[0]?.value).toBe(Math.round((1000 * 500_001) / 1_000_001));
  });

  it("waits for 1M of context, and reports the main calls made by then", () => {
    expect(only("subagents", [call(0, 100_000), sub(1, 899_999)])).toEqual([]);
    const fired = only("subagents", [call(0, 100_000), sub(1, 899_999), call(2, 1), sub(3, 10)]);
    expect(fired).toEqual([expect.objectContaining({ turn: 2, at: T0 + 2 * 60_000, value: 900 })]);
  });
});

describe("sessions and switches", () => {
  it("keeps sessions and providers apart, a subagent's calls with its parent", () => {
    const groups = groupSessions([call(0, 1), call(1, 1, { sessionId: "s2" }), call(2, 1, { subagent: true, agentId: "a" }), call(3, 1, { provider: "other" })]);
    expect(groups.map((g) => [g.provider, g.sessionId, g.main.length, g.subagents.length])).toEqual([
      ["claude", "s1", 1, 1],
      ["claude", "s2", 1, 0],
      ["other", "s1", 1, 0],
    ]);
    expect(rules([call(0, 400_000), call(1, 400_000, { sessionId: "s2" })]).map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("runs only the rules switched on; unset switches keep the defaults", () => {
    expect(ruleSwitches(undefined)).toEqual({ context: true, turns: true, mechanical: true, subagents: true });
    expect(ruleSwitches({ context: false, bogus: false })).toEqual({ context: false, turns: true, mechanical: true, subagents: true });
    const turns = [call(0, 400_000), ...Array.from({ length: 300 }, (_, i) => call(1 + i, 1))];
    expect(rules(turns).map((s) => s.rule)).toEqual(["context", "turns"]);
    expect(rules(turns, ruleSwitches({ context: false })).map((s) => s.rule)).toEqual(["turns"]);
  });

  it("gives numbers, a rule code and the session id; the folder only for its repository key", () => {
    const [s] = rules([call(0, 400_000, { tools: ["Bash"] })]);
    expect(Object.keys(s ?? {}).sort()).toEqual(["at", "cwd", "experimental", "provider", "rule", "sessionId", "turn", "value"]);
  });
});
