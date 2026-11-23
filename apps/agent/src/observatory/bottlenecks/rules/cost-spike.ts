// `cost_spike` (CORE: the Live Map has no station of its own for cost; by prompt id): a turn (a prompt and every API
// call it made, subagents' too) costing more than `warnRatio` × the p95 of
// the project's turns before it (alert past `alertRatio` ×), with at least
// `minN` of them (the latest turns of the last 90 days:
// history-percentiles.ts) and above the floor (`minUsd`). When the turn or a
// turn of the baseline has a call without a cost, every turn is compared by
// its total tokens instead (floor `minTokens`), and the finding says so
// (`unit`). Closes `closeAfterMs` after the turn ended.
//
// The p95, not the mean of the last turns: a turn's size follows its number
// of API calls (one to forty in a real session), so a busy stretch of work
// is always twice the mean; measured on a real working session, the mean
// flagged five turns of 28.
import type { Rule, Verdict } from "./rule-types.ts";
import { apiEventId, maxSeverity, newest, severityOf, turnEndAt } from "./rule-support.ts";
import { apiTokens } from "../session-model.ts";
import { p95 } from "../history-percentiles.ts";

export const costSpike: Rule = {
  name: "cost_spike",
  evaluate(ctx) {
    const project = ctx.session.projectKey;
    if (project === null) return [];
    const out: Verdict[] = [];
    for (const prompt of ctx.session.prompts) {
      const t = ctx.thresholds.of("cost_spike", prompt.promptId);
      const end = turnEndAt(ctx.session, prompt);
      if (end !== undefined && ctx.now - end > t.closeAfterMs) continue;
      const calls = ctx.session.apiCalls.filter((a) => a.promptId === prompt.promptId);
      if (calls.length === 0) continue;
      const baseline = ctx.history.projectTurns(project, prompt.at, prompt.promptId);
      if (baseline.length < t.minN) continue;
      const costed = calls.every((a) => a.costUsd !== null) && baseline.every((b) => b.costUsd !== null);
      const value = costed ? calls.reduce((s, a) => s + (a.costUsd ?? 0), 0) : calls.reduce((s, a) => s + apiTokens(a), 0);
      const line = p95(baseline.map((b) => (costed ? (b.costUsd ?? 0) : b.tokens))) ?? 0;
      if (value < (costed ? t.minUsd : t.minTokens) || line <= 0) continue;
      const prior = ctx.prior(prompt.promptId);
      const severity = maxSeverity(severityOf(value, line * t.warnRatio, line * t.alertRatio), prior?.status === "open" ? prior.severity : undefined);
      if (!severity) continue;
      out.push({
        subkey: prompt.promptId,
        station: "CORE",
        severity,
        value,
        threshold: line * t.warnRatio,
        n: baseline.length,
        measures: { unit: costed ? "usd" : "tokens", baselineP95: line, ratio: Math.round((value / line) * 100) / 100 },
        evidence: newest(calls.map((a) => apiEventId(a.dedupeKey))),
      });
    }
    return out;
  },
};
