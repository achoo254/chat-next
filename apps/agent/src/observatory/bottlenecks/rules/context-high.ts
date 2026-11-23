// `context_high` (CORE, no subkey): the latest API call of the session's
// main thread filled more than `warnPercent` of its model's context window
// (alert past `alertPercent`). Judged only when the model's window is known
// (live-map/model-window.ts, given to the runner): no percentage is guessed.
// Closes when a later main-thread call is back under `warnPercent`, or a
// compaction ended after the call.
import { apiTokens } from "../session-model.ts";
import type { Rule } from "./rule-types.ts";
import { apiEventId, severityOf } from "./rule-support.ts";

/** A call of the session's main thread (not a subagent's, a compaction's or a title's), as the ingest tells them. */
function mainThread(agentId: string | null, querySource: string | null): boolean {
  return agentId === null && (querySource === null || querySource === "sdk" || querySource.startsWith("repl_main_thread"));
}

export const contextHigh: Rule = {
  name: "context_high",
  evaluate(ctx) {
    const last = ctx.session.apiCalls.findLast((a) => mainThread(a.agentId, a.querySource) && a.model !== null && a.inputTokens !== null);
    if (!last || last.model === null) return [];
    if (ctx.session.events.some((e) => e.kind === "compact_end" && e.at > last.at)) return [];
    const largest = Math.max(...ctx.session.apiCalls.map((a) => apiTokens({ ...a, outputTokens: 0 })));
    const window = ctx.contextWindow(last.model, largest);
    if (window === undefined || window <= 0) return [];
    // The context the call read: its input, cached or not (its output is not in it yet).
    const used = apiTokens({ ...last, outputTokens: 0 });
    const percent = (used / window) * 100;
    const t = ctx.thresholds.of("context_high");
    const severity = severityOf(percent, t.warnPercent, t.alertPercent);
    if (!severity) return [];
    return [{ subkey: "", station: "CORE", severity, value: percent, threshold: t.warnPercent, n: null, measures: { tokens: used, window, model: last.model }, evidence: [apiEventId(last.dedupeKey)] }];
  },
};
