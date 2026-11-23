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
//
// The spool's tail (spool/spool-live-tail.ts) hands the hub provisional rows
// of a watched session before the store has them (provisional()): each goes
// out as a provisional event under the id its stored row will have, and the
// stored row, once written, replaces it as an update. A stored row that still
// lacks what the provisional one knew (the store has the call's start, the
// tail its end) goes out with that filled in, still provisional, until the
// store has it all. Once the spool reader has taken every file a provisional
// row came from (spoolFileTaken()), the store holds all of it it ever will:
// its stored row goes out as it is, and a row never stored (a record set
// aside, an instruction load numbered otherwise) is withdrawn through a seq
// gap, so watchers take a snapshot without it. Neither path carries content
// (the tail drops it before anything else; timeline-reads.ts leaves it out of
// stored rows).
//
// Every snapshot and every `session` event carries the session's live state
// (live-state.ts), worked out from its newest events, provisional ones
// included, after the older rows that still change it (a call running since
// before them, the last turn end, the main thread's last request): the state
// the whole session gives. The Live Map's other requests are answered here too: an event's
// stored content by its id (the only content that leaves the machine, read
// with the project's setting applied) and a station's numbers.
import { create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  ErrorReason,
  type ObservatoryContentResult,
  ObservatoryContentResultSchema,
  ObservatoryContentState,
  type ObservatoryEarlierResult,
  ObservatoryEarlierResultSchema,
  type ObservatoryEvent,
  type ObservatoryEvents,
  ObservatoryEventsSchema,
  type ObservatorySessionListResult,
  ObservatorySessionListResultSchema,
  type ObservatorySessionState,
  type ObservatorySnapshot,
  ObservatorySnapshotSchema,
  type ObservatoryStationResult,
} from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../../core/agent-core.ts";
import { BoundedMap } from "../ingest/bounded-map.ts";
import { LOAD_MATCH_MS } from "../ingest/instruction-load-seq.ts";
import { TOOL_ERROR } from "../ingest/normalize-hook-record.ts";
import type { InstructionLoad } from "../ingest/normalized-record.ts";
import type { LiveTailEvent } from "../spool/spool-live-tail.ts";
import type { StoredContent } from "../store/live-map-reads.ts";
import type { ObservatoryStore } from "../store/observatory-store.ts";
import { StationFlag } from "../live-map/station-map.ts";
import {
  MAX_TIMELINE_PAGE,
  type TimelineEntry,
  type TimelinePage,
  type TimelineRef,
  compareTimeline,
  timelineEntryOfWrite,
  timelineRefOf,
} from "../store/timeline-reads.ts";
import type { WriteOp } from "../store/write-ops.ts";
import { liveStateOf } from "./live-state.ts";
import { decodeCursor, encodeCursor, eventId, hasControl, parseEventId, sessionEvent, sessionInfo, sessionState, stationResult, timelineEvent } from "./observatory-wire.ts";

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
/** Rows of a session whose last event is remembered, so writing the same row again sends nothing; also the provisional rows held per session. */
const SENT_WINDOW = 2_000;
/** The longest session id taken (Claude Code's are UUIDs). */
const MAX_SESSION_ID_LENGTH = 200;
/** The longest event id taken (a key is an id or a file path, both bounded well below). */
const MAX_EVENT_ID_LENGTH = 2_048;
/** A station's name: upper-case letters and `_` (live-map/station-map.ts); one this agent has no row of gives empty numbers. */
const STATION_NAME = /^[A-Z][A-Z_]{0,31}$/;
/** The newest events the live state is worked out from, with the older rows that still change it (store liveCarry); also the most running calls carried. */
export const LIVE_WINDOW = 200;

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

/**
 * A row of the spool's tail not (fully) in the store yet: the writes seen for
 * it merged, where its stored row is, and the spool files its records came
 * from that the spool reader has not taken yet.
 */
type Provisional = { op: WriteOp; entry: TimelineEntry; ref: TimelineRef; files: Set<string> };

/** An event to send and whether it is provisional. */
type Outgoing = { entry: TimelineEntry; provisional: boolean };

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
  /** Provisional rows by event id, oldest first, at most SENT_WINDOW. */
  provisional: Map<string, Provisional>;
  /** Provisional rows changed since the last flush, by event id. */
  provisionalPending: Set<string>;
  /**
   * Refs of provisional rows the store was asked for and did not have, by ref
   * id. A row only comes into the store through a write written() hears, which
   * takes its ref out: until then it is not asked again, so a spool the
   * reader cannot drain costs no read per held row at each flush.
   */
  unstored: Set<string>;
  /** Provisional rows whose spool files the reader has all taken since the last flush, by event id: the store has all of them it will ever have. */
  settled: Set<string>;
};

function newWatched(): Watched {
  return { sinks: new Set(), seq: 0n, pending: new Map(), stateDirty: false, sent: new BoundedMap(SENT_WINDOW), lastState: "", provisional: new Map(), provisionalPending: new Set(), unstored: new Set(), settled: new Set() };
}

function refuse(message: string, reason: ErrorReason): AgentError {
  return new AgentError(ErrorCode.INVALID, message, { reason });
}

/** `limit` as a device asked it: 0 is the default, anything else capped. */
function pageSize(limit: number, fallback: number, max: number): number {
  return limit <= 0 ? fallback : Math.min(max, Math.floor(limit));
}

/** A session id as Claude Code makes them: not empty, short, no control characters. */
function checkSessionId(sessionId: string): void {
  if (sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH || hasControl(sessionId)) throw refuse("not a session id", ErrorReason.OBSERVATORY_INVALID);
}

/** A message as text, to tell whether it changed (64-bit numbers as decimals). */
function printOf(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** A fingerprint of an event without its seq. */
function fingerprint(e: ObservatoryEvent): string {
  return printOf([e.kind, e.provisional]);
}

const CONTENT_STATES: Record<StoredContent["state"], ObservatoryContentState> = {
  stored: ObservatoryContentState.STORED,
  off: ObservatoryContentState.OFF,
  none: ObservatoryContentState.NONE,
  notYet: ObservatoryContentState.NOT_YET,
};

/** Fields of a row as plain values (the merges below are field by field, whatever the kind). */
type Fields = Record<string, unknown>;

/** The time fields of a row: the earliest of two writes is kept, as the store does. */
const EARLIEST = new Set(["at", "startedAt"]);

/** `next` merged over `prev`, written for the same row: a value `next` has replaces, a time keeps the earliest. */
function mergeWrite(prev: WriteOp, next: WriteOp): WriteOp {
  const row: Fields = { ...prev.row };
  for (const [k, v] of Object.entries(next.row)) {
    if (v === undefined || v === null) continue;
    const old = row[k];
    row[k] = EARLIEST.has(k) && typeof old === "number" && typeof v === "number" ? Math.min(old, v) : v;
  }
  // Same kind and same row: the merged fields are those of the kind's write.
  return { kind: next.kind, row } as WriteOp;
}

/** A station placed from the raw call, not estimated from the filtered target. */
const isExact = (flags: unknown): boolean => ((typeof flags === "number" ? flags : 0) & StationFlag.estimated) === 0;

/**
 * The stored row with what the provisional one knows and it lacks: a value
 * the stored row has no value for, and an exact station over an estimated
 * one. `added` tells whether anything was.
 */
function overlay(stored: TimelineEntry, held: TimelineEntry): { entry: TimelineEntry; added: boolean } {
  if (stored.kind !== held.kind) return { entry: stored, added: false };
  const row: Fields = { ...stored.row };
  const from: Fields = { ...held.row };
  let added = false;
  for (const [k, v] of Object.entries(from)) {
    if (v === null || v === undefined || row[k] !== null) continue;
    row[k] = v;
    added = true;
  }
  if (stored.kind === "toolCall" && from.station !== null && isExact(from.stationFlags) && !isExact(row.stationFlags)) {
    row.station = from.station;
    row.stationFlags = from.stationFlags;
    added = true;
  }
  // The same kind's row with some of its NULL fields filled from a row of that kind.
  return { entry: added ? ({ ...stored, row } as TimelineEntry) : stored, added };
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
      if (!ref) continue;
      w.pending.set(ref.id, ref);
      w.unstored.delete(ref.id);
    }
    if (touched) this.scheduleFlush();
  }

  /**
   * The machine's most recent sessions, newest first; with `threadSessions`
   * (the Claude Code sessions a thread's segments name; [] for a thread of
   * another AI) only those and the sessions linked to them through /clear.
   */
  listSessions(limit: number, threadSessions?: readonly string[]): ObservatorySessionListResult {
    const n = pageSize(limit, DEFAULT_SESSIONS_LISTED, MAX_SESSIONS_LISTED);
    const store = this.store();
    const seeds = threadSessions?.filter((id) => id !== "" && id.length <= MAX_SESSION_ID_LENGTH && !hasControl(id));
    const rows = seeds === undefined ? store.sessions({ limit: n }) : seeds.length === 0 ? [] : store.threadSessions(seeds, n);
    return create(ObservatorySessionListResultSchema, { sessions: rows.map(sessionInfo) });
  }

  /**
   * Rows of a watched session read from the spool's tail before the store
   * has them (ObservatoryService.onLiveEvent): sent within FLUSH_MS as
   * provisional events. Rows of a session nobody watches are dropped. Never
   * throws.
   */
  provisional(event: LiveTailEvent): void {
    const w = this.running ? this.sessions.get(event.sessionId) : undefined;
    if (!w) return;
    try {
      let held = false;
      for (const op of event.ops) held = this.hold(w, event.sessionId, op, event.file) || held;
      if (event.instruction) {
        const op = this.instructionOp(w, event.instruction);
        if (op) held = this.hold(w, event.sessionId, op, event.file) || held;
      }
      if (held || event.ops.some((op) => op.kind === "session")) w.stateDirty = true;
      if (w.stateDirty) this.scheduleFlush();
    } catch (err) {
      this.opts.problems("hub-provisional", err);
    }
  }

  /**
   * The spool reader took `file` (ObservatoryService, from the spool's tail):
   * every record in it is stored by now, or will never be (set aside, refused,
   * an instruction load numbered otherwise than the hub guessed). A
   * provisional row with no other file left goes at the next flush: as its
   * stored row when there is one, else it is withdrawn, which watchers see as
   * a gap (they take a snapshot without it). Never throws.
   */
  spoolFileTaken(file: string): void {
    if (!this.running) return;
    let settled = false;
    for (const w of this.sessions.values()) {
      for (const [id, p] of w.provisional) {
        if (!p.files.delete(file) || p.files.size > 0) continue;
        w.settled.add(id);
        settled = true;
      }
    }
    if (settled) this.scheduleFlush();
  }

  /** The stored content of one event of a session, the project's content setting applied. Watching is not needed. */
  content(sessionId: string, id: string): ObservatoryContentResult {
    checkSessionId(sessionId);
    const parsed = id.length <= MAX_EVENT_ID_LENGTH && !hasControl(id) ? parseEventId(id) : undefined;
    if (!parsed) throw refuse("not an event id of this machine", ErrorReason.OBSERVATORY_INVALID);
    const found = this.store().content(sessionId, parsed.kind, parsed.key);
    return create(ObservatoryContentResultSchema, { sessionId, eventId: id, state: CONTENT_STATES[found.state], text: found.state === "stored" ? found.text : "" });
  }

  /** One station's numbers in a session, up to `at` (Unix ms; 0 for everything). Watching is not needed. */
  station(sessionId: string, station: string, at = 0): ObservatoryStationResult {
    checkSessionId(sessionId);
    if (!STATION_NAME.test(station)) throw refuse("not a station", ErrorReason.OBSERVATORY_INVALID);
    if (!Number.isSafeInteger(at) || at < 0) throw refuse("not a time", ErrorReason.OBSERVATORY_INVALID);
    const drill = this.store().station({ sessionId, station, ...(at > 0 ? { at } : {}) });
    return stationResult(sessionId, station, at, drill);
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
    const fresh = w ?? newWatched();
    const page = store.timelinePage(sessionId, undefined, pageSize(limit, DEFAULT_PAGE, MAX_TIMELINE_PAGE));
    const oldest = page.more ? page.entries[0] : undefined;
    const outgoing = this.withProvisional(fresh, store, page.entries, oldest);
    const state = this.stateOf(sessionId, fresh, store);
    if (!w) {
      w = fresh;
      this.sessions.set(sessionId, w);
      this.tellService("watch", () => this.opts.watchSession(sessionId));
    }
    w.sinks.add(sink);
    const events = outgoing.map((o) => timelineEvent(o.entry, 0n, o.provisional));
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
      w.provisional.clear();
      w.provisionalPending.clear();
      w.unstored.clear();
      w.settled.clear();
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
    if (w.pending.size === 0 && w.provisionalPending.size === 0 && w.settled.size === 0 && !w.stateDirty) return;
    const refs = [...w.pending.values()];
    const held = [...w.provisionalPending];
    const settled = [...w.settled];
    let stateDirty = w.stateDirty;
    w.pending.clear();
    w.provisionalPending.clear();
    w.settled.clear();
    w.stateDirty = false;
    const events: ObservatoryEvent[] = [];
    try {
      const outgoing = new Map<string, Outgoing>();
      for (const ref of refs) {
        const entry = store.timelineEntry(ref);
        if (entry && entry.row.sessionId === sessionId) outgoing.set(eventId(entry), this.stored(w, entry));
      }
      let withdrawn = false;
      for (const id of settled) {
        const p = w.provisional.get(id);
        if (!p || p.files.size > 0) continue;
        const entry = this.storedRowOf(w, store, p);
        w.provisional.delete(id);
        w.unstored.delete(p.ref.id);
        // The store has all of the row it will have: that goes out, not what only the spool knew.
        if (entry) outgoing.set(id, { entry, provisional: false });
        else withdrawn = true;
      }
      if (withdrawn) {
        // A seq skipped: every watcher takes a snapshot, which no longer holds the withdrawn rows. A `session` event goes out after it, so the gap is seen now.
        w.seq += 1n;
        w.lastState = "";
        stateDirty = true;
      }
      for (const id of held) {
        const p = w.provisional.get(id);
        if (!p || outgoing.has(id)) continue;
        const entry = this.storedRowOf(w, store, p);
        outgoing.set(id, entry ? this.stored(w, entry) : { entry: p.entry, provisional: true });
      }
      for (const o of [...outgoing.values()].sort((a, b) => compareTimeline(a.entry, b.entry))) {
        const event = timelineEvent(o.entry, 0n, o.provisional);
        const print = fingerprint(event);
        if (w.sent.get(event.id) === print) continue;
        w.sent.set(event.id, print);
        event.seq = ++w.seq;
        events.push(event);
      }
      if (stateDirty) {
        const state = this.stateOf(sessionId, w, store);
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

  /** The session's row, totals and live state as stored now, its provisional rows included. */
  private stateOf(sessionId: string, w: Watched, store: ObservatoryStore): ObservatorySessionState {
    const row = store.session(sessionId);
    const facts = store.liveFacts(sessionId);
    const page = store.timelinePage(sessionId, undefined, LIVE_WINDOW);
    const oldest = page.entries[0];
    // Older rows that still count (a call running since before the window, the last turn end, the last main-thread request).
    const carried = page.more && oldest ? store.liveCarry(sessionId, oldest, LIVE_WINDOW, TOOL_ERROR.interrupted) : [];
    const entries = this.withProvisional(w, store, [...carried, ...page.entries], undefined).map((o) => o.entry);
    const live = liveStateOf({ entries, endedAt: row?.endedAt ?? null, mainModel: row?.mainModel ?? null, openBottlenecks: facts.openBottlenecks, largestContext: facts.largestContext });
    return sessionState(row, store.sessionTotals(sessionId), live);
  }

  /**
   * `stored` (a page of stored rows, oldest first) with the provisional rows
   * filled in, and the provisional rows not stored yet that sort after
   * `oldest` (every one when undefined), in timeline order.
   */
  private withProvisional(w: Watched, store: ObservatoryStore, stored: readonly TimelineEntry[], oldest: TimelineEntry | undefined): Outgoing[] {
    const out = stored.map((entry) => this.stored(w, entry));
    if (w.provisional.size === 0) return out;
    const have = new Set(stored.map(eventId));
    for (const [id, p] of [...w.provisional]) {
      if (have.has(id)) continue;
      const entry = this.storedRowOf(w, store, p);
      const o = entry ? this.stored(w, entry) : { entry: p.entry, provisional: true };
      if (o.provisional && (!oldest || compareTimeline(o.entry, oldest) >= 0)) out.push(o);
    }
    return out.sort((a, b) => compareTimeline(a.entry, b.entry));
  }

  /** The stored row of a provisional one, as stored now; undefined when it is not, without asking again a store known not to have it. */
  private storedRowOf(w: Watched, store: ObservatoryStore, p: Provisional): TimelineEntry | undefined {
    if (w.unstored.has(p.ref.id)) return undefined;
    const entry = store.timelineEntry(p.ref);
    if (!entry) w.unstored.add(p.ref.id);
    return entry;
  }

  /** A stored row with what its provisional row knows; the provisional row is dropped once the store has it all. */
  private stored(w: Watched, entry: TimelineEntry): Outgoing {
    const id = eventId(entry);
    const p = w.provisional.get(id);
    if (!p) return { entry, provisional: false };
    const merged = overlay(entry, p.entry);
    if (!merged.added) {
      w.provisional.delete(id);
      w.unstored.delete(p.ref.id);
    }
    return { entry: merged.entry, provisional: merged.added };
  }

  /** Holds one write of the spool's tail as a provisional row; false for a write that is not a timeline row of `sessionId`. */
  private hold(w: Watched, sessionId: string, op: WriteOp, file: string): boolean {
    const ref = timelineRefOf(op);
    const alone = ref && ref.sessionId === sessionId ? timelineEntryOfWrite(op) : undefined;
    if (!ref || !alone) return false;
    const id = eventId(alone);
    const prev = w.provisional.get(id);
    const merged = prev ? mergeWrite(prev.op, op) : op;
    const entry = prev ? timelineEntryOfWrite(merged) : alone;
    if (!entry) return false;
    w.provisional.delete(id);
    w.provisional.set(id, { op: merged, entry, ref, files: new Set([...(prev?.files ?? []), file]) });
    while (w.provisional.size > SENT_WINDOW) {
      const first = w.provisional.entries().next();
      if (first.done === true) break;
      const [oldest, dropped] = first.value;
      w.provisional.delete(oldest);
      w.unstored.delete(dropped.ref.id);
    }
    w.provisionalPending.add(id);
    return true;
  }

  /**
   * The write of an instruction file loaded, numbered as the ingest will
   * number it from the spool (ingest/instruction-load-seq.ts): after the
   * loads of the file for the reason stored and held; undefined when a stored
   * load is this one (its stored event went out already).
   */
  private instructionOp(w: Watched, load: InstructionLoad): WriteOp | undefined {
    const store = this.opts.store();
    if (!store) return undefined;
    const stored = store.instructionLoads(load.sessionId, load.filePath, load.loadReason);
    if (stored.some((s) => Math.abs(s.at - load.at) <= LOAD_MATCH_MS)) return undefined;
    const held = [...w.provisional.values()].flatMap((p) => (p.entry.kind === "instructionLoaded" && p.entry.row.filePath === load.filePath && p.entry.row.loadReason === load.loadReason ? [p.entry.row] : []));
    const same = held.find((r) => r.at === load.at);
    const seq = same?.seq ?? stored.reduce((next, s) => Math.max(next, s.seq + 1), 0) + held.length;
    return { kind: "instructionLoaded", row: { sessionId: load.sessionId, seq, at: load.at, filePath: load.filePath, loadReason: load.loadReason, memoryType: load.memoryType } };
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
