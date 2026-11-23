// Runs the bottleneck rules (rules/all-rules.ts) inside the agent and keeps
// their findings in the store (`bottlenecks`). It scores a session:
//
// - after each batch the store took (written(): the ops of the batch), and on
//   each provisional event read from the spool's tail (liveEvent()), so a
//   terminal session whose spool reaches the store a minute late is judged
//   at once; a finding from a provisional event is written like any other,
//   its evidence the event ids the stored rows get later;
// - every TICK_MS for the sessions with a turn, a tool call or a subagent
//   still running, or a finding open: a hung call or a silent subagent sends
//   no event, and some findings close with time.
//
// Batches are scored after the writer's flush has returned (setImmediate),
// never inside it, and the findings go back through the same writer. Each
// session is loaded once from the store when first met (its rows and its
// stored findings), then followed from the writes; sessions quiet for
// ACTIVE_MS, or ended, are closed and forgotten. Sessions with an internal
// label (the Advisor's) are never scored. The history the rules compare with
// (history-percentiles.ts) is read on a read-only connection of the runner's
// own, so the store's write connection is never held for it.
//
// Nothing here throws into the agent: a failing rule or read is reported to
// `problems` and the rest goes on. Listeners of onFinding() hear every open,
// update and close (the hub sends them to devices).
import type { ConfigStore, ObservatoryThresholdsConfig } from "../../config.ts";
import { BoundedMap } from "../ingest/bounded-map.ts";
import type { LiveTailEvent } from "../spool/spool-live-tail.ts";
import type { ObservatoryStore } from "../store/observatory-store.ts";
import { type SqliteConnection, type SqliteRuntime, openSqlite } from "../store/sqlite-driver.ts";
import { readSessionTimeline } from "../store/store-reads.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { readSessionFindings, readSessionsWithOpenFindings } from "./bottleneck-reads.ts";
import { ThresholdTable, bottleneckRulesEnabled } from "./bottleneck-thresholds.ts";
import { type FindingChange, SessionFindings } from "./finding-lifecycle.ts";
import { HistoryPercentiles } from "./history-percentiles.ts";
import { ALL_RULES } from "./rules/all-rules.ts";
import { runningSubagents, runningToolCalls, turnRunning } from "./rules/rule-support.ts";
import type { Rule } from "./rules/rule-types.ts";
import { SessionModel } from "./session-model.ts";

export const TICK_MS = 15_000;
/** A session that did nothing this long is no longer followed: its open findings close. */
export const ACTIVE_MS = 2 * 60 * 60_000;
/** An ended session is kept this long for its late records (OpenTelemetry comes after the hooks). */
export const ENDED_KEPT_MS = 10 * 60_000;
/** Sessions with an open finding taken up again at start, at most. */
const RESUMED_AT_START = 500;
/** Internal sessions remembered so they are not loaded again. */
const INTERNAL_KEPT = 5_000;

export type BottleneckRunnerOptions = {
  config: ConfigStore;
  /** The store open now; its file is read on the runner's own read-only connection. */
  store: () => ObservatoryStore | undefined;
  /** Queues a write (the store's batch writer). */
  push: (op: WriteOp) => void;
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  /** The context window of a model in tokens (live-map/model-window.ts contextWindowOf); none known by default, so context_high stays quiet. */
  contextWindow?: ((model: string, largestContext: number) => number | undefined) | undefined;
  tickMs?: number;
  /** Opens the read-only connection (tests pass their own). */
  openReader?: (path: string, runtime: SqliteRuntime) => Promise<SqliteConnection>;
  rules?: readonly Rule[];
};

type Followed = { model: SessionModel; findings: SessionFindings };
type Pending = { ops: readonly WriteOp[]; ended?: { sessionId: string; at: number } };

export class BottleneckRunner {
  private readonly now: () => number;
  private readonly sessions = new Map<string, Followed>();
  private readonly internal = new BoundedMap<string, true>(INTERNAL_KEPT);
  private readonly listeners = new Set<(change: FindingChange) => void>();
  private readonly history: HistoryPercentiles;
  private reader: SqliteConnection | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Pending[] = [];
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private idleWaiters: (() => void)[] = [];
  private running = false;
  private table: { config: ObservatoryThresholdsConfig | undefined; table: ThresholdTable } | undefined;

  constructor(private readonly opts: BottleneckRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.history = new HistoryPercentiles(() => this.reader, this.now, opts.problems);
  }

  /** The rules run (the config's switch, unset is on). */
  get enabled(): boolean {
    return bottleneckRulesEnabled(this.opts.config.get().observatory?.thresholds);
  }

  /** Sessions followed now (status, tests). */
  get followed(): number {
    return this.sessions.size;
  }

  /** Opens the read connection, takes up the sessions with an open finding, starts the tick; never rejects. */
  async start(): Promise<void> {
    if (this.running) return;
    const store = this.opts.store();
    if (!store) return;
    this.running = true;
    try {
      this.reader = await (this.opts.openReader ?? ((path, runtime) => openSqlite(path, runtime, "readonly")))(store.path, store.runtime);
    } catch (err) {
      // History and loading stay off: the rules that need history are quiet, the others judge from the writes.
      this.opts.problems("bottleneck-reader", err);
    }
    if (!this.running) {
      this.closeReader();
      return;
    }
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
    if (this.enabled) this.resumeOpenFindings();
  }

  /** Stops the tick, drops what waits and what it follows, closes the read connection (before a wipe or the store's close). */
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.pending = [];
    this.sessions.clear();
    this.history.clear();
    this.closeReader();
    this.wakeIdle();
  }

  /** A batch went into the store: its sessions are scored once the writer's flush returned. */
  written(ops: readonly WriteOp[]): void {
    this.enqueue({ ops });
  }

  /** A provisional event of a watched session (spool/spool-live-tail.ts). */
  liveEvent(event: LiveTailEvent): void {
    this.enqueue(event.event === "SessionEnd" ? { ops: event.ops, ended: { sessionId: event.sessionId, at: event.at } } : { ops: event.ops });
  }

  /** Calls `listener` with every finding opened, updated or closed; returns the call that removes it. */
  onFinding(listener: (change: FindingChange) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Resolves once what was handed in so far is scored. */
  idle(): Promise<void> {
    if (!this.scheduled) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Scores the sessions time can change (see the file's head); the timer calls it. */
  tick(): void {
    if (!this.running || !this.enabled) return;
    const now = this.now();
    for (const [sessionId, f] of [...this.sessions]) {
      try {
        const m = f.model;
        if (m.ended) {
          if (now - (m.endedAt ?? now) > ENDED_KEPT_MS) this.sessions.delete(sessionId);
          continue;
        }
        if (turnRunning(m) || runningToolCalls(m).length > 0 || runningSubagents(m).length > 0 || f.findings.hasOpen) this.score(f, now);
      } catch (err) {
        this.opts.problems("bottleneck-tick", err);
      }
    }
  }

  private enqueue(item: Pending): void {
    if (!this.running) return;
    this.pending.push(item);
    this.scheduled ??= setImmediate(() => this.process());
  }

  private process(): void {
    this.scheduled = undefined;
    const items = this.pending;
    this.pending = [];
    try {
      if (this.running && this.enabled) this.scoreItems(items);
    } catch (err) {
      this.opts.problems("bottleneck-score", err);
    }
    this.wakeIdle();
  }

  private scoreItems(items: readonly Pending[]): void {
    const touched = new Map<string, Followed>();
    for (const item of items) {
      for (const op of item.ops) {
        if (op.kind === "bottleneck" || op.kind === "contentSetting") continue;
        const f = this.follow(op.row.sessionId);
        if (f && f.model.apply(op)) touched.set(f.model.sessionId, f);
      }
      if (item.ended) {
        const f = this.follow(item.ended.sessionId);
        if (f) {
          f.model.endAt(item.ended.at);
          touched.set(f.model.sessionId, f);
        }
      }
    }
    const now = this.now();
    for (const f of touched.values()) {
      try {
        this.score(f, now);
      } catch (err) {
        this.opts.problems("bottleneck-score", err);
      }
    }
  }

  /** The session as followed, loaded from the store when first met; undefined for an internal one. */
  private follow(sessionId: string): Followed | undefined {
    if (this.internal.has(sessionId)) return undefined;
    const known = this.sessions.get(sessionId);
    if (known) return known;
    const f: Followed = { model: new SessionModel(sessionId), findings: new SessionFindings(sessionId) };
    if (this.reader) {
      try {
        f.model.load(readSessionTimeline(this.reader, sessionId));
        f.findings.load(readSessionFindings(this.reader, sessionId));
      } catch (err) {
        this.opts.problems("bottleneck-load", err);
      }
    }
    this.sessions.set(sessionId, f);
    return f;
  }

  private score(f: Followed, now: number): void {
    const m = f.model;
    if (m.internalLabel !== null) {
      this.sessions.delete(m.sessionId);
      this.internal.set(m.sessionId, true);
      return;
    }
    if (m.ended) {
      this.emit(f.findings.closeAll(m.endedAt ?? now));
      return;
    }
    if (now - m.lastActivityAt > ACTIVE_MS) {
      this.emit(f.findings.closeAll(now));
      this.sessions.delete(m.sessionId);
      return;
    }
    const thresholds = this.thresholds();
    for (const rule of this.opts.rules ?? ALL_RULES) {
      try {
        const verdicts = rule.evaluate({
          now,
          session: m,
          thresholds,
          history: this.history,
          prior: (subkey) => f.findings.prior(rule.name, subkey),
          contextWindow: this.opts.contextWindow ?? (() => undefined),
        });
        this.emit(f.findings.reconcile(rule.name, verdicts, now));
      } catch (err) {
        this.opts.problems(`bottleneck-rule-${rule.name}`, err);
      }
    }
  }

  /** The thresholds of the config as it is now, built again when it changed (a bad value reported once per change). */
  private thresholds(): ThresholdTable {
    const config = this.opts.config.get().observatory?.thresholds;
    if (this.table?.config !== config || !this.table) {
      this.table = { config, table: new ThresholdTable(config, (problem) => this.opts.problems("bottleneck-thresholds", new Error(problem))) };
    }
    return this.table.table;
  }

  private emit(changes: readonly FindingChange[]): void {
    for (const change of changes) {
      this.opts.push({ kind: "bottleneck", row: change.row });
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (err) {
          this.opts.problems("bottleneck-listener", err);
        }
      }
    }
  }

  /** Sessions left with an open finding by an earlier run: scored now (an ended or long quiet one closes). */
  private resumeOpenFindings(): void {
    if (!this.reader) return;
    try {
      const now = this.now();
      for (const sessionId of readSessionsWithOpenFindings(this.reader, RESUMED_AT_START)) {
        const f = this.follow(sessionId);
        if (f) this.score(f, now);
      }
    } catch (err) {
      this.opts.problems("bottleneck-resume", err);
    }
  }

  private closeReader(): void {
    try {
      this.reader?.close();
    } catch (err) {
      this.opts.problems("bottleneck-reader", err);
    }
    this.reader = undefined;
  }

  private wakeIdle(): void {
    for (const wake of this.idleWaiters.splice(0)) wake();
  }
}
