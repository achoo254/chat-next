// The batch writer: a batch at 200 writes or after 500 ms, a refused batch
// dropped and reported, and under load the event loop never held long.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BATCH_DELAY_MS, MAX_BATCH_OPS, ObservatoryBatchWriter, REPORT_INTERVAL_MS } from "../../src/observatory/store/batch-writer.ts";
import { ObservatoryInvalidWrite, ObservatoryStoreBusy } from "../../src/observatory/store/store-errors.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { openTempStore } from "./store-fixture.ts";

const prompt = (i: number): WriteOp => ({ kind: "prompt", row: { promptId: `p${i}`, sessionId: "s", at: i } });

afterEach(() => {
  vi.useRealTimers();
});

describe("ObservatoryBatchWriter", () => {
  it("writes a batch once MAX_BATCH_OPS are waiting", () => {
    const batches: number[] = [];
    const w = new ObservatoryBatchWriter({ write: (ops) => void batches.push(ops.length) }, { onError: () => undefined });
    for (let i = 0; i < MAX_BATCH_OPS * 2 + 5; i++) w.push(prompt(i));
    expect(batches).toEqual([MAX_BATCH_OPS, MAX_BATCH_OPS]);
    expect(w.pending).toBe(5);
    w.close();
    expect(batches).toEqual([MAX_BATCH_OPS, MAX_BATCH_OPS, 5]);
    w.push(prompt(0));
    expect(w.pending).toBe(0);
  });

  it("writes what waits MAX_BATCH_DELAY_MS after the first write", () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const w = new ObservatoryBatchWriter({ write: (ops) => void batches.push(ops.length) }, { onError: () => undefined });
    w.push(prompt(1));
    vi.advanceTimersByTime(MAX_BATCH_DELAY_MS - 1);
    w.push(prompt(2));
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([2]);
  });

  it("drops only the write the store refuses; the rest of its batch lands", async () => {
    const store = await openTempStore();
    const errors: [string, number][] = [];
    const w = new ObservatoryBatchWriter(store, { onError: (err, n) => void errors.push([(err as Error).name, n]) });
    for (let i = 0; i < 199; i++) w.push(prompt(i));
    w.push({ kind: "prompt", row: { promptId: "bad", sessionId: "s", at: 1.5 } });
    expect(errors).toEqual([["ObservatoryInvalidWrite", 1]]);
    expect(store.sessionTimeline("s").prompts).toHaveLength(199);
    w.close();
    store.close();
  });

  it("isolates a write the database's constraints refuse the same way", async () => {
    const store = await openTempStore();
    const errors: number[] = [];
    const w = new ObservatoryBatchWriter(store, { maxOps: 10, onError: (_err, n) => void errors.push(n) });
    for (let i = 0; i < 9; i++) w.push(prompt(i));
    // Passes the codec, fails the schema's CHECK (SQLITE_CONSTRAINT).
    w.push({ kind: "session", row: { sessionId: "x", source: "web", startedAt: 1 } } as unknown as WriteOp);
    expect(errors).toEqual([1]);
    expect(store.sessionTimeline("s").prompts).toHaveLength(9);
    w.close();
    store.close();
  });

  it("ignores an onError that throws, and keeps writing", () => {
    let calls = 0;
    const written: number[] = [];
    const w = new ObservatoryBatchWriter(
      {
        write: (ops) => {
          if (ops.some((op) => op.kind === "prompt" && op.row.promptId === "p1")) throw new ObservatoryInvalidWrite("refused");
          written.push(ops.length);
        },
      },
      {
        maxOps: 2,
        onError: () => {
          calls++;
          throw new Error("the reporter broke");
        },
      },
    );
    expect(() => {
      w.push(prompt(1));
      w.push(prompt(2));
      w.push(prompt(3));
      w.close();
    }).not.toThrow();
    expect(calls).toBe(1);
    expect(written).toEqual([1, 1]);
  });

  it("keeps a whole batch on a failure of the database (disk I/O), tries again later, and reports it once", () => {
    vi.useFakeTimers();
    // SQLITE_IOERR_WRITE (778) as node:sqlite reports it.
    const diskError = Object.assign(new Error("disk I/O error"), { errcode: 778 });
    let failing = true;
    let calls = 0;
    const written: number[] = [];
    const errors: [string, number][] = [];
    const w = new ObservatoryBatchWriter(
      {
        write: (ops) => {
          calls++;
          if (failing) throw diskError;
          written.push(ops.length);
        },
      },
      { onError: (err, n) => void errors.push([(err as Error).message, n]) },
    );
    for (let i = 0; i < MAX_BATCH_OPS; i++) w.push(prompt(i));
    expect(calls).toBe(1);
    expect(errors).toEqual([["disk I/O error", 0]]);
    expect(w.pending).toBe(MAX_BATCH_OPS);
    vi.advanceTimersByTime(MAX_BATCH_DELAY_MS);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    failing = false;
    vi.advanceTimersByTime(2 * MAX_BATCH_DELAY_MS);
    expect(written).toEqual([MAX_BATCH_OPS]);
    expect(w.pending).toBe(0);
  });

  it("reports a full queue once, with the count, then at most once a minute", () => {
    vi.useFakeTimers();
    const errors: number[] = [];
    const w = new ObservatoryBatchWriter(
      {
        write: () => {
          throw new ObservatoryStoreBusy(new Error("database is locked"));
        },
      },
      { maxOps: 10, maxQueued: 100, onError: (_err, n) => void errors.push(n) },
    );
    for (let i = 0; i < 400; i++) w.push(prompt(i));
    expect(errors).toEqual([1]);
    vi.advanceTimersByTime(REPORT_INTERVAL_MS);
    w.push(prompt(400));
    expect(errors).toEqual([1, 300]);
    w.close();
    // At close: what waits (100) is reported once.
    expect(errors).toEqual([1, 300, 100]);
  });

  it("stops for good once its store is closed, reporting the loss once", async () => {
    const store = await openTempStore();
    const errors: [string, number][] = [];
    const w = new ObservatoryBatchWriter(store, { onError: (err, n) => void errors.push([(err as Error).name, n]) });
    store.close();
    w.push(prompt(1));
    w.push(prompt(2));
    w.flush();
    w.push(prompt(3));
    w.flush();
    w.close();
    expect(errors).toEqual([["ObservatoryStoreClosed", 2]]);
    expect(w.isStopped).toBe(true);
    expect(w.pending).toBe(0);
  });

  it("stores 20 000 writes without holding the event loop long", async () => {
    const store = await openTempStore();
    const w = new ObservatoryBatchWriter(store, { onError: (err) => expect.fail(String(err)) });
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) {
      w.push(prompt(i));
      // Events arrive spread over time: give the loop a turn every 100 writes.
      if (i % 100 === 99) await new Promise((r) => setImmediate(r));
    }
    w.close();
    const elapsed = performance.now() - started;
    histogram.disable();
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    console.info(`observatory batch writer: 20000 writes in ${elapsed.toFixed(0)} ms; event loop delay p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    expect(store.sessionTimeline("s").prompts).toHaveLength(20_000);
    store.close();
    // One batch of 200 rows takes well under a millisecond; a shared CI runner gets a wide margin.
    expect(p99).toBeLessThan(50);
  });
});
