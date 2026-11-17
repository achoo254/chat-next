// The offices of the machine's threads that devices watch (OfficeWatch): one
// OfficeThread per watched thread, shared by every connection watching it,
// fed from the core as things happen; events go out to the watchers in
// batches of up to FLUSH_MS. A thread nobody watches has no office (it is
// built again, from the journal, when one does). Advisor's actor goes only
// to watches that said they draw it (OfficeWatch.advisor_role): any other
// gets each event about it without a kind, so its seq still runs on, and a
// snapshot without it. docs/office-wire.md.
import { create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  ErrorReason,
  type OfficeEvent,
  OfficeEventSchema,
  type OfficeEvents,
  OfficeEventsSchema,
  OfficeRole,
  type OfficeSnapshot,
  OfficeSnapshotSchema,
  type OfficeState,
  OfficeStateSchema,
  ThreadKind,
  type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import { AgentError, type AgentCore } from "../core/agent-core.ts";
import type { AgentProvider, HistoryEntry, ProviderEvent } from "../providers/types.ts";
import { ADVISOR_ID } from "./office-actor.ts";
import { type OfficeLog, OfficeProblems } from "./office-problem-log.ts";
import { OfficeMemory, OfficeThread } from "./office-thread.ts";

/** Events are gathered this long before they go out. */
export const FLUSH_MS = 250;
/** How often watched threads are looked at: their transcripts (turns run elsewhere), the subagents' records, idle staff going home. Same as following a thread. */
export const POLL_MS = 1_500;
/** Overlap of two reads of the subagents' records, so a tool call that started just before a read is not missed. */
const POLL_OVERLAP_MS = 5_000;
/** Offices one connection may watch at once (a device shows one or two; more is a device looping). */
export const WATCHES_PER_CONNECTION = 4;
/** Offices the machine keeps at once, for all connections: each costs a build from the journal and a place in every poll. */
export const OFFICES_PER_MACHINE = 16;

/** Where a watching connection gets a thread's events. */
export type OfficeSink = (events: OfficeEvents) => void;

export type OfficeHubOptions = {
  providers: readonly AgentProvider[];
  now?: () => number;
  flushMs?: number;
  pollMs?: number;
  /** The machine's log; console by default. */
  log?: OfficeLog;
};

/** Each watching sink, and whether it draws Advisor (OfficeWatch.advisor_role). */
type Office = { thread: OfficeThread; sinks: Map<OfficeSink, boolean>; reading: boolean; lastRead: number };

/** The actor an event is about; "" for one about no actor (a turn, the session). */
function eventActorId(e: OfficeEvent): string {
  const k = e.kind;
  switch (k.case) {
    case "actorEnter":
    case "actorUpdate":
      return k.value.id;
    case "actorLeave":
    case "activityStart":
    case "activityEnd":
    case "approval":
      return k.value.actorId;
    default:
      return "";
  }
}

/** The office as a device that does not draw Advisor gets it: Advisor left out. */
function withoutAdvisor(state: OfficeState): OfficeState {
  if (!state.actors.some((a) => a.role === OfficeRole.ADVISOR)) return state;
  return create(OfficeStateSchema, { ...state, actors: state.actors.filter((a) => a.role !== OfficeRole.ADVISOR) });
}

/** Events for a device that does not draw Advisor: those about Advisor keep their seq and time but lose their kind. */
function eventsWithoutAdvisor(events: readonly OfficeEvent[]): OfficeEvent[] {
  return events.map((e) => (eventActorId(e) === ADVISOR_ID ? create(OfficeEventSchema, { seq: e.seq, at: e.at }) : e));
}

export class OfficeHub {
  private readonly memory = new OfficeMemory();
  private readonly offices = new Map<string, Office>();
  private readonly now: () => number;
  private listeners: (() => void)[] = [];
  private attached = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly problems: OfficeProblems;

  constructor(
    private readonly core: AgentCore,
    private readonly opts: OfficeHubOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.problems = new OfficeProblems(opts.log ?? ((line) => console.log(line)), this.now);
  }

  /**
   * A device connected: while any is, the hub hears the core (so an office
   * built later knows what the journal does not keep). Returns the release.
   */
  attach(): () => void {
    if (this.attached++ === 0) this.listen();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.attached === 0) this.stopListening();
    };
  }

  /**
   * Starts (or restarts) watching a thread's office for `sink`; the snapshot
   * it starts from. Refused (OFFICE_WATCH_LIMIT) past WATCHES_PER_CONNECTION
   * offices for one sink or OFFICES_PER_MACHINE for the machine; watching
   * again an office already watched is never refused. `advisorRole`: the
   * device draws Advisor (OfficeWatch.advisor_role).
   */
  watch(threadId: string, sink: OfficeSink, advisorRole = false): OfficeSnapshot {
    let office = this.offices.get(threadId);
    if (!office?.sinks.has(sink)) this.checkLimits(sink, office === undefined);
    if (office) {
      // Whatever the watchers already have goes out first: the snapshot covers it, the next events follow it.
      this.flush();
      office.sinks.delete(sink);
    } else {
      office = this.build(threadId);
      this.offices.set(threadId, office);
      this.pollTimer ??= setInterval(() => this.poll(), this.opts.pollMs ?? POLL_MS);
      this.pollTimer.unref?.();
    }
    office.sinks.set(sink, advisorRole);
    const t = office.thread.tracker;
    const state = t.snapshot();
    return create(OfficeSnapshotSchema, { threadId, epoch: this.core.epoch, seq: BigInt(t.seq), state: advisorRole ? state : withoutAdvisor(state) });
  }

  unwatch(threadId: string, sink: OfficeSink): void {
    const office = this.offices.get(threadId);
    if (!office) return;
    office.sinks.delete(sink);
    if (office.sinks.size > 0) return;
    this.offices.delete(threadId);
    if (this.offices.size === 0) this.stopTimers();
  }

  /** The connection closed: every watch of `sink` ends. */
  forget(sink: OfficeSink): void {
    for (const threadId of [...this.offices.keys()]) this.unwatch(threadId, sink);
  }

  /** A thread was deleted (or put in the trash): its office goes, whoever watches it (devices hear of the deletion itself). */
  private dropOffice(threadId: string): void {
    if (!this.offices.delete(threadId)) return;
    if (this.offices.size === 0) this.stopTimers();
  }

  private checkLimits(sink: OfficeSink, newOffice: boolean): void {
    let mine = 0;
    for (const o of this.offices.values()) if (o.sinks.has(sink)) mine++;
    if (mine >= WATCHES_PER_CONNECTION) {
      throw new AgentError(ErrorCode.INVALID, `at most ${WATCHES_PER_CONNECTION} offices are watched at once on one connection`, { reason: ErrorReason.OFFICE_WATCH_LIMIT });
    }
    if (newOffice && this.offices.size >= OFFICES_PER_MACHINE) {
      throw new AgentError(ErrorCode.INVALID, `at most ${OFFICES_PER_MACHINE} offices are watched at once on this machine`, { reason: ErrorReason.OFFICE_WATCH_LIMIT });
    }
  }

  /** Threads with an office now (tests, diagnostics). */
  get watched(): string[] {
    return [...this.offices.keys()];
  }

  // --- inside ------------------------------------------------------------------

  private build(threadId: string): Office {
    const summary = this.core.list().find((s) => s.id === threadId);
    // Advisor's own threads have no office: they are hidden everywhere.
    if (!summary || summary.kind === ThreadKind.ADVISOR) throw new AgentError(ErrorCode.NOT_FOUND, "no such thread", { reason: ErrorReason.THREAD_NOT_FOUND });
    const provider = this.opts.providers.find((p) => p.id === summary.provider);
    const reportsStaff = provider?.history?.subagentActivity !== undefined;
    const now = this.now();
    // Nothing the AI said since the agent started names its session (a restart, a session run elsewhere): the
    // thread's own record does, and the subagents' records cannot be read without it.
    if (!this.memory.sessionIds.has(threadId)) {
      const sessionId = this.core.sessionIdOf(threadId);
      if (sessionId !== "") this.memory.sessionIds.set(threadId, sessionId);
    }
    const thread = new OfficeThread(threadId, reportsStaff, this.memory, now);
    // Advisor sits in before the journal is read: it hears the calls still open, and its last answer.
    thread.tracker.setAdvisor(this.core.advisorAllowed(threadId), now);
    thread.seed(this.core.snapshot(threadId), summary, now, this.endedBackground(summary.provider, thread.sessionId));
    // Nobody has seen these events: the snapshot holds what they did.
    thread.tracker.drain();
    return { thread, sinks: new Map(), reading: false, lastRead: 0 };
  }

  private listen(): void {
    this.listeners = [
      this.core.onProviderEvent((threadId, e) => this.guard("provider event", () => this.providerEvent(threadId, e))),
      this.core.onItems((threadId, items) =>
        this.guard("journal item", () => {
          const office = this.offices.get(threadId);
          if (!office) return;
          const now = this.now();
          for (const item of items) office.thread.item(item, now);
          this.changed();
        }),
      ),
      this.core.onDeleted((threadId) => this.guard("thread deleted", () => this.dropOffice(threadId))),
      // The session's automatic Advisor turned on or off (among other changes of the thread's info).
      this.core.onInfo((threadId) => this.guard("thread info", () => this.advisorNow(threadId))),
      this.core.onStatus((summary) =>
        this.guard("thread status", () => {
          const office = this.offices.get(summary.id);
          if (!office) return;
          const now = this.now();
          // Before the count of tasks still running: a fall in it must find the machines that ended already gone.
          office.thread.backgroundEnded(this.endedBackground(summary.provider, office.thread.sessionId), now);
          office.thread.setSummary(summary, now);
          this.changed();
        }),
      ),
    ];
  }

  private providerEvent(threadId: string, e: ProviderEvent | HistoryEntry): void {
    this.memory.remember(threadId, e);
    const office = this.offices.get(threadId);
    if (!office) return;
    office.thread.providerEvent(e, this.now());
    this.changed();
  }

  /** Advisor is in the thread's office exactly while the session's automatic Advisor runs (on, and its AI can reach it). */
  private advisorNow(threadId: string): void {
    const office = this.offices.get(threadId);
    if (!office) return;
    office.thread.tracker.setAdvisor(this.core.advisorAllowed(threadId), this.now());
    this.changed();
  }

  /**
   * The office is a view: whatever goes wrong in it must never reach the
   * core's own work (a listener that throws would break the turn). A failed
   * update is dropped and logged (rate-limited, `place` and the error's kind
   * only); devices recover with their next snapshot.
   */
  private guard(place: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.problems.report(place, err);
    }
  }

  private stopListening(): void {
    for (const u of this.listeners) u();
    this.listeners = [];
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.pollTimer = undefined;
    this.flushTimer = undefined;
  }

  /** Something changed: the watchers hear of it within FLUSH_MS. */
  private changed(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.opts.flushMs ?? FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Sends every office's pending events to its watchers. */
  private flush(): void {
    for (const [threadId, office] of this.offices) {
      const events = office.thread.tracker.drain();
      if (events.length === 0) continue;
      const frame = create(OfficeEventsSchema, { threadId, epoch: this.core.epoch, events });
      let plain: OfficeEvents | undefined;
      for (const [sink, advisorRole] of office.sinks) {
        if (advisorRole) {
          this.guard("send events", () => sink(frame));
          continue;
        }
        const out = (plain ??= create(OfficeEventsSchema, { threadId, epoch: this.core.epoch, events: eventsWithoutAdvisor(events) }));
        this.guard("send events", () => sink(out));
      }
    }
  }

  /** The core's threads by id; undefined (logged) when it cannot list them: this runs in a timer, where a throw would be uncaught. */
  private threadsNow(): Map<string, ThreadSummary> | undefined {
    try {
      return new Map(this.core.list().map((t) => [t.id, t]));
    } catch (err) {
      this.problems.report("list threads", err);
      return undefined;
    }
  }

  private poll(): void {
    const now = this.now();
    const threads = this.threadsNow();
    // The core could not list its threads: nothing is dropped or read this time.
    if (!threads) return;
    for (const [threadId, office] of [...this.offices]) {
      const summary = threads.get(threadId);
      // Gone without a deletion heard (the core forgot it): nothing left to show.
      if (!summary) {
        this.dropOffice(threadId);
        continue;
      }
      this.guard("poll", () => {
        // Turns typed elsewhere come in through the journal (onItems).
        this.core.followHistory(threadId);
        // Advisor's key or the AI's reach to it changed without a word about the thread itself.
        office.thread.tracker.setAdvisor(this.core.advisorAllowed(threadId), now);
        office.thread.tracker.tick(now);
        this.readSubagents(threadId, summary.provider, office, now);
      });
    }
    this.changed();
  }

  /** The background tasks the AI's record of the session says ended (empty when it does not keep them). */
  private endedBackground(provider: string, sessionId: string): ReadonlyMap<string, boolean> {
    if (sessionId === "") return new Map();
    return this.opts.providers.find((p) => p.id === provider)?.history?.endedBackground?.(sessionId) ?? new Map();
  }

  /** Reads the subagents' records of a session run elsewhere, one read at a time per office. */
  private readSubagents(threadId: string, provider: string, office: Office, now: number): void {
    const thread = office.thread;
    if (office.reading || !thread.wantsSubagentRecords()) return;
    const history = this.opts.providers.find((p) => p.id === provider)?.history;
    if (!history?.subagentActivity) return;
    office.reading = true;
    const since = office.lastRead === 0 ? 0 : office.lastRead - POLL_OVERLAP_MS;
    void history
      .subagentActivity(thread.sessionId, since)
      .then((report) => {
        office.lastRead = now;
        if (this.offices.get(threadId) !== office) return;
        thread.subagentReport(report, this.now());
        this.changed();
      })
      .catch((err: unknown) => this.problems.report("subagent records", err))
      .finally(() => {
        office.reading = false;
      });
  }
}

const hubs = new WeakMap<AgentCore, OfficeHub>();

/** The machine's office hub (one per core), made by the first connection that asks. */
export function officeHubFor(core: AgentCore, providers: readonly AgentProvider[], log?: OfficeLog): OfficeHub {
  let hub = hubs.get(core);
  if (!hub) {
    hub = new OfficeHub(core, { providers, ...(log ? { log } : {}) });
    hubs.set(core, hub);
  }
  return hub;
}
