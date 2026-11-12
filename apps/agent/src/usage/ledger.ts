// The usage ledger: what the AIs' transcripts on this machine say about
// token usage, kept in <config>/usage/ledger.json after the transcripts are
// gone (Claude Code deletes its own after about a month). Numbers and the
// minimal metadata of each call only (see docs/privacy/data-inventory.md):
// never a message, a tool's input or its result.
//
// One queue runs every change (a scan's file, a quota reading, an app
// session) and every write, in order, so none is lost to another. A write
// goes to a temp file renamed over the ledger (mode 0600) after the last
// ledger is copied to ledger.prev.json. A ledger that cannot be read, or
// that a newer agent wrote (an unknown schemaVersion), is never written over:
// the ledger stays blocked until it is deleted.
//
// A call is counted once on the whole machine (its key may be copied into a
// resumed or forked session): it belongs to the occurrence with the earliest
// time, a subagent's copy giving way to the main session's at the same time;
// its output tokens are the largest any occurrence reports.
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { UsageFile, UsageLineStats, UsageRead } from "../providers/types.ts";

export const SCHEMA_VERSION = 1;
export const LEDGER_FILE = "ledger.json";
export const PREV_FILE = "ledger.prev.json";
/** Below this share of reply records with token counts, the transcript format is suspect. */
export const USAGE_RATIO_MIN = 0.95;
/** Context per call moving more than this against the 7 days before flags the format. */
export const DRIFT_MAX = 0.3;
/** Fewest samples on each side before a shape flag is raised. */
const SHAPE_MIN_SAMPLES = 20;
const DAY_MS = 24 * 60 * 60_000;
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
  /** Mean context per main-session call of the last day against the 7 days before; 1 when too few. */
  driftRatio: number;
  drift: boolean;
  /** Reply content kinds of the last 7 days the reader did not know. */
  unknownTypes: string[];
};

export type LedgerData = {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: number;
  /** Unix milliseconds of the last scan that finished; 0 before the first. */
  lastScanAt: number;
  turns: Turn[];
  /** By provider, device and inode of the file. */
  files: Record<string, FileMark>;
  /** Working directory → repository key, as told when first seen. */
  dirs: Record<string, { repo: string; at: number }>;
  /** Sessions the agent opened (chat, resume, terminal), by provider then session id → first seen. */
  launched: Record<string, Record<string, number>>;
  quota: QuotaPoint[];
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
const diskSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: z.number(),
  lastScanAt: z.number(),
  strings: z.array(z.unknown()),
  turns: z.array(z.unknown()),
  files: z.record(z.string(), z.object({ path: z.string(), dev: z.number(), ino: z.number(), size: z.number(), mtimeMs: z.number(), offset: z.number() })),
  dirs: z.record(z.string(), z.object({ repo: z.string(), at: z.number() })),
  launched: z.record(z.string(), z.record(z.string(), z.number())),
  quota: z.array(
    z.object({ profile: z.string(), at: z.number(), via: z.enum(["scheduled", "user"]), fiveHour: windowSchema.optional(), sevenDay: windowSchema.optional() }),
  ),
  errors: z.object({ parse: z.number(), overCap: z.number() }),
  shape: z.object({
    days: z.record(z.string(), z.object({ records: z.number(), withUsage: z.number(), unknownTypes: z.record(z.string(), z.number()) })),
    flags: z.object({ usageRatio: z.number(), lowUsageRatio: z.boolean(), driftRatio: z.number(), drift: z.boolean(), unknownTypes: z.array(z.string()) }),
  }),
});

const noFlags = (): ShapeFlags => ({ usageRatio: 1, lowUsageRatio: false, driftRatio: 1, drift: false, unknownTypes: [] });

export function emptyLedger(now: number): LedgerData {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    lastScanAt: 0,
    turns: [],
    files: {},
    dirs: {},
    launched: {},
    quota: [],
    errors: { parse: 0, overCap: 0 },
    shape: { days: {}, flags: noFlags() },
  };
}

export function serializeLedger(d: LedgerData): string {
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
  const turns: TurnRow[] = d.turns.map((t) => [
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
  const { turns: _turns, ...rest } = d;
  return JSON.stringify({ ...rest, strings, turns });
}

/** Thrown for a ledger file this agent cannot read or must not write over. */
export class LedgerUnreadable extends Error {}

export function parseLedger(text: string): LedgerData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerUnreadable("the usage ledger is not valid JSON");
  }
  const version = typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== SCHEMA_VERSION) throw new LedgerUnreadable(`the usage ledger has schemaVersion ${String(version)}; this agent knows ${SCHEMA_VERSION}`);
  const parsed = diskSchema.safeParse(raw);
  if (!parsed.success) throw new LedgerUnreadable("the usage ledger does not have the expected shape");
  const { strings, turns: rows, ...rest } = parsed.data;
  const str = (i: unknown): string => {
    const s = typeof i === "number" ? strings[i] : undefined;
    if (typeof s !== "string") throw new LedgerUnreadable("the usage ledger names a string it does not hold");
    return s;
  };
  const num = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new LedgerUnreadable("the usage ledger holds a call that is not numbers");
    return v;
  };
  const turns = rows.map((row): Turn => {
    if (!Array.isArray(row) || row.length !== 13 || typeof row[0] !== "string" || !Array.isArray(row[12])) {
      throw new LedgerUnreadable("the usage ledger holds a call of an unknown shape");
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
  const quota = rest.quota.map((q): QuotaPoint => ({
    profile: q.profile,
    at: q.at,
    via: q.via,
    ...(q.fiveHour ? { fiveHour: q.fiveHour } : {}),
    ...(q.sevenDay ? { sevenDay: q.sevenDay } : {}),
  }));
  return { ...rest, quota, turns };
}

// --- shape ---------------------------------------------------------------------

/** The local calendar day of `ms`, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const contextOf = (t: Pick<Turn, "input" | "cacheRead" | "cacheWrite">) => t.input + t.cacheRead + t.cacheWrite;

/** Whether the transcripts still look as the reader expects (see ShapeFlags). */
export function shapeFlags(d: LedgerData, now: number): ShapeFlags {
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
  let recentSum = 0;
  let recentN = 0;
  let priorSum = 0;
  let priorN = 0;
  for (const t of d.turns) {
    if (t.subagent || t.at > now) continue;
    const age = now - t.at;
    if (age < DAY_MS) {
      recentSum += contextOf(t);
      recentN++;
    } else if (age < 8 * DAY_MS) {
      priorSum += contextOf(t);
      priorN++;
    }
  }
  const driftRatio = recentN >= SHAPE_MIN_SAMPLES && priorN >= SHAPE_MIN_SAMPLES && priorSum > 0 ? recentSum / recentN / (priorSum / priorN) : 1;
  return {
    usageRatio,
    lowUsageRatio: usageRatio < USAGE_RATIO_MIN,
    driftRatio,
    drift: Math.abs(driftRatio - 1) > DRIFT_MAX,
    unknownTypes: [...unknown].sort(),
  };
}

// --- the ledger ----------------------------------------------------------------------

const fileKey = (provider: string, f: Pick<UsageFile, "dev" | "ino">) => `${provider}:${f.dev}:${f.ino}`;

export type LedgerOptions = {
  now?: () => number;
  log?: (line: string) => void;
};

export class Ledger {
  readonly dir: string;
  readonly file: string;
  readonly prevFile: string;
  private data: LedgerData;
  /** Each provider's calls by their key. */
  private index = new Map<string, Map<string, Turn>>();
  private strings = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingSave: Promise<void> | undefined;
  private dirty = false;
  private opened: Promise<void> | undefined;
  private blockedBy: string | undefined;
  private gen = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(dir: string, opts: LedgerOptions = {}) {
    this.dir = dir;
    this.file = join(dir, LEDGER_FILE);
    this.prevFile = join(dir, PREV_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.data = emptyLedger(this.now());
  }

  /** Why the ledger is neither scanned into nor written; undefined when it works. */
  get blocked(): string | undefined {
    return this.blockedBy;
  }

  /** Changes with every deletion: a scan started before one stops. */
  get generation(): number {
    return this.gen;
  }

  /** Reads the ledger from disk, once; every change waits for it. */
  open(): Promise<void> {
    this.opened ??= this.enqueue(() => this.load());
    return this.opened;
  }

  private async load(): Promise<void> {
    let text: string | undefined;
    let from = this.file;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.block(`the usage ledger cannot be read (${(err as Error).message})`);
        return;
      }
    }
    if (text === undefined && existsSync(this.prevFile)) {
      // The ledger went missing after a copy was kept: the copy is the latest there is.
      text = await readFile(this.prevFile, "utf8").catch(() => undefined);
      from = this.prevFile;
    }
    if (text === undefined) return;
    try {
      this.data = parseLedger(text);
    } catch (err) {
      this.block(`${(err as Error).message} (${from}); it is left as it is until deleted (\`tunelo usage delete\`)`);
      return;
    }
    this.reindex();
    if (from === this.prevFile) {
      this.log("usage: the ledger was missing; its last copy was taken");
      this.dirty = true;
    }
  }

  private block(reason: string): void {
    this.blockedBy = reason;
    this.log(`usage: ${reason}`);
  }

  private reindex(): void {
    this.index.clear();
    this.strings.clear();
    for (const t of this.data.turns) {
      t.provider = this.intern(t.provider);
      t.sessionId = this.intern(t.sessionId);
      t.model = this.intern(t.model);
      t.cwd = this.intern(t.cwd);
      if (t.agentId !== undefined) t.agentId = this.intern(t.agentId);
      t.tools = t.tools.map((x) => this.intern(x));
      this.calls(t.provider).set(t.key, t);
    }
  }

  private calls(provider: string): Map<string, Turn> {
    let m = this.index.get(provider);
    if (!m) {
      m = new Map();
      this.index.set(provider, m);
    }
    return m;
  }

  /** One copy of each repeated string (session ids, folders, models) in memory. */
  private intern(s: string): string {
    const hit = this.strings.get(s);
    if (hit !== undefined) return hit;
    this.strings.set(s, s);
    return s;
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs a change after every change and write queued before it; refused while blocked. */
  update(fn: (d: LedgerData) => void): Promise<void> {
    void this.open();
    return this.enqueue(() => {
      if (this.blockedBy) throw new LedgerUnreadable(this.blockedBy);
      fn(this.data);
      this.dirty = true;
    });
  }

  /** Writes the ledger when it changed, after everything queued before; calls close together share one write. */
  save(): Promise<void> {
    void this.open();
    this.pendingSave ??= this.enqueue(async () => {
      this.pendingSave = undefined;
      if (!this.dirty || this.blockedBy) return;
      await this.write();
    });
    return this.pendingSave;
  }

  private async write(): Promise<void> {
    // The text is made in one go, so a change queued later is not half in it.
    const text = serializeLedger(this.data);
    this.dirty = false;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      if (existsSync(this.file)) {
        await copyFile(this.file, this.prevFile, constants.COPYFILE_FICLONE);
        await chmod(this.prevFile, 0o600);
      }
      await rename(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  /**
   * Deletes the ledger, its copy and any unfinished write, and starts an
   * empty one (also when the ledger was blocked). A scan under way stops.
   */
  delete(): Promise<void> {
    this.gen++;
    return this.enqueue(async () => {
      await deleteLedgerFiles(this.dir);
      this.data = emptyLedger(this.now());
      this.index.clear();
      this.strings.clear();
      this.blockedBy = undefined;
      this.dirty = false;
    });
  }

  /** What the ledger holds now; read only. */
  snapshot(): Readonly<LedgerData> {
    return this.data;
  }

  /** Where to continue reading `file`: 0 for a file not seen, replaced (another inode or path) or cut shorter. */
  offsetFor(provider: string, file: UsageFile): number {
    const mark = this.data.files[fileKey(provider, file)];
    if (!mark || mark.path !== file.path || file.size < mark.offset) return 0;
    return mark.offset;
  }

  /**
   * Adds what a read of `file` found: its calls (counted once on the
   * machine), where the read stopped, and what it saw of the format. New
   * working directories get their repository key from `repoKey`.
   * Run inside update().
   */
  applyRead(d: LedgerData, provider: string, file: UsageFile, read: UsageRead, repoKey: (cwd: string) => string): number {
    let added = 0;
    const p = this.intern(provider);
    const calls = this.calls(p);
    for (const t of read.turns) {
      const found = calls.get(t.key);
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
        d.turns.push(turn);
        calls.set(t.key, turn);
        added++;
      } else {
        if (t.at < found.at || (t.at === found.at && found.subagent && !t.subagent)) {
          found.sessionId = this.intern(t.sessionId);
          found.subagent = t.subagent;
          if (t.agentId !== undefined) found.agentId = this.intern(t.agentId);
          else delete found.agentId;
          found.at = t.at;
          found.model = this.intern(t.model);
          found.cwd = this.intern(t.cwd);
          found.input = t.inputTokens ?? 0;
          found.cacheRead = t.cacheReadTokens ?? 0;
          found.cacheWrite = t.cacheWriteTokens ?? 0;
        }
        found.output = Math.max(found.output, output);
        // One reply is written as several records, a tool on each.
        for (const tool of t.tools) if (!found.tools.includes(tool)) found.tools.push(this.intern(tool));
      }
      if (t.cwd && !d.dirs[t.cwd]) d.dirs[t.cwd] = { repo: repoKey(t.cwd), at: this.now() };
    }
    d.files[fileKey(p, file)] = { path: file.path, dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, offset: read.end };
    this.addStats(d, read.stats);
    return added;
  }

  private addStats(d: LedgerData, s: UsageLineStats): void {
    d.errors.parse += s.parseErrors;
    d.errors.overCap += s.overCap;
    if (s.records === 0 && Object.keys(s.unknownTypes).length === 0) return;
    const key = localDay(this.now());
    const day = (d.shape.days[key] ??= { records: 0, withUsage: 0, unknownTypes: {} });
    day.records += s.records;
    day.withUsage += s.withUsage;
    for (const [k, n] of Object.entries(s.unknownTypes)) day.unknownTypes[k] = (day.unknownTypes[k] ?? 0) + n;
  }

  /** Forgets the files of `provider` that a full listing no longer found (their calls stay). */
  forgetFiles(d: LedgerData, provider: string, seen: readonly UsageFile[]): void {
    const keep = new Set(seen.map((f) => fileKey(provider, f)));
    const prefix = `${provider}:`;
    d.files = Object.fromEntries(Object.entries(d.files).filter(([k]) => !k.startsWith(prefix) || keep.has(k)));
  }

  /** Ends a scan: its time, the format check, and shape counters older than kept. */
  finishScan(d: LedgerData): void {
    const now = this.now();
    d.lastScanAt = now;
    d.shape.flags = shapeFlags(d, now);
    const oldest = localDay(now - SHAPE_KEEP_DAYS * DAY_MS);
    d.shape.days = Object.fromEntries(Object.entries(d.shape.days).filter(([day]) => day >= oldest));
  }

  /** Records a profile's plan usage; readings of the same kind within minutes replace each other. */
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
}

/** Deletes the ledger files in `dir` (the ledger, its copy, unfinished writes). */
export async function deleteLedgerFiles(dir: string): Promise<void> {
  await rm(join(dir, LEDGER_FILE), { force: true });
  await rm(join(dir, PREV_FILE), { force: true });
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith(`${LEDGER_FILE}.`) && n.endsWith(".tmp")) await rm(join(dir, n), { force: true });
}
