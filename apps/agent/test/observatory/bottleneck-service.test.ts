// The bottleneck runner inside the Observatory service: records taken by the
// ingest reach the store in batches, the runner scores them and writes its
// finding back through the same writer, onFinding hears it, and a wipe
// stops the runner around the deletion and starts it again on the new store.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import type { FindingChange } from "../../src/observatory/bottlenecks/finding-lifecycle.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { ObservatorySink } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const S = "sess-service-0001";

/** Three reads of one file, then its end: what the ingest would write for each record taken. */
function readOps(n: number, at: number): WriteOp[] {
  return [
    { kind: "session", row: { sessionId: S, source: "cli", startedAt: at, projectKey: "github.com/acme/app" } },
    { kind: "toolCall", row: { toolUseId: `toolu_${n}`, sessionId: S, promptId: "p1", at, toolName: "Read", station: "FILES", stationFlags: 0, targetKey: "k-index", durationMs: 12, success: true } },
  ];
}

async function exportRows(s: ObservatoryService, dir: string): Promise<Record<string, unknown>[]> {
  const file = join(dir, `export-${Date.now()}.json`);
  await s.exportToFile(file, true);
  return (JSON.parse(readFileSync(file, "utf8")) as { tables: Record<string, Record<string, unknown>[]> }).tables.bottlenecks ?? [];
}

describe("the service's bottleneck runner", () => {
  it("scores the store's batches, writes the finding through the writer, and starts again after a wipe", async () => {
    const dir = obsTempDir("bottleneck-service");
    const config = new ConfigStore(join(dir, "config"));
    const port = await pickFreePort();
    config.update((c) => (c.observatory = { otlpPort: port ?? 47_398, enabled: true }));
    const ingest = (push: (op: WriteOp) => void): ObservatorySink => ({
      accept: async (record) => {
        for (const op of readOps(Number(record.f.n), record.at)) push(op);
      },
    });
    const s = new ObservatoryService({ config, dataDir: join(dir, "data"), log: () => undefined, knownSecrets: () => [], ingest, tokenTimings: { tokenRetryMs: [] } });
    await s.start();
    stops.push(() => s.stop());
    const changes: FindingChange[] = [];
    s.bottlenecks.onFinding((c) => changes.push(c));

    const now = Date.now();
    for (const n of [1, 2, 3]) await s.accept({ v: 1, src: "hook", event: "PostToolUse", at: now + n, f: { session_id: S, n } }, "spool");
    await s.drainSpool();
    // The batch writer flushes within its delay; the runner scores right after.
    await expect.poll(() => changes.length, { timeout: 5_000 }).toBe(1);
    await s.bottlenecks.idle();
    expect(changes[0]).toMatchObject({ type: "open", row: { sessionId: S, rule: "repeat_read", subkey: "k-index", status: "open" } });
    await expect.poll(async () => (await exportRows(s, dir)).length, { timeout: 5_000 }).toBe(1);
    const row = (await exportRows(s, dir))[0];
    expect(JSON.parse(String(row?.evidence_json)).eventIds).toEqual(["tool:toolu_3", "tool:toolu_2", "tool:toolu_1"]);

    await s.wipe();
    expect(await exportRows(s, dir)).toEqual([]);
    changes.length = 0;
    for (const n of [4, 5, 6]) await s.accept({ v: 1, src: "hook", event: "PostToolUse", at: now + n, f: { session_id: S, n } }, "spool");
    await expect.poll(() => changes.length, { timeout: 5_000 }).toBe(1);
    expect(changes[0]?.row.openedAt).toBeGreaterThan(0);
  });
});
