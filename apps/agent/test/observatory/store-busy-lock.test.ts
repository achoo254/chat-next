// Another connection holding the write lock (a CLI command, a database
// browser, a second agent): a store call gives up after its short busy
// timeout with a typed error, and the batch writer backs off instead of
// blocking the event loop again every half second; the writes land once the
// lock is released.
//
// The retry schedule is checked with fake timers (exact, the same on every
// machine). The real-lock test measures against the machine itself: how
// long one blocked write takes here, and how late timers run here with no
// lock at all, instead of a fixed number of milliseconds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BACKOFF_MS, MAX_BATCH_DELAY_MS, MAX_BATCH_OPS, ObservatoryBatchWriter } from "../../src/observatory/store/batch-writer.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { AGENT_BUSY_TIMEOUT_MS } from "../../src/observatory/store/open-observatory-db.ts";
import { type SqliteConnection, openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import { ObservatoryStoreBusy } from "../../src/observatory/store/store-errors.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { tempDbPath } from "./store-fixture.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const o of opened.splice(0)) o.close();
});

const prompt = (i: number): WriteOp => ({ kind: "prompt", row: { promptId: `p${i}`, sessionId: "s", at: i } });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function lockedStore(): Promise<{ store: ObservatoryStore; locker: SqliteConnection }> {
  const path = tempDbPath();
  const store = await ObservatoryStore.open({ path });
  const locker = await openSqlite(path);
  opened.push(store, locker);
  locker.exec("BEGIN IMMEDIATE");
  return { store, locker };
}

/** The longest gap between 5 ms timer ticks while `during` runs: how late this machine runs timers. */
async function longestTimerGap(during: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  await during();
  clearInterval(tick);
  return longest;
}

describe("the batch writer's retry schedule while the database is locked", () => {
  it("tries again after 500 ms, doubling to 30 s, without writing on push meanwhile, then writes everything", () => {
    vi.useFakeTimers();
    let locked = true;
    const tries: number[] = [];
    let written = 0;
    const start = Date.now();
    const w = new ObservatoryBatchWriter(
      {
        write: (ops) => {
          tries.push(Date.now() - start);
          if (locked) throw new ObservatoryStoreBusy(new Error("database is locked"));
          written += ops.length;
        },
      },
      { onError: () => expect.fail("a lock is not reported") },
    );
    for (let i = 0; i < MAX_BATCH_OPS * 3; i++) w.push(prompt(i));
    // One try when the first batch filled; pushing more while backing off tries nothing.
    expect(tries).toEqual([0]);

    vi.advanceTimersByTime(120_000);
    const gaps = tries.slice(1).map((t, i) => t - (tries[i] ?? 0));
    const expected = [MAX_BATCH_DELAY_MS];
    while (expected.length < gaps.length) expected.push(Math.min((expected.at(-1) ?? 0) * 2, MAX_BACKOFF_MS));
    expect(gaps).toEqual(expected);
    expect(gaps.slice(0, 7)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
    expect(w.pending).toBe(MAX_BATCH_OPS * 3);

    locked = false;
    w.close();
    expect(written).toBe(MAX_BATCH_OPS * 3);
  });
});

describe("a write lock held by another connection", () => {
  it("makes a write fail with ObservatoryStoreBusy after the agent's short timeout", async () => {
    const { store, locker } = await lockedStore();
    const started = performance.now();
    expect(() => store.write([prompt(1)])).toThrow(ObservatoryStoreBusy);
    const blocked = performance.now() - started;
    console.info(`observatory store under a held lock: one write blocked ${blocked.toFixed(0)} ms (busy timeout ${AGENT_BUSY_TIMEOUT_MS} ms)`);
    expect(blocked).toBeGreaterThanOrEqual(AGENT_BUSY_TIMEOUT_MS * 0.8);
    expect(blocked).toBeLessThan(AGENT_BUSY_TIMEOUT_MS + 150);
    locker.exec("ROLLBACK");
    store.write([prompt(1)]);
    expect(store.sessionTimeline("s").prompts).toHaveLength(1);
  });

  it("calls the store at most 3 times in 1.2 s, stalls the loop no longer than one blocked write, and writes everything once released", async () => {
    const { store, locker } = await lockedStore();
    // This machine's own numbers: one blocked write, and timer lateness with no lock.
    const t0 = performance.now();
    expect(() => store.write([prompt(-1)])).toThrow(ObservatoryStoreBusy);
    const blocked = performance.now() - t0;
    const baseline = await longestTimerGap(() => sleep(300));

    let calls = 0;
    const counting = {
      write: (ops: readonly WriteOp[]) => {
        calls++;
        store.write(ops);
      },
    };
    const errors: unknown[] = [];
    const w = new ObservatoryBatchWriter(counting, { onError: (err) => void errors.push(err) });
    const stall = await longestTimerGap(async () => {
      const end = performance.now() + 1200;
      // 1 000 events spread over the first few hundred ms, then the lock stays held to the end.
      for (let i = 0; i < 1000; i++) {
        w.push(prompt(i));
        if (i % 50 === 49) await sleep(10);
      }
      await sleep(Math.max(0, end - performance.now()));
    });
    console.info(
      `observatory writer under a held lock: ${calls} store calls in 1.2 s; longest stall ${stall.toFixed(0)} ms (one blocked write ${blocked.toFixed(0)} ms, timer lateness ${baseline.toFixed(0)} ms)`,
    );
    // Without backing off it would try every 500 ms per filled batch: about 24 calls.
    expect(calls).toBeLessThanOrEqual(3);
    expect(stall).toBeLessThanOrEqual(blocked + 2 * baseline + 25);
    expect(errors).toEqual([]);

    const queued = w.pending;
    locker.exec("ROLLBACK");
    w.close();
    expect(errors).toEqual([]);
    expect(store.sessionTimeline("s").prompts).toHaveLength(queued);
  });
});
