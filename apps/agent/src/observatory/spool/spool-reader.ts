// The agent's side of the hook spool (spool-files.ts): every few seconds it
// reads the files of minutes that are settled (over, and past the hooks'
// deadline), oldest first, and passes each record on. A run reads at most a
// byte budget, a chunk at a time with a turn of the event loop between
// chunks, so a spool grown large while the agent was off drains over several
// runs without holding the agent up.
//
// Nothing is given up before it is stored: after each chunk every record must
// be taken (`accept` resolved) and the writes committed (`commit` resolved:
// in the store, or dropped and counted); only then is the position saved
// (cursor.json), and a file is deleted only once read to its end that way.
// When either fails the run stops and the chunk is read again next time (the
// store ignores a duplicate). A record the ingest refuses SPOOL_MAX_ATTEMPTS
// runs in a row is set aside (spool-quarantine.ts: as the ingest got it, after
// the second pass) and the reader goes on, so one bad record never holds the
// files after it; the tries are saved before the commit, so a commit failing
// right after never sets the same record aside twice. An agent restarted
// halfway goes on from the saved position. `dropped-` files are added to the
// dropped count and deleted. Quarantined records past their time are deleted
// once an hour.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readLinesUntil } from "../../office/office-bounded-lines.ts";
import { type FilteredRecord, isFilteredRecord } from "../privacy/filtered-record.ts";
import { ObservatoryStoreError } from "../store/store-errors.ts";
import { SPOOL_CURSOR_FILE, SPOOL_DIR, SPOOL_GRACE_MS, SPOOL_MAX_LINE_BYTES, parseSpoolFileName, spoolFileSettled } from "./spool-files.ts";
import { type RefusedRecord, SPOOL_MAX_ATTEMPTS, type SpoolCursor, lineKey, pruneQuarantine, readSpoolCursor, setAsideRefused, writeSpoolCursor } from "./spool-quarantine.ts";

export const SPOOL_READ_EVERY_MS = 10_000;
/** Bytes read in one run at most. */
export const SPOOL_RUN_BUDGET_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const FIRST_RUN_DELAY_MS = 2_000;
const QUARANTINE_PRUNE_EVERY_MS = 60 * 60_000;

export type SpoolReaderOptions = {
  dataDir: string;
  /**
   * The agent's second pass over each record read (privacy/redact-record-again.ts),
   * before it is accepted or set aside; records as read when absent (they are
   * final already).
   */
  secondPass?: (record: FilteredRecord) => FilteredRecord;
  /** Takes each record read, after the second pass (the agent hands it to the ingest); rejects when it could not. */
  accept: (record: FilteredRecord) => Promise<void>;
  /** Resolves once everything accepted so far is stored (or dropped and counted); rejects when the store cannot take it now. */
  commit: () => Promise<void>;
  /** A problem at a fixed place, for the throttled log (office/office-problem-log.ts). */
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  graceMs?: number;
  intervalMs?: number;
  budgetBytes?: number;
  quarantineMaxBytes?: number;
};

export type SpoolStats = {
  /** Records passed on and stored since the agent started. */
  loaded: number;
  /** Lines that were not a record. */
  malformed: number;
  /** Events the hooks dropped (spool full, payload too large), as counted in the `dropped-` files read. */
  dropped: number;
  /** Size of the events files at the last run. */
  pendingBytes: number;
  /** Refusals by the ingest (each try of each record). */
  rejected: number;
  /** Records set aside in the quarantine file after SPOOL_MAX_ATTEMPTS refusals. */
  quarantined: number;
  /** Records to be set aside, dropped because the quarantine file was full. */
  quarantineDropped: number;
};

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SpoolReader {
  readonly stats: SpoolStats = { loaded: 0, malformed: 0, dropped: 0, pendingBytes: 0, rejected: 0, quarantined: 0, quarantineDropped: 0 };
  private readonly dir: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private quarantinePrunedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: SpoolReaderOptions) {
    this.dir = join(opts.dataDir, SPOOL_DIR);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    const run = (): void => void this.drainOnce();
    this.first = setTimeout(run, FIRST_RUN_DELAY_MS);
    this.first.unref?.();
    this.timer = setInterval(run, this.opts.intervalMs ?? SPOOL_READ_EVERY_MS);
    this.timer.unref?.();
  }

  /** Stops the timer and waits for a run in progress to end (it stops after its current chunk). */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One run now (or the one in progress); never rejects. */
  drainOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.running ??= this.drain()
      .catch((err: unknown) => this.opts.problems("spool-read", err))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async drain(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      this.stats.pendingBytes = 0;
      return; // no spool yet
    }
    const now = this.now();
    if (now - this.quarantinePrunedAt >= QUARANTINE_PRUNE_EVERY_MS) {
      this.quarantinePrunedAt = now;
      await pruneQuarantine(this.dir, now).catch((err: unknown) => this.opts.problems("spool-quarantine-prune", err));
    }
    const files = names
      .flatMap((name) => {
        const parsed = parseSpoolFileName(name);
        return parsed ? [{ name, ...parsed }] : [];
      })
      .sort((a, b) => a.minute - b.minute || a.name.localeCompare(b.name));
    this.stats.pendingBytes = await this.eventsBytes(files.filter((f) => f.kind === "events").map((f) => f.name));
    let budget = this.opts.budgetBytes ?? SPOOL_RUN_BUDGET_BYTES;
    const cursor = await readSpoolCursor(this.dir);
    for (const file of files) {
      if (this.stopping || budget <= 0) return;
      if (!spoolFileSettled(file.kind, file.minute, now, this.opts.graceMs ?? SPOOL_GRACE_MS)) continue;
      if (file.kind === "dropped") {
        await this.countDropped(file.name).catch((err: unknown) => this.opts.problems("spool-dropped", err));
        continue;
      }
      // A record not taken or not stored stops the run: later files wait too, in order.
      budget = await this.readEvents(file.name, cursor, budget);
    }
  }

  /** Reads `name` from the cursor's offset within `budget`; deletes it once read to its end. Returns the budget left. */
  private async readEvents(name: string, cursor: SpoolCursor | undefined, budget: number): Promise<number> {
    const path = join(this.dir, name);
    const size = (await stat(path)).size;
    let at = cursor?.file === name ? cursor.offset : 0;
    let attempts = cursor?.file === name ? cursor.attempts : {};
    while (at < size && budget > 0 && !this.stopping) {
      const taken: Promise<RefusedRecord | undefined>[] = [];
      const hasAttempts = Object.keys(attempts).length > 0;
      const { next, bytesRead } = await readLinesUntil(path, at, Math.min(size, at + CHUNK_BYTES), SPOOL_MAX_LINE_BYTES, (line) => {
        // Set aside already in an earlier run of this chunk.
        if (hasAttempts && (attempts[lineKey(line)] ?? 0) >= SPOOL_MAX_ATTEMPTS) return;
        const record = this.record(line);
        // Each outcome is settled at once: a refusal must not go unhandled while the chunk is still being read.
        if (record) taken.push(this.opts.accept(record).then(() => undefined, () => ({ key: lineKey(line), record })));
      });
      const refused = (await Promise.all(taken)).filter((r): r is RefusedRecord => r !== undefined);
      this.stats.rejected += refused.length;
      const outcome = await setAsideRefused(this.dir, refused, attempts, this.now(), this.opts.quarantineMaxBytes);
      this.stats.quarantined += outcome.quarantined;
      this.stats.quarantineDropped += outcome.dropped;
      if (outcome.quarantined + outcome.dropped > 0) this.opts.problems("spool-quarantine", new ObservatoryStoreError("spool records the ingest kept refusing were set aside"));
      if (outcome.waiting || outcome.quarantined + outcome.dropped > 0) {
        // The tries are kept across a restart, and before the commit: a commit failing now reads the chunk again without setting a record aside twice.
        await writeSpoolCursor(this.dir, { file: name, offset: at, attempts });
      }
      // Tried again next run, from the same place.
      if (outcome.waiting) throw new ObservatoryStoreError(`the ingest refused ${refused.length} spool record(s)`);
      await this.opts.commit();
      this.stats.loaded += taken.length - refused.length;
      // No newline up to the end: a line a hook never finished (it was stopped mid-write). Nothing more to read.
      at = next === at ? size : next;
      attempts = {};
      budget -= Math.max(bytesRead, 1);
      await writeSpoolCursor(this.dir, { file: name, offset: at, attempts });
      await yieldLoop();
    }
    if (at >= size) {
      await rm(path, { force: true });
      await rm(join(this.dir, SPOOL_CURSOR_FILE), { force: true });
    }
    return budget;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The record a line holds, after the second pass; undefined (counted) for anything else. */
  private record(line: Buffer): FilteredRecord | undefined {
    try {
      const value: unknown = JSON.parse(line.toString("utf8"));
      if (isFilteredRecord(value)) return this.opts.secondPass ? this.opts.secondPass(value) : value;
    } catch {
      // not JSON, or the second pass could not read it: not a record
    }
    this.stats.malformed++;
    return undefined;
  }

  private async countDropped(name: string): Promise<void> {
    const path = join(this.dir, name);
    const text = await readFile(path, "utf8");
    this.stats.dropped += text.split("\n").filter((l) => l.trim() !== "").length;
    await rm(path, { force: true });
  }

  private async eventsBytes(names: readonly string[]): Promise<number> {
    let total = 0;
    for (const name of names) total += await stat(join(this.dir, name)).then((s) => s.size, () => 0);
    return total;
  }
}
