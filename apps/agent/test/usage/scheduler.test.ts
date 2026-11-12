// Scans of a made-up Claude folder into the ledger: incremental reads,
// replaced files, checkpoints that survive a kill, deletion, plan usage, the
// sessions the app opened, and nothing of the messages in the ledger file.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeUsage } from "../../src/providers/claude/usage-scan.ts";
import type { UsageFile, UsageRead, UsageSource } from "../../src/providers/types.ts";
import { type Turn, localMonth, parseIndex, parseShard } from "../../src/usage/ledger.ts";
import { UsageScheduler } from "../../src/usage/scheduler.ts";
import { tempDir } from "../harness.ts";
import { MARKER, appendLines, mainFile, minute, replyRecord, subagentFile, userRecord, writeLines } from "./usage-fixture.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
/** The month of the fixture's calls, in this machine's time zone. */
const MONTH = localMonth(Date.parse(minute(0)));

function setup(extra: Partial<ConstructorParameters<typeof UsageScheduler>[0]> = {}) {
  const root = tempDir("usage-sched-");
  const home = join(root, "claude");
  const configDir = join(root, "config");
  mkdirSync(join(home, "projects"), { recursive: true });
  const source = new ClaudeUsage({ homes: () => [home] });
  const make = (more: Partial<ConstructorParameters<typeof UsageScheduler>[0]> = {}) =>
    new UsageScheduler({ configDir, sources: () => [{ provider: "claude", usage: source }], repoKey: () => "example-key", ...extra, ...more });
  return { root, home, configDir, source, make };
}

/** What the ledger in `configDir` holds on disk: its index and every call. */
function onDisk(configDir: string) {
  const dir = join(configDir, "usage");
  const turns: Turn[] = [];
  for (const n of readdirSync(join(dir, "ledger"))) {
    const m = /^(\d{4}-\d{2})\.json$/.exec(n)?.[1];
    if (m) turns.push(...parseShard(readFileSync(join(dir, "ledger", n), "utf8"), m));
  }
  return { index: parseIndex(readFileSync(join(dir, "index.json"), "utf8")), turns };
}

/** Every file of the ledger in `configDir` (relative). */
function ledgerFiles(configDir: string): string[] {
  const dir = join(configDir, "usage");
  try {
    return readdirSync(dir, { recursive: true })
      .map((f) => String(f).replaceAll("\\", "/"))
      .sort();
  } catch {
    return [];
  }
}

const reply = (sessionId: string, n: number, extra: Partial<Parameters<typeof replyRecord>[0]> = {}) =>
  replyRecord({ sessionId, msgId: `msg_${n}`, requestId: `req_${n}`, at: minute(n), ...extra });

describe("scanning transcripts", () => {
  it("reads only what was appended, and a subagent's calls go to its parent session", async () => {
    const { home, make } = setup();
    const main = mainFile(home, "-work-example", S1);
    writeLines(main, [userRecord(S1, minute(0)), reply(S1, 1), reply(S1, 2)]);
    writeLines(subagentFile(home, "-work-example", S1, "a1"), [reply(S1, 3, { agentId: "a1" })]);
    const s = make();
    expect(await s.run()).toMatchObject({ files: 2, read: 2, added: 3 });
    const turns = await s.ledger.turns();
    expect(turns.filter((t) => t.subagent).map((t) => [t.sessionId, t.agentId])).toEqual([[S1, "a1"]]);
    expect(await s.run()).toMatchObject({ files: 2, read: 0, added: 0 });
    appendLines(main, [reply(S1, 4)]);
    expect(await s.run()).toMatchObject({ read: 1, added: 1 });
    expect((await s.ledger.turns())).toHaveLength(4);
  });

  it("reads a file replaced at the same path from the start, counting nothing twice", async () => {
    const { home, make } = setup();
    const main = mainFile(home, "-work-example", S1);
    writeLines(main, [reply(S1, 1), reply(S1, 2)]);
    const s = make();
    await s.run();
    const ino = statSync(main).ino;
    writeLines(`${main}.new`, [reply(S1, 1), reply(S1, 2), reply(S1, 5)]);
    renameSync(`${main}.new`, main);
    expect(statSync(main).ino).not.toBe(ino);
    expect(await s.run()).toMatchObject({ read: 1, added: 1 });
    expect((await s.ledger.turns())).toHaveLength(3);
    expect(Object.keys(s.ledger.snapshot().files)).toHaveLength(1);
  });

  it("keeps the calls of a deleted transcript", async () => {
    const { home, make } = setup();
    const main = mainFile(home, "-work-example", S1);
    writeLines(main, [reply(S1, 1)]);
    const s = make();
    await s.run();
    rmSync(main);
    await s.run();
    expect((await s.ledger.turns())).toHaveLength(1);
    expect(s.ledger.snapshot().files).toEqual({});
  });

  it("runs one scan at a time", async () => {
    const { home, make } = setup();
    writeLines(mainFile(home, "-work-example", S1), [reply(S1, 1)]);
    const s = make();
    const a = s.run();
    const b = s.run();
    expect(a).toBe(b);
    await a;
  });

  it("writes every 50 files, so a scan killed halfway is taken up where the last write left it", async () => {
    const { home, configDir, source, make } = setup();
    for (let i = 0; i < 120; i++) {
      const sid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      writeLines(mainFile(home, "-work-example", sid), [replyRecord({ sessionId: sid, msgId: `msg_${i}`, requestId: `req_${i}`, at: minute(i) })]);
    }
    // The process dies during the 75th read: that read never ends and nothing else is written.
    let reads = 0;
    const dying: UsageSource = {
      files: () => source.files(),
      read: (file: UsageFile, from: number): Promise<UsageRead> => (++reads >= 75 ? new Promise<UsageRead>(() => undefined) : source.read(file, from)),
    };
    const first = new UsageScheduler({ configDir, sources: () => [{ provider: "claude", usage: dying }], repoKey: () => "k" });
    void first.run();
    await until(() => reads >= 75);
    const kept = onDisk(configDir);
    expect(kept.turns).toHaveLength(50);
    expect(Object.keys(kept.index.files)).toHaveLength(50);
    const second = make();
    expect(await second.run()).toMatchObject({ read: 70, added: 70 });
    expect((await second.ledger.turns())).toHaveLength(120);
  });

  it("loses no plan usage recorded while a scan runs", async () => {
    const { home, make } = setup();
    for (let i = 0; i < 5; i++) writeLines(mainFile(home, "-work-example", `00000000-0000-4000-8000-00000000000${i}`), [reply(S1, i)]);
    const s = make({ checkpointFiles: 2 });
    const scan = s.run();
    s.recordQuota("p1", { fiveHour: { utilization: 0.5, resetsAt: 1 } });
    await scan;
    await s.stop();
    const saved = onDisk(s.ledger.dir.replace(/[\\/]usage$/, ""));
    expect(saved.index.quota).toEqual([expect.objectContaining({ profile: "p1", via: "user" })]);
    expect(saved.turns).toHaveLength(5);
  });

  it("reads plan usage every 30 minutes when the scans found new calls, marked as scheduled", async () => {
    const { home, make } = setup();
    let now = Date.parse("2026-11-01T09:00:00.000Z");
    let refreshes = 0;
    const s = make({
      now: () => now,
      refreshQuota: async () => {
        refreshes++;
        s.recordQuota("", { fiveHour: { utilization: 0.3, resetsAt: 1 } });
      },
    });
    const main = mainFile(home, "-work-example", S1);
    writeLines(main, [reply(S1, 1)]);
    await s.run();
    expect(refreshes).toBe(1);
    appendLines(main, [reply(S1, 2)]);
    now += 15 * 60_000;
    await s.run();
    expect(refreshes).toBe(1);
    now += 15 * 60_000;
    await s.run();
    expect(refreshes).toBe(2);
    now += 30 * 60_000;
    await s.run();
    // No new calls since: no reading.
    expect(refreshes).toBe(2);
    await s.stop();
    expect(s.ledger.snapshot().quota.map((q) => q.via)).toEqual(["scheduled", "scheduled"]);
  });

  it("deletes the ledger, its shards and their copies, stopping a scan under way", async () => {
    const { home, configDir, make } = setup();
    for (let i = 0; i < 6; i++) writeLines(mainFile(home, "-work-example", `00000000-0000-4000-8000-00000000000${i}`), [reply(S1, i)]);
    const s = make({ checkpointFiles: 1 });
    await s.run();
    appendLines(mainFile(home, "-work-example", "00000000-0000-4000-8000-000000000000"), [reply(S1, 9)]);
    await s.run();
    expect(ledgerFiles(configDir)).toEqual(["index.json", "index.prev.json", "ledger", `ledger/${MONTH}.json`, `ledger/${MONTH}.prev.json`]);
    for (let i = 0; i < 6; i++) appendLines(mainFile(home, "-work-example", `00000000-0000-4000-8000-00000000000${i}`), [reply(S1, 20 + i)]);
    const scan = s.run();
    await s.deleteLedger();
    expect((await scan)?.stopped).toBe(true);
    expect(await s.ledger.turns()).toHaveLength(0);
    await s.stop();
    // The stopped scan wrote nothing back.
    expect(ledgerFiles(configDir)).toEqual([]);
    // The next scan starts from the transcripts on disk.
    const next = make();
    expect(await next.run()).toMatchObject({ added: 13 });
    appendLines(mainFile(home, "-work-example", "00000000-0000-4000-8000-000000000001"), [reply(S1, 40)]);
    await next.run();
    await next.stop();
    expect(ledgerFiles(configDir)).toContain(`ledger/${MONTH}.prev.json`);
    // Deleting again takes the copies the last scan kept too.
    await make().deleteLedger();
    expect(ledgerFiles(configDir)).toEqual([]);
  });

  it("runs afterScan after each finished scan while its shards are in memory, then lets them go", async () => {
    const { home, make } = setup();
    const main = mainFile(home, "-work-example", S1);
    writeLines(main, [reply(S1, 1)]);
    const seen: { read: number; loaded: string[] }[] = [];
    const s = make({
      afterScan: async (summary) => {
        seen.push({ read: summary.read, loaded: s.ledger.loadedMonths });
      },
    });
    await s.run();
    await s.run();
    expect(seen).toEqual([
      { read: 1, loaded: [MONTH] },
      { read: 0, loaded: [] },
    ]);
    expect(s.ledger.loadedMonths).toEqual([]);
    // A scan that read nothing keeps the last format check and does not read the shards for it.
    expect(s.ledger.snapshot().lastScanAt).toBeGreaterThan(0);
    await s.stop();
  });

  it("records the sessions the app opened, once", async () => {
    const { make } = setup();
    const s = make();
    expect(s.launched.add("claude", S1)).toBe(true);
    expect(s.launched.add("claude", S1)).toBe(true);
    expect(s.launched.add("claude", "bad\nid")).toBe(false);
    await s.stop();
    const saved = parseIndex(readFileSync(s.ledger.indexFile, "utf8"));
    expect(Object.keys(saved.launched.claude ?? {})).toEqual([S1]);
    expect(s.launched.has("claude", S1)).toBe(true);
    expect(s.launched.has("claude", S2)).toBe(false);
  });

  it("keeps no message, tool input or tool result in the ledger file", async () => {
    const { home, configDir, make } = setup();
    writeLines(mainFile(home, "-work-example", S1), [userRecord(S1, minute(0)), reply(S1, 1, { tools: [{ name: "Skill", skill: "example-skill" }, { name: "Bash" }] })]);
    writeLines(subagentFile(home, "-work-example", S1, "a1"), [reply(S1, 2, { agentId: "a1", tools: [{ name: "Read" }] })]);
    const s = make();
    await s.run();
    await s.stop();
    const text = ledgerFiles(configDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(join(configDir, "usage", f), "utf8"))
      .join("\n");
    expect(text).not.toContain(MARKER);
    expect(text).toContain("Skill:example-skill");
    expect(statSync(join(configDir, "usage")).mode & 0o777).toBe(0o700);
  });

  it("does not scan into a ledger it must not write over", async () => {
    const { home, configDir, make } = setup();
    writeLines(mainFile(home, "-work-example", S1), [reply(S1, 1)]);
    mkdirSync(join(configDir, "usage"), { recursive: true });
    writeFileSync(join(configDir, "usage", "index.json"), JSON.stringify({ schemaVersion: 3 }));
    const logs: string[] = [];
    const s = make({ log: (l) => logs.push(l) });
    expect(await s.run()).toBeUndefined();
    await s.stop();
    expect(readFileSync(join(configDir, "usage", "index.json"), "utf8")).toBe(JSON.stringify({ schemaVersion: 3 }));
    expect(ledgerFiles(configDir)).toEqual(["index.json"]);
    expect(logs.some((l) => l.includes("schemaVersion 3"))).toBe(true);
  });
});

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
