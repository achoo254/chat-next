// Tokens and estimated cost of one session for the office's audit board
// (docs/office-wire.md, part 6). Turns the machine ran count by what the core
// already worked out for each of them (its TurnItem: tokens of the turn's own
// conversation, cost with subagents); calls to the AI's API read from the
// AI's transcript count only outside those turns, so a turn the machine ran
// is never counted twice. Pure: no clock, no I/O.
import type { SessionUsageCall } from "../providers/types.ts";

export type OfficeUsageNumbers = { inputTokens: number; outputTokens: number; costUsd: number; hasCost: boolean; available: boolean };

/** A turn the machine ran, from its journal item. `durationMs` is 0 while it runs. */
export type MachineTurn = { at: number; durationMs: number; running: boolean; inputTokens: number; outputTokens: number; costUsd: number };

/** Clock skew allowed between the journal's times and the transcript's. */
const WINDOW_SLACK_MS = 2_000;
/** Calls kept per session at most (a call is a few numbers). */
const CALLS_MAX = 200_000;

export const NO_USAGE: OfficeUsageNumbers = { inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false, available: false };

export class OfficeUsageTally {
  private readonly turns = new Map<string, MachineTurn>();
  private readonly calls = new Map<string, SessionUsageCall>();
  private cached: OfficeUsageNumbers | undefined = NO_USAGE;

  /** A turn the machine ran, by its journal item id; seen again (it ended, it was updated) it replaces the earlier copy. */
  addTurn(itemId: string, turn: MachineTurn): void {
    this.turns.set(itemId, turn);
    this.cached = undefined;
  }

  /** Calls read from the transcript; one seen before (same key) is not counted again. */
  addCalls(calls: readonly SessionUsageCall[]): void {
    for (const c of calls) {
      if (this.calls.has(c.key)) continue;
      if (this.calls.size >= CALLS_MAX) {
        const oldest = this.calls.keys().next().value;
        if (oldest !== undefined) this.calls.delete(oldest);
      }
      this.calls.set(c.key, c);
      this.cached = undefined;
    }
  }

  numbers(): OfficeUsageNumbers {
    this.cached ??= this.count();
    return this.cached;
  }

  private count(): OfficeUsageNumbers {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let ended = 0;
    const windows: [number, number][] = [];
    for (const t of this.turns.values()) {
      windows.push([t.at - WINDOW_SLACK_MS, t.running ? Number.POSITIVE_INFINITY : t.at + t.durationMs + WINDOW_SLACK_MS]);
      if (t.running) continue;
      ended++;
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
      costUsd += t.costUsd;
    }
    const merged = mergeWindows(windows);
    let counted = 0;
    for (const c of this.calls.values()) {
      if (insideAny(merged, c.at)) continue;
      counted++;
      inputTokens += c.inputTokens;
      outputTokens += c.outputTokens;
    }
    return { inputTokens, outputTokens, costUsd, hasCost: costUsd > 0, available: ended > 0 || counted > 0 };
  }
}

/** Windows sorted by start, overlapping ones joined. */
function mergeWindows(windows: [number, number][]): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/** Whether `at` falls in one of the sorted, disjoint windows (binary search). */
function insideAny(windows: readonly [number, number][], at: number): boolean {
  let lo = 0;
  let hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid];
    if (!w) return false;
    if (at < w[0]) hi = mid - 1;
    else if (at > w[1]) lo = mid + 1;
    else return true;
  }
  return false;
}
