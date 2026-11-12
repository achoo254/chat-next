// Scans the AIs' transcripts into the usage ledger: shortly after the agent
// starts, then every 15 minutes, one scan at a time. Only what was appended
// since the last scan is read (a file is read again from the start when it
// was replaced or cut shorter); the event loop gets a turn between files, and
// the ledger is written every CHECKPOINT_FILES files read, so a scan stopped
// halfway loses little. Every 30 minutes, when the scans found new calls,
// the plan usage of each profile is read too (marked as scheduled).
//
// The core knows no AI: each provider with a `usage` source is scanned the
// same way.
import type { UsageSource } from "../providers/types.ts";
import { LaunchedSessions } from "./launched-sessions.ts";
import { Ledger, type QuotaVia, type QuotaWindow, usageDir } from "./ledger.ts";
import { repoKeyOf } from "./repo-key.ts";

export const SCAN_EVERY_MS = 15 * 60_000;
export const QUOTA_EVERY_MS = 30 * 60_000;
export const CHECKPOINT_FILES = 50;
const FIRST_SCAN_DELAY_MS = 5_000;
/**
 * Bun, the agent's runtime, collects garbage lazily: a cold scan parses
 * gigabytes of transcript lines, so it asks for a collection after reading
 * this much, which keeps the scan's peak memory low on a shared machine.
 */
const COLLECT_EVERY_BYTES = 32 * 1024 * 1024;

export type UsageSourceEntry = { provider: string; usage: UsageSource };

export type UsageSchedulerOptions = {
  /** The agent's config folder; the ledger lives in its usage/ folder. */
  configDir: string;
  /** The providers that read usage from their transcripts. */
  sources: () => UsageSourceEntry[];
  /** Reads the plan usage of every profile again (the results come back through recordQuota). */
  refreshQuota?: () => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  scanEveryMs?: number;
  quotaEveryMs?: number;
  firstScanDelayMs?: number;
  checkpointFiles?: number;
  repoKey?: (cwd: string) => string;
};

export type ScanSummary = {
  /** Transcript files found. */
  files: number;
  /** Of those, files read (new or appended to). */
  read: number;
  /** Calls not in the ledger before. */
  added: number;
  /** Files that could not be read. */
  failed: number;
  ms: number;
  /** Stopped before the end (the agent stopped, or the ledger was deleted). */
  stopped: boolean;
};

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A full collection where the runtime offers one (Bun); nothing elsewhere. */
function collectGarbage(): void {
  (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
}

export class UsageScheduler {
  readonly ledger: Ledger;
  readonly launched: LaunchedSessions;
  private running: Promise<ScanSummary | undefined> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private lastQuotaAt = 0;
  private addedSinceQuota = 0;
  private quotaRunning = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: UsageSchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.ledger = new Ledger(usageDir(opts.configDir), { now: this.now, log: this.log });
    this.launched = new LaunchedSessions(this.ledger, this.log);
  }

  /** True while the scheduled reading of plan usage runs: readings now are "scheduled". */
  get refreshingQuota(): boolean {
    return this.quotaRunning;
  }

  /** The first scan shortly, then one every 15 minutes. */
  start(): void {
    this.stopping = false;
    void this.ledger.open();
    this.firstTimer = setTimeout(() => void this.run(), this.opts.firstScanDelayMs ?? FIRST_SCAN_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.run(), this.opts.scanEveryMs ?? SCAN_EVERY_MS);
    this.timer.unref?.();
  }

  /** Stops the schedule and the scan under way, and writes what it found so far. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    await this.running;
    await this.ledger.save().catch((err: unknown) => this.log(`usage: ledger not written (${(err as Error).message})`));
  }

  /** Records plan usage read for a profile, as scheduled while the schedule reads it. */
  recordQuota(profile: string, usage: { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }, via?: QuotaVia): void {
    void this.ledger
      .recordQuota(profile, usage, via ?? (this.quotaRunning ? "scheduled" : "user"))
      .then(() => this.ledger.save())
      .catch((err: unknown) => this.log(`usage: plan usage not recorded (${(err as Error).message})`));
  }

  /** Deletes the ledger (and its copy); a scan under way stops, the next one starts from nothing. */
  async deleteLedger(): Promise<void> {
    await this.ledger.delete();
    this.addedSinceQuota = 0;
  }

  /** Runs a scan now, or joins the one under way. Undefined when the ledger is blocked. */
  run(): Promise<ScanSummary | undefined> {
    this.running ??= this.scan()
      .catch((err: unknown) => {
        this.log(`usage: scan failed (${(err as Error).message})`);
        return undefined;
      })
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async scan(): Promise<ScanSummary | undefined> {
    const ledger = this.ledger;
    // Taken before anything waits, so a deletion right after the scan was asked for stops it.
    const gen = ledger.generation;
    await ledger.open();
    if (ledger.blocked) return undefined;
    const started = this.now();
    const repoKey = this.opts.repoKey ?? repoKeyOf;
    const every = this.opts.checkpointFiles ?? CHECKPOINT_FILES;
    const summary: ScanSummary = { files: 0, read: 0, added: 0, failed: 0, ms: 0, stopped: false };
    const halted = () => this.stopping || ledger.generation !== gen;
    let sinceCollect = 0;
    for (const { provider, usage } of this.opts.sources()) {
      const files = await usage.files();
      summary.files += files.length;
      for (const file of files) {
        if (halted()) break;
        const from = ledger.offsetFor(provider, file);
        if (from === file.size) continue;
        let read;
        try {
          read = await usage.read(file, from);
        } catch (err) {
          summary.failed++;
          if (summary.failed === 1) this.log(`usage: a transcript could not be read (${(err as Error).message})`);
          continue;
        }
        await ledger.update((d) => {
          if (ledger.generation !== gen) return;
          summary.added += ledger.applyRead(d, provider, file, read, repoKey);
        });
        summary.read++;
        sinceCollect += file.size - from;
        if (summary.read % every === 0) {
          await ledger.save();
          // A checkpoint leaves the ledger's text behind as garbage too.
          sinceCollect = COLLECT_EVERY_BYTES;
        }
        if (sinceCollect >= COLLECT_EVERY_BYTES) {
          sinceCollect = 0;
          collectGarbage();
        }
        await yieldLoop();
      }
      if (halted()) break;
      await ledger.update((d) => {
        if (ledger.generation === gen) ledger.forgetFiles(d, provider, files);
      });
    }
    summary.stopped = halted();
    if (!summary.stopped) await ledger.update((d) => ledger.finishScan(d));
    await ledger.save();
    summary.ms = this.now() - started;
    this.addedSinceQuota += summary.added;
    if (!summary.stopped) await this.maybeRefreshQuota();
    return summary;
  }

  private async maybeRefreshQuota(): Promise<void> {
    const refresh = this.opts.refreshQuota;
    if (!refresh || this.addedSinceQuota === 0) return;
    if (this.now() - this.lastQuotaAt < (this.opts.quotaEveryMs ?? QUOTA_EVERY_MS)) return;
    this.lastQuotaAt = this.now();
    this.addedSinceQuota = 0;
    this.quotaRunning = true;
    try {
      await refresh();
    } catch (err) {
      this.log(`usage: plan usage not read (${(err as Error).message})`);
    } finally {
      this.quotaRunning = false;
    }
  }
}
