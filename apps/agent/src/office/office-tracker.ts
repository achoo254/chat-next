// The office of one session (docs/office-wire.md): who is in, what each does
// and in which room, and the session's numbers. Pure: it takes signals the
// hub has already read from the core and the AI's records, each with its
// time, and turns them into events with consecutive seq; it does no I/O and
// reads no clock of its own. A snapshot plus the events after it always
// gives the tracker's own state.
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import {
  OfficeActorState,
  OfficeApprovalState,
  type OfficeEvent,
  OfficeEventSchema,
  OfficeRole,
  type OfficeState,
  OfficeStateSchema,
} from "@achoo254/chat-proto/remote/remote";
import type { ToolKind } from "../providers/types.ts";
import { ARRIVE, CONSULT, HAND_IN, THINK, classifyActivity } from "./office-activity-map.ts";
import {
  ADVISOR_ID,
  type ActivityRecord,
  type ActorRecord,
  DIRECTOR_ID,
  activityWire,
  actorWire,
  isAdvisor,
  isEmployee,
  isMachine,
  newActor,
  shownActivity,
} from "./office-actor.ts";
import { ResidentLog } from "./office-residents.ts";
import { classifyService } from "./office-service-kind.ts";
import { officeSubject, officeToolName } from "./office-subject.ts";
import { type OfficeStatus, SessionNumbers, type TodoCounts } from "./office-session-numbers.ts";
import type { OfficeUsageNumbers } from "./office-usage.ts";

export type { OfficeStatus, TodoCounts } from "./office-session-numbers.ts";

/** Actors devices get at most (the director included); the rest are only counted. */
export const MAX_ACTORS = 64;
/** How long the session stays idle before finished staff go home. */
export const LEAVE_AFTER_IDLE_MS = 10 * 60_000;
/**
 * A subagent in the background the AI never said ended, with nothing heard
 * of it for this long while the session is idle and counts no background
 * work: taken as finished (the AI that ran it quit, or its end was missed).
 * Its record going quiet ends it sooner where the records are read
 * (office-thread.ts, STALE_SUBAGENT_MS).
 */
export const BACKGROUND_SILENT_MS = 30 * 60_000;
const DESCRIPTION_MAX = 80;
/** Tool calls remembered as seen, so one read twice (live, then from a record) starts once. */
const SEEN_MAX = 10_000;

export type ToolStart = {
  toolId: string;
  /** The employee whose tool call it is; unset for the director's own. */
  actorId?: string;
  name: string;
  kind: ToolKind;
  /** The chat card's one line (a shell's command, a path); read for the subject and room only. */
  summary: string;
  /** A shell call's whole command, when known; read for the room only. */
  command?: string;
  sensitive: boolean;
  /** Runs in the background (a shell with run_in_background, a Monitor): a machine. */
  background: boolean;
};

export type SubagentStart = {
  toolId: string;
  /** The employee that started it; unset for the director's own staff. */
  parentId?: string;
  workflowId?: string;
  agentType: string;
  description: string;
  background: boolean;
  spawnDepth?: number;
};

export type PromptState = "waiting" | "allowed" | "denied" | "cancelled";

const PROMPT_WIRE: Record<PromptState, OfficeApprovalState> = {
  waiting: OfficeApprovalState.WAITING,
  allowed: OfficeApprovalState.ALLOWED,
  denied: OfficeApprovalState.DENIED,
  cancelled: OfficeApprovalState.CANCELLED,
};

type EventKind = NonNullable<MessageInitShape<typeof OfficeEventSchema>["kind"]>;

export class OfficeTracker {
  private seqNo = 0;
  private readonly actors = new Map<string, ActorRecord>();
  /** Actors over MAX_ACTORS: tracked by id and role only, never sent. */
  private readonly hidden = new Map<string, OfficeRole>();
  /** Which actor each open tool call belongs to. */
  private readonly owners = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** Open permission prompts and the actor each one waits on. */
  private readonly prompts = new Map<string, string>();
  private events: OfficeEvent[] = [];
  private readonly numbers = new SessionNumbers();
  /** Employees that left, for the snapshot (a device opening the office later still knows them). */
  private readonly residents = new ResidentLog();
  private idleSince: number;
  /** Advisor's latest answer in the session ("<option> · 72%"), kept while Advisor is away so it says it again when back. */
  private advisorSays = "";

  constructor(
    private readonly reportsStaff: boolean,
    at: number,
  ) {
    this.idleSince = at;
    this.actors.set(DIRECTOR_ID, newActor({ id: DIRECTOR_ID, role: OfficeRole.DIRECTOR, enteredAt: at, state: OfficeActorState.IDLE, stateBeforePrompt: OfficeActorState.IDLE }));
  }

  private get status(): OfficeStatus {
    return this.numbers.status;
  }

  /** The seq of the last event made. */
  get seq(): number {
    return this.seqNo;
  }

  /** Events made since the last call, oldest first. */
  drain(): OfficeEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  snapshot(): OfficeState {
    return create(OfficeStateSchema, {
      actors: [...this.actors.values()].map(actorWire),
      reportsStaff: this.reportsStaff,
      session: this.numbers.wire(this.hidden.size),
      residents: this.residents.wire(),
    });
  }

  /** Whether an actor of this id is in the office (or counted over the limit). */
  has(actorId: string): boolean {
    return this.actors.has(actorId) || this.hidden.has(actorId);
  }

  /**
   * After the office was built from the thread's journal: when the session is
   * idle, it has been since `lastActivityAt` (finished staff go home
   * LEAVE_AFTER_IDLE_MS after it, not after the office was built), and only
   * as many machines stay as background tasks the session has now.
   */
  settle(lastActivityAt: number, now: number): void {
    if (!this.status.busy) this.idleSince = Math.min(this.idleSince, lastActivityAt);
    // The journal never says when background work ended: the count of it now does.
    this.backgroundShrank(this.status.backgroundTasks, now);
    this.tick(now);
    this.sessionChanged(now);
  }

  // --- signals -----------------------------------------------------------------

  /**
   * The session's automatic Advisor is on (Advisor sits in the office) or off
   * (Advisor leaves). An office already holding MAX_ACTORS has no seat for it:
   * Advisor is then neither shown nor counted in hidden_actors (an older device
   * would count someone it never draws), and comes in on a later call (the
   * hub asks every poll) once there is room.
   */
  setAdvisor(on: boolean, at: number): void {
    const advisor = this.actors.get(ADVISOR_ID);
    if (!on) {
      if (advisor) this.leave(advisor, at);
      return;
    }
    if (advisor || this.actors.size >= MAX_ACTORS) return;
    this.enter(
      { id: ADVISOR_ID, role: OfficeRole.ADVISOR, description: this.advisorSays, state: OfficeActorState.IDLE, stateBeforePrompt: OfficeActorState.IDLE, enteredAt: at },
      at,
    );
  }

  /** Advisor answered in the session (an AdvisorVerdictItem): what it says now; "" when it could not answer. */
  advisorAnswered(says: string, at: number): void {
    if (says === "" || says === this.advisorSays) return;
    this.advisorSays = says;
    const advisor = this.actors.get(ADVISOR_ID);
    if (!advisor) return;
    advisor.description = says;
    this.emit({ case: "actorUpdate", value: actorWire(advisor) }, at, advisor);
  }

  /** Where the session stands (ThreadSummary): busy, waiting for the user, background work. */
  setStatus(next: OfficeStatus, at: number): void {
    const prev = this.status;
    this.numbers.status = next;
    if (!prev.busy && next.busy) this.turnStarted(at);
    else if (prev.busy && !next.busy) this.turnEnded(at);
    if (next.backgroundTasks < prev.backgroundTasks) this.backgroundShrank(next.backgroundTasks, at);
    this.sessionChanged(at);
  }

  toolStart(t: ToolStart, at: number): void {
    if (this.seenBefore(t.toolId)) return;
    const place = classifyActivity({ kind: t.kind, name: t.name, command: t.command ?? t.summary });
    const tool = officeToolName(t.kind, t.name);
    if (t.background && !t.actorId) {
      // A shell in the background is a machine of its own, standing in its room until its work ends.
      const work: ActivityRecord = { id: t.toolId, tool, place, subject: "", startedAt: at };
      // Its label is read from the command here; only the kind and a port leave the machine.
      const service = t.kind === "shell" ? { ...classifyService(t.command ?? t.summary), startedAt: at } : undefined;
      this.enter({ id: t.toolId, role: OfficeRole.MACHINE, agentType: tool.slice(0, 60), background: true, enteredAt: at, open: [work], ...(service ? { service } : {}) }, at);
      return;
    }
    const actor = this.actors.get(t.actorId ?? DIRECTOR_ID);
    // Taken as done only for its silence: a tool call of its own says it still works.
    if (actor?.state === OfficeActorState.DONE && actor.donePresumed) this.resumeInBackground(actor, at);
    if (!actor || actor.state === OfficeActorState.DONE) return;
    const subject = actor.id === DIRECTOR_ID ? officeSubject(t) : "";
    actor.open.push({ id: t.toolId, tool, place, subject, startedAt: at });
    actor.heardAt = Math.max(actor.heardAt, at);
    // A subagent's first tool call: it has arrived.
    if (actor.between?.id === "arrive") delete actor.between;
    this.owners.set(t.toolId, actor.id);
    this.refreshActivity(actor, at);
    if (place.group === CONSULT.group) this.advisorListens(t.toolId, at);
  }

  toolEnd(toolId: string, ok: boolean, at: number): void {
    const advisor = this.actors.get(ADVISOR_ID);
    const asked = advisor?.open.findIndex((r) => r.id === toolId) ?? -1;
    if (advisor && asked >= 0) {
      // Asked twice at once: it listens on while another call is open.
      advisor.open.splice(asked, 1);
      this.refreshActivity(advisor, at, { id: toolId, ok });
    }
    const actor = this.actors.get(this.owners.get(toolId) ?? "");
    if (!actor || isMachine(actor)) return;
    this.owners.delete(toolId);
    const i = actor.open.findIndex((r) => r.id === toolId);
    if (i < 0) return;
    const [ended] = actor.open.splice(i, 1);
    actor.heardAt = Math.max(actor.heardAt, at);
    if (ended) this.numbers.countCheck(ended.place.room, ok);
    this.refreshActivity(actor, at, { id: toolId, ok });
    this.sessionChanged(at);
  }

  subagentStart(s: SubagentStart, at: number): void {
    if (!this.reportsStaff) return;
    const known = this.actors.get(s.toolId);
    if (known) {
      known.heardAt = Math.max(known.heardAt, at);
      // Its tool call answered ("launched") before the AI's record said it runs in the background, or its turn
      // ended first: it was taken as done, but it works on until the AI says its background work ended.
      if (s.background && known.state === OfficeActorState.DONE && !known.doneInBackground && !known.donePresumed) {
        known.agentType ||= s.agentType.slice(0, 60);
        this.resumeInBackground(known, at);
        return;
      }
      // Learnt more about it later (its kind, from the AI's record).
      const agentType = known.agentType || s.agentType.slice(0, 60);
      // Whether it runs in the background matters only until it is done.
      const background = known.state === OfficeActorState.DONE ? known.background : known.background || s.background;
      if (agentType === known.agentType && background === known.background) return;
      known.agentType = agentType;
      known.background = background;
      this.emit({ case: "actorUpdate", value: actorWire(known) }, at, known);
      return;
    }
    if (this.hidden.has(s.toolId) || this.seenBefore(s.toolId)) return;
    const parent = s.parentId ? this.actors.get(s.parentId) : undefined;
    const spawnDepth = s.spawnDepth ?? (parent ? parent.spawnDepth + 1 : 1);
    const parentId = parent ? parent.id : s.workflowId ? `workflow:${s.workflowId}` : "";
    this.enter(
      {
        id: s.toolId,
        role: OfficeRole.EMPLOYEE,
        agentType: s.agentType.slice(0, 60),
        // Only a subagent of the director has its description shown in the chat already.
        description: spawnDepth === 1 && parentId === "" ? s.description.slice(0, DESCRIPTION_MAX) : "",
        parentId,
        spawnDepth,
        background: s.background,
        enteredAt: at,
        between: { id: "arrive", tool: "", place: ARRIVE, subject: "", startedAt: at },
      },
      at,
    );
  }

  /**
   * The subagent's tool call answered (`fromBackground` false) or the AI
   * reported its background work ended, or its record said finished (true).
   * A subagent in the background is done only by the latter. `end.doneAt`:
   * when it finished, if known earlier than `at` (its record's last write);
   * `end.presumed`: only taken as done for its silence (its next tool call
   * brings it back). One already done keeps its time and hand-in; a sure end
   * only makes it final.
   */
  subagentDone(toolId: string, at: number, fromBackground = false, end: { doneAt?: number; presumed?: boolean } = {}): void {
    const actor = this.actors.get(toolId);
    // A subagent over the limit still hands in its work (counted); a hidden machine is not a subagent.
    if (this.hidden.get(toolId) === OfficeRole.EMPLOYEE) {
      this.hidden.delete(toolId);
      this.numbers.subagentsDone++;
      this.sessionChanged(at);
    }
    if (!actor || !isEmployee(actor)) return;
    if (actor.state === OfficeActorState.DONE) {
      if (fromBackground && end.presumed !== true) {
        actor.doneInBackground = true;
        actor.donePresumed = false;
      }
      return;
    }
    if (actor.background && !fromBackground) return;
    this.finishEmployee(actor, at, { final: fromBackground && end.presumed !== true, presumed: end.presumed === true, doneAt: end.doneAt ?? at });
    this.sessionChanged(at);
  }

  /** Background work of the tool call `toolId` ended: its machine leaves, its subagent is done. */
  backgroundEnded(toolId: string, ok: boolean, at: number): void {
    if (this.hidden.get(toolId) === OfficeRole.MACHINE) {
      this.hidden.delete(toolId);
      this.sessionChanged(at);
      return;
    }
    const actor = this.actors.get(toolId);
    if (actor && isMachine(actor)) {
      const work = actor.open[0];
      if (work) this.numbers.countCheck(work.place.room, ok);
      this.leave(actor, at);
      this.sessionChanged(at);
      return;
    }
    this.subagentDone(toolId, at, true);
  }

  setTodo(counts: TodoCounts, at: number): void {
    this.numbers.todo = counts;
    this.sessionChanged(at);
  }

  setUsage(numbers: OfficeUsageNumbers, at: number): void {
    this.numbers.usage = numbers;
    this.sessionChanged(at);
  }

  /** A permission prompt (`promptId`) for the tool call `toolId` ("" when not known) changed state. */
  prompt(promptId: string, toolId: string, state: PromptState, at: number): void {
    if (state === "waiting") {
      if (this.prompts.has(promptId)) return;
      const owner = this.actors.get(this.owners.get(toolId) ?? "") ?? this.director;
      this.prompts.set(promptId, owner.id);
      if (owner.prompts === 0) owner.stateBeforePrompt = owner.state;
      owner.prompts++;
      owner.state = OfficeActorState.AWAITING_APPROVAL;
      this.emit({ case: "approval", value: { actorId: owner.id, state: OfficeApprovalState.WAITING } }, at);
      return;
    }
    const ownerId = this.prompts.get(promptId);
    if (ownerId === undefined) return;
    this.prompts.delete(promptId);
    const owner = this.actors.get(ownerId);
    if (!owner) return;
    owner.prompts = Math.max(0, owner.prompts - 1);
    owner.state = owner.stateBeforePrompt;
    this.emit({ case: "approval", value: { actorId: owner.id, state: PROMPT_WIRE[state] } }, at);
    // Another prompt still waits on the same actor: it goes back to waiting.
    if (owner.prompts > 0) {
      owner.state = OfficeActorState.AWAITING_APPROVAL;
      this.emit({ case: "approval", value: { actorId: owner.id, state: OfficeApprovalState.WAITING } }, at);
    }
  }

  /**
   * Time passes: a subagent in the background silent for BACKGROUND_SILENT_MS
   * with no background work counted is done; after LEAVE_AFTER_IDLE_MS idle
   * with no background work (a subagent in the background still working is
   * some), everyone but the director goes home.
   */
  tick(now: number): void {
    if (!this.status.busy && this.status.backgroundTasks === 0) {
      let quiet = false;
      for (const a of this.backgroundStaff()) {
        // A tool of its own still open is work going on, however long it runs.
        if (a.open.length > 0 || now - a.heardAt < BACKGROUND_SILENT_MS) continue;
        this.finishEmployee(a, now, { final: false, presumed: true, doneAt: now });
        quiet = true;
      }
      if (quiet) {
        // Handing in their work is the last thing done: the idle time to go home runs from it.
        this.idleSince = Math.max(this.idleSince, now);
        this.sessionChanged(now);
      }
    }
    if (this.status.busy || this.status.backgroundTasks > 0 || this.backgroundStaff().length > 0 || now - this.idleSince < LEAVE_AFTER_IDLE_MS) return;
    let left = false;
    for (const a of [...this.actors.values()]) {
      // Advisor stays while the session's automatic Advisor is on.
      if (a.id === DIRECTOR_ID || isAdvisor(a)) continue;
      this.leave(a, now);
      left = true;
    }
    if (this.hidden.size > 0) {
      this.hidden.clear();
      left = true;
    }
    if (left) this.sessionChanged(now);
  }

  // --- inside ------------------------------------------------------------------

  private get director(): ActorRecord {
    const d = this.actors.get(DIRECTOR_ID);
    if (!d) throw new Error("the office has no director");
    return d;
  }

  /**
   * Someone asks Advisor (the tool call `toolId`): Advisor listens at its seat
   * until every call open to it ends. Its open calls are the askers' (owners
   * keeps those), never its own.
   */
  private advisorListens(toolId: string, at: number): void {
    const advisor = this.actors.get(ADVISOR_ID);
    if (!advisor) return;
    advisor.open.push({ id: toolId, tool: "", place: CONSULT, subject: "", startedAt: at });
    advisor.heardAt = Math.max(advisor.heardAt, at);
    this.refreshActivity(advisor, at);
  }

  private seenBefore(id: string): boolean {
    if (this.seen.has(id)) return true;
    if (this.seen.size >= SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(id);
    return false;
  }

  private turnStarted(at: number): void {
    if (this.numbers.startedAt === 0) this.numbers.startedAt = at;
    this.emit({ case: "turnStart", value: {} }, at);
    const d = this.director;
    d.between = { id: "think", tool: "", place: THINK, subject: "", startedAt: at };
    this.setActorState(d, OfficeActorState.WORKING);
    this.emit({ case: "actorUpdate", value: actorWire(d) }, at, d);
  }

  /**
   * The turn ended: open tool calls close, staff still working are done. Not
   * staff in the background: their work goes on after the turn (they finish
   * when the AI says so, or when no background work is left).
   */
  private turnEnded(at: number): void {
    this.idleSince = at;
    for (const a of [...this.actors.values()]) {
      // Advisor is told only when someone was still asking it.
      if (isMachine(a) || (isAdvisor(a) && a.open.length === 0)) continue;
      if (isEmployee(a)) {
        if (a.state !== OfficeActorState.DONE && !a.background) this.finishEmployee(a, at);
        continue;
      }
      // Advisor's open calls belong to whoever asked.
      if (!isAdvisor(a)) for (const r of a.open) this.owners.delete(r.id);
      a.open = [];
      delete a.between;
      this.setActorState(a, OfficeActorState.IDLE);
      this.emit({ case: "actorUpdate", value: actorWire(a) }, at, a);
    }
  }

  /** Fewer background tasks than machines: the oldest machines leave (all of them at 0), shown ones first, then those over the limit. */
  private backgroundShrank(count: number, at: number): void {
    const machines = [...this.actors.values()].filter(isMachine);
    const hiddenMachines = [...this.hidden].filter(([, role]) => role === OfficeRole.MACHINE).map(([id]) => id);
    let excess = machines.length + hiddenMachines.length - count;
    for (const m of machines) {
      if (excess <= 0) break;
      this.leave(m, at);
      excess--;
    }
    for (const id of hiddenMachines) {
      if (excess <= 0) break;
      this.hidden.delete(id);
      excess--;
    }
    // No background work left: staff still at work are done, but not subagents in the background (the count may
    // miss them; they end when the AI says so, when their record goes quiet, or after BACKGROUND_SILENT_MS).
    if (count === 0 && !this.status.busy) {
      for (const a of [...this.actors.values()]) if (isEmployee(a) && a.state !== OfficeActorState.DONE && !a.background) this.finishEmployee(a, at);
    }
  }

  /** Subagents in the background still working. */
  private backgroundStaff(): ActorRecord[] {
    return [...this.actors.values()].filter((a) => isEmployee(a) && a.background && a.state !== OfficeActorState.DONE);
  }

  /** A subagent taken as done before it was known to run in the background works again until its background work ends. */
  private resumeInBackground(a: ActorRecord, at: number): void {
    a.background = true;
    a.doneAt = 0;
    a.donePresumed = false;
    delete a.between;
    a.state = OfficeActorState.WORKING;
    a.stateBeforePrompt = OfficeActorState.WORKING;
    this.numbers.subagentsDone = Math.max(0, this.numbers.subagentsDone - 1);
    // The update shows no activity, and emit records that (shownId ""): its next tool starts fresh, no end of the hand-in.
    this.emit({ case: "actorUpdate", value: actorWire(a) }, at, a);
    this.sessionChanged(at);
  }

  /**
   * `end.final`: the AI said its background work ended or its record said finished, so it is done for good;
   * `end.presumed`: taken as done for its silence; `end.doneAt`: when it finished (`at` unless known earlier).
   */
  private finishEmployee(a: ActorRecord, at: number, end: { final: boolean; presumed: boolean; doneAt: number } = { final: false, presumed: false, doneAt: at }): void {
    a.doneInBackground = end.final;
    a.donePresumed = end.presumed;
    for (const r of a.open) this.owners.delete(r.id);
    a.open = [];
    a.between = { id: "hand-in", tool: "", place: HAND_IN, subject: "", startedAt: at };
    a.doneAt = Math.min(at, end.doneAt);
    a.prompts = 0;
    a.state = OfficeActorState.DONE;
    this.numbers.subagentsDone++;
    this.emit({ case: "actorUpdate", value: actorWire(a) }, at, a);
  }

  /** The actor's state, kept under a waiting prompt (it goes back to it once answered). */
  private setActorState(a: ActorRecord, state: OfficeActorState): void {
    if (a.prompts > 0) a.stateBeforePrompt = state;
    else a.state = state;
  }

  private enter(fields: Parameters<typeof newActor>[0], at: number): ActorRecord | undefined {
    if (this.actors.size >= MAX_ACTORS) {
      this.hidden.set(fields.id, fields.role);
      this.sessionChanged(at);
      return undefined;
    }
    const a = newActor(fields);
    this.actors.set(a.id, a);
    a.shownId = shownActivity(a)?.id ?? "";
    this.emit({ case: "actorEnter", value: actorWire(a) }, at);
    return a;
  }

  private leave(a: ActorRecord, at: number): void {
    // Advisor's open calls belong to whoever asked: they go on without it.
    if (!isAdvisor(a)) for (const r of a.open) this.owners.delete(r.id);
    for (const [prompt, owner] of this.prompts) if (owner === a.id) this.prompts.delete(prompt);
    this.actors.delete(a.id);
    if (isEmployee(a)) this.residents.record(a, at);
    this.emit({ case: "actorLeave", value: { actorId: a.id } }, at);
  }

  /**
   * Tells devices when the activity the actor shows changed. A start replaces
   * what was shown; an end is sent only when the shown one ended (`ended`)
   * or nothing is shown any more.
   */
  private refreshActivity(a: ActorRecord, at: number, ended?: { id: string; ok: boolean }): void {
    const d = a.id === DIRECTOR_ID;
    // The director with nothing open in a busy session is thinking.
    if (d) {
      if (a.open.length === 0 && this.status.busy) a.between ??= { id: "think", tool: "", place: THINK, subject: "", startedAt: at };
      else if (a.open.length > 0) delete a.between;
    }
    const shown = shownActivity(a);
    const shownId = shown?.id ?? "";
    if (shownId === a.shownId) return;
    const before = a.shownId;
    if (before !== "" && (ended?.id === before || !shown)) this.emit({ case: "activityEnd", value: { actorId: a.id, activityId: before, ok: ended?.ok ?? true } }, at);
    a.shownId = shownId;
    if (shown) this.emit({ case: "activityStart", value: { actorId: a.id, activity: activityWire(shown) } }, at);
  }

  /** Sends the session's numbers when one of them changed. */
  private sessionChanged(at: number): void {
    const s = this.numbers.changed(this.hidden.size);
    if (s) this.emit({ case: "session", value: s }, at);
  }

  /** One event; `actor` (with actorEnter/actorUpdate) records the activity devices now know it shows. */
  private emit(kind: EventKind, at: number, actor?: ActorRecord): void {
    if (actor) actor.shownId = shownActivity(actor)?.id ?? "";
    this.seqNo++;
    this.events.push(create(OfficeEventSchema, { seq: BigInt(this.seqNo), at: BigInt(at), kind }));
  }
}
