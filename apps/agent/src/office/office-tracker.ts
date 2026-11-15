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
import { ARRIVE, HAND_IN, THINK, classifyActivity } from "./office-activity-map.ts";
import { type ActivityRecord, type ActorRecord, DIRECTOR_ID, activityWire, actorWire, isEmployee, isMachine, newActor, shownActivity } from "./office-actor.ts";
import { officeSubject } from "./office-subject.ts";
import { type OfficeStatus, SessionNumbers, type TodoCounts } from "./office-session-numbers.ts";
import type { OfficeUsageNumbers } from "./office-usage.ts";

export type { OfficeStatus, TodoCounts } from "./office-session-numbers.ts";

/** Actors devices get at most (the director included); the rest are only counted. */
export const MAX_ACTORS = 64;
/** How long the session stays idle before finished staff go home. */
export const LEAVE_AFTER_IDLE_MS = 10 * 60_000;
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
  /** Actors over MAX_ACTORS: tracked by id only, never sent. */
  private readonly hidden = new Set<string>();
  /** Which actor each open tool call belongs to. */
  private readonly owners = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** Open permission prompts and the actor each one waits on. */
  private readonly prompts = new Map<string, string>();
  private events: OfficeEvent[] = [];
  private readonly numbers = new SessionNumbers();
  private idleSince: number;

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
    if (t.background && !t.actorId) {
      // A shell in the background is a machine of its own, standing in its room until its work ends.
      const work: ActivityRecord = { id: t.toolId, tool: t.name, place, subject: "", startedAt: at };
      this.enter({ id: t.toolId, role: OfficeRole.MACHINE, agentType: t.name.slice(0, 60), background: true, enteredAt: at, open: [work] }, at);
      return;
    }
    const actor = this.actors.get(t.actorId ?? DIRECTOR_ID);
    if (!actor || actor.state === OfficeActorState.DONE) return;
    const subject = actor.id === DIRECTOR_ID ? officeSubject(t) : "";
    actor.open.push({ id: t.toolId, tool: t.name, place, subject, startedAt: at });
    // A subagent's first tool call: it has arrived.
    if (actor.between?.id === "arrive") delete actor.between;
    this.owners.set(t.toolId, actor.id);
    this.refreshActivity(actor, at);
  }

  toolEnd(toolId: string, ok: boolean, at: number): void {
    const actor = this.actors.get(this.owners.get(toolId) ?? "");
    if (!actor || isMachine(actor)) return;
    this.owners.delete(toolId);
    const i = actor.open.findIndex((r) => r.id === toolId);
    if (i < 0) return;
    const [ended] = actor.open.splice(i, 1);
    if (ended) this.numbers.countCheck(ended.place.room, ok);
    this.refreshActivity(actor, at, { id: toolId, ok });
    this.sessionChanged(at);
  }

  subagentStart(s: SubagentStart, at: number): void {
    if (!this.reportsStaff) return;
    const known = this.actors.get(s.toolId);
    if (known) {
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
   * reported its background work ended (true). A subagent in the background
   * is done only by the latter.
   */
  subagentDone(toolId: string, at: number, fromBackground = false): void {
    const actor = this.actors.get(toolId);
    if (this.hidden.delete(toolId)) {
      this.numbers.subagentsDone++;
      this.sessionChanged(at);
    }
    if (!actor || !isEmployee(actor) || actor.state === OfficeActorState.DONE) return;
    if (actor.background && !fromBackground) return;
    this.finishEmployee(actor, at);
    this.sessionChanged(at);
  }

  /** Background work of the tool call `toolId` ended: its machine leaves, its subagent is done. */
  backgroundEnded(toolId: string, ok: boolean, at: number): void {
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

  /** Time passes: after LEAVE_AFTER_IDLE_MS idle with no background work, everyone but the director goes home. */
  tick(now: number): void {
    if (this.status.busy || this.status.backgroundTasks > 0 || now - this.idleSince < LEAVE_AFTER_IDLE_MS) return;
    let left = false;
    for (const a of [...this.actors.values()]) {
      if (a.id === DIRECTOR_ID) continue;
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
      if (isMachine(a)) continue;
      if (isEmployee(a)) {
        if (a.state !== OfficeActorState.DONE && !a.background) this.finishEmployee(a, at);
        continue;
      }
      for (const r of a.open) this.owners.delete(r.id);
      a.open = [];
      delete a.between;
      this.setActorState(a, OfficeActorState.IDLE);
      this.emit({ case: "actorUpdate", value: actorWire(a) }, at, a);
    }
  }

  /** Fewer background tasks than machines: the oldest machines leave (all of them at 0). */
  private backgroundShrank(count: number, at: number): void {
    const machines = [...this.actors.values()].filter(isMachine);
    for (const m of machines.slice(0, Math.max(0, machines.length - count))) this.leave(m, at);
    if (count === 0 && !this.status.busy) {
      for (const a of [...this.actors.values()]) if (isEmployee(a) && a.state !== OfficeActorState.DONE) this.finishEmployee(a, at);
    }
  }

  private finishEmployee(a: ActorRecord, at: number): void {
    for (const r of a.open) this.owners.delete(r.id);
    a.open = [];
    a.between = { id: "hand-in", tool: "", place: HAND_IN, subject: "", startedAt: at };
    a.doneAt = at;
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
      this.hidden.add(fields.id);
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
    for (const r of a.open) this.owners.delete(r.id);
    for (const [prompt, owner] of this.prompts) if (owner === a.id) this.prompts.delete(prompt);
    this.actors.delete(a.id);
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
