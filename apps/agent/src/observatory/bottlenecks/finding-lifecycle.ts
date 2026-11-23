// The findings of one session and how they change: a rule's answer
// (rules/rule-types.ts) opens a finding for a subkey it names (or opens it
// again after it closed), updates it when its severity changes, and closes a
// finding open before that the answer no longer names. A session's end closes
// all its open findings. Each change is the whole row (the store keeps the
// latest write of the row: observatory-table-specs.ts) and one event for the
// listeners (the hub sends them to devices).
import type { BottleneckRow } from "../store/observatory-rows.ts";
import type { BottleneckRule } from "./bottleneck-thresholds.ts";
import type { Prior, Verdict } from "./rules/rule-types.ts";
import { MAX_EVIDENCE } from "./rules/rule-support.ts";

export type FindingChange = { type: "open" | "update" | "close"; row: BottleneckRow };

const keyOf = (rule: string, subkey: string): string => `${rule}\u0000${subkey}`;

/** The evidence column: the measures and at most MAX_EVIDENCE event ids under `eventIds`, the key the hub sends to devices (never content). */
export function evidenceJson(verdict: Verdict): string {
  return JSON.stringify({ measures: verdict.measures, eventIds: verdict.evidence.slice(0, MAX_EVIDENCE) });
}

export class SessionFindings {
  private readonly rows = new Map<string, BottleneckRow>();

  constructor(readonly sessionId: string) {}

  /** Takes the findings already stored for the session. */
  load(rows: readonly BottleneckRow[]): void {
    for (const row of rows) this.rows.set(keyOf(row.rule, row.subkey), row);
  }

  get hasOpen(): boolean {
    for (const row of this.rows.values()) if (row.status === "open") return true;
    return false;
  }

  prior(rule: BottleneckRule, subkey: string): Prior | undefined {
    const row = this.rows.get(keyOf(rule, subkey));
    return row && { status: row.status, severity: row.severity, openedAt: row.openedAt, closedAt: row.closedAt };
  }

  /** The changes `verdicts` (the rule's whole answer now) make at `now`. */
  reconcile(rule: BottleneckRule, verdicts: readonly Verdict[], now: number): FindingChange[] {
    const changes: FindingChange[] = [];
    const named = new Set<string>();
    for (const v of verdicts) {
      const key = keyOf(rule, v.subkey);
      named.add(key);
      const stored = this.rows.get(key);
      const measured = { station: v.station, value: v.value, threshold: v.threshold, n: v.n, evidenceJson: evidenceJson(v) };
      if (stored?.status !== "open") {
        changes.push(this.put({ sessionId: this.sessionId, rule, subkey: v.subkey, severity: v.severity, status: "open", openedAt: now, updatedAt: now, closedAt: null, ...measured }, "open"));
      } else if (stored.severity !== v.severity) {
        changes.push(this.put({ ...stored, ...measured, severity: v.severity, updatedAt: now }, "update"));
      }
    }
    for (const [key, row] of this.rows) {
      if (row.rule === rule && row.status === "open" && !named.has(key)) changes.push(this.put({ ...row, status: "closed", closedAt: now, updatedAt: now }, "close"));
    }
    return changes;
  }

  /** Closes every open finding at `at` (the session ended, or went quiet). */
  closeAll(at: number): FindingChange[] {
    const changes: FindingChange[] = [];
    for (const row of [...this.rows.values()]) {
      if (row.status === "open") changes.push(this.put({ ...row, status: "closed", closedAt: at, updatedAt: at }, "close"));
    }
    return changes;
  }

  private put(row: BottleneckRow, type: FindingChange["type"]): FindingChange {
    this.rows.set(keyOf(row.rule, row.subkey), row);
    return { type, row };
  }
}
