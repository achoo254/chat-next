// Costs at API prices, what each habit cost, the rows per model, the
// sessions that cost most, and what sessions left in git.
import { describe, expect, it } from "vitest";
import { usageReportBody } from "../../src/link/usage-link.ts";
import { claudeModels } from "../../src/providers/claude/usage-models.ts";
import { costAt, costOf } from "../../src/usage/costs.ts";
import type { LedgerIndex, Turn } from "../../src/usage/ledger.ts";
import { OutcomeReader, parseLog } from "../../src/usage/outcomes.ts";
import { type ReportSession, SESSIONS_MAX, buildReport } from "../../src/usage/report.ts";
import { ruleSwitches } from "../../src/usage/rules.ts";

const catalogs = (p: string) => (p === "claude" ? claudeModels : undefined);
const T0 = new Date(2026, 10, 3, 9, 0).getTime();
let seq = 0;

function call(extra: Partial<Turn> = {}): Turn {
  return {
    provider: "claude",
    key: `k${seq++}`,
    sessionId: "s1",
    subagent: false,
    at: T0 + seq * 60_000,
    model: "claude-opus-5-5",
    cwd: "/work/app",
    input: 1000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 100,
    tools: [],
    ...extra,
  };
}

function index(): LedgerIndex {
  return {
    schemaVersion: 2,
    createdAt: 0,
    lastScanAt: 0,
    files: {},
    dirs: { "/work/app": { repo: "example.com/team/app", at: 0 } },
    launched: { claude: { s1: 0 } },
    quota: [],
    notified: {},
    errors: { parse: 0, overCap: 0 },
    shape: { days: {}, flags: { usageRatio: 1, lowUsageRatio: false, driftRatio: 1, drift: false, unknownTypes: [] } },
  };
}

const report = (turns: Turn[]) => buildReport({ index: index(), turns, query: { from: "2026-11-03", to: "2026-11-03" }, rules: ruleSwitches(undefined), now: T0, catalogs });

describe("Claude's model catalog", () => {
  it("prices the 5.5 models as Claude Code reports their cost", () => {
    // 1M input + 1M output + 1M cache read on Opus 5.5: 4 + 20 + 0.2 dollars.
    expect(costAt({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, claudeModels.price("claude-opus-5-5") ?? fail())).toBeCloseTo(24.2);
    expect(claudeModels.price("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
    expect(claudeModels.tier("claude-fable-5-2")).toBe("strong");
    expect(claudeModels.price("claude-fable-5-2")).toBeUndefined();
    expect(claudeModels.tier("claude-haiku-5-5")).toBe("light");
    expect(claudeModels.lighterPrice("claude-opus-5-5")).toEqual(claudeModels.price("claude-sonnet-5-5"));
    expect(claudeModels.tier("gemini-pro")).toBeUndefined();
  });

  it("leaves a call of an unknown model or AI without a cost", () => {
    expect(costOf(call({ model: "claude-fable-5-2" }), catalogs)).toBeUndefined();
    expect(costOf(call({ provider: "antigravity" }), catalogs)).toBeUndefined();
  });
});

function fail(): never {
  throw new Error("no price");
}

describe("what a habit cost", () => {
  it("context: cache reads of the context above 300K on every main call", () => {
    const r = report([call({ cacheRead: 400_000 }), call({ cacheRead: 200_000 }), call({ cacheRead: 500_000 })]);
    const s = r.suggestions.find((x) => x.rule === "context");
    // (100K + 0 + 200K) context over the line, read at $0.2 per million, plus the input just above it.
    expect(s?.excessUsd).toBeCloseTo(((101_000 + 0 + 201_000) * 0.2) / 1e6);
  });

  it("turns: the calls after the 300th", () => {
    const calls = Array.from({ length: 302 }, () => call());
    const s = report(calls).suggestions.find((x) => x.rule === "turns");
    const one = costAt(calls[0] ?? fail(), claudeModels.price("claude-opus-5-5") ?? fail());
    expect(s?.excessUsd).toBeCloseTo(2 * one);
  });

  it("mechanical: a strong model's mechanical calls against the standard model", () => {
    const calls = Array.from({ length: 30 }, () => call({ tools: ["Read"], output: 200 }));
    const s = report(calls).suggestions.find((x) => x.rule === "mechanical");
    const each = (calls[0]?.input ?? 0) * (4 - 2) / 1e6 + 200 * (20 - 10) / 1e6;
    expect(s?.excessUsd).toBeCloseTo(30 * each);
    expect(s?.value).toBe(1000);
  });

  it("an AI without a catalog never fires the mechanical rule", () => {
    const calls = Array.from({ length: 30 }, () => call({ provider: "other", tools: ["Read"], output: 200 }));
    expect(report(calls).suggestions.filter((x) => x.rule === "mechanical")).toEqual([]);
  });
});

describe("rows per model and the costliest sessions", () => {
  it("adds up each model of a day, and marks the ones without a price", () => {
    const r = report([call(), call({ model: "claude-sonnet-5-5" }), call({ model: "claude-fable-5-2", subagent: true, agentId: "a" })]);
    expect(r.modelDays.map((m) => [m.model, m.mainTurns, m.subagentTurns, m.priced])).toEqual([
      ["claude-fable-5-2", 0, 1, false],
      ["claude-opus-5-5", 1, 0, true],
      ["claude-sonnet-5-5", 1, 0, true],
    ]);
    expect(r.modelDays.find((m) => m.model === "claude-opus-5-5")?.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6);
  });

  it("lists sessions costliest first, with their main model, peak context and whether the app opened them", () => {
    const r = report([call({ sessionId: "cheap", model: "claude-haiku-5-5" }), call({ cacheRead: 300_000 }), call(), call({ model: "claude-fable-5-2" })]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["s1", "cheap"]);
    expect(r.sessions[0]).toMatchObject({ mainTurns: 3, model: "claude-opus-5-5", peakContext: 301_000, unpricedTurns: 1, app: true, repoKey: "example.com/team/app" });
    expect(r.sessions[1]).toMatchObject({ app: false });
  });

  it("keeps to the costliest SESSIONS_MAX", () => {
    const r = report(Array.from({ length: SESSIONS_MAX + 5 }, (_, i) => call({ sessionId: `x${i}`, input: 1000 * (i + 1) })));
    expect(r.sessions).toHaveLength(SESSIONS_MAX);
    expect(r.sessions[0]?.sessionId).toBe(`x${SESSIONS_MAX + 4}`);
  });
});

describe("what sessions left in git", () => {
  const session = (extra: Partial<ReportSession> = {}): ReportSession => ({
    provider: "claude",
    sessionId: "s1",
    repoKey: "example.com/team/app",
    firstAt: T0,
    lastAt: T0 + 30 * 60_000,
    mainTurns: 3,
    subagentTurns: 0,
    peakContext: 0,
    model: "claude-opus-5-5",
    costUsd: 1,
    unpricedTurns: 0,
    app: true,
    cwd: "/work/app",
    ...extra,
  });

  it("counts commits and the files they changed", () => {
    const h1 = "a".repeat(40);
    const h2 = "b".repeat(40);
    expect(parseLog(`${h1}\n\n 3 files changed, 10 insertions(+)\n${h2}\n\n 1 file changed, 2 deletions(-)\n`)).toEqual({ commits: 2, filesChanged: 4 });
    expect(parseLog("")).toEqual({ commits: 0, filesChanged: 0 });
  });

  it("asks git once per folder and span, from the first call to 10 minutes after the last", async () => {
    const asked: string[][] = [];
    const reader = new OutcomeReader(async (dir, args) => {
      asked.push([dir, ...args]);
      return dir === "/work/app" ? `${"c".repeat(40)}\n 2 files changed\n` : undefined;
    });
    const found = await reader.read([session(), session({ sessionId: "s2", cwd: "/not/git" }), session({ sessionId: "s3", cwd: "" })]);
    expect([...found.entries()]).toEqual([["claude\u0000s1", { commits: 1, filesChanged: 2 }]]);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(`--since=${new Date(T0).toISOString()}`);
    expect(asked[0]).toContain(`--until=${new Date(T0 + 40 * 60_000).toISOString()}`);
    await reader.read([session()]);
    expect(asked).toHaveLength(2);
  });

  it("sends the counts, never the folder", () => {
    const r = report([call()]);
    const body = usageReportBody({ ...r, sessions: r.sessions.map((s) => ({ ...s, outcome: { commits: 2, filesChanged: 5 } })) });
    expect(body.sessions[0]).toMatchObject({ outcomeKnown: true, commits: 2, filesChanged: 5 });
    expect(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v))).not.toContain("/work/app");
  });
});
