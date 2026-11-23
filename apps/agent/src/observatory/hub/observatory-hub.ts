// The Claude Code sessions devices watch through Observatory
// (ObservatoryWatch): one watch per session, shared by every connection
// watching it, fed by the store's writes. A batch written to the store tells
// the hub which rows it touched; for a watched session each is read again as
// stored (merged, without content) and goes out as an event, the session's
// row and totals after them when they changed, batched for up to FLUSH_MS.
// A session nobody watches costs nothing: the hub keeps no state for it and
// skips its writes. docs/observatory-wire.md.
//
// The hub runs with the Observatory service: start() takes a new epoch,
// stop() drops what waits (devices still watching see the next epoch and
// watch again), reset() follows a wipe the same way. The first watcher of a
// session asks the service to read its spool's tail (watchSession), the last
// one to leave stops it (unwatchSession).
import { create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  ErrorReason,
  type ObservatoryEarlierResult,
  ObservatoryEarlierResultSchema,
  type ObservatoryEvent,
  type ObservatoryEvents,
  ObservatoryEventsSchema,
  type ObservatorySessionListResult,
  ObservatorySessionListResultSchema,
  type ObservatorySnapshot,
  ObservatorySnapshotSchema,
} from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../../core/agent-core.ts";
import { BoundedMap } from "../ingest/bounded-map.ts";
import type { ObservatoryStore } from "../store/observatory-store.ts";
import { MAX_TIMELINE_PAGE, type TimelinePage, type TimelineRef, compareTimeline, timelineRefOf } from "../store/timeline-reads.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { decodeCursor, encodeCursor, sessionEvent, sessionInfo, sessionState, timelineEvent } from "./observatory-wire.ts";

/** Events are gathered this long before they go out. */
export const FLUSH_MS = 250;
/** Sessions one connection may watch at once (a device shows one or two; more is a device looping). */
export const WATCHES_PER_CONNECTION = 4;
/** Sessions the machine watches at once, for all connections: each costs reads after every write that touches it. */
export const SESSIONS_PER_MACHINE = 16;
/** Connections watching one session at once. */
export const VIEWERS_PER_SESSION = 8;
/** Events a snapshot or a page carries when the device names no number. */
export const DEFAULT_PAGE = 200;
/** Sessions listed when the device names no number, and at most. */
export const DEFAULT_SESSIONS_LISTED = 50;
export const MAX_SESSIONS_LISTED = 200;
/** Rows of a session whose last event is remembered, so writing the same row again sends nothing. */
const SENT_WINDOW = 2_000;
/** The longest session id taken (Claude Code's are UUIDs). */
const MAX_SESSION_ID_LENGTH = 200;

/** Where a watching connection gets a session's events. */
export type ObservatoryEventSink = (events: ObservatoryEvents) => void;

export type ObservatoryHubOptions = {
  /** The store open now; undefined while Observatory is off or its store is not open. */
  store: () => ObservatoryStore | undefined;
  /** Someone watches the session: its spool's tail is read (ObservatoryService.watchSession). */
  watchSession: (sessionId: string) => void;
  /** Its last watcher left (ObservatoryService.unwatchSession). */
  unwatchSession: (sessionId: string) => void;
  /** The service's throttled log (never content). */
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  flushMs?: number;
};

type Watched = {
  sinks: Set<ObservatoryEventSink>;
  /** The last event's seq this epoch. */
  seq: bigint;
  /** Rows written since the last flush, by ref id. */
  pending: Map<string, TimelineRef>;
  /** The session's own row or totals may have changed since the last flush. */
  stateDirty: boolean;
  /** What each row's last event held, by event id (a row written again unchanged sends nothing). */
  sent: BoundedMap<string, string>;
  /** What the session's row and totals were when last sent (or snapshotted). */
  lastState: string;
};

function refuse(message: string, reason: ErrorReason): AgentError {
  return new AgentError(ErrorCode.INVALID, message, { reason });
}

/** `limit` as a device asked it: 0 is the default, anything else capped. */
function pageSize(limit: number, fallback: number, max: number): number {
  return limit <= 0 ? fallback : Math.min(max, Math.floor(limit));
}

/** A session id as Claude Code makes them: not empty, short, no control characters. */
function checkSessionId(sessionId: string): void {
  const control = [...sessionId].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH || control) throw refuse("not a session id", ErrorReason.OBSERVATORY_INVALID);
}

/** A message as text, to tell whether it changed (64-bit numbers as decimals). */
function printOf(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** A fingerprint of an event without its seq. */
function fingerprint(e: ObservatoryEvent): string {
  return printOf(e.kind);
}

export class ObservatoryHub {
  private readonly sessions = new Map<string, Watched>();
  private readonly now: () => number;
  private running = false;
  private epoch = 0n;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: ObservatoryHubOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Observatory started: a new epoch; sessions still watched start again from seq 0. */
  start(): void {
    this.running = true;
    this.newEpoch();
  }

  /** Observatory stopped: what waits is dropped; requests are refused until start(). The watches stay. */
  stop(): void {
    this.running = false;
    this.stopTimer();
    for (const w of this.sessions.values()) {
      w.pending.clear();
      w.stateDirty = false;
    }
  }

  /** The data was wiped: a new epoch, so every device watching takes a fresh snapshot. */
  reset(): void {
    this.stopTimer();
    this.newEpoch();
  }

  /** The epoch now (tests, diagnostics). */
  get currentEpoch(): bigint {
    return this.epoch;
  }

  /** Sessions watched now (tests, diagnostics). */
  get watched(): string[] {
    return [...this.sessions.keys()];
  }

  /** A batch went into the store: the rows of watched sessions it touched go out within FLUSH_MS. Never throws. */
  written(ops: readonly WriteOp[]): void {
    if (!this.running || this.sessions.size === 0) return;
    let touched = false;
    for (const op of ops) {
      if (op.kind === "contentSetting") continue;
      const w = this.sessions.get(op.row.sessionId);
      if (!w) continue;
      touched = true;
      w.stateDirty = true;
      const ref = timelineRefOf(op);
      if (ref) w.pending.set(ref.id, ref);
    }
    if (touched) this.scheduleFlush();
  }

  /** The machine's most recent sessions, newest first. */
  listSessions(limit: number): ObservatorySessionListResult {
    const rows = this.store().sessions({ limit: pageSize(limit, DEFAULT_SESSIONS_LISTED, MAX_SESSIONS_LISTED) });
    return create(ObservatorySessionListResultSchema, { sessions: rows.map(sessionInfo) });
  }

  /**
   * Starts (or restarts) watching a session for `sink`; the snapshot it
   * starts from: the session's row and totals and its `limit` newest events.
   * Refused (OBSERVATORY_WATCH_LIMIT) past WATCHES_PER_CONNECTION sessions for
   * one sink, SESSIONS_PER_MACHINE for the machine or VIEWERS_PER_SESSION for
   * the session; watching again a session the sink watches is never refused.
   */
  watch(sessionId: string, sink: ObservatoryEventSink, limit = 0): ObservatorySnapshot {
    checkSessionId(sessionId);
    const store = this.store();
    let w = this.sessions.get(sessionId);
    if (!w?.sinks.has(sink)) this.checkLimits(sink, w);
    // Reads first: a store that fails leaves no watch behind.
    if (w) this.flushSession(sessionId, w, store);
    const page = store.timelinePage(sessionId, undefined, pageSize(limit, DEFAULT_PAGE, MAX_TIMELINE_PAGE));
    const state = sessionState(store.session(sessionId), store.sessionTotals(sessionId));
    if (!w) {
      w = { sinks: new Set(), seq: 0n, pending: new Map(), stateDirty: false, sent: new BoundedMap(SENT_WINDOW), lastState: "" };
      this.sessions.set(sessionId, w);
      this.tellService("watch", () => this.opts.watchSession(sessionId));
    }
    w.sinks.add(sink);
    const events = page.entries.map((e) => timelineEvent(e));
    for (const e of events) w.sent.set(e.id, fingerprint(e));
    w.lastState = printOf(state);
    return create(ObservatorySnapshotSchema, { sessionId, epoch: this.epoch, seq: w.seq, session: state, events, earlier: this.earlierOf(page) });
  }

  unwatch(sessionId: string, sink: ObservatoryEventSink): void {
    const w = this.sessions.get(sessionId);
    if (!w?.sinks.delete(sink)) return;
    if (w.sinks.size > 0) return;
    this.sessions.delete(sessionId);
    this.tellService("unwatch", () => this.opts.unwatchSession(sessionId));
    if (this.sessions.size === 0) this.stopTimer();
  }

  /** The connection closed: every watch of `sink` ends. */
  forget(sink: ObservatoryEventSink): void {
    for (const sessionId of [...this.sessions.keys()]) this.unwatch(sessionId, sink);
  }

  /** The events of a session before `earlier` (a cursor this hub sent), oldest first. Watching is not needed. */
  earlier(sessionId: string, earlier: string, limit = 0): ObservatoryEarlierResult {
    checkSessionId(sessionId);
    const before = decodeCursor(earlier);
    if (!before) throw refuse("not a cursor of this machine", ErrorReason.OBSERVATORY_INVALID);
    const page = this.store().timelinePage(sessionId, before, pageSize(limit, DEFAULT_PAGE, MAX_TIMELINE_PAGE));
    return create(ObservatoryEarlierResultSchema, { sessionId, events: page.entries.map((e) => timelineEvent(e)), earlier: this.earlierOf(page) });
  }

  // --- inside ------------------------------------------------------------------

  private store(): ObservatoryStore {
    const store = this.running ? this.opts.store() : undefined;
    if (!store) throw refuse("Observatory is off on this machine", ErrorReason.OBSERVATORY_OFF);
    return store;
  }

  private earlierOf(page: TimelinePage): string {
    const oldest = page.entries[0];
    return page.more && oldest ? encodeCursor(oldest) : "";
  }

  private checkLimits(sink: ObservatoryEventSink, w: Watched | undefined): void {
    let mine = 0;
    for (const s of this.sessions.values()) if (s.sinks.has(sink)) mine++;
    if (mine >= WATCHES_PER_CONNECTION) throw refuse(`at most ${WATCHES_PER_CONNECTION} sessions are watched at once on one connection`, ErrorReason.OBSERVATORY_WATCH_LIMIT);
    if (!w && this.sessions.size >= SESSIONS_PER_MACHINE) throw refuse(`at most ${SESSIONS_PER_MACHINE} sessions are watched at once on this machine`, ErrorReason.OBSERVATORY_WATCH_LIMIT);
    if (w && w.sinks.size >= VIEWERS_PER_SESSION) throw refuse(`at most ${VIEWERS_PER_SESSION} connections watch one session at once`, ErrorReason.OBSERVATORY_WATCH_LIMIT);
  }

  private newEpoch(): void {
    // Strictly growing, and unlike any epoch of an earlier run of the agent.
    const now = BigInt(Math.trunc(this.now()));
    this.epoch = now > this.epoch ? now : this.epoch + 1n;
    for (const w of this.sessions.values()) {
      w.seq = 0n;
      w.pending.clear();
      w.stateDirty = false;
      w.sent = new BoundedMap(SENT_WINDOW);
      w.lastState = "";
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.opts.flushMs ?? FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private stopTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** Sends every watched session's new events to its watchers. Runs in a timer: never throws. */
  private flush(): void {
    const store = this.running ? this.opts.store() : undefined;
    if (!store) return;
    for (const [sessionId, w] of this.sessions) this.flushSession(sessionId, w, store);
  }

  /**
   * Reads the rows written for one session since the last flush and sends
   * their events. A read that fails sends nothing and skips a seq, so the
   * watchers see a gap and ask for a snapshot (the store has the truth).
   */
  private flushSession(sessionId: string, w: Watched, store: ObservatoryStore): void {
    if (w.pending.size === 0 && !w.stateDirty) return;
    const refs = [...w.pending.values()];
    const stateDirty = w.stateDirty;
    w.pending.clear();
    w.stateDirty = false;
    const events: ObservatoryEvent[] = [];
    try {
      const entries = refs.flatMap((ref) => {
        const entry = store.timelineEntry(ref);
        return entry && entry.row.sessionId === sessionId ? [entry] : [];
      });
      entries.sort(compareTimeline);
      for (const entry of entries) {
        const event = timelineEvent(entry);
        const print = fingerprint(event);
        if (w.sent.get(event.id) === print) continue;
        w.sent.set(event.id, print);
        event.seq = ++w.seq;
        events.push(event);
      }
      if (stateDirty) {
        const state = sessionState(store.session(sessionId), store.sessionTotals(sessionId));
        const print = printOf(state);
        if (print !== w.lastState) {
          w.lastState = print;
          events.push(sessionEvent(state, ++w.seq, this.now()));
        }
      }
    } catch (err) {
      this.opts.problems("hub-read", err);
      // What was read and numbered is not sent: the gap makes every watcher take a snapshot.
      w.seq += 1n;
      return;
    }
    if (events.length === 0) return;
    const frame = create(ObservatoryEventsSchema, { sessionId, epoch: this.epoch, events });
    for (const sink of w.sinks) {
      try {
        sink(frame);
      } catch (err) {
        this.opts.problems("hub-send", err);
      }
    }
  }

  /** Tells the service a session is watched or not; its failure is logged, never thrown into a request. */
  private tellService(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.problems(`hub-${what}`, err);
    }
  }
}
