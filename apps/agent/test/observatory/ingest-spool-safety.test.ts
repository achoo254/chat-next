// What must hold before the ingest reads the spool: a record set aside in
// spool/quarantine.jsonl is as private as the store (the machine's secrets
// hidden, content cut to its stored size), kept seven days, deleted on a
// wipe; a commit failing right after a record was set aside never sets it
// aside twice; and the service's stop never hangs on an `accept` that never
// settles.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { FilteredRecord, ObservatorySink } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { clearSpool } from "../../src/observatory/spool/clear-spool.ts";
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";
import { SPOOL_DIR, SPOOL_GRACE_MS, SPOOL_QUARANTINE_FILE } from "../../src/observatory/spool/spool-files.ts";
import { QUARANTINE_KEEP_MS, SPOOL_QUARANTINE_TEMP_FILE } from "../../src/observatory/spool/spool-quarantine.ts";
import { SpoolReader } from "../../src/observatory/spool/spool-reader.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const MINUTE = 60_000;
const T = 29_400_000 * MINUTE;
const MACHINE_SECRET = "example-machine-secret-value";
const never = (): Promise<void> => new Promise<void>(() => undefined);

async function service(dir: string, ingest: () => ObservatorySink, opts: { now?: () => number; stopWaitMs?: number; log?: string[] } = {}): Promise<{ s: ObservatoryService; data: string }> {
  const config = new ConfigStore(join(dir, "config"));
  const port = await pickFreePort();
  config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_394 }));
  config.update((c) => (c.machineSecret = MACHINE_SECRET));
  const data = join(dir, "data");
  const s = new ObservatoryService({
    config,
    dataDir: data,
    log: (line) => opts.log?.push(line),
    knownSecrets: () => [config.get().machineSecret ?? ""],
    ingest,
    tokenTimings: { tokenRetryMs: [] },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.stopWaitMs !== undefined ? { stopWaitMs: opts.stopWaitMs } : {}),
  });
  await s.start();
  stops.push(() => s.stop());
  return { s, data };
}

/**
 * A Stop record as the hook process spools it: content redacted by pattern
 * only (the hook process never knows the machine's secrets), the window cut
 * and flagged for the agent's final cut. Written out literally: in this test
 * process the running service has already taught redact() the secret.
 */
function spooledStop(session: string, message: string, at: number): string {
  const long = message.length > 2_048;
  return JSON.stringify({ v: 1, src: "hook", event: "Stop", at, f: { session_id: session, cwd: "~/work/example-app" }, c: { last_assistant_message: message }, ...(long ? { truncated: { last_assistant_message: true } } : {}) });
}

const quarantineLines = (data: string): Record<string, unknown>[] =>
  readFileSync(join(data, SPOOL_DIR, SPOOL_QUARANTINE_FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the quarantine file", () => {
  it("holds the record after the second pass: no machine secret, content cut to its stored size, with the time it was set aside", async () => {
    const dir = obsTempDir("ingest-quarantine");
    const now = T + MINUTE + SPOOL_GRACE_MS;
    const { s, data } = await service(dir, () => ({ accept: () => Promise.reject(new Error("the store is not ready")) }), { now: () => now });
    // Inside the hook's window (about 7.7 KB): the secret near the start and near the 2 KB mark.
    const message = `${MACHINE_SECRET} near the start, then ${"y".repeat(2_030)}${MACHINE_SECRET} at the cut, ${"z".repeat(5_000)}`;
    const line = spooledStop("sess-q", message, T);
    expect(line).toContain(MACHINE_SECRET);
    expect(await appendSpoolLine(data, line, T)).toBe("written");
    for (let run = 0; run < 3; run++) await s.drainSpool();
    expect(s.status().spool).toMatchObject({ rejected: 3, quarantined: 1 });
    const file = readFileSync(join(data, SPOOL_DIR, SPOOL_QUARANTINE_FILE), "utf8");
    expect(file).not.toContain(MACHINE_SECRET);
    expect(file).not.toContain("example-machine");
    const [kept] = quarantineLines(data);
    expect(kept).toMatchObject({ quarantinedAt: now, event: "Stop", f: { session_id: "sess-q" } });
    expect(kept?.truncated).toBeUndefined();
    const content = (kept?.c as { last_assistant_message?: string } | undefined)?.last_assistant_message ?? "";
    expect(content.length).toBeGreaterThan(0);
    expect(content.length).toBeLessThanOrEqual(2_049);
  });

  it("deletes a record seven days after it was set aside, and a line without that time at once", async () => {
    const dir = obsTempDir("ingest-quarantine");
    const spool = join(dir, SPOOL_DIR);
    mkdirSync(spool, { recursive: true });
    const file = join(spool, SPOOL_QUARANTINE_FILE);
    const record = (at: number): string => `${JSON.stringify({ quarantinedAt: at, v: 1, src: "hook", event: "Stop", at, f: { session_id: `s-${at}` } })}\n`;
    writeFileSync(file, record(T) + record(T + 2 * 24 * 60 * MINUTE));
    // A raw spool line an older agent set aside.
    appendFileSync(file, `${spooledStop("raw", `leaked ${MACHINE_SECRET}`, T)}\n`);
    const run = async (now: number): Promise<void> => {
      const r = new SpoolReader({ dataDir: dir, now: () => now, accept: async () => undefined, commit: async () => undefined, problems: () => undefined });
      await r.drainOnce();
    };
    await run(T + QUARANTINE_KEEP_MS);
    expect(readFileSync(file, "utf8")).not.toContain(MACHINE_SECRET);
    expect(quarantineLines(dir).map((l) => l.quarantinedAt)).toEqual([T, T + 2 * 24 * 60 * MINUTE]);
    await run(T + QUARANTINE_KEEP_MS + 1);
    expect(quarantineLines(dir).map((l) => l.quarantinedAt)).toEqual([T + 2 * 24 * 60 * MINUTE]);
    await run(T + 10 * 24 * 60 * MINUTE);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(spool)).toEqual([]);
  });

  it("is deleted with the rest of the spool on a wipe, the file it is rewritten through too", async () => {
    const dir = obsTempDir("ingest-quarantine");
    mkdirSync(join(dir, SPOOL_DIR), { recursive: true });
    writeFileSync(join(dir, SPOOL_DIR, SPOOL_QUARANTINE_FILE), "{}\n");
    writeFileSync(join(dir, SPOOL_DIR, SPOOL_QUARANTINE_TEMP_FILE), "{}\n");
    await clearSpool(dir);
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([]);
  });

  it("gets a record once even when the commit fails right after it was set aside", async () => {
    const dir = obsTempDir("ingest-quarantine");
    await appendSpoolLine(dir, spooledStop("poison", "bad", T), T);
    await appendSpoolLine(dir, spooledStop("good", "fine", T), T);
    const stored: string[] = [];
    const accept = async (record: FilteredRecord): Promise<void> => {
      if (record.f.session_id === "poison") throw new Error("refused");
      stored.push(String(record.f.session_id));
    };
    let commitFails = false;
    const reader = new SpoolReader({
      dataDir: dir,
      now: () => T + MINUTE + SPOOL_GRACE_MS,
      accept,
      commit: async () => {
        if (commitFails) throw new Error("the store cannot take it now");
      },
      problems: () => undefined,
    });
    await reader.drainOnce();
    await reader.drainOnce();
    // The third refusal sets the record aside; the commit right after fails.
    commitFails = true;
    await reader.drainOnce();
    expect(reader.stats.quarantined).toBe(1);
    commitFails = false;
    await reader.drainOnce();
    expect(quarantineLines(dir).map((l) => (l.f as { session_id: string }).session_id)).toEqual(["poison"]);
    expect(reader.stats.quarantined).toBe(1);
    expect(new Set(stored)).toEqual(new Set(["good"]));
    expect(readdirSync(join(dir, SPOOL_DIR))).toEqual([SPOOL_QUARANTINE_FILE]);
  });
});

describe("the service's stop", () => {
  it("does not wait past its deadline for an accept that never settles, says so, and still closes the store", async () => {
    const log: string[] = [];
    const { s } = await service(obsTempDir("ingest-stop"), () => ({ accept: never }), { stopWaitMs: 100, log });
    void s.accept({ v: 1, src: "hook", event: "Stop", at: T, f: { session_id: "stuck" } }, "sdk");
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.status().store).toBe("off");
    expect(log.some((l) => l.includes("ingest-stop"))).toBe(true);
  });

  it("does not hang on a spool run whose records are never taken", async () => {
    const now = T + MINUTE + SPOOL_GRACE_MS;
    let taken: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (taken = resolve));
    const ingest = (): ObservatorySink => ({
      accept: () => {
        taken();
        return never();
      },
    });
    const { s, data } = await service(obsTempDir("ingest-stop"), ingest, { now: () => now, stopWaitMs: 100 });
    await appendSpoolLine(data, spooledStop("stuck", "x", T), T);
    void s.drainSpool();
    // The run is inside the ingest now, waiting for an accept that never settles.
    await reached;
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.status().store).toBe("off");
  });
});
