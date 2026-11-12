// The usage ledger: what the AIs' transcripts on this machine say about
// token usage, kept in <config>/usage/ after the transcripts are gone (Claude
// Code deletes its own after about a month). Numbers and the minimal metadata
// of each call only (see docs/privacy/data-inventory.md): never a message, a
// tool's input or its result.
//
// On disk: one shard of calls per local month (usage/ledger/YYYY-MM.json)
// and a small index (usage/index.json) of everything else: where each
// transcript was read to, directories' repository keys, the sessions the app
// opened, plan usage readings, the hints sent, the format check. A year of
// calls is about 100 MB, so a scan rewrites only the shards it added to, and
// shards are held in memory only while a scan or a report needs them.
//
// One queue runs every change (a scan's file, a quota reading, an app
// session, a hint sent) and every write, in order, so none is lost to
// another. A write goes to a temp file renamed over the file (mode 0600)
// after the file is copied to its .prev.json; shards are written before the
// index, so offsets never run ahead of the calls they read. A file that
// cannot be read, or that a newer agent wrote (an unknown schemaVersion), is
// never written over: the ledger stays blocked until it is deleted.
//
// A call is counted once on the machine (its key may be copied into a
// resumed or forked session): it belongs to the occurrence with the earliest
// time, a subagent's copy giving way to the main session's at the same time;
// its output tokens are the largest any occurrence reports. A copy keeps the
// original's time (copies on this machine differed by 99 seconds at most), so
// a call is looked for in the shards of the months a day either side of it
// falls in: its own month, and the next or last one near a month's end.
//
// The single-file ledger of the first version (usage/ledger.json) is split
// into shards on first open: written into a separate folder, read back and
// compared, moved into place, then the index is written; the old file is
// removed only after that.
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { UsageFile, UsageLineStats, UsageRead } from "../providers/types.ts";

export const SCHEMA_VERSION = 2;
/** The single-file ledger before shards. */
const LEGACY_VERSION = 1;
export const INDEX_FILE = "index.json";
export const INDEX_PREV = "index.prev.json";
export const SHARD_DIR = "ledger";
export const LEGACY_FILE = "ledger.json";
export const LEGACY_PREV = "ledger.prev.json";
const MIGRATING_DIR = "ledger.migrating";
const SHARD_NAME = /^(\d{4}-\d{2})\.json$/;
/** Below this share of reply records with token counts, the transcript format is suspect. */
export const USAGE_RATIO_MIN = 0.95;
/** Median context per call of the last 7 days moving more than this against the 7 days before flags the format. */
export const DRIFT_MAX = 0.4;
/** Fewest samples on each side before a shape flag is raised. */
const SHAPE_MIN_SAMPLES = 20;
export const DAY_MS = 24 * 60 * 60_000;
/** Shape counters are kept this many days. */
const SHAPE_KEEP_DAYS = 60;
/** Quota readings of a profile closer than this replace each other. */
const QUOTA_MERGE_MS = 5 * 60_000;

/** The usage folder in the agent's config folder. */
export const usageDir = (configDir: string) => join(configDir, "usage");

export type Turn = {
  provider: string;
  key: string;
  sessionId: string;
  subagent: boolean;
  agentId?: string;
  at: number;
  model: string;
  cwd: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  tools: string[];
};

/** Where a scan stopped in one transcript file. */
export type FileMark = { path: string; dev: number; ino: number; size: number; mtimeMs: number; offset: number };
export type QuotaWindow = { utilization: number; resetsAt: number };
/** `scheduled`: read by the ledger's own schedule; `user`: a session or a person asked. */
export type QuotaVia = "scheduled" | "user";
export type QuotaPoint = { profile: string; at: number; via: QuotaVia; fiveHour?: QuotaWindow; sevenDay?: QuotaWindow };
export type ShapeDay = { records: number; withUsage: number; unknownTypes: Record<string, number> };
export type ShapeFlags = {
  /** Share of reply records with token counts over the last 7 days; 1 when there were too few. */
  usageRatio: number;
  lowUsageRatio: boolean;
  /** Median context per main-session call of the last 7 days against the 7 days before; 1 when too few. */
  driftRatio: number;
  drift: boolean;
  /** Reply content kinds of the last 7 days the reader did not know. */
  unknownTypes: string[];
};
/** Hints sent to devices: provider → session id → rule code → Unix milliseconds sent. */
export type Notified = Record<string, Record<string, Record<string, number>>>;

/** Everything but the calls: small, always in memory. */
export type LedgerIndex = {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: number;
  /** Unix milliseconds of the last scan that finished; 0 before the first. */
  lastScanAt: number;
  /** By provider, device and inode of the file. */
  files: Record<string, FileMark>;
  /** Working directory → repository key, as told when first seen. */
  dirs: Record<string, { repo: string; at: number }>;
  /** Sessions the agent opened (chat, resume, terminal), by provider then session id → first seen. */
  launched: Record<string, Record<string, number>>;
  quota: QuotaPoint[];
  notified: Notified;
  errors: { parse: number; overCap: number };
  shape: { days: Record<string, ShapeDay>; flags: ShapeFlags };
};

// --- on disk -----------------------------------------------------------------

/**
 * A turn on disk: [key, provider, session id, agent id (-1: none), subagent
 * (0/1), at, model, cwd, input, cache read, cache write, output, tools],
 * strings by their index in `strings`. Rows are checked by hand: a schema
 * library over tens of thousands of rows costs far more memory.
 */
type TurnRow = [string, number, number, number, 0 | 1, number, number, number, number, number, number, number, number[]];

const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });
const fileMarkSchema = z.object({ path: z.string(), dev: z.number(), ino: z.number(), size: z.number(), mtimeMs: z.number(), offset: z.number() });
const quotaSchema = z.array(
  z.object({ profile: z.string(), at: z.number(), via: z.enum(["scheduled", "user"]), fiveHour: windowSchema.optional(), sevenDay: windowSchema.optional() }),
);
const shapeSchema = z.object({
  days: z.record(z.string(), z.object({ records: z.number(), withUsage: z.number(), unknownTypes: z.record(z.string(), z.number()) })),
  flags: z.object({ usageRatio: z.number(), lowUsageRatio: z.boolean(), driftRatio: z.number(), drift: z.boolean(), unknownTypes: z.array(z.string()) }),
});
const commonFields = {
  createdAt: z.number(),
  lastScanAt: z.number(),
  files: z.record(z.string(), fileMarkSchema),
  dirs: z.record(z.string(), z.object({ repo: z.string(), at: z.number() })),
  launched: z.record(z.string(), z.record(z.string(), z.number())),
  quota: quotaSchema,
  errors: z.object({ parse: z.number(), overCap: z.number() }),
  shape: shapeSchema,
};
const indexSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  ...commonFields,
  notified: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number()))),
});
const shardSchema = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), month: z.string(), strings: z.array(z.unknown()), turns: z.array(z.unknown()) });
const legacySchema = z.object({ schemaVersion: z.literal(LEGACY_VERSION), ...commonFields, strings: z.array(z.unknown()), turns: z.array(z.unknown()) });

const noFlags = (): ShapeFlags => ({ usageRatio: 1, lowUsageRatio: false, driftRatio: 1, drift: false, unknownTypes: [] });

export function emptyIndex(now: number): LedgerIndex {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    lastScanAt: 0,
    files: {},
    dirs: {},
    launched: {},
    quota: [],
    notified: {},
    errors: { parse: 0, overCap: 0 },
    shape: { days: {}, flags: noFlags() },
  };
}

/** Thrown for a ledger file this agent cannot read or must not write over. */
export class LedgerUnreadable extends Error {}

function encodeTurns(turns: readonly Turn[]): { strings: string[]; turns: TurnRow[] } {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const id = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const rows: TurnRow[] = turns.map((t) => [
    t.key,
    id(t.provider),
    id(t.sessionId),
    t.agentId === undefined ? -1 : id(t.agentId),
    t.subagent ? 1 : 0,
    t.at,
    id(t.model),
    id(t.cwd),
    t.input,
    t.cacheRead,
    t.cacheWrite,
    t.output,
    t.tools.map(id),
  ]);
  return { strings, turns: rows };
}

function decodeTurns(strings: unknown[], rows: unknown[], what: string): Turn[] {
  const str = (i: unknown): string => {
    const s = typeof i === "number" ? strings[i] : undefined;
    if (typeof s !== "string") throw new LedgerUnreadable(`${what} names a string it does not hold`);
    return s;
  };
  const num = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new LedgerUnreadable(`${what} holds a call that is not numbers`);
    return v;
  };
  return rows.map((row): Turn => {
    if (!Array.isArray(row) || row.length !== 13 || typeof row[0] !== "string" || !Array.isArray(row[12])) {
      throw new LedgerUnreadable(`${what} holds a call of an unknown shape`);
    }
    const r = row as unknown[];
    const t: Turn = {
      key: row[0],
      provider: str(r[1]),
      sessionId: str(r[2]),
      subagent: r[4] === 1,
      at: num(r[5]),
      model: str(r[6]),
      cwd: str(r[7]),
      input: num(r[8]),
      cacheRead: num(r[9]),
      cacheWrite: num(r[10]),
      output: num(r[11]),
      tools: (r[12] as unknown[]).map(str),
    };
    if (num(r[3]) >= 0) t.agentId = str(r[3]);
    return t;
  });
}

function parseJson(text: string, what: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerUnreadable(`${what} is not valid JSON`);
  }
  return raw;
}

function versionOf(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
}

function cleanQuota(quota: z.infer<typeof quotaSchema>): QuotaPoint[] {
  return quota.map((q): QuotaPoint => ({
    profile: q.profile,
    at: q.at,
    via: q.via,
    ...(q.fiveHour ? { fiveHour: q.fiveHour } : {}),
    ...(q.sevenDay ? { sevenDay: q.sevenDay } : {}),
  }));
}

export function serializeIndex(d: LedgerIndex): string {
  return JSON.stringify(d);
}

export function parseIndex(text: string): LedgerIndex {
  const what = "the usage ledger's index";
  const raw = parseJson(text, what);
  const version = versionOf(raw);
  if (version !== SCHEMA_VERSION) throw new LedgerUnreadable(`${what} has schemaVersion ${String(version)}; this agent knows ${SCHEMA_VERSION}`);
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) throw new LedgerUnreadable(`${what} does not have the expected shape`);
  return { ...parsed.data, schemaVersion: SCHEMA_VERSION, quota: cleanQuota(parsed.data.quota) };
}

export function serializeShard(month: string, turns: readonly Turn[]): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, month, ...encodeTurns(turns) });
}

export function parseShard(text: string, month: string): Turn[] {
  const what = `the usage ledger's shard ${month}`;
  const raw = parseJson(text, what);
  const version = versionOf(raw);
  if (version !== SCHEMA_VERSION) throw new LedgerUnreadable(`${what} has schemaVersion ${String(version)}; this agent knows ${SCHEMA_VERSION}`);
  const parsed = shardSchema.safeParse(raw);
  if (!parsed.success || parsed.data.month !== month) throw new LedgerUnreadable(`${what} does not have the expected shape`);
  return decodeTurns(parsed.data.strings, parsed.data.turns, what);
}

/** The single-file ledger of the first version: its index part and every call. */
export function parseLegacyLedger(text: string): { index: LedgerIndex; turns: Turn[] } {
  const what = "the usage ledger";
  const raw = parseJson(text, what);
  const version = versionOf(raw);
  if (version !== LEGACY_VERSION) throw new LedgerUnreadable(`${what} has schemaVersion ${String(version)}; this agent knows ${LEGACY_VERSION} and ${SCHEMA_VERSION}`);
  const parsed = legacySchema.safeParse(raw);
  if (!parsed.success) throw new LedgerUnreadable(`${what} does not have the expected shape`);
  const { strings, turns, schemaVersion: _v, quota, ...rest } = parsed.data;
  return { index: { ...rest, schemaVersion: SCHEMA_VERSION, quota: cleanQuota(quota), notified: {} }, turns: decodeTurns(strings, turns, what) };
}

/** The legacy file's format, for tests of the migration. */
export function serializeLegacyLedger(index: LedgerIndex, turns: readonly Turn[]): string {
  const { notified: _n, schemaVersion: _v, ...rest } = index;
  return JSON.stringify({ ...rest, schemaVersion: LEGACY_VERSION, ...encodeTurns(turns) });
}

// --- days and months ---------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of `ms`, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar month of `ms`, YYYY-MM: the shard holding a call made then. */
export function localMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** The month `by` months from `month` (YYYY-MM). */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y ?? 1970, (m ?? 1) - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Local midnight starting `month` (YYYY-MM). */
export function monthStart(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1).getTime();
}

/** The months of the shards a call at `at` (or a copy of it) may sit in: its own, and a neighbour within a day. */
export function nearMonths(at: number): string[] {
  const own = localMonth(at);
  const out = [own];
  for (const m of [localMonth(at - DAY_MS), localMonth(at + DAY_MS)]) if (!out.includes(m)) out.push(m);
  return out;
}

export const contextOf = (t: Pick<Turn, "input" | "cacheRead" | "cacheWrite">) => t.input + t.cacheRead + t.cacheWrite;

/** The median of `xs` (the mean of the two middle values for an even count); 0 for none. Sorts `xs`. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  xs.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 ? (xs[mid] ?? 0) : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
}

// --- shape ---------------------------------------------------------------------

/**
 * Whether the transcripts still look as the reader expects (see ShapeFlags).
 * `turns` holds at least the calls of the last 14 days.
 */
export function shapeFlags(d: Pick<LedgerIndex, "shape">, turns: Iterable<Turn>, now: number): ShapeFlags {
  let records = 0;
  let withUsage = 0;
  const unknown = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const day = d.shape.days[localDay(now - i * DAY_MS)];
    if (!day) continue;
    records += day.records;
    withUsage += day.withUsage;
    for (const k of Object.keys(day.unknownTypes)) unknown.add(k);
  }
  const usageRatio = records >= SHAPE_MIN_SAMPLES ? withUsage / records : 1;
  const recent: number[] = [];
  const prior: number[] = [];
  for (const t of turns) {
    if (t.subagent || t.at > now) continue;
    const age = now - t.at;
    if (age < 7 * DAY_MS) recent.push(contextOf(t));
    else if (age < 14 * DAY_MS) prior.push(contextOf(t));
  }
  const enough = recent.length >= SHAPE_MIN_SAMPLES && prior.length >= SHAPE_MIN_SAMPLES;
  const priorMedian = enough ? median(prior) : 0;
  const driftRatio = enough && priorMedian > 0 ? median(recent) / priorMedian : 1;
  return {
    usageRatio,
    lowUsageRatio: usageRatio < USAGE_RATIO_MIN,
    driftRatio,
    drift: Math.abs(driftRatio - 1) > DRIFT_MAX,
    unknownTypes: [...unknown].sort(),
  };
}

// --- writing files ---------------------------------------------------------------

/** `text` into `file` through a temp file (0600), the file's last version copied to `prev` first. */
async function writeAtomic(file: string, prev: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  if (existsSync(file)) {
    await copyFile(file, prev, constants.COPYFILE_FICLONE);
    await chmod(prev, 0o600);
  }
  await rename(tmp, file);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// --- the ledger ----------------------------------------------------------------------

const fileKey = (provider: string, f: Pick<UsageFile, "dev" | "ino">) => `${provider}:${f.dev}:${f.ino}`;

/** The calls of one month in memory, by provider and key. */
type Shard = { month: string; turns: Turn[]; keys: Map<string, Map<string, Turn>>; dirty: boolean };

export type TurnQuery = {
  /** Unix milliseconds, included; absent: from the first. */
  from?: number;
  /** Unix milliseconds, excluded; absent: to the last. */
  to?: number;
  /** Only the calls this keeps. */
  keep?: (t: Turn) => boolean;
  /** Keeps the shards read in memory until release() (for work right after a scan); otherwise they are dropped. */
  hold?: boolean;
};

export type LedgerOptions = {
  now?: () => number;
  log?: (line: string) => void;
};

export class Ledger {
  readonly dir: string;
  readonly indexFile: string;
  readonly indexPrev: string;
  readonly shardDir: string;
  private data: LedgerIndex;
  /** Shards a scan or a change needs, kept until written and released. */
  private shards = new Map<string, Shard>();
  private strings = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingSave: Promise<void> | undefined;
  /** The index changed since it was written. */
  private dirty = false;
  private opened: Promise<void> | undefined;
  private blockedBy: string | undefined;
  private gen = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(dir: string, opts: LedgerOptions = {}) {
    this.dir = dir;
    this.indexFile = join(dir, INDEX_FILE);
    this.indexPrev = join(dir, INDEX_PREV);
    this.shardDir = join(dir, SHARD_DIR);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.data = emptyIndex(this.now());
  }

  /** The shard file of `month` (YYYY-MM). */
  shardFile(month: string): string {
    return join(this.shardDir, `${month}.json`);
  }

  private shardPrev(month: string): string {
    return join(this.shardDir, `${month}.prev.json`);
  }

  /** Why the ledger is neither scanned into nor written; undefined when it works. */
  get blocked(): string | undefined {
    return this.blockedBy;
  }

  /** Changes with every deletion: a scan started before one stops. */
  get generation(): number {
    return this.gen;
  }

  /** Months whose shards are in memory now (for tests of memory use). */
  get loadedMonths(): string[] {
    return [...this.shards.keys()].sort();
  }

  /** Reads the index from disk (splitting a single-file ledger first), once; every change waits for it. */
  open(): Promise<void> {
    this.opened ??= this.enqueue(() => this.load());
    return this.opened;
  }

  private async load(): Promise<void> {
    try {
      let text = await readText(this.indexFile);
      let from = this.indexFile;
      if (text === undefined) {
        // The index went missing after a copy was kept: the copy is the latest there is.
        text = await readText(this.indexPrev);
        from = this.indexPrev;
      }
      if (text === undefined) return await this.migrateLegacy();
      try {
        this.data = parseIndex(text);
      } catch (err) {
        return this.block(`${(err as Error).message} (${from}); it is left as it is until deleted (\`tunelo usage delete\`)`);
      }
      if (from === this.indexPrev) {
        this.log("usage: the ledger's index was missing; its last copy was taken");
        this.dirty = true;
      }
      // A migration that wrote its index but stopped before removing the old file.
      await this.removeLegacy();
    } catch (err) {
      this.block(`the usage ledger cannot be read (${(err as Error).message})`);
    }
  }

  /** Splits the single-file ledger of the first version into shards; nothing to do when there is none. */
  private async migrateLegacy(): Promise<void> {
    const legacyFile = join(this.dir, LEGACY_FILE);
    let text = await readText(legacyFile);
    let from = legacyFile;
    if (text === undefined) {
      text = await readText(join(this.dir, LEGACY_PREV));
      from = join(this.dir, LEGACY_PREV);
    }
    if (text === undefined) return;
    let old: { index: LedgerIndex; turns: Turn[] };
    try {
      old = parseLegacyLedger(text);
    } catch (err) {
      return this.block(`${(err as Error).message} (${from}); it is left as it is until deleted (\`tunelo usage delete\`)`);
    }
    const byMonth = new Map<string, Turn[]>();
    for (const t of old.turns) {
      const m = localMonth(t.at);
      let list = byMonth.get(m);
      if (!list) byMonth.set(m, (list = []));
      list.push(t);
    }
    const staging = join(this.dir, MIGRATING_DIR);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const [m, turns] of byMonth) await writeFile(join(staging, `${m}.json`), serializeShard(m, turns), { mode: 0o600 });
    // Read back: every call of the old file in the shards, token for token.
    const sum = (turns: readonly Turn[]) => turns.reduce((s, t) => s + contextOf(t) + t.output, 0);
    let count = 0;
    let tokens = 0;
    for (const m of byMonth.keys()) {
      const back = parseShard(await readFile(join(staging, `${m}.json`), "utf8"), m);
      count += back.length;
      tokens += sum(back);
    }
    if (count !== old.turns.length || tokens !== sum(old.turns)) {
      await rm(staging, { recursive: true, force: true });
      return this.block(`the usage ledger could not be split into monthly files (${from} is kept as it is)`);
    }
    // No index yet: a shard folder here is what an earlier, interrupted split left.
    await rm(this.shardDir, { recursive: true, force: true });
    await rename(staging, this.shardDir);
    await writeAtomic(this.indexFile, this.indexPrev, serializeIndex(old.index));
    this.data = old.index;
    await this.removeLegacy();
    this.log(`usage: the ledger was split into ${byMonth.size} monthly files (${count} calls)`);
  }

  private async removeLegacy(): Promise<void> {
    await rm(join(this.dir, LEGACY_FILE), { force: true });
    await rm(join(this.dir, LEGACY_PREV), { force: true });
  }

  private block(reason: string): void {
    this.blockedBy = reason;
    this.log(`usage: ${reason}`);
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One copy of each repeated string (session ids, folders, models) in memory. */
  private intern(s: string): string {
    const hit = this.strings.get(s);
    if (hit !== undefined) return hit;
    this.strings.set(s, s);
    return s;
  }

  /** Runs a change of the index after every change and write queued before it; refused while blocked. */
  update(fn: (d: LedgerIndex) => void): Promise<void> {
    void this.open();
    return this.enqueue(() => {
      if (this.blockedBy) throw new LedgerUnreadable(this.blockedBy);
      fn(this.data);
      this.dirty = true;
    });
  }

  /** Writes what changed, after everything queued before; calls close together share one write. */
  save(): Promise<void> {
    void this.open();
    this.pendingSave ??= this.enqueue(async () => {
      this.pendingSave = undefined;
      if (this.blockedBy) return;
      await this.write();
    });
    return this.pendingSave;
  }

  private async write(): Promise<void> {
    const shards = [...this.shards.values()].filter((s) => s.dirty);
    if (shards.length === 0 && !this.dirty) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (shards.length > 0) await mkdir(this.shardDir, { recursive: true, mode: 0o700 });
    for (const s of shards) {
      // The text is made in one go, so a change queued later is not half in it.
      const text = serializeShard(s.month, s.turns);
      s.dirty = false;
      try {
        await writeAtomic(this.shardFile(s.month), this.shardPrev(s.month), text);
      } catch (err) {
        s.dirty = true;
        throw err;
      }
    }
    if (!this.dirty) return;
    const text = serializeIndex(this.data);
    this.dirty = false;
    try {
      await writeAtomic(this.indexFile, this.indexPrev, text);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  /** Lets go of the shards in memory that are written (after a scan); the next one reads them again. */
  release(): Promise<void> {
    return this.enqueue(() => {
      for (const [m, s] of this.shards) if (!s.dirty) this.shards.delete(m);
      if (this.shards.size === 0) this.strings.clear();
    });
  }

  /**
   * Deletes the ledger (index, every shard, their copies, any unfinished
   * write, a single-file ledger) and starts an empty one, also when it was
   * blocked. A scan under way stops.
   */
  delete(): Promise<void> {
    this.gen++;
    return this.enqueue(async () => {
      await deleteLedgerFiles(this.dir);
      this.data = emptyIndex(this.now());
      this.shards.clear();
      this.strings.clear();
      this.blockedBy = undefined;
      this.dirty = false;
    });
  }

  /** The index as it is now; read only. */
  snapshot(): Readonly<LedgerIndex> {
    return this.data;
  }

  /** Where to continue reading `file`: 0 for a file not seen, replaced (another inode or path) or cut shorter. */
  offsetFor(provider: string, file: UsageFile): number {
    const mark = this.data.files[fileKey(provider, file)];
    if (!mark || mark.path !== file.path || file.size < mark.offset) return 0;
    return mark.offset;
  }

  /** Months that have a shard, on disk or in memory, in order. */
  private async months(): Promise<string[]> {
    const found = new Set(this.shards.keys());
    let names: string[] = [];
    try {
      names = await readdir(this.shardDir);
    } catch {
      // no shard yet
    }
    for (const n of names) {
      const m = SHARD_NAME.exec(n)?.[1];
      if (m) found.add(m);
      // A shard lost after its copy was kept still counts.
      const p = /^(\d{4}-\d{2})\.prev\.json$/.exec(n)?.[1];
      if (p) found.add(p);
    }
    return [...found].sort();
  }

  /** The calls of `month` from disk (its copy when the shard itself is missing); undefined when it has none. Blocks on a bad file. */
  private async readShard(month: string): Promise<{ turns: Turn[]; fromCopy: boolean } | undefined> {
    let text = await readText(this.shardFile(month));
    let fromCopy = false;
    if (text === undefined) {
      text = await readText(this.shardPrev(month));
      fromCopy = text !== undefined;
    }
    if (text === undefined) return undefined;
    try {
      return { turns: parseShard(text, month), fromCopy };
    } catch (err) {
      this.block(`${(err as Error).message}; it is left as it is until deleted (\`tunelo usage delete\`)`);
      throw new LedgerUnreadable(this.blockedBy);
    }
  }

  /** The shard of `month` in memory, read from disk once; undefined when it has none and `create` is false. */
  private async shard(month: string, create: boolean): Promise<Shard | undefined> {
    const hit = this.shards.get(month);
    if (hit) return hit;
    const disk = await this.readShard(month);
    if (!disk && !create) return undefined;
    const s: Shard = { month, turns: [], keys: new Map(), dirty: disk?.fromCopy ?? false };
    if (disk?.fromCopy) this.log(`usage: the ledger's shard ${month} was missing; its last copy was taken`);
    for (const t of disk?.turns ?? []) {
      t.provider = this.intern(t.provider);
      t.sessionId = this.intern(t.sessionId);
      t.model = this.intern(t.model);
      t.cwd = this.intern(t.cwd);
      if (t.agentId !== undefined) t.agentId = this.intern(t.agentId);
      t.tools = t.tools.map((x) => this.intern(x));
      this.keysOf(s, t.provider).set(t.key, t);
      s.turns.push(t);
    }
    this.shards.set(month, s);
    return s;
  }

  private keysOf(s: Shard, provider: string): Map<string, Turn> {
    let m = s.keys.get(provider);
    if (!m) s.keys.set(provider, (m = new Map()));
    return m;
  }

  /**
   * Adds what a read of `file` found: its calls (counted once on the
   * machine), where the read stopped, and what it saw of the format. New
   * working directories get their repository key from `repoKey`. Nothing is
   * added when the ledger was deleted since generation `gen`. Resolves with
   * the number of calls not in the ledger before.
   */
  apply(provider: string, file: UsageFile, read: UsageRead, repoKey: (cwd: string) => string, gen = this.gen): Promise<number> {
    void this.open();
    return this.enqueue(async () => {
      if (this.blockedBy) throw new LedgerUnreadable(this.blockedBy);
      if (gen !== this.gen) return 0;
      const near = new Set<string>();
      for (const t of read.turns) for (const m of nearMonths(t.at)) near.add(m);
      for (const m of near) await this.shard(m, false);
      const p = this.intern(provider);
      const d = this.data;
      let added = 0;
      for (const t of read.turns) {
        const month = localMonth(t.at);
        const found = this.find(p, t.key, t.at);
        const output = t.outputTokens ?? 0;
        if (!found) {
          const turn: Turn = {
            provider: p,
            key: t.key,
            sessionId: this.intern(t.sessionId),
            subagent: t.subagent,
            at: t.at,
            model: this.intern(t.model),
            cwd: this.intern(t.cwd),
            input: t.inputTokens ?? 0,
            cacheRead: t.cacheReadTokens ?? 0,
            cacheWrite: t.cacheWriteTokens ?? 0,
            output,
            tools: t.tools.map((x) => this.intern(x)),
          };
          if (t.agentId !== undefined) turn.agentId = this.intern(t.agentId);
          await this.put(month, turn);
          added++;
        } else {
          const { turn, shard } = found;
          if (t.at < turn.at || (t.at === turn.at && turn.subagent && !t.subagent)) {
            turn.sessionId = this.intern(t.sessionId);
            turn.subagent = t.subagent;
            if (t.agentId !== undefined) turn.agentId = this.intern(t.agentId);
            else delete turn.agentId;
            turn.at = t.at;
            turn.model = this.intern(t.model);
            turn.cwd = this.intern(t.cwd);
            turn.input = t.inputTokens ?? 0;
            turn.cacheRead = t.cacheReadTokens ?? 0;
            turn.cacheWrite = t.cacheWriteTokens ?? 0;
            if (shard.month !== month) {
              // The earlier copy belongs to another month: the call moves there.
              shard.turns.splice(shard.turns.indexOf(turn), 1);
              this.keysOf(shard, p).delete(turn.key);
              await this.put(month, turn);
            }
          }
          turn.output = Math.max(turn.output, output);
          // One reply is written as several records, a tool on each.
          for (const tool of t.tools) if (!turn.tools.includes(tool)) turn.tools.push(this.intern(tool));
          shard.dirty = true;
        }
        if (t.cwd && !d.dirs[t.cwd]) d.dirs[this.intern(t.cwd)] = { repo: repoKey(t.cwd), at: this.now() };
      }
      d.files[fileKey(p, file)] = { path: file.path, dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, offset: read.end };
      this.addStats(d, read.stats);
      this.dirty = true;
      return added;
    });
  }

  private find(provider: string, key: string, at: number): { turn: Turn; shard: Shard } | undefined {
    for (const m of nearMonths(at)) {
      const shard = this.shards.get(m);
      const turn = shard?.keys.get(provider)?.get(key);
      if (shard && turn) return { turn, shard };
    }
    return undefined;
  }

  private async put(month: string, turn: Turn): Promise<void> {
    const s = await this.shard(month, true);
    if (!s) return;
    s.turns.push(turn);
    this.keysOf(s, turn.provider).set(turn.key, turn);
    s.dirty = true;
  }

  private addStats(d: LedgerIndex, s: UsageLineStats): void {
    d.errors.parse += s.parseErrors;
    d.errors.overCap += s.overCap;
    if (s.records === 0 && Object.keys(s.unknownTypes).length === 0) return;
    const key = localDay(this.now());
    const day = (d.shape.days[key] ??= { records: 0, withUsage: 0, unknownTypes: {} });
    day.records += s.records;
    day.withUsage += s.withUsage;
    for (const [k, n] of Object.entries(s.unknownTypes)) day.unknownTypes[k] = (day.unknownTypes[k] ?? 0) + n;
  }

  /** Forgets the files of `provider` that a full listing no longer found (their calls stay). Run inside update(). */
  forgetFiles(d: LedgerIndex, provider: string, seen: readonly UsageFile[]): void {
    const keep = new Set(seen.map((f) => fileKey(provider, f)));
    const prefix = `${provider}:`;
    d.files = Object.fromEntries(Object.entries(d.files).filter(([k]) => !k.startsWith(prefix) || keep.has(k)));
  }

  /**
   * Ends a scan: its time, the format check (when `check`: the scan read
   * something; it reads the shards of the last 14 days), and shape counters
   * older than kept.
   */
  finishScan(check = true): Promise<void> {
    return this.enqueue(async () => {
      if (this.blockedBy) throw new LedgerUnreadable(this.blockedBy);
      const now = this.now();
      const d = this.data;
      d.lastScanAt = now;
      if (check) d.shape.flags = shapeFlags(d, await this.collect({ from: now - 14 * DAY_MS, to: now + 1, keep: (t) => !t.subagent, hold: true }), now);
      const oldest = localDay(now - SHAPE_KEEP_DAYS * DAY_MS);
      d.shape.days = Object.fromEntries(Object.entries(d.shape.days).filter(([day]) => day >= oldest));
      this.dirty = true;
    });
  }

  /**
   * The calls in a time range, shard by shard: shards in memory as they are,
   * the others read from disk and dropped after (only the calls kept stay)
   * unless `hold`. Read only. Rejects while blocked.
   */
  turns(q: TurnQuery = {}): Promise<Turn[]> {
    void this.open();
    return this.enqueue(() => {
      if (this.blockedBy) throw new LedgerUnreadable(this.blockedBy);
      return this.collect(q);
    });
  }

  private async collect(q: TurnQuery): Promise<Turn[]> {
    const out: Turn[] = [];
    const from = q.from ?? Number.NEGATIVE_INFINITY;
    const to = q.to ?? Number.POSITIVE_INFINITY;
    for (const m of await this.months()) {
      // A month's shard may hold a call up to a day outside it (another time zone): look one day wider.
      if (monthStart(shiftMonth(m, 1)) + DAY_MS <= from || monthStart(m) - DAY_MS >= to) continue;
      const turns = (q.hold ? await this.shard(m, false) : this.shards.get(m))?.turns ?? (await this.readShard(m))?.turns ?? [];
      for (const t of turns) if (t.at >= from && t.at < to && (!q.keep || q.keep(t))) out.push(t);
    }
    return out;
  }

  /** Records plan usage of a profile; readings of the same kind within minutes replace each other. */
  recordQuota(profile: string, usage: { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }, via: QuotaVia): Promise<void> {
    const at = this.now();
    const point: QuotaPoint = { profile, at, via };
    const win = (w: QuotaWindow | undefined) =>
      w && Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt) ? { utilization: w.utilization, resetsAt: w.resetsAt } : undefined;
    const fiveHour = win(usage.fiveHour);
    const sevenDay = win(usage.sevenDay);
    if (fiveHour) point.fiveHour = fiveHour;
    if (sevenDay) point.sevenDay = sevenDay;
    if (!fiveHour && !sevenDay) return Promise.resolve();
    return this.update((d) => {
      const last = d.quota.findLast((q) => q.profile === profile);
      if (last && last.via === via && at - last.at < QUOTA_MERGE_MS) d.quota[d.quota.lastIndexOf(last)] = point;
      else d.quota.push(point);
    });
  }

  /** When the hint of `rule` for a session was sent; undefined when it was not. */
  notifiedAt(provider: string, sessionId: string, rule: string): number | undefined {
    return this.data.notified[provider]?.[sessionId]?.[rule];
  }

  /** Records hints sent to devices at `at` (a hint already recorded keeps its first time). */
  recordNotified(hints: readonly { provider: string; sessionId: string; rule: string }[], at: number): Promise<void> {
    return this.update((d) => {
      for (const h of hints) {
        const bySession = (d.notified[h.provider] ??= {});
        const byRule = (bySession[h.sessionId] ??= {});
        byRule[h.rule] ??= at;
      }
    });
  }
}

/** Deletes the ledger files in `dir`: index, shards, their copies, unfinished writes, a single-file ledger. */
export async function deleteLedgerFiles(dir: string): Promise<void> {
  for (const f of [INDEX_FILE, INDEX_PREV, LEGACY_FILE, LEGACY_PREV]) await rm(join(dir, f), { force: true });
  await rm(join(dir, SHARD_DIR), { recursive: true, force: true });
  await rm(join(dir, MIGRATING_DIR), { recursive: true, force: true });
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if ((n.startsWith(`${INDEX_FILE}.`) || n.startsWith(`${LEGACY_FILE}.`)) && n.endsWith(".tmp")) await rm(join(dir, n), { force: true });
  }
}
