// The usage ledger: a call counted once on the machine, monthly shards of
// which only those changed are written (a copy first, 0600, never over a file
// it cannot read), the split of the single-file ledger of the first version,
// one queue for every change.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageFile, UsageRead, UsageTurn } from "../../src/providers/types.ts";
import {
  DRIFT_MAX,
  LEGACY_FILE,
  Ledger,
  type Turn,
  contextOf,
  emptyIndex,
  localDay,
  localMonth,
  parseIndex,
  parseShard,
  serializeIndex,
  serializeLegacyLedger,
  serializeShard,
  shapeFlags,
} from "../../src/usage/ledger.ts";
import { tempDir } from "../harness.ts";

const FILE: UsageFile = { path: "/fake/a.jsonl", dev: 1, ino: 10, size: 100, mtimeMs: 1 };
const T0 = Date.parse("2026-11-01T08:00:00.000Z");
/** Middle of two months, far from any time zone's month boundary. */
const OCT = new Date(2026, 9, 15, 12).getTime();
const NOV = new Date(2026, 10, 15, 12).getTime();

function turn(key: string, at: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return { key, sessionId: "s-main", subagent: false, at, model: "m", cwd: "/work/a", inputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 10, outputTokens: 5, tools: [], ...extra };
}

function row(key: string, at: number, extra: Partial<Turn> = {}): Turn {
  return { provider: "claude", key, sessionId: "s", subagent: false, at, model: "m", cwd: "/c", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, tools: [], ...extra };
}

const readOf = (turns: UsageTurn[], end = 100): UsageRead => ({ turns, end, stats: { records: turns.length, withUsage: turns.length, parseErrors: 0, overCap: 0, unknownTypes: {} } });

const apply = (ledger: Ledger, file: UsageFile, turns: UsageTurn[], end = 100, repoKey: (cwd: string) => string = () => "repo-key") =>
  ledger.apply("claude", file, readOf(turns, end), repoKey);

const newLedger = (opts?: ConstructorParameters<typeof Ledger>[1]) => new Ledger(join(tempDir("ledger-"), "usage"), opts);

/** Every call written to disk, by month. */
function shardsOnDisk(ledger: Ledger): Record<string, Turn[]> {
  const out: Record<string, Turn[]> = {};
  for (const n of readdirSync(ledger.shardDir)) {
    const m = /^(\d{4}-\d{2})\.json$/.exec(n)?.[1];
    if (m) out[m] = parseShard(readFileSync(ledger.shardFile(m), "utf8"), m);
  }
  return out;
}

describe("counting a call once on the machine", () => {
  it("counts the 50 calls a fork copied once, in the session where they came first", async () => {
    const ledger = newLedger();
    const original = Array.from({ length: 50 }, (_, i) => turn(`msg_${i}|req_${i}`, T0 + i * 1000));
    expect(await apply(ledger, FILE, original)).toBe(50);
    // The fork holds the same calls (as written then) and its own new one.
    const forked = [...original.map((t) => ({ ...t, sessionId: "s-fork" })), turn("msg_new|req_new", T0 + 3_600_000, { sessionId: "s-fork" })];
    expect(await apply(ledger, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, forked)).toBe(1);
    const turns = await ledger.turns();
    expect(turns).toHaveLength(51);
    expect(turns.filter((t) => t.sessionId === "s-main")).toHaveLength(50);
    // Read in the other order, the result is the same.
    const other = newLedger();
    await apply(other, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, forked.map((t) => ({ ...t, at: t.at + 1 })));
    await apply(other, FILE, original);
    expect((await other.turns()).filter((t) => t.sessionId === "s-main")).toHaveLength(50);
  });

  it("finds a copy across a month's end, and moves the call to the month of its earliest copy", async () => {
    const late = new Date(2026, 10, 1, 0, 30).getTime();
    const early = new Date(2026, 9, 31, 23, 30).getTime();
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("k1", late)]);
    await ledger.save();
    await ledger.release();
    // The same call, an hour earlier, in the month before: it belongs there now, once.
    expect(await apply(ledger, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, [turn("k1", early, { sessionId: "s-early" })])).toBe(0);
    await ledger.save();
    const disk = shardsOnDisk(ledger);
    expect(disk[localMonth(early)]?.map((t) => [t.key, t.sessionId])).toEqual([["k1", "s-early"]]);
    expect(disk[localMonth(late)]).toEqual([]);
    // Read again by a later scan from disk: still counted once.
    const again = new Ledger(ledger.dir);
    expect(await apply(again, FILE, [turn("k1", late)])).toBe(0);
    expect(await again.turns()).toHaveLength(1);
    // Mid-month, only the call's own month is read.
    await again.save();
    await again.release();
    await apply(again, FILE, [turn("k2", NOV)]);
    expect(again.loadedMonths).toEqual([localMonth(NOV)]);
  });

  it("takes the largest output tokens, keeps every tool of the reply, and gives a tie to the main session", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [
      turn("msg_1|req_1", T0, { outputTokens: 3, tools: ["Read"], subagent: true, agentId: "a1" }),
      turn("msg_1|req_1", T0, { outputTokens: 90, tools: ["Bash"] }),
      turn("msg_1|req_1", T0 + 5, { outputTokens: 10, tools: ["Read"] }),
    ]);
    const [t] = await ledger.turns();
    expect(t).toMatchObject({ output: 90, subagent: false, tools: ["Read", "Bash"] });
    expect(t?.agentId).toBeUndefined();
  });

  it("keeps the working directory of each call, and the repository of a directory as first told", async () => {
    const ledger = newLedger();
    let asked = 0;
    await apply(ledger, FILE, [turn("m1|r", T0, { cwd: "/work/a" }), turn("m2|r", T0 + 1, { cwd: "/work/b" }), turn("m3|r", T0 + 2, { cwd: "/work/a" })], 100, (cwd) => {
      asked++;
      return `key:${cwd}`;
    });
    expect((await ledger.turns()).map((t) => t.cwd)).toEqual(["/work/a", "/work/b", "/work/a"]);
    expect(asked).toBe(2);
    expect(ledger.snapshot().dirs["/work/b"]?.repo).toBe("key:/work/b");
  });
});

describe("where a file is read from", () => {
  it("continues from the last offset, and starts over for another inode, another path or a shorter file", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [], 80);
    expect(ledger.offsetFor("claude", { ...FILE, size: 120 })).toBe(80);
    expect(ledger.offsetFor("claude", { ...FILE, ino: 99, size: 120 })).toBe(0);
    expect(ledger.offsetFor("claude", { ...FILE, path: "/fake/moved.jsonl", size: 120 })).toBe(0);
    expect(ledger.offsetFor("claude", { ...FILE, size: 40 })).toBe(0);
    expect(ledger.offsetFor("other-ai", { ...FILE, size: 120 })).toBe(0);
  });
});

describe("writing the ledger", () => {
  it("writes each month's shard and the index 0600 through a temp file, a copy of each kept before it is written again", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("m1|r", NOV, { tools: ["Skill:example"] })]);
    await ledger.save();
    const nov = ledger.shardFile(localMonth(NOV));
    for (const f of [nov, ledger.indexFile]) expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(ledger.shardDir).mode & 0o777).toBe(0o700);
    expect(existsSync(ledger.indexPrev)).toBe(false);
    const first = readFileSync(nov, "utf8");
    await apply(ledger, FILE, [turn("m2|r", NOV + 1)], 200);
    await ledger.save();
    const prev = nov.replace(/\.json$/, ".prev.json");
    expect(readFileSync(prev, "utf8")).toBe(first);
    expect(statSync(prev).mode & 0o777).toBe(0o600);
    expect(statSync(ledger.indexPrev).mode & 0o777).toBe(0o600);
    const again = new Ledger(ledger.dir);
    await again.open();
    expect((await again.turns()).map((t) => t.key)).toEqual(["m1|r", "m2|r"]);
    expect(again.snapshot().files["claude:1:10"]?.offset).toBe(200);
    expect(again.offsetFor("claude", { ...FILE, size: 300 })).toBe(200);
  });

  it("rewrites only the shards a change touched", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("o1", OCT), turn("n1", NOV)]);
    await ledger.save();
    await ledger.release();
    const oct = ledger.shardFile(localMonth(OCT));
    const octText = readFileSync(oct, "utf8");
    const octTime = statSync(oct).mtimeMs;
    await apply(ledger, { ...FILE, ino: 11, path: "/fake/b.jsonl" }, [turn("n2", NOV + 60_000)]);
    await ledger.save();
    // The October shard was neither rewritten nor copied; November was.
    expect(readFileSync(oct, "utf8")).toBe(octText);
    expect(statSync(oct).mtimeMs).toBe(octTime);
    expect(existsSync(oct.replace(/\.json$/, ".prev.json"))).toBe(false);
    expect(existsSync(ledger.shardFile(localMonth(NOV)).replace(/\.json$/, ".prev.json"))).toBe(true);
    expect(shardsOnDisk(ledger)[localMonth(NOV)]?.map((t) => t.key)).toEqual(["n1", "n2"]);
  });

  it("lets go of written shards and reads them again when needed", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("o1", OCT), turn("n1", NOV)]);
    expect(ledger.loadedMonths).toEqual([localMonth(OCT), localMonth(NOV)]);
    // Not written yet: nothing is let go.
    await ledger.release();
    expect(ledger.loadedMonths).toHaveLength(2);
    await ledger.save();
    await ledger.release();
    expect(ledger.loadedMonths).toEqual([]);
    expect((await ledger.turns({ from: NOV - 1000 })).map((t) => t.key)).toEqual(["n1"]);
    // A read for a report does not keep the shard.
    expect(ledger.loadedMonths).toEqual([]);
  });

  it("round-trips every field through the shard and index formats", () => {
    const t = row("k", T0, { subagent: true, agentId: "a", tools: ["Bash", "Skill:x"] });
    expect(parseShard(serializeShard("2026-11", [t]), "2026-11")).toEqual([t]);
    const d = emptyIndex(T0);
    d.quota.push({ profile: "", at: T0, via: "scheduled", fiveHour: { utilization: 50, resetsAt: T0 + 1 } });
    d.launched.claude = { s: T0 };
    d.notified.claude = { s: { context: T0 } };
    expect(parseIndex(serializeIndex(d))).toEqual(d);
  });

  it("never writes over an index or a shard of an unknown schema or one it cannot parse, until the ledger is deleted", async () => {
    const cases: [string, string][] = [
      ["index.json", JSON.stringify({ schemaVersion: 99 })],
      ["index.json", "{ not json"],
      [join("ledger", `${localMonth(NOV)}.json`), JSON.stringify({ schemaVersion: 99, month: localMonth(NOV), strings: [], turns: [] })],
      [join("ledger", `${localMonth(NOV)}.json`), "{ broken"],
    ];
    for (const [name, text] of cases) {
      const dir = join(tempDir("ledger-"), "usage");
      const good = new Ledger(dir);
      await apply(good, FILE, [turn("n0", NOV)]);
      await good.save();
      writeFileSync(join(dir, name), text);
      const logs: string[] = [];
      const ledger = new Ledger(dir, { log: (l) => logs.push(l) });
      await ledger.open();
      // A bad shard shows when it is first needed.
      await expect(apply(ledger, FILE, [turn("n1", NOV + 1)])).rejects.toThrow();
      expect(ledger.blocked, name).toBeTruthy();
      await ledger.recordQuota("", { fiveHour: { utilization: 1, resetsAt: 2 } }, "user").catch(() => undefined);
      await expect(ledger.turns()).rejects.toThrow();
      await ledger.save();
      expect(readFileSync(join(dir, name), "utf8")).toBe(text);
      expect(logs.join("\n")).toContain("usage delete");
      await ledger.delete();
      expect(ledger.blocked).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
      await apply(ledger, FILE, [turn("m|r", NOV)]);
      await ledger.save();
      expect(shardsOnDisk(ledger)[localMonth(NOV)]).toHaveLength(1);
    }
  });

  it("takes the copy when the index or a shard itself is missing", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("m1|r", NOV)]);
    await ledger.save();
    await apply(ledger, FILE, [turn("m2|r", NOV + 1)], 200);
    await ledger.save();
    rmSync(ledger.indexFile);
    rmSync(ledger.shardFile(localMonth(NOV)));
    const again = new Ledger(ledger.dir);
    await again.open();
    expect(again.blocked).toBeUndefined();
    expect(again.snapshot().files["claude:1:10"]?.offset).toBe(100);
    expect((await again.turns()).map((t) => t.key)).toEqual(["m1|r"]);
    // Reading on from the copy's offset counts nothing twice.
    expect(await apply(again, FILE, [turn("m2|r", NOV + 1)], 200)).toBe(1);
    await again.save();
    expect(existsSync(again.indexFile)).toBe(true);
    expect(shardsOnDisk(again)[localMonth(NOV)]?.map((t) => t.key)).toEqual(["m1|r", "m2|r"]);
  });

  it("loses no change queued while a write is under way", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("m1|r", T0)]);
    const writing = ledger.save();
    const quota = ledger.recordQuota("p1", { fiveHour: { utilization: 40, resetsAt: T0 } }, "user");
    const more = apply(ledger, { ...FILE, ino: 12, path: "/fake/c.jsonl" }, [turn("m2|r", T0 + 1)]);
    await Promise.all([writing, quota, more]);
    await ledger.save();
    expect(shardsOnDisk(ledger)[localMonth(T0)]?.map((t) => t.key)).toEqual(["m1|r", "m2|r"]);
    expect(parseIndex(readFileSync(ledger.indexFile, "utf8")).quota).toHaveLength(1);
  });

  it("deletes every shard, copy and index", async () => {
    const ledger = newLedger();
    await apply(ledger, FILE, [turn("o1", OCT), turn("n1", NOV)]);
    await ledger.save();
    await apply(ledger, FILE, [turn("n2", NOV + 1)], 200);
    await ledger.save();
    expect(readdirSync(ledger.shardDir).length).toBeGreaterThan(2);
    await ledger.delete();
    expect(readdirSync(ledger.dir)).toEqual([]);
    expect(await ledger.turns()).toEqual([]);
  });
});

describe("splitting the single-file ledger", () => {
  function legacy(dir: string, turns: Turn[], version?: number): string {
    const index = emptyIndex(T0);
    index.lastScanAt = T0;
    index.files["claude:1:10"] = { path: "/fake/a.jsonl", dev: 1, ino: 10, size: 100, mtimeMs: 1, offset: 90 };
    index.dirs["/c"] = { repo: "example.com/team/app", at: T0 };
    index.launched.claude = { s: T0 };
    index.quota.push({ profile: "", at: T0, via: "user", sevenDay: { utilization: 12, resetsAt: T0 } });
    let text = serializeLegacyLedger(index, turns);
    if (version !== undefined) text = text.replace('"schemaVersion":1', `"schemaVersion":${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LEGACY_FILE), text);
    writeFileSync(join(dir, "ledger.prev.json"), text);
    return text;
  }

  const sample = () => [row("o1", OCT), row("o2", OCT + 1, { subagent: true, agentId: "a" }), row("n1", NOV, { tools: ["Read"] })];

  it("moves every call into its month's shard and the rest into the index, then removes the old file", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    legacy(dir, sample());
    const logs: string[] = [];
    const ledger = new Ledger(dir, { log: (l) => logs.push(l) });
    await ledger.open();
    expect(ledger.blocked).toBeUndefined();
    const disk = shardsOnDisk(ledger);
    expect(Object.keys(disk).sort()).toEqual([localMonth(OCT), localMonth(NOV)]);
    expect(disk[localMonth(OCT)]).toEqual(sample().slice(0, 2));
    expect(disk[localMonth(NOV)]).toEqual(sample().slice(2));
    const index = parseIndex(readFileSync(ledger.indexFile, "utf8"));
    expect(index).toMatchObject({ lastScanAt: T0, dirs: { "/c": { repo: "example.com/team/app" } }, launched: { claude: { s: T0 } }, notified: {} });
    expect(index.quota).toHaveLength(1);
    expect(index.files["claude:1:10"]?.offset).toBe(90);
    expect(existsSync(join(dir, LEGACY_FILE))).toBe(false);
    expect(existsSync(join(dir, "ledger.prev.json"))).toBe(false);
    expect(existsSync(join(dir, "ledger.migrating"))).toBe(false);
    expect(logs.join("\n")).toContain("split into 2 monthly files (3 calls)");
    // Scanning on from the offsets kept.
    expect(ledger.offsetFor("claude", { ...FILE, size: 150 })).toBe(90);
  });

  it("starts over a split that stopped halfway, leaving nothing of it", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    legacy(dir, sample());
    // What a split killed before its index was written leaves behind.
    mkdirSync(join(dir, "ledger.migrating"), { recursive: true });
    writeFileSync(join(dir, "ledger.migrating", "2026-01.json"), "partial");
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(join(dir, "ledger", "2026-02.json"), serializeShard("2026-02", [row("stale", new Date(2026, 1, 10).getTime())]));
    const ledger = new Ledger(dir);
    await ledger.open();
    expect(Object.keys(shardsOnDisk(ledger)).sort()).toEqual([localMonth(OCT), localMonth(NOV)]);
    expect((await ledger.turns()).map((t) => t.key)).toEqual(["o1", "o2", "n1"]);
  });

  it("removes the old file left by a split that wrote its index", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    legacy(dir, sample());
    const first = new Ledger(dir);
    await first.open();
    // As if the agent stopped right after the index was written.
    legacy(dir, [row("ghost", NOV)]);
    const again = new Ledger(dir);
    await again.open();
    expect(existsSync(join(dir, LEGACY_FILE))).toBe(false);
    expect((await again.turns()).map((t) => t.key)).toEqual(["o1", "o2", "n1"]);
  });

  it("keeps an old file it cannot read as it is, and writes nothing", async () => {
    for (const [text, version] of [[undefined, 7], ["{ nope", undefined]] as const) {
      const dir = join(tempDir("ledger-"), "usage");
      const kept = text ?? legacy(dir, sample(), version);
      if (text) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, LEGACY_FILE), text);
      }
      const ledger = new Ledger(dir);
      await ledger.open();
      expect(ledger.blocked).toBeTruthy();
      await ledger.recordQuota("", { fiveHour: { utilization: 1, resetsAt: 2 } }, "user").catch(() => undefined);
      await ledger.save();
      expect(readFileSync(join(dir, LEGACY_FILE), "utf8")).toBe(kept);
      expect(existsSync(ledger.indexFile)).toBe(false);
      expect(existsSync(ledger.shardDir)).toBe(false);
    }
  });

  it("keeps every token of a large ledger", async () => {
    const dir = join(tempDir("ledger-"), "usage");
    const many = Array.from({ length: 5000 }, (_, i) =>
      row(`k${i}`, OCT + i * 15 * 60_000, { input: i, cacheRead: 1000 + i, cacheWrite: 7, output: i % 13, sessionId: `s${i % 40}`, tools: i % 2 ? ["Read"] : [] }),
    );
    legacy(dir, many);
    const ledger = new Ledger(dir);
    await ledger.open();
    const back = await ledger.turns();
    const total = (ts: readonly Turn[]) => ts.reduce((s, t) => s + contextOf(t) + t.output, 0);
    expect(back).toHaveLength(5000);
    expect(total(back)).toBe(total(many));
    expect(Object.keys(shardsOnDisk(ledger)).length).toBeGreaterThan(1);
  });
});

describe("plan usage readings", () => {
  it("keeps one reading per profile and kind within minutes, and every kind apart", async () => {
    let now = T0;
    const ledger = newLedger({ now: () => now });
    await ledger.recordQuota("", { fiveHour: { utilization: 10, resetsAt: 1 } }, "user");
    now += 60_000;
    await ledger.recordQuota("", { fiveHour: { utilization: 20, resetsAt: 1 } }, "user");
    await ledger.recordQuota("", { fiveHour: { utilization: 20, resetsAt: 1 } }, "scheduled");
    now += 10 * 60_000;
    await ledger.recordQuota("", { sevenDay: { utilization: 30, resetsAt: 1 } }, "scheduled");
    await ledger.recordQuota("", {}, "scheduled");
    expect(ledger.snapshot().quota.map((q) => [q.via, q.fiveHour?.utilization ?? q.sevenDay?.utilization])).toEqual([
      ["user", 20],
      ["scheduled", 20],
      ["scheduled", 30],
    ]);
  });
});

describe("the transcript format check", () => {
  const now = T0 + 20 * 86_400_000;
  const day = 86_400_000;
  const main = (ageMs: number, ctx: number, i: number) => row(`k${i}`, now - ageMs, { input: ctx, cacheRead: 0, cacheWrite: 0 });

  it("flags few replies with token counts and unknown reply content", () => {
    const d = emptyIndex(now);
    d.shape.days[localDay(now)] = { records: 100, withUsage: 90, unknownTypes: { hologram: 2 } };
    expect(shapeFlags(d, [], now)).toEqual({ usageRatio: 0.9, lowUsageRatio: true, driftRatio: 1, drift: false, unknownTypes: ["hologram"] });
    d.shape.days[localDay(now)] = { records: 100, withUsage: 99, unknownTypes: {} };
    expect(shapeFlags(d, [], now)).toMatchObject({ lowUsageRatio: false, unknownTypes: [] });
  });

  it("compares the median context per call of the last 7 days with the 7 days before, and flags a move over 40%", () => {
    const d = emptyIndex(now);
    const prior = Array.from({ length: 30 }, (_, i) => main(10 * day, 100_000, i));
    const at = (ctx: number) => [...prior, ...Array.from({ length: 30 }, (_, i) => main(2 * day, ctx, 100 + i))];
    expect(shapeFlags(d, at(141_000), now)).toMatchObject({ driftRatio: 1.41, drift: true });
    expect(shapeFlags(d, at(140_000), now)).toMatchObject({ driftRatio: 1.4, drift: false });
    expect(shapeFlags(d, at(59_000), now)).toMatchObject({ drift: true });
    expect(DRIFT_MAX).toBe(0.4);
    // One heavy day inside a steady week moves the median little: no flag (the last-24-hours check tripped on such a day).
    const steady = [...prior, ...Array.from({ length: 60 }, (_, i) => main((1 + (i % 6)) * day + 1000, 120_000, 200 + i)), ...Array.from({ length: 20 }, (_, i) => main(3_600_000, 400_000, 300 + i))];
    expect(shapeFlags(d, steady, now)).toMatchObject({ driftRatio: 1.2, drift: false });
    // Too few calls on either side: no ratio.
    expect(shapeFlags(d, prior, now)).toMatchObject({ driftRatio: 1, drift: false });
    // Subagent calls do not count.
    expect(shapeFlags(d, at(500_000).map((t) => (t.at > now - 7 * day ? { ...t, subagent: true } : t)), now)).toMatchObject({ driftRatio: 1 });
  });
});
