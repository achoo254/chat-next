// The office of one thread as the agent sees it: reads what the core and the
// AI's records say about the thread (journal items, the AI's own events,
// the thread's summary, the subagents' records) and hands it to the thread's
// OfficeTracker as signals. What leaves this file is only what the tracker
// makes of it (docs/office-wire.md).
import {
  Decision,
  type Item,
  PromptState,
  ThreadState,
  type ThreadSummary,
  ToolKind as WireToolKind,
  TodoState,
  TurnState,
} from "@achoo254/chat-proto/remote/remote";
import type { HistoryEntry, ProviderEvent, SubagentReport, ToolKind } from "../providers/types.ts";
import { type OfficeStatus, OfficeTracker } from "./office-tracker.ts";
import { OfficeUsageTally } from "./office-usage.ts";

const KIND: Record<WireToolKind, ToolKind> = {
  [WireToolKind.UNSPECIFIED]: "other",
  [WireToolKind.READ]: "read",
  [WireToolKind.EDIT]: "edit",
  [WireToolKind.SHELL]: "shell",
  [WireToolKind.SEARCH]: "search",
  [WireToolKind.WEB]: "web",
  [WireToolKind.MCP]: "mcp",
  [WireToolKind.SUBAGENT]: "subagent",
  [WireToolKind.TODO]: "todo",
  [WireToolKind.OTHER]: "other",
};

/** The prompt id the tracker uses for prompts outside the journal (sign-in secrets, a session run elsewhere). */
const OUTSIDE_PROMPT = "outside";
/** Subagents a record reports that finished this long before the office was built are not brought in. */
const STALE_SUBAGENT_MS = 10 * 60_000;
/** Reads of the subagents' records made each time one is due (see OfficeThread.recordsDue). */
const RECORD_READS_DUE = 2;

/** One option Advisor weighed (AdvisorOption). */
type AdvisorChoice = { readonly text: string; readonly probability: number };

/** What Advisor's bubble says at most (OfficeActor.description). */
const ADVISOR_SAYS_MAX = 80;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Advisor's bubble for one answer: its likeliest option and how likely,
 * "<option> · 72%", cut to ADVISOR_SAYS_MAX characters; "" when Advisor did
 * not answer (an error, nothing weighed). From an AdvisorVerdictItem; the options are what the session's
 * Advisor card already shows (sent to Advisor after secrets were hidden).
 */
export function advisorSays(v: { readonly error: string; readonly options: readonly AdvisorChoice[] }): string {
  if (v.error !== "") return "";
  let top: AdvisorChoice | undefined;
  for (const o of v.options) if (top === undefined || o.probability > top.probability) top = o;
  if (top === undefined) return "";
  const text = top.text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const suffix = ` · ${Math.round(Math.min(1, Math.max(0, top.probability)) * 100)}%`;
  const room = ADVISOR_SAYS_MAX - suffix.length;
  const chars = [...text];
  return `${chars.length <= room ? text : `${chars.slice(0, room - 1).join("")}…`}${suffix}`;
}

/** Whether the tool call runs in the background (a machine of the office): its input asks for it, or it is a Monitor. */
function inBackground(name: string, input: string): boolean {
  if (name === "Monitor") return true;
  if (!input.includes("run_in_background")) return false;
  try {
    const v: unknown = JSON.parse(input);
    return typeof v === "object" && v !== null && (v as { run_in_background?: unknown }).run_in_background === true;
  } catch {
    // Shortened input: the flag itself is what counts.
    return /"run_in_background"\s*:\s*true/.test(input);
  }
}

/**
 * What the agent remembers of every thread while devices are connected, office
 * or not: the AI's session id of each thread, and what the AI said about each
 * subagent when it started it (its kind, whether in the background), which
 * the journal does not keep. An office built later starts from it.
 */
export class OfficeMemory {
  private static readonly SUBAGENTS_MAX = 5_000;
  readonly sessionIds = new Map<string, string>();
  readonly subagents = new Map<string, { agentType: string; background: boolean }>();

  /** Takes what an event of a thread's AI tells; true when it was about a subagent starting. */
  remember(threadId: string, e: ProviderEvent | HistoryEntry): boolean {
    if (e.type === "session") this.sessionIds.set(threadId, e.sessionId);
    if (e.type !== "subagent" || e.done) return false;
    if (this.subagents.size >= OfficeMemory.SUBAGENTS_MAX) {
      const oldest = this.subagents.keys().next().value;
      if (oldest !== undefined) this.subagents.delete(oldest);
    }
    this.subagents.set(e.toolId, { agentType: e.agentType ?? "", background: e.background === true });
    return true;
  }
}

/** The machine runs the thread's turn itself (not a session elsewhere). */
const runsHere = (s: ThreadSummary): boolean => s.state === ThreadState.RUNNING || s.state === ThreadState.WAITING || s.state === ThreadState.QUEUED;

export class OfficeThread {
  readonly tracker: OfficeTracker;
  private readonly usage = new OfficeUsageTally();
  /** Prompts in the journal still waiting (approvals and questions). */
  private readonly openPrompts = new Set<string>();
  private summary: ThreadSummary | undefined;
  private readonly builtAt: number;
  /**
   * Reads of the subagents' records due: after the office is built (turns
   * and subagents of runs elsewhere before it), and after a run elsewhere
   * ends (its last lines). Each is RECORD_READS_DUE reads: the provider's read
   * never fails but may come back empty after an I/O error, and one more
   * read (POLL_MS later) keeps such an error from losing the last lines.
   */
  private recordsDue = RECORD_READS_DUE;
  /** The last turn seen ran elsewhere (not on the machine): its background work is in the records only. */
  private ranElsewhere = false;

  constructor(
    readonly threadId: string,
    reportsStaff: boolean,
    private readonly memory: OfficeMemory,
    now: number,
  ) {
    this.tracker = new OfficeTracker(reportsStaff, now);
    this.builtAt = now;
  }

  /** Builds the office from the thread's journal (its times), then its summary now. */
  seed(items: readonly Item[], summary: ThreadSummary, now: number): void {
    let last = 0;
    for (const item of items) {
      const at = Number(item.at) || now;
      last = Math.max(last, at);
      // Each turn of the journal ends what the turn before it left open.
      if (item.body.case === "turn") {
        this.tracker.setStatus({ busy: false, waitingForUser: false, backgroundTasks: 0 }, at);
        this.tracker.setStatus({ busy: true, waitingForUser: false, backgroundTasks: 0 }, at);
      }
      this.item(item, at);
    }
    this.setSummary(summary, now);
    this.tracker.settle(last || now, now);
  }

  setSummary(s: ThreadSummary, at: number): void {
    if (this.summary?.busyElsewhere && !s.busyElsewhere) this.recordsDue = RECORD_READS_DUE;
    if (s.busyElsewhere) this.ranElsewhere = true;
    else if (runsHere(s)) this.ranElsewhere = false;
    this.summary = s;
    const elsewhere = s.busyElsewhere;
    const status: OfficeStatus = {
      busy: runsHere(s) || elsewhere,
      waitingForUser: s.state === ThreadState.WAITING || (elsewhere && s.pending > 0),
      backgroundTasks: s.backgroundTasks,
    };
    this.tracker.setStatus(status, at);
    // Prompts the journal does not hold (a sign-in secret, a session run elsewhere): the director waits.
    // The core writes a prompt's journal item before it counts the prompt in `pending` (and takes it out
    // of `pending` before it marks the item answered), so a prompt of the journal is never taken for one outside.
    const outside = s.pending > this.openPrompts.size;
    this.tracker.prompt(OUTSIDE_PROMPT, "", outside ? "waiting" : "cancelled", at);
  }

  /** One journal item, new or updated. */
  item(item: Item, at: number): void {
    const b = item.body;
    switch (b.case) {
      case "toolCall": {
        const v = b.value;
        const kind = KIND[v.kind];
        this.tracker.toolStart(
          { toolId: v.toolId, name: v.name, kind, summary: v.summary, sensitive: v.sensitive, background: kind === "shell" && inBackground(v.name, v.input) },
          at,
        );
        return;
      }
      case "toolResult":
        this.tracker.toolEnd(b.value.toolId, b.value.ok, at);
        return;
      case "subagent": {
        const v = b.value;
        const said = this.memory.subagents.get(v.toolId);
        // A journal item is updated in place: one read back already done never showed starting (a start seen before is a no-op).
        this.tracker.subagentStart({ toolId: v.toolId, agentType: said?.agentType ?? "", description: v.description, background: said?.background ?? false }, at);
        if (v.done) this.tracker.subagentDone(v.toolId, at);
        return;
      }
      case "todo": {
        const counts = { pending: 0, inProgress: 0, done: 0 };
        for (const e of b.value.entries) {
          if (e.state === TodoState.DONE) counts.done++;
          else if (e.state === TodoState.IN_PROGRESS) counts.inProgress++;
          else counts.pending++;
        }
        this.tracker.setTodo(counts, at);
        return;
      }
      case "approval": {
        const v = b.value;
        if (v.state === PromptState.PENDING) {
          this.openPrompts.add(item.id);
          this.tracker.prompt(item.id, v.toolId, "waiting", at);
          return;
        }
        this.openPrompts.delete(item.id);
        const state = v.state === PromptState.ANSWERED ? (v.decision === Decision.DENY ? "denied" : "allowed") : "cancelled";
        this.tracker.prompt(item.id, v.toolId, state, at);
        return;
      }
      case "advisorVerdict":
        this.tracker.advisorAnswered(advisorSays(b.value), at);
        return;
      case "question":
        if (b.value.state === PromptState.PENDING) this.openPrompts.add(item.id);
        else this.openPrompts.delete(item.id);
        return;
      case "turn": {
        const v = b.value;
        this.usage.addTurn(item.id, {
          at: Number(item.at),
          durationMs: Number(v.durationMs),
          running: v.state === TurnState.RUNNING,
          inputTokens: Number(v.inputTokens),
          outputTokens: Number(v.outputTokens),
          costUsd: v.costUsdEstimate,
        });
        this.tracker.setUsage(this.usage.numbers(), at);
        return;
      }
      default:
        return;
    }
  }

  /** The AI's session id of the thread, when known. */
  get sessionId(): string {
    return this.memory.sessionIds.get(this.threadId) ?? "";
  }

  /**
   * An event of the thread's AI (live), or an entry read back from its
   * transcript: what the journal does not keep. The hub has put it in the
   * memory already.
   */
  providerEvent(e: ProviderEvent | HistoryEntry, at: number): void {
    switch (e.type) {
      case "subagent":
        // Already in (built from the journal before its kind was known): it learns its kind.
        if (!e.done && this.tracker.has(e.toolId)) this.tracker.subagentStart({ toolId: e.toolId, agentType: e.agentType ?? "", description: "", background: e.background === true }, at);
        return;
      case "subagent-tool":
        if (!e.done) {
          if (e.kind === "subagent") this.tracker.subagentStart({ toolId: e.toolId, parentId: e.parentToolId, agentType: e.agentType ?? "", description: "", background: false }, at);
          else
            this.tracker.toolStart(
              { toolId: e.toolId, actorId: e.parentToolId, name: e.name, kind: e.kind, summary: "", sensitive: false, background: false, ...(e.command !== undefined ? { command: e.command } : {}) },
              at,
            );
        } else if (this.tracker.has(e.toolId)) this.tracker.subagentDone(e.toolId, at);
        else this.tracker.toolEnd(e.toolId, e.ok !== false, at);
        return;
      case "background-task":
        this.tracker.backgroundEnded(e.toolId, e.ok, at);
        return;
      default:
        return;
    }
  }

  /**
   * Whether the subagents' records are worth reading now: the AI keeps them,
   * the machine does not run the turn (its own stream tells it all, background
   * subagents included), and the session runs elsewhere (or its background
   * work from a run elsewhere goes on) or a read is due.
   * An idle thread the machine ran is read once, for what earlier runs
   * elsewhere left, and not again until it runs elsewhere.
   */
  wantsSubagentRecords(): boolean {
    if (this.sessionId === "" || (this.summary && runsHere(this.summary))) return false;
    const s = this.summary;
    return this.recordsDue > 0 || s?.busyElsewhere === true || (this.ranElsewhere && (s?.backgroundTasks ?? 0) > 0);
  }

  /** What the AI's records tell of the session's subagents and calls (a session run elsewhere). */
  subagentReport(r: SubagentReport, at: number): void {
    this.recordsDue = Math.max(0, this.recordsDue - 1);
    for (const s of r.subagents) {
      if (s.finished && s.updatedAt > 0 && s.updatedAt < this.builtAt - STALE_SUBAGENT_MS) {
        // Not brought in, but one the journal already put in learns its kind: the journal does not keep it, and
        // the agent's memory of it is gone after a restart (else it would be a nameless "new employee").
        if (this.tracker.has(s.toolUseId)) {
          // Finished: it only learns its kind (never back to work to hand in again), and its end is final, at its record's last write.
          this.tracker.subagentStart({ toolId: s.toolUseId, agentType: s.agentType, description: s.description, background: false }, at);
          this.tracker.subagentDone(s.toolUseId, at, true, { doneAt: s.updatedAt });
        }
        continue;
      }
      this.tracker.subagentStart(
        {
          toolId: s.toolUseId,
          ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
          ...(s.workflowId ? { workflowId: s.workflowId } : {}),
          agentType: s.agentType,
          description: s.description,
          // A finished one is not brought back to work to hand in again.
          background: s.background && !s.finished,
          spawnDepth: s.spawnDepth,
        },
        at,
      );
      for (const t of s.tools) {
        if (t.kind === "subagent") continue;
        this.tracker.toolStart(
          { toolId: t.toolId, actorId: s.toolUseId, name: t.name, kind: t.kind, summary: "", sensitive: false, background: false, ...(t.command !== undefined ? { command: t.command } : {}) },
          t.at || at,
        );
        if (t.done) this.tracker.toolEnd(t.toolId, t.ok, at);
      }
      if (s.finished) {
        this.tracker.subagentDone(s.toolUseId, at, true, s.updatedAt > 0 ? { doneAt: s.updatedAt } : {});
        continue;
      }
      // In the background with its record quiet for STALE_SUBAGENT_MS, no tool of its own open and no background work
      // counted: presumed gone (the AI that ran it quit). Only presumed: its next tool call brings it back.
      const quiet =
        s.background && s.updatedAt > 0 && at - s.updatedAt > STALE_SUBAGENT_MS && !s.tools.some((t) => !t.done) && (this.summary?.backgroundTasks ?? 0) === 0;
      if (quiet) this.tracker.subagentDone(s.toolUseId, at, true, { presumed: true });
    }
    if (r.usage.length > 0) {
      this.usage.addCalls(r.usage);
      this.tracker.setUsage(this.usage.numbers(), at);
    }
  }
}
