// Hints for running sessions: sent once per rule and session, also across a
// restart (the time sent is in the ledger's index), only for sessions with a
// main call in the last 30 minutes, tried again when no device was reached.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageTurn } from "../../src/providers/types.ts";
import { Ledger, parseIndex } from "../../src/usage/ledger.ts";
import { ACTIVE_WINDOW_MS, type UsageHint, UsageNotifier } from "../../src/usage/notify.ts";
import { type RuleSwitches, ruleSwitches } from "../../src/usage/rules.ts";
import { tempDir } from "../harness.ts";

const NOW = new Date(2026, 10, 12, 15, 0).getTime();
const min = 60_000;
let seq = 0;

function call(sessionId: string, when: number, ctx: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return { key: `k${seq++}`, sessionId, subagent: false, at: when, model: "m", cwd: "/work/app", inputTokens: ctx, outputTokens: 10, tools: [], ...extra };
}

async function ledgerWith(dir: string, turns: UsageTurn[], now: () => number): Promise<Ledger> {
  const ledger = new Ledger(dir, { now });
  await ledger.apply("claude", { path: `/fake/${seq++}.jsonl`, dev: 1, ino: seq, size: 1, mtimeMs: 1 }, { turns, end: 1, stats: { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} } }, () => "example.com/team/app");
  await ledger.save();
  return ledger;
}

function notifier(ledger: Ledger, opts: { now?: () => number; reach?: () => boolean; rules?: () => RuleSwitches } = {}) {
  const sent: { hints: UsageHint[]; at: number }[] = [];
  const n = new UsageNotifier({
    ledger,
    rules: opts.rules ?? (() => ruleSwitches(undefined)),
    deliver: async (hints, at) => {
      if (opts.reach && !opts.reach()) return false;
      sent.push({ hints, at });
      return true;
    },
    now: opts.now ?? (() => NOW),
  });
  return { n, sent };
}

describe("hints for running sessions", () => {
  it("sends a rule's hint once per session, also after a restart", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(dir, [call("s1", NOW - 20 * min, 100_000), call("s1", NOW - 5 * min, 350_000)], () => NOW);
    const { n, sent } = notifier(ledger);
    expect(await n.check()).toHaveLength(1);
    expect(sent).toEqual([
      { hints: [{ rule: "context", provider: "claude", sessionId: "s1", repoKey: "example.com/team/app", turn: 2, at: NOW - 5 * min, value: 350_000, experimental: false }], at: NOW },
    ]);
    // Nothing of a folder, a model or a message in a hint.
    expect(JSON.stringify(sent)).not.toContain("/work/app");
    expect(await n.check()).toEqual([]);
    expect(parseIndex(readFileSync(join(dir, "index.json"), "utf8")).notified).toEqual({ claude: { s1: { context: NOW } } });
    // The agent restarts: a new ledger and notifier on the same folder send nothing again.
    const again = new Ledger(dir, { now: () => NOW + 15 * min });
    const after = notifier(again, { now: () => NOW + 15 * min });
    expect(await after.n.check()).toEqual([]);
    expect(after.sent).toEqual([]);
  });

  it("sends a second rule of the same session when it fires later, alone", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(dir, [call("s1", NOW - 5 * min, 350_000)], () => NOW);
    const { n, sent } = notifier(ledger);
    await n.check();
    const later = NOW + 15 * min;
    const more = Array.from({ length: 300 }, (_, i) => call("s1", NOW + i * 100, 1000));
    await ledger.apply("claude", { path: "/fake/more.jsonl", dev: 1, ino: 999, size: 1, mtimeMs: 1 }, { turns: more, end: 1, stats: { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} } }, () => "example.com/team/app");
    const n2 = notifier(ledger, { now: () => later });
    expect((await n2.n.check()).map((h) => h.rule)).toEqual(["turns"]);
    expect(sent).toHaveLength(1);
  });

  it("leaves out sessions whose last main call is older than 30 minutes, and subagent-only activity", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(
      dir,
      [
        call("old", NOW - ACTIVE_WINDOW_MS - 1, 900_000),
        call("sub", NOW - 60 * min, 900_000),
        call("sub", NOW - 1 * min, 10, { subagent: true, agentId: "a" }),
        call("live", NOW - ACTIVE_WINDOW_MS + 1, 900_000),
      ],
      () => NOW,
    );
    const { n } = notifier(ledger);
    expect((await n.check()).map((h) => h.sessionId)).toEqual(["live"]);
  });

  it("records nothing when no device was reached, and tries again after the next scan", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(dir, [call("s1", NOW - 5 * min, 350_000)], () => NOW);
    let reach = false;
    const { n, sent } = notifier(ledger, { reach: () => reach });
    expect(await n.check()).toEqual([]);
    expect(ledger.notifiedAt("claude", "s1", "context")).toBeUndefined();
    // A scan that read nothing still tries what is pending.
    reach = true;
    expect(await n.check(false)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(ledger.notifiedAt("claude", "s1", "context")).toBe(NOW);
    // Nothing pending and nothing read: the ledger is not even looked at.
    expect(await n.check(false)).toEqual([]);
  });

  it("sends nothing for a rule switched off", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(dir, [call("s1", NOW - 5 * min, 350_000)], () => NOW);
    const { n, sent } = notifier(ledger, { rules: () => ruleSwitches({ context: false }) });
    expect(await n.check()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sends nothing while the ledger is blocked", async () => {
    const dir = join(tempDir("usage-notify-"), "usage");
    const ledger = await ledgerWith(dir, [call("s1", NOW - 5 * min, 350_000)], () => NOW);
    writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 9 }));
    const blocked = new Ledger(dir);
    const { n, sent } = notifier(blocked);
    expect(await n.check()).toEqual([]);
    expect(sent).toEqual([]);
    expect(ledger.blocked).toBeUndefined();
  });
});
