// What every bottleneck rule takes and returns. A rule is a pure function of
// one session as the runner holds it, the time, the thresholds, the machine's
// history and the rule's own findings so far; it answers the findings that
// should be open now, one per subkey. The lifecycle (finding-lifecycle.ts)
// opens, raises and closes rows from that answer: a subkey open before and
// absent now is closed, so each rule's close condition is the condition under
// which it stops answering the subkey.
import type { BottleneckSeverity, BottleneckStatus } from "../../store/observatory-rows.ts";
import type { BottleneckRule, ThresholdTable } from "../bottleneck-thresholds.ts";
import type { HistoryView } from "../history-percentiles.ts";
import type { SessionModel } from "../session-model.ts";

/** A rule's finding for one subkey as it stands (open or closed), for rules whose close condition is not just "no longer true". */
export type Prior = { status: BottleneckStatus; severity: BottleneckSeverity; openedAt: number; closedAt: number | null };

export type RuleContext = {
  now: number;
  session: SessionModel;
  thresholds: ThresholdTable;
  history: HistoryView;
  /** The rule's stored finding for `subkey`, if it ever had one in this session. */
  prior: (subkey: string) => Prior | undefined;
  /**
   * The context window of `model` in tokens, given the largest context one of
   * the session's requests carried (live-map/model-window.ts); undefined when
   * the model is not known (no percentage is guessed).
   */
  contextWindow: (model: string, largestContext: number) => number | undefined;
};

/** A finding that should be open now. Measures and evidence never hold content: numbers, names the privacy filter kept, event ids. */
export type Verdict = {
  subkey: string;
  station: string;
  severity: BottleneckSeverity;
  /** What was measured (a duration, a count, a percentage, a rate). */
  value: number;
  /** The threshold it is compared with (the warning's). */
  threshold: number;
  /** The history count behind the threshold, or the count measured. */
  n: number | null;
  /** The other numbers behind the verdict, by name. */
  measures: Record<string, number | string>;
  /** The ids of the events behind it (the ids devices get), most telling first. */
  evidence: string[];
};

export type Rule = { name: BottleneckRule; evaluate: (ctx: RuleContext) => Verdict[] };
