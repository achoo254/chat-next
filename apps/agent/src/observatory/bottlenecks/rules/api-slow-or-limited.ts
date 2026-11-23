// `api_slow_or_limited` (EXTERNAL, by model): the model's latest API call
// spent more milliseconds per output token than `warnRatio` × the model's
// p95 (at least `minN` calls in history) and lasted over `minDurationMs`
// (warning), or the model answered 429, rate limited, after its latest call
// (alert). Closes on the model's next normal call: the latest call is then
// neither slow nor followed by a 429.
import type { ApiCallState } from "../session-model.ts";
import type { Rule, Verdict } from "./rule-types.ts";
import { apiEventId, newest, sessionEventId } from "./rule-support.ts";

const RATE_LIMITED = 429;

export const apiSlowOrLimited: Rule = {
  name: "api_slow_or_limited",
  evaluate(ctx) {
    const latest = new Map<string, ApiCallState>();
    for (const call of ctx.session.apiCalls) {
      if (call.model !== null && call.durationMs !== null && (call.outputTokens ?? 0) > 0) latest.set(call.model, call);
    }
    const limited = new Map<string, string[]>();
    for (const e of ctx.session.events) {
      if (e.kind !== "api_error" || e.label === null || (e.flag !== true && e.number !== RATE_LIMITED)) continue;
      const last = latest.get(e.label);
      if (last && last.at >= e.at) continue;
      limited.set(e.label, [...(limited.get(e.label) ?? []), sessionEventId(e.dedupeKey)]);
    }
    const out: Verdict[] = [];
    for (const [model, ids] of limited) {
      out.push({ subkey: model, station: "EXTERNAL", severity: "alert", value: ids.length, threshold: 1, n: ids.length, measures: { status: RATE_LIMITED }, evidence: newest(ids) });
    }
    for (const [model, call] of latest) {
      if (limited.has(model) || call.durationMs === null || call.outputTokens === null) continue;
      const t = ctx.thresholds.of("api_slow_or_limited", model);
      if (call.durationMs <= t.minDurationMs) continue;
      const hist = ctx.history.apiMsPerTokenP95(model);
      if (!hist || hist.n < t.minN) continue;
      const perToken = call.durationMs / call.outputTokens;
      const line = hist.p95 * t.warnRatio;
      if (perToken <= line) continue;
      out.push({
        subkey: model,
        station: "EXTERNAL",
        severity: "warn",
        value: perToken,
        threshold: line,
        n: hist.n,
        measures: { durationMs: call.durationMs, outputTokens: call.outputTokens, p95MsPerToken: hist.p95 },
        evidence: [apiEventId(call.dedupeKey)],
      });
    }
    return out;
  },
};
