// Reading the hook spool's tail for the sessions someone is watching. The
// spool reader (spool-reader.ts) takes a minute's file only once the minute
// is over plus a grace, every few seconds: a terminal or CLI session reaches
// the store 5 to 75 seconds late. For a watched session this reads the files
// the reader has not taken yet (at most two: the current minute and the one
// just over) every LIVE_TAIL_EVERY_MS, and hands on each new record of that
// session as a provisional event, so the Live Map moves at once; the stored
// rows replace it later, under the same ids.
//
// It never writes the store and never deletes or changes a file. Only whole
// lines (ending in a newline) are read: a line a hook is still writing waits
// for the next read. Positions are kept per file and per session, so a
// session watched later is shown the file from its start. A file it read
// that is no longer in the folder was taken by the spool reader, which
// deletes a file only once every record in it is stored or set aside: that is
// told (onTaken), so a provisional row from it that never reaches the store
// is not shown for ever.
//
// An event carries no content, whatever the project's setting: the record's
// content (`c`) is dropped before anything else, the second privacy pass
// (privacy/redact-record-again.ts) runs on what is left, and the event holds
// the rows the record would write (labels, numbers, ids). Records of a
// session the agent runs through the SDK (its hook callbacks are its source)
// or of one with an internal label are left out, as the ingest leaves them.
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeHookRecord } from "../ingest/normalize-hook-record.ts";
import type { InstructionLoad } from "../ingest/normalized-record.ts";
import { INTERNAL_LABEL_FIELD } from "../ingest/record-known-fields.ts";
import { type FilteredHookRecord, type FilteredRecord, isFilteredRecord } from "../privacy/filtered-record.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { SPOOL_DIR, SPOOL_MAX_LINE_BYTES, minuteOf, parseSpoolFileName } from "./spool-files.ts";

/** How often the watched sessions' files are read at most. */
export const LIVE_TAIL_EVERY_MS = 500;
/** Bytes read from one file in one read at most (a spool line is at most SPOOL_MAX_LINE_BYTES, so a read always ends a line). */
export const LIVE_TAIL_READ_BYTES = 4 * SPOOL_MAX_LINE_BYTES;

/** A record of a watched session, read from the spool before the store has it. */
export type LiveTailEvent = {
  provisional: true;
  sessionId: string;
  /** The hook event (`PostToolUse`). */
  event: string;
  at: number;
  /** The rows the record writes once stored, keyed as the stored rows are; no content. */
  ops: WriteOp[];
  /** An instruction file loaded (its number among the session's loads is given once stored). */
  instruction?: InstructionLoad;
  /** The spool file the record was read from (its name). */
  file: string;
};

export type SpoolLiveTailOptions = {
  dataDir: string;
  /** The agent's second pass over a record (privacy/redact-record-again.ts). */
  secondPass: (record: FilteredRecord) => FilteredRecord;
  /** A session whose records are left out (one the agent runs through the SDK, one with an internal label). */
  skipSession: (sessionId: string) => boolean;
  onEvent: (event: LiveTailEvent) => void;
  /** The spool reader took (deleted) a file records were read from: each is stored by now, or never will be. */
  onTaken?: (file: string) => void;
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  intervalMs?: number;
};

type Watch = { count: number; offsets: Map<string, number> };

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `record` without its content, so nothing below can hand content on. */
function withoutContent(record: FilteredHookRecord): FilteredHookRecord {
  const { c: _content, truncated: _cut, ...rest } = record;
  return rest;
}

export class SpoolLiveTail {
  private readonly dir: string;
  private readonly watches = new Map<string, Watch>();
  /** Files records were read from, while they are in the folder. */
  private readonly readFrom = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private started = false;

  constructor(private readonly opts: SpoolLiveTailOptions) {
    this.dir = join(opts.dataDir, SPOOL_DIR);
  }

  /** Reads for the watched sessions from now on (until stop()). */
  start(): void {
    this.started = true;
    this.schedule();
  }

  /** Stops reading and waits for a read in progress; the watched sessions are kept for the next start(). */
  async stop(): Promise<void> {
    this.started = false;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Someone watches `sessionId`: its records are read from now on. Counted: each watch() needs its unwatch(). */
  watch(sessionId: string): void {
    const w = this.watches.get(sessionId);
    if (w) w.count++;
    else this.watches.set(sessionId, { count: 1, offsets: new Map() });
    this.schedule();
  }

  /** One watcher of `sessionId` left; with none left its records are no longer read. */
  unwatch(sessionId: string): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    if (--w.count <= 0) this.watches.delete(sessionId);
    if (this.watches.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The sessions watched now. */
  get watched(): string[] {
    return [...this.watches.keys()];
  }

  /** One read now (or the one in progress); never rejects. */
  readOnce(): Promise<void> {
    this.running ??= this.read()
      .catch((err: unknown) => this.opts.problems("spool-live-tail", err))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private schedule(): void {
    if (!this.started || this.timer || this.watches.size === 0) return;
    this.timer = setInterval(() => void this.readOnce(), this.opts.intervalMs ?? LIVE_TAIL_EVERY_MS);
    this.timer.unref?.();
  }

  /** The events files the spool reader has not taken yet: the current minute's and the one before, oldest first. */
  private async unconsumedFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // no spool yet (nothing is told taken: a folder that cannot be read says nothing of its files)
    }
    this.tellTaken(new Set(names));
    const minute = minuteOf((this.opts.now ?? Date.now)());
    return names
      .flatMap((name) => {
        const parsed = parseSpoolFileName(name);
        return parsed?.kind === "events" && parsed.minute >= minute - 1 && parsed.minute <= minute ? [{ name, minute: parsed.minute }] : [];
      })
      .sort((a, b) => a.minute - b.minute)
      .map((f) => f.name);
  }

  private async read(): Promise<void> {
    if (!this.started || this.watches.size === 0) return;
    const files = await this.unconsumedFiles();
    // A file taken by the spool reader (deleted) is forgotten.
    for (const w of this.watches.values()) for (const name of w.offsets.keys()) if (!files.includes(name)) w.offsets.delete(name);
    for (const name of files) {
      if (!this.started) return;
      await this.readFile(name);
      await yieldLoop();
    }
  }

  /** Tells onTaken of each file read from that `names` (the folder now) no longer holds. */
  private tellTaken(names: ReadonlySet<string>): void {
    for (const name of [...this.readFrom]) {
      if (names.has(name)) continue;
      this.readFrom.delete(name);
      try {
        this.opts.onTaken?.(name);
      } catch (err) {
        this.opts.problems("spool-live-tail-taken", err);
      }
    }
  }

  /** Reads `name` from the earliest position a watched session needs, up to its last whole line. */
  private async readFile(name: string): Promise<void> {
    const watches = [...this.watches.values()];
    const from = Math.min(...watches.map((w) => w.offsets.get(name) ?? 0));
    let bytes: Buffer;
    try {
      const fh = await open(join(this.dir, name), "r");
      try {
        const buf = Buffer.alloc(LIVE_TAIL_READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        bytes = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // taken by the spool reader meanwhile
      throw err;
    }
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) return; // no whole line yet
    let start = 0;
    while (start <= end) {
      const nl = bytes.indexOf(0x0a, start);
      this.line(name, from + start, bytes.subarray(start, nl));
      start = nl + 1;
    }
    const next = from + end + 1;
    for (const w of watches) w.offsets.set(name, Math.max(w.offsets.get(name) ?? 0, next));
  }

  /** The line at `position` of file `name`: an event for its session when watched from before it. */
  private line(name: string, position: number, line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      return; // not a record: the spool reader counts it
    }
    if (!isFilteredRecord(value) || value.src !== "hook") return;
    const sessionId = value.f.session_id;
    if (typeof sessionId !== "string") return;
    const w = this.watches.get(sessionId);
    if (!w || (w.offsets.get(name) ?? 0) > position) return;
    if (value.f[INTERNAL_LABEL_FIELD] !== undefined || this.opts.skipSession(sessionId)) return;
    try {
      const record = this.opts.secondPass(withoutContent(value));
      if (record.src !== "hook") return;
      const n = normalizeHookRecord(withoutContent(record), "spool");
      if (n.outcome !== "stored" || (n.ops.length === 0 && !n.instruction)) return;
      const event: LiveTailEvent = { provisional: true, sessionId, event: record.event, at: record.at, ops: n.ops, ...(n.instruction ? { instruction: n.instruction } : {}), file: name };
      this.readFrom.add(name);
      this.opts.onEvent(event);
    } catch (err) {
      this.opts.problems("spool-live-tail-event", err);
    }
  }
}
