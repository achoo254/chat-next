// The usage ledger: a call counted once on the machine, safe writes (a copy
// first, 0600, never over a ledger it cannot read), one queue for every change.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageFile, UsageRead, UsageTurn } from "../../src/providers/types.ts";
import { Ledger, emptyLedger, parseLedger, serializeLedger, shapeFlags } from "../../src/usage/ledger.ts";
import { tempDir } from "../harness.ts";

const FILE: UsageFile = { path: "/fake/a.jsonl", dev: 1, ino: 10, size: 100, mtimeMs: 1 };
const T0 = Date.parse("2026-11-01T08:00:00.000Z");

function turn(key: string, at: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return { key, sessionId: "s-main", subagent: false, at, model: "m", cwd: "/work/a", inputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 10, outputTokens: 5, tools: [], ...extra };
}

const readOf = (turns: UsageTurn[], end = 100): UsageRead => ({ turns, end, stats: { records: turns.length, withUsage: turns.length, parseErrors: 0, overCap: 0, unknownTypes: {} } });

async function apply(ledger: Ledger, file: UsageFile, turns: UsageTurn[], end = 100): Promise<number> {
  let added = 0;
  await ledger.update((d) => (added = ledger.applyRead(d, "claude", file, readOf(turns, end), () => "repo-key")));
  return added;
}

describe("counting a call once on the machine", () => {
  it("counts the 50 calls a fork copied once, in the session where they came first", async () => {
    const ledger = new Ledger(join(tempDir("ledger-"), "usage"));
    const original = Array.from({ length: 50 }, (_, i) => turn(`msg_${i}|req_${i}`, T0 + i * 1000));
    expect(await apply(ledger, FILE, original)).toBe(50);
    // The fork holds the same calls (as written then) and its own new one.
    const forked = [...original.map((t) => ({ ...t, sessionId: "s-fork" })), turn("msg_new|req_new", T0 + 3_600_000, { sessionId: "s-fork" })];
    expect(await apply(ledger, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, forked)).toBe(1);
    const turns = ledger.snapshot().turns;
    expect(turns).toHaveLength(51);
    expect(turns.filter((t) => t.sessionId === "s-main")).toHaveLength(50);
    // Read in the other order, the result is the same.
    const other = new Ledger(join(tempDir("ledger-"), "usage"));
    await apply(other, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, forked.map((t) => ({ ...t, at: t.at + 1 })));
    await apply(other, FILE, original);
    expect(other.snapshot().turns.filter((t) => t.sessionId === "s-main")).toHaveLength(50);
  });

  it("takes the largest output tokens, keeps every tool of the reply, and gives a tie to the main session", async () => {
    const ledger = new Ledger(join(tempDir("ledger-"), "usage"));
    await apply(ledger, FILE, [
      turn("msg_1|req_1", T0, { outputTokens: 3, tools: ["Read"], subagent: true, agentId: "a1" }),
      turn("msg_1|req_1", T0, { outputTokens: 90, tools: ["Bash"] }),
      turn("msg_1|req_1", T0 + 5, { outputTokens: 10, tools: ["Read"] }),
    ]);
    const [t] = ledger.snapshot().turns;
    expect(t).toMatchObject({ output: 90, subagent: false, tools: ["Read", "Bash"] });
    expect(t?.agentId).toBeUndefined();
  });

  it("keeps the working directory of each call, and the repository of a directory as first told", async () => {
    const ledger = new Ledger(join(tempDir("ledger-"), "usage"));
    let asked = 0;
    await ledger.update((d) =>
      ledger.applyRead(d, "claude", FILE, readOf([turn("m1|r", T0, { cwd: "/work/a" }), turn("m2|r", T0 + 1, { cwd: "/work/b" }), turn("m3|r", T0 + 2, { cwd: "/work/a" })]), (cwd) => {
        asked++;
        return `key:${cwd}`;
      }),
    );
    expect(ledger.snapshot().turns.map((t) => t.cwd)).toEqual(["/work/a", "/work/b", "/work/a"]);
    expect(asked).toBe(2);
    expect(ledger.snapshot().dirs["/work/b"]?.repo).toBe("key:/work/b");
  });
});

describe("where a file is read from", () => {
  it("continues from the last offset, and starts over for another inode, another path or a shorter file", async () => {
    const ledger = new Ledger(join(tempDir("ledger-"), "usage"));
    await apply(ledger, FILE, [], 80);
    expect(ledger.offsetFor("claude", { ...FILE, size: 120 })).toBe(80);
    expect(ledger.offsetFor("claude", { ...FILE, ino: 99, size: 120 })).toBe(0);
    expect(ledger.offsetFor("claude", { ...FILE, path: "/fake/moved.jsonl", size: 120 })).toBe(0);
    expect(ledger.offsetFor("claude", { ...FILE, size: 40 })).toBe(0);
    expect(ledger.offsetFor("other-ai", { ...FILE, size: 120 })).toBe(0);
  });
});

describe("writing the ledger", () => {
  it("writes 0600 through a temp file, keeps the previous ledger as a copy, and reads back what it wrote", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    const ledger = new Ledger(dir);
    await apply(ledger, FILE, [turn("m1|r", T0, { tools: ["Skill:example"] })]);
    await ledger.save();
    expect(statSync(ledger.file).mode & 0o777).toBe(0o600);
    expect(existsSync(ledger.prevFile)).toBe(false);
    const first = readFileSync(ledger.file, "utf8");
    await apply(ledger, FILE, [turn("m2|r", T0 + 1)], 200);
    await ledger.save();
    expect(readFileSync(ledger.prevFile, "utf8")).toBe(first);
    expect(statSync(ledger.prevFile).mode & 0o777).toBe(0o600);
    const again = new Ledger(dir);
    await again.open();
    expect(again.snapshot().turns.map((t) => t.key)).toEqual(["m1|r", "m2|r"]);
    expect(again.snapshot().files["claude:1:10"]?.offset).toBe(200);
    expect(again.offsetFor("claude", { ...FILE, size: 300 })).toBe(200);
  });

  it("round-trips every field through its file format", () => {
    const d = emptyLedger(T0);
    d.turns.push({ provider: "claude", key: "k", sessionId: "s", subagent: true, agentId: "a", at: T0, model: "m", cwd: "/c", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, tools: ["Bash", "Skill:x"] });
    d.quota.push({ profile: "", at: T0, via: "scheduled", fiveHour: { utilization: 0.5, resetsAt: T0 + 1 } });
    d.launched.claude = { s: T0 };
    expect(parseLedger(serializeLedger(d))).toEqual(d);
  });

  it("never writes over a ledger of an unknown schema or one it cannot parse, until it is deleted", async () => {
    for (const text of [JSON.stringify({ schemaVersion: 99, turns: [] }), "{ not json"]) {
      const dir = join(tempDir("ledger-"), "usage");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ledger.json"), text);
      const logs: string[] = [];
      const ledger = new Ledger(dir, { log: (l) => logs.push(l) });
      await ledger.open();
      expect(ledger.blocked).toBeTruthy();
      await expect(apply(ledger, FILE, [turn("m|r", T0)])).rejects.toThrow();
      await ledger.recordQuota("", { fiveHour: { utilization: 1, resetsAt: 2 } }, "user").catch(() => undefined);
      await ledger.save();
      expect(readFileSync(join(dir, "ledger.json"), "utf8")).toBe(text);
      expect(existsSync(join(dir, "ledger.prev.json"))).toBe(false);
      expect(logs.join("\n")).toContain("usage delete");
      await ledger.delete();
      expect(ledger.blocked).toBeUndefined();
      expect(existsSync(join(dir, "ledger.json"))).toBe(false);
      await apply(ledger, FILE, [turn("m|r", T0)]);
      await ledger.save();
      expect(parseLedger(readFileSync(join(dir, "ledger.json"), "utf8")).turns).toHaveLength(1);
    }
  });

  it("takes the copy when the ledger itself is missing", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    const ledger = new Ledger(dir);
    await apply(ledger, FILE, [turn("m1|r", T0)]);
    await ledger.save();
    await apply(ledger, FILE, [turn("m2|r", T0 + 1)]);
    await ledger.save();
    rmSync(ledger.file);
    const again = new Ledger(dir);
    await again.open();
    expect(again.blocked).toBeUndefined();
    expect(again.snapshot().turns.map((t) => t.key)).toEqual(["m1|r"]);
  });

  it("loses no change queued while a write is under way", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    const ledger = new Ledger(dir);
    await apply(ledger, FILE, [turn("m1|r", T0)]);
    const writing = ledger.save();
    const quota = ledger.recordQuota("p1", { fiveHour: { utilization: 0.4, resetsAt: T0 } }, "user");
    const more = apply(ledger, { ...FILE, ino: 12, path: "/fake/c.jsonl" }, [turn("m2|r", T0 + 1)]);
    await Promise.all([writing, quota, more]);
    await ledger.save();
    const saved = parseLedger(readFileSync(ledger.file, "utf8"));
    expect(saved.turns.map((t) => t.key)).toEqual(["m1|r", "m2|r"]);
    expect(saved.quota).toHaveLength(1);
  });
});

describe("plan usage readings", () => {
  it("keeps one reading per profile and kind within minutes, and every kind apart", async () => {
    let now = T0;
    const ledger = new Ledger(join(tempDir("ledger-"), "usage"), { now: () => now });
    await ledger.recordQuota("", { fiveHour: { utilization: 0.1, resetsAt: 1 } }, "user");
    now += 60_000;
    await ledger.recordQuota("", { fiveHour: { utilization: 0.2, resetsAt: 1 } }, "user");
    await ledger.recordQuota("", { fiveHour: { utilization: 0.2, resetsAt: 1 } }, "scheduled");
    now += 10 * 60_000;
    await ledger.recordQuota("", { sevenDay: { utilization: 0.3, resetsAt: 1 } }, "scheduled");
    await ledger.recordQuota("", {}, "scheduled");
    expect(ledger.snapshot().quota.map((q) => [q.via, q.fiveHour?.utilization ?? q.sevenDay?.utilization])).toEqual([
      ["user", 0.2],
      ["scheduled", 0.2],
      ["scheduled", 0.3],
    ]);
  });
});

describe("the transcript format check", () => {
  it("flags few replies with token counts, unknown reply content, and context per call moving more than 30%", () => {
    const now = T0 + 10 * 86_400_000;
    const d = emptyLedger(now);
    const day = new Date(now);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    d.shape.days[key] = { records: 100, withUsage: 90, unknownTypes: { hologram: 2 } };
    const add = (ageMs: number, ctx: number) =>
      d.turns.push({ provider: "claude", key: `k${d.turns.length}`, sessionId: "s", subagent: false, at: now - ageMs, model: "m", cwd: "", input: ctx, cacheRead: 0, cacheWrite: 0, output: 0, tools: [] });
    for (let i = 0; i < 30; i++) add(3 * 86_400_000, 100_000);
    for (let i = 0; i < 30; i++) add(3_600_000, 150_000);
    expect(shapeFlags(d, now)).toEqual({ usageRatio: 0.9, lowUsageRatio: true, driftRatio: 1.5, drift: true, unknownTypes: ["hologram"] });
    d.shape.days[key] = { records: 100, withUsage: 99, unknownTypes: {} };
    for (const t of d.turns) if (now - t.at < 86_400_000) t.input = 120_000;
    expect(shapeFlags(d, now)).toMatchObject({ lowUsageRatio: false, drift: false, unknownTypes: [] });
  });
});
