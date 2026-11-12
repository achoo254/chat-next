// The usage report over a made-up ledger, against numbers worked out by
// hand: rows by repository key and local day, the rules' suggestions in the
// range (with when their hint was sent), plan usage readings, and refused
// ranges.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageTurn } from "../../src/providers/types.ts";
import { Ledger, LedgerUnreadable } from "../../src/usage/ledger.ts";
import { REPORT_MAX_DAYS, ReportRangeError, p90, rangeOf, usageReport } from "../../src/usage/report.ts";
import { ruleSwitches } from "../../src/usage/rules.ts";
import { tempDir } from "../harness.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const D1 = at(3, 10);
const D2 = at(4, 9);
const REPO = "example.com/team/app";

function call(key: string, when: number, sessionId: string, tokens: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }, extra: Partial<UsageTurn> = {}): UsageTurn {
  return {
    key,
    sessionId,
    subagent: false,
    at: when,
    model: "claude-test",
    cwd: "/work/app",
    inputTokens: tokens.input ?? 0,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
    outputTokens: tokens.output ?? 0,
    tools: [],
    ...extra,
  };
}

const repoKey = (cwd: string) => (cwd.startsWith("/work/app") ? REPO : "scratch");

async function synthetic() {
  let now = at(1, 12);
  const ledger = new Ledger(join(tempDir("usage-report-"), "usage"), { now: () => now });
  const turns = [
    // s1, opened by the app: a call the day before the range (over 300K), then three main calls and one subagent call on D1.
    call("k0", at(2, 23), "s1", { input: 350_000, output: 1 }),
    call("k1", D1, "s1", { input: 100_000, output: 10 }),
    call("k2", D1 + 60_000, "s1", { input: 50_000, cacheRead: 150_000, output: 20 }),
    call("k3", D1 + 2 * 60_000, "s1", { cacheWrite: 300_000, output: 30 }),
    call("k4", D1 + 3 * 60_000, "s1", { input: 50_000, output: 5 }, { subagent: true, agentId: "a1" }),
    // s2: one call over 300K on D1, in a sub-folder of the same repository.
    call("k5", D1 + 4 * 60_000, "s2", { input: 400_000, output: 40 }, { cwd: "/work/app/sub" }),
    // s3: a scratch folder on D2.
    call("k6", D2, "s3", { input: 1000, output: 1 }, { cwd: "/tmp/try" }),
    // After the range.
    call("k7", at(5, 0, 30), "s3", { input: 999_999 }, { cwd: "/tmp/try" }),
  ];
  await ledger.apply("claude", { path: "/fake/a.jsonl", dev: 1, ino: 1, size: 10, mtimeMs: 1 }, { turns, end: 10, stats: { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} } }, repoKey);
  await ledger.update((d) => {
    d.launched.claude = { s1: D1 };
  });
  now = D1 + 10 * 60_000;
  await ledger.recordNotified([{ provider: "claude", sessionId: "s2", rule: "context" }], now);
  await ledger.recordQuota("", { fiveHour: { utilization: 42, resetsAt: D2 } }, "scheduled");
  now = at(6, 8);
  await ledger.recordQuota("p1", { sevenDay: { utilization: 70, resetsAt: D2 } }, "user");
  await ledger.save();
  return ledger;
}

describe("the usage report", () => {
  it("adds up each repository and day as worked out by hand", async () => {
    const ledger = await synthetic();
    const r = await usageReport(ledger, { from: "2026-11-03", to: "2026-11-04" }, ruleSwitches(undefined), at(6, 9));
    expect(r.from).toBe("2026-11-03");
    expect(r.utcOffsetMinutes).toBe(-new Date(at(6, 9)).getTimezoneOffset());
    expect(r.days).toEqual([
      {
        repoKey: REPO,
        day: "2026-11-03",
        input: 600_000,
        cacheRead: 150_000,
        cacheWrite: 300_000,
        output: 105,
        mainTurns: 4,
        subagentTurns: 1,
        sessions: 2,
        appTurns: 3,
        meanContext: 250_000,
        medianContext: 250_000,
        p90Context: 400_000,
      },
      {
        repoKey: "scratch",
        day: "2026-11-04",
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        mainTurns: 1,
        subagentTurns: 0,
        sessions: 1,
        appTurns: 0,
        meanContext: 1000,
        medianContext: 1000,
        p90Context: 1000,
      },
    ]);
    // s1 went over 300K before the range (its first call): only s2's suggestion is in it, sent at D1 + 10 minutes.
    expect(r.suggestions).toEqual([
      { rule: "context", sessionId: "s2", repoKey: REPO, turn: 1, at: D1 + 4 * 60_000, value: 400_000, experimental: false, notifiedAt: D1 + 10 * 60_000 },
    ]);
    expect(r.quota).toEqual([{ profile: "", at: D1 + 10 * 60_000, via: "scheduled", fiveHour: { utilization: 42, resetsAt: D2 } }]);
    expect(r.lastScanAt).toBe(0);
    expect(r.flags).toMatchObject({ drift: false, lowUsageRatio: false });
  });

  it("counts the calls of a session before the range for the rules", async () => {
    const ledger = await synthetic();
    const r = await usageReport(ledger, { from: "2026-11-02", to: "2026-11-03" }, ruleSwitches(undefined), at(6, 9));
    expect(r.suggestions.map((s) => [s.sessionId, s.turn, s.notifiedAt])).toEqual([
      ["s1", 1, 0],
      ["s2", 1, D1 + 10 * 60_000],
    ]);
  });

  it("keeps to one repository key, and to the rules switched on", async () => {
    const ledger = await synthetic();
    const scratch = await usageReport(ledger, { from: "2026-11-03", to: "2026-11-04", repoKey: "scratch" }, ruleSwitches(undefined), at(6, 9));
    expect(scratch.days.map((d) => [d.repoKey, d.day])).toEqual([["scratch", "2026-11-04"]]);
    expect(scratch.suggestions).toEqual([]);
    const off = await usageReport(ledger, { from: "2026-11-03", to: "2026-11-04" }, ruleSwitches({ context: false }), at(6, 9));
    expect(off.suggestions).toEqual([]);
  });

  it("holds numbers, rule codes, session ids, repository keys and days only", async () => {
    const ledger = await synthetic();
    const r = await usageReport(ledger, { from: "2026-11-01", to: "2026-11-06" }, ruleSwitches(undefined), at(6, 9));
    const text = JSON.stringify(r);
    for (const leak of ["/work/app", "/tmp/try", "claude-test", "/fake/a.jsonl"]) expect(text).not.toContain(leak);
  });

  it("refuses days that are not days, a reversed range, a range over 92 days and a key with control characters", () => {
    for (const q of [
      { from: "2026-11-3", to: "2026-11-04" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-11-05", to: "2026-11-04" },
      { from: "2026-01-01", to: "2026-04-03" },
      { from: "2026-11-01", to: "2026-11-02", repoKey: "a\nb" },
      { from: "2026-11-01", to: "2026-11-02", repoKey: "x".repeat(513) },
    ]) {
      expect(() => rangeOf(q), JSON.stringify(q)).toThrow(ReportRangeError);
    }
    expect(REPORT_MAX_DAYS).toBe(92);
    const r = rangeOf({ from: "2026-01-01", to: "2026-04-02" });
    expect(r).toEqual({ from: new Date(2026, 0, 1).getTime(), to: new Date(2026, 3, 3).getTime() });
  });

  it("takes p90 at rank round(0.9 × (n − 1)), as the baseline script", () => {
    expect(p90([])).toBe(0);
    expect(p90([5])).toBe(5);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([1, 2, 3, 4])).toBe(4);
  });

  it("is refused while the ledger is blocked", async () => {
    const dir = join(tempDir("usage-report-"), "usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), "{ broken");
    await expect(usageReport(new Ledger(dir), { from: "2026-11-01", to: "2026-11-02" }, ruleSwitches(undefined), at(6, 9))).rejects.toThrow(LedgerUnreadable);
  });
});
