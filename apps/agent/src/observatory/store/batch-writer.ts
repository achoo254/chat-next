// Collects Observatory writes and hands them to the store in short batches:
// when MAX_BATCH_OPS are waiting, or MAX_BATCH_DELAY_MS after the first one,
// whichever comes first. A batch is one transaction, so the agent's event
// loop is held for one short write at a time, never for row-by-row commits.
//
// Nothing here ever throws into the code that pushed a write; what goes
// wrong is reported to `onError(err, dropped)` (an onError that throws is
// ignored):
// - the database cannot take writes now (locked elsewhere, disk full, I/O
//   error, read-only, corrupt…): the batch stays queued and the next try
//   waits longer each time (MAX_BATCH_DELAY_MS, doubling up to
//   MAX_BACKOFF_MS), so a lasting failure costs one short call per try, not
//   one every half second. A failure other than a lock is reported with
//   dropped = 0 (nothing lost yet), at most once per REPORT_INTERVAL_MS.
//   Past MAX_QUEUED_OPS the oldest writes are dropped, counted, and reported
//   at most once per REPORT_INTERVAL_MS (and at close);
// - a write whose own data is refused (ObservatoryInvalidWrite, a constraint
//   or type mismatch): the batch is split in halves until that write is
//   alone, which alone is dropped and reported; the others land (writing one
//   twice is harmless: every table merges or ignores a duplicate);
// - the store is closed: the writer stops for good, drops what waits, and
//   reports it once.
//
// The owner wipes the database in this order: writer.close() (what waits
// goes in first and is deleted with the rest), store.wipe(), then a new
// store and a new writer, whether the wipe succeeded or not. The timer is
// unref'd; the owner calls close() on shutdown.
import { isSqliteBusy, isSqliteDataError } from "./sqlite-driver.ts";
import { ObservatoryInvalidWrite, ObservatoryStoreBusy, ObservatoryStoreClosed, ObservatoryStoreError } from "./store-errors.ts";
import type { WriteOp } from "./write-ops.ts";

export const MAX_BATCH_OPS = 200;
export const MAX_BATCH_DELAY_MS = 500;
export const MAX_BACKOFF_MS = 30_000;
export const MAX_QUEUED_OPS = 10_000;
/** A repeated failure (queue full, database failing) is reported at most this often. */
export const REPORT_INTERVAL_MS = 60_000;

/** The part of ObservatoryStore a writer needs. */
export interface BatchSink {
  write(ops: readonly WriteOp[]): void;
}

export type BatchWriterOptions = {
  maxOps?: number;
  maxDelayMs?: number;
  maxQueued?: number;
  /** Something went wrong: why, and how many writes were lost (0: kept and tried again later). */
  onError: (err: unknown, dropped: number) => void;
};

type Outcome = "written" | "retry" | "stopped";

/** A failure of the database as a whole (the batch is kept), as opposed to one write's data or a closed store. */
function isDatabaseFailure(err: unknown): boolean {
  if (err instanceof ObservatoryStoreClosed || err instanceof ObservatoryInvalidWrite) return false;
  return err instanceof ObservatoryStoreBusy || isSqliteBusy(err) || !isSqliteDataError(err);
}

export class ObservatoryBatchWriter {
  private queue: WriteOp[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The wait before the next try while the database fails; 0 when it does not. */
  private backoffMs = 0;
  private stopped = false;
  /** Writes dropped from a full queue and not reported yet. */
  private overflow = 0;
  private lastOverflowReport = Number.NEGATIVE_INFINITY;
  private lastFailureReport = Number.NEGATIVE_INFINITY;
  private readonly maxOps: number;
  private readonly maxDelayMs: number;
  private readonly maxQueued: number;

  constructor(
    private readonly sink: BatchSink,
    private readonly opts: BatchWriterOptions,
  ) {
    this.maxOps = Math.max(1, Math.floor(opts.maxOps ?? MAX_BATCH_OPS));
    this.maxDelayMs = Math.max(0, opts.maxDelayMs ?? MAX_BATCH_DELAY_MS);
    this.maxQueued = Math.max(this.maxOps, Math.floor(opts.maxQueued ?? MAX_QUEUED_OPS));
  }

  /** Writes waiting for the next batch. */
  get pending(): number {
    return this.queue.length;
  }

  /** The writer stopped (closed, or its store was): pushes are ignored. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Queues one write; ignored once stopped. */
  push(op: WriteOp): void {
    if (this.stopped) return;
    this.queue.push(op);
    if (this.queue.length > this.maxQueued) {
      this.overflow += this.queue.splice(0, this.queue.length - this.maxQueued).length;
      if (Date.now() - this.lastOverflowReport >= REPORT_INTERVAL_MS) this.reportOverflow();
    }
    if (this.backoffMs === 0 && this.queue.length >= this.maxOps) this.flush();
    else this.schedule(this.backoffMs || this.maxDelayMs);
  }

  /** Writes what waits now, in batches of at most maxOps; stops at the first batch the database cannot take and tries again later. */
  flush(): void {
    this.clearTimer();
    while (this.queue.length > 0 && !this.stopped) {
      const batch = this.queue.slice(0, this.maxOps);
      const outcome = this.write(batch);
      if (outcome === "stopped") return;
      if (outcome === "retry") {
        this.backoffMs = this.backoffMs === 0 ? Math.max(1, this.maxDelayMs) : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.schedule(this.backoffMs);
        return;
      }
      this.queue.splice(0, batch.length);
    }
    this.backoffMs = 0;
  }

  /** Writes what waits and stops taking writes; what the database cannot take now is dropped and reported. */
  close(): void {
    if (this.stopped) return;
    this.flush();
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    if (this.overflow > 0) this.reportOverflow();
    if (this.queue.length > 0) {
      this.report(new ObservatoryStoreError("the Observatory database could not take writes when the writer closed"), this.queue.length);
      this.queue = [];
    }
  }

  private write(batch: readonly WriteOp[]): Outcome {
    try {
      this.sink.write(batch);
      return "written";
    } catch (err) {
      if (err instanceof ObservatoryStoreClosed) {
        this.stop(err);
        return "stopped";
      }
      if (isDatabaseFailure(err)) {
        if (!(err instanceof ObservatoryStoreBusy) && Date.now() - this.lastFailureReport >= REPORT_INTERVAL_MS) {
          this.lastFailureReport = Date.now();
          this.report(err, 0);
        }
        return "retry";
      }
      if (batch.length === 1) {
        this.report(err, 1);
        return "written";
      }
      const half = batch.length >> 1;
      const first = this.write(batch.slice(0, half));
      return first === "written" ? this.write(batch.slice(half)) : first;
    }
  }

  private stop(err: unknown): void {
    this.stopped = true;
    this.clearTimer();
    const dropped = this.queue.length;
    this.queue = [];
    this.report(err, dropped);
  }

  private reportOverflow(): void {
    this.lastOverflowReport = Date.now();
    const dropped = this.overflow;
    this.overflow = 0;
    this.report(new ObservatoryStoreError(`the Observatory write queue was full: ${dropped} writes dropped (the database could not take writes)`), dropped);
  }

  private schedule(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private report(err: unknown, dropped: number): void {
    try {
      this.opts.onError(err, dropped);
    } catch {
      // a failing reporter must not stop the writes, nor reach the code that pushed them
    }
  }
}
