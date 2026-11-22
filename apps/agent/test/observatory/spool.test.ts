// The hook spool: hook processes appending at once never break a line; a
// full spool drops and counts; the agent reads only settled minutes (over,
// plus the grace for a late hook), deletes what it read, and after a restart
// goes on where it stopped instead of reading lines again.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FilteredRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";
import { SPOOL_DIR, SPOOL_GRACE_MS, spoolFilePath } from "../../src/observatory/spool/spool-files.ts";
import { SpoolReader } from "../../src/observatory/spool/spool-reader.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const MINUTE = 60_000;
const T = 29_400_000 * MINUTE; // a minute boundary
const line = (id: string, pad = 10): string => JSON.stringify({ v: 1, src: "hook", event: "Stop", at: T, f: { session_id: id }, c: { last_assistant_message: "p".repeat(pad) } });

type ReaderExtra = { budgetBytes?: number; quarantineMaxBytes?: number; accept?: (rec: FilteredRecord) => Promise<void>; commit?: () => Promise<void> };

function reader(dataDir: string, now: () => number, extra: ReaderExtra = {}): { reader: SpoolReader; seen: string[]; problems: string[] } {
  const seen: string[] = [];
  const problems: string[] = [];
  const r = new SpoolReader({
    dataDir,
    now,
    accept: async (rec: FilteredRecord) => {
      seen.push(String(rec.f.session_id));
    },
    commit: async () => undefined,
    problems: (place) => problems.push(place),
    ...extra,
  });
  return { reader: r, seen, problems };
}

function runChild(dataDir: string, count: number, tag: string, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(import.meta.dirname, "spool-writer-child.ts"), dataDir, String(count), tag, String(T + 1_000), String(size)], { stdio: ["ignore", "ignore", "inherit"] });
    p.once("error", reject);
    p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}`))));
  });
}

describe("hook processes writing the spool", () => {
  it("never breaks a line when four processes append to the same minute at once", async () => {
    const dir = obsTempDir("spool");
    await Promise.all(["a", "b", "c", "d"].map((tag) => runChild(dir, 150, tag, 3_000)));
    const text = readFileSync(spoolFilePath(dir, "events", Math.floor((T + 1_000) / MINUTE)), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(600);
    const ids = lines.map((l) => (JSON.parse(l) as { f: { session_id: string } }).f.session_id);
    expect(new Set(ids).size).toBe(600);
  }, 60_000);

  it("drops lines past the cap and counts them, and the reader adds the count up", async () => {
    const dir = obsTempDir("spool");
    const limits = { maxBytes: 1_000, maxFiles: 10, maxLineBytes: 10_000 };
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(await appendSpoolLine(dir, line(`s${i}`, 150), T, limits));
    const written = outcomes.filter((o) => o === "written").length;
    expect(written).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === "dropped")).toHaveLength(10 - written);
    expect(await appendSpoolLine(dir, "x".repeat(20_000), T, limits)).toBe("dropped");
    // Dropped counts are kept per hour: read once the hour is over.
    const { reader: r, seen } = reader(dir, () => T + 60 * MINUTE + SPOOL_GRACE_MS);
    await r.drainOnce();
    expect(seen).toHaveLength(written);
    expect(r.stats.dropped).toBe(11 - written);
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([]);
  });
});

describe("the spool's file cap", () => {
  it("counts drops of a whole hour in one file, and counts that file against the cap", async () => {
    const dir = obsTempDir("spool");
    const limits = { maxBytes: 10_000_000, maxFiles: 3, maxLineBytes: 10_000 };
    for (let m = 0; m < 3; m++) expect(await appendSpoolLine(dir, line(`m${m}`), T + m * MINUTE, limits)).toBe("written");
    // Full by file count: drops of many minutes of the hour go into one file.
    for (let m = 3; m < 40; m++) expect(await appendSpoolLine(dir, line(`m${m}`), T + m * MINUTE, limits)).toBe("dropped");
    const names = readdirSync(join(dir, SPOOL_DIR));
    expect(names.filter((n) => n.startsWith("dropped-"))).toEqual([`dropped-${T / MINUTE}.log`]);
    expect(names).toHaveLength(4);
  });
});

describe("the agent reading the spool", () => {
  it("leaves the current minute and the minute just over alone until the grace has passed, then reads and deletes", async () => {
    const dir = obsTempDir("spool");
    await appendSpoolLine(dir, line("old"), T - MINUTE);
    await appendSpoolLine(dir, line("just-over"), T);
    await appendSpoolLine(dir, line("current"), T + MINUTE);
    let now = T + MINUTE + SPOOL_GRACE_MS - 1;
    const { reader: r, seen } = reader(dir, () => now);
    await r.drainOnce();
    expect(seen).toEqual(["old"]);
    expect(existsSync(spoolFilePath(dir, "events", T / MINUTE - 1))).toBe(false);
    expect(existsSync(spoolFilePath(dir, "events", T / MINUTE))).toBe(true);
    now += 1;
    await r.drainOnce();
    expect(seen).toEqual(["old", "just-over"]);
    expect(existsSync(spoolFilePath(dir, "events", T / MINUTE + 1))).toBe(true);
    expect(r.stats.pendingBytes).toBeGreaterThan(0);
  });

  it("goes on where it stopped after a restart: every line passed on once", async () => {
    const dir = obsTempDir("spool");
    for (let i = 0; i < 400; i++) await appendSpoolLine(dir, line(`s${i}`, 1_000), T);
    const now = (): number => T + MINUTE + SPOOL_GRACE_MS;
    // A budget smaller than the file: the first agent stops partway, as if stopped.
    const first = reader(dir, now, { budgetBytes: 100_000 });
    await first.reader.drainOnce();
    await first.reader.stop();
    expect(first.seen.length).toBeGreaterThan(0);
    expect(first.seen.length).toBeLessThan(400);
    const second = reader(dir, now);
    await second.reader.drainOnce();
    const all = [...first.seen, ...second.seen];
    expect(all).toHaveLength(400);
    expect(new Set(all).size).toBe(400);
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([]);
  });

  it("keeps a file whole while the ingest refuses records or the store cannot commit them", async () => {
    const dir = obsTempDir("spool");
    for (let i = 0; i < 5; i++) await appendSpoolLine(dir, line(`s${i}`), T);
    const file = spoolFilePath(dir, "events", T / MINUTE);
    const before = readFileSync(file, "utf8");
    const now = (): number => T + MINUTE + SPOOL_GRACE_MS;
    const refused = reader(dir, now, { accept: () => Promise.reject(new Error("ingest refused")) });
    await refused.reader.drainOnce();
    expect(refused.problems).toEqual(["spool-read"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    const notStored = reader(dir, now, { commit: () => Promise.reject(new Error("store busy")) });
    await notStored.reader.drainOnce();
    expect(notStored.reader.stats.loaded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    // The position did not move: the refusal kept the file's start and counted one try per refused record.
    expect(JSON.parse(readFileSync(join(dir, SPOOL_DIR, "cursor.json"), "utf8"))).toMatchObject({ offset: 0 });
    const ok = reader(dir, now);
    await ok.reader.drainOnce();
    expect(ok.seen).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(existsSync(file)).toBe(false);
  });

  it("sets aside a record the ingest keeps refusing, after three runs, and goes on with the files after it", async () => {
    const dir = obsTempDir("spool");
    await appendSpoolLine(dir, line("poison"), T);
    await appendSpoolLine(dir, line("good-1"), T);
    await appendSpoolLine(dir, line("good-2"), T + MINUTE);
    await appendSpoolLine(dir, line("good-3"), T + 2 * MINUTE);
    const now = (): number => T + 3 * MINUTE + SPOOL_GRACE_MS;
    const stored: string[] = [];
    const accept = async (rec: FilteredRecord): Promise<void> => {
      if (rec.f.session_id === "poison") throw new Error("the ingest cannot take it");
      stored.push(String(rec.f.session_id));
    };
    for (let run = 1; run <= 3; run++) {
      // A new reader each run, as after a restart: the tries are kept in cursor.json.
      const r = reader(dir, now, { accept });
      await r.reader.drainOnce();
      if (run < 3) expect(r.problems, `run ${run}`).toEqual(["spool-read"]);
      else expect(r.reader.stats).toMatchObject({ rejected: 1, quarantined: 1, quarantineDropped: 0 });
    }
    expect([...new Set(stored)].sort()).toEqual(["good-1", "good-2", "good-3"]);
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual(["quarantine.jsonl"]);
    const quarantined = readFileSync(join(dir, SPOOL_DIR, "quarantine.jsonl"), "utf8").trim().split("\n");
    expect(quarantined.map((l) => (JSON.parse(l) as { f: { session_id: string } }).f.session_id)).toEqual(["poison"]);
  });

  it("drops and counts a refused record once the quarantine file is at its cap, so the spool never fills up", async () => {
    const dir = obsTempDir("spool");
    for (let i = 0; i < 3; i++) await appendSpoolLine(dir, line(`poison-${i}`, 300), T);
    const now = (): number => T + MINUTE + SPOOL_GRACE_MS;
    let last: SpoolReader | undefined;
    for (let run = 0; run < 3; run++) {
      const r = reader(dir, now, { accept: () => Promise.reject(new Error("refused")), quarantineMaxBytes: 500 });
      await r.reader.drainOnce();
      last = r.reader;
    }
    expect(last?.stats).toMatchObject({ quarantined: 1, quarantineDropped: 2 });
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual(["quarantine.jsonl"]);
  });

  it("skips lines that are not records and a line a hook never finished", async () => {
    const dir = obsTempDir("spool");
    mkdirSync(join(dir, SPOOL_DIR), { recursive: true });
    writeFileSync(spoolFilePath(dir, "events", T / MINUTE), `${line("ok")}\nnot json\n{"v":2}\n${line("ok2")}\n{"v":1,"src":"hook","ev`);
    const { reader: r, seen, problems } = reader(dir, () => T + MINUTE + SPOOL_GRACE_MS);
    await r.drainOnce();
    expect(seen).toEqual(["ok", "ok2"]);
    expect(r.stats.malformed).toBe(2);
    expect(problems).toEqual([]);
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([]);
  });
});
