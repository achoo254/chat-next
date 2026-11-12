// Tells devices that look at a workspace what changed in it, while one does.
// File events (fs.watch, recursive) are gathered for 125 ms (at most 1 s
// under a steady stream) into the folders that changed; folders that only
// hold build output or dependencies are left out. git's status is looked at
// again after a change, at most every 3 s, and every 60 s in any case
// (events can be lost); devices hear `git` only when it differs. Nothing is
// watched or read while no device looks. Where files cannot be watched (the
// system refuses, or Linux, where a recursive watch would hold a watch on
// every folder of the tree, node_modules included), it polls instead: git's
// status every 10 s, told as git and overflow (read the open folders again),
// with `polling` set so devices can say so.
import { type FSWatcher, watch as fsWatch } from "node:fs";

export type WorkspaceChange = { dirs: string[]; overflow: boolean; git: boolean; polling: boolean };

export type WatchTimings = { debounceMs: number; maxWaitMs: number; statusMinMs: number; pollMs: number; pollingMs: number };

export const WATCH_TIMINGS: WatchTimings = { debounceMs: 125, maxWaitMs: 1_000, statusMinMs: 3_000, pollMs: 60_000, pollingMs: 10_000 };

/** Folders named more than this in one batch: overflow (read every open folder again). */
export const WATCH_DIRS_MAX = 200;

/** Folders whose changes devices do not hear (build output, dependencies, caches). */
const QUIET_DIRS = new Set(["node_modules", "dist", "build", ".next", ".cache", "target", ".venv", "__pycache__", ".dart_tool", ".gradle", ".turbo"]);

/** Starts watching `root`; calls back with each changed path (relative, null when unknown); returns the stop. */
export type FileWatch = (root: string, onEvent: (rel: string | null) => void, onError: () => void) => () => void;

export const nodeFileWatch: FileWatch = (root, onEvent, onError) => {
  // Linux has no recursive watch of its own: Node would add one per folder, dependencies included. Polling instead.
  if (process.platform === "linux") {
    onError();
    return () => undefined;
  }
  let w: FSWatcher;
  try {
    w = fsWatch(root, { recursive: true, persistent: false }, (_event, name) => onEvent(name === null ? null : String(name)));
  } catch {
    onError();
    return () => undefined;
  }
  w.on("error", () => {
    w.close();
    onError();
  });
  return () => w.close();
};

export type WatcherOptions = {
  root: string;
  emit: (change: WorkspaceChange) => void;
  /** A fingerprint of git's status; undefined outside git. */
  statusKey: () => Promise<string | undefined>;
  timings?: WatchTimings;
  fileWatch?: FileWatch;
  now?: () => number;
};

export class WorkspaceWatcher {
  private readonly t: WatchTimings;
  private readonly now: () => number;
  private stopWatch: (() => void) | undefined;
  private dirs = new Set<string>();
  private overflow = false;
  private gitHint = false;
  private firstEventAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastStatusAt = Number.NEGATIVE_INFINITY;
  private lastKey: string | undefined;
  private reading = false;
  private running = false;
  private starting = false;
  private degraded = false;

  constructor(private readonly opts: WatcherOptions) {
    this.t = opts.timings ?? WATCH_TIMINGS;
    this.now = opts.now ?? Date.now;
  }

  /** Files are not watched here: git's status is polled every 10 s instead. */
  get polling(): boolean {
    return this.degraded;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.starting = true;
    const watchFiles = this.opts.fileWatch ?? nodeFileWatch;
    this.stopWatch = watchFiles(this.opts.root, (rel) => this.event(rel), () => this.degrade());
    this.starting = false;
    if (!this.degraded) this.poll(this.t.pollMs);
    // The status as it is now, so the first change is told against it.
    void this.readStatus(false);
  }

  private poll(ms: number): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.requestStatus(), ms);
    this.pollTimer.unref?.();
  }

  /** File events stopped (or never started): poll git's status, and say so (once started, to listeners at once). */
  private degrade(): void {
    this.stopWatch = undefined;
    if (this.degraded || !this.running) return;
    this.degraded = true;
    this.poll(this.t.pollingMs);
    if (!this.starting) this.opts.emit({ dirs: [], overflow: true, git: false, polling: true });
  }

  stop(): void {
    this.running = false;
    this.stopWatch?.();
    this.stopWatch = undefined;
    clearTimeout(this.flushTimer);
    clearTimeout(this.statusTimer);
    clearInterval(this.pollTimer);
    this.flushTimer = this.statusTimer = this.pollTimer = undefined;
    this.dirs.clear();
  }

  private event(rel: string | null): void {
    if (!this.running) return;
    if (rel === null) {
      this.overflow = true;
      this.gitHint = true;
    } else {
      const parts = rel.split(/[\\/]/).filter(Boolean);
      // git's own folder: its status may have changed, no folder of the tree did.
      if (parts[0] === ".git") this.gitHint = true;
      else if (!parts.some((p) => QUIET_DIRS.has(p))) {
        this.gitHint = true;
        if (this.dirs.size < WATCH_DIRS_MAX) this.dirs.add(parts.slice(0, -1).join("/"));
        else this.overflow = true;
      }
    }
    const now = this.now();
    if (this.flushTimer === undefined) this.firstEventAt = now;
    clearTimeout(this.flushTimer);
    const wait = Math.min(this.t.debounceMs, Math.max(0, this.firstEventAt + this.t.maxWaitMs - now));
    this.flushTimer = setTimeout(() => this.flush(), wait);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    this.flushTimer = undefined;
    const dirs = [...this.dirs];
    const overflow = this.overflow;
    this.dirs.clear();
    this.overflow = false;
    if (overflow || dirs.length > 0) this.opts.emit({ dirs: overflow ? [] : dirs, overflow, git: false, polling: this.degraded });
    if (this.gitHint) {
      this.gitHint = false;
      this.requestStatus();
    }
  }

  /** A look at git now, or once 3 s have passed since the last one. */
  private requestStatus(): void {
    if (!this.running || this.statusTimer !== undefined) return;
    const wait = Math.max(0, this.lastStatusAt + this.t.statusMinMs - this.now());
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      void this.readStatus(true);
    }, wait);
    this.statusTimer.unref?.();
  }

  private async readStatus(tell: boolean): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    this.lastStatusAt = this.now();
    try {
      const key = await this.opts.statusKey();
      // Polling names no folder: every open one may have changed.
      if (this.running && tell && key !== this.lastKey) this.opts.emit({ dirs: [], overflow: this.degraded, git: true, polling: this.degraded });
      this.lastKey = key;
    } catch {
      // the next look tries again
    } finally {
      this.reading = false;
    }
  }
}
