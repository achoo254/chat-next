// The numbers of a session's office (OfficeSession on the wire): where the
// session stands, todo entries by state, tokens and cost, test runs passed
// and failed. Counts only, never a text. Sent whole, only when one changed.
import { create } from "@bufbuild/protobuf";
import { OfficeRoom, type OfficeSession, OfficeSessionSchema } from "@achoo254/chat-proto/remote/remote";
import { NO_USAGE, type OfficeUsageNumbers } from "./office-usage.ts";

export type OfficeStatus = { busy: boolean; waitingForUser: boolean; backgroundTasks: number };

export type TodoCounts = { pending: number; inProgress: number; done: number };

export class SessionNumbers {
  status: OfficeStatus = { busy: false, waitingForUser: false, backgroundTasks: 0 };
  /** Unix ms the first turn began; 0 before one. */
  startedAt = 0;
  subagentsDone = 0;
  todo: TodoCounts = { pending: 0, inProgress: 0, done: 0 };
  usage: OfficeUsageNumbers = NO_USAGE;
  private readonly checks = { passed: 0, failed: 0, lastOk: false };
  private sent: string;

  constructor() {
    this.sent = key(this.wire(0));
  }

  /** A test, lint or typecheck run (an activity in the QA room) ended. */
  countCheck(room: OfficeRoom, ok: boolean): void {
    if (room !== OfficeRoom.QA) return;
    if (ok) this.checks.passed++;
    else this.checks.failed++;
    this.checks.lastOk = ok;
  }

  wire(hiddenActors: number): OfficeSession {
    const u = this.usage;
    return create(OfficeSessionSchema, {
      busy: this.status.busy,
      waitingForUser: this.status.waitingForUser,
      startedAt: BigInt(this.startedAt),
      tasksDone: this.subagentsDone + this.todo.done,
      backgroundMachines: this.status.backgroundTasks,
      todo: { pending: this.todo.pending, inProgress: this.todo.inProgress, done: this.todo.done },
      usage: {
        inputTokens: BigInt(Math.round(u.inputTokens)),
        outputTokens: BigInt(Math.round(u.outputTokens)),
        costUsdEstimate: u.costUsd,
        hasCost: u.hasCost,
        available: u.available,
      },
      checks: { passed: this.checks.passed, failed: this.checks.failed, lastOk: this.checks.lastOk },
      hiddenActors,
    });
  }

  /** The numbers to send when one changed since they were last taken; undefined when none did. */
  changed(hiddenActors: number): OfficeSession | undefined {
    const s = this.wire(hiddenActors);
    const k = key(s);
    if (k === this.sent) return undefined;
    this.sent = k;
    return s;
  }
}

function key(s: OfficeSession): string {
  const u = s.usage;
  const t = s.todo;
  const c = s.checks;
  return [
    s.busy,
    s.waitingForUser,
    s.startedAt,
    s.tasksDone,
    s.backgroundMachines,
    t?.pending,
    t?.inProgress,
    t?.done,
    u?.inputTokens,
    u?.outputTokens,
    u?.costUsdEstimate,
    u?.hasCost,
    u?.available,
    c?.passed,
    c?.failed,
    c?.lastOk,
    s.hiddenActors,
  ].join("|");
}
