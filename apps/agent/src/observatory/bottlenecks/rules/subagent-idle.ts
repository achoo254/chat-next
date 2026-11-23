// `subagent_idle` (ORCHESTRATOR, by agent id): a subagent running more than
// `warnMinutes` (alert past `alertMinutes`) while using fewer than
// `minTokensPerMinute` tokens a minute over its run (input, output and cache
// of its API calls). A silent subagent sends no event, so the 15 s tick
// judges it. Closes when it stops or its rate goes over the line.
import { apiTokens } from "../session-model.ts";
import type { Rule, Verdict } from "./rule-types.ts";
import { apiEventId, newest, runningSubagents, subagentEventId } from "./rule-support.ts";

const MINUTE = 60_000;

export const subagentIdle: Rule = {
  name: "subagent_idle",
  evaluate(ctx) {
    const out: Verdict[] = [];
    for (const agent of runningSubagents(ctx.session)) {
      const t = ctx.thresholds.of("subagent_idle", agent.agentId);
      const minutes = (ctx.now - agent.startedAt) / MINUTE;
      if (minutes <= t.warnMinutes) continue;
      const calls = ctx.session.apiCalls.filter((a) => a.agentId === agent.agentId);
      const tokens = calls.reduce((sum, a) => sum + apiTokens(a), 0);
      const perMinute = tokens / minutes;
      if (perMinute >= t.minTokensPerMinute) continue;
      out.push({
        subkey: agent.agentId,
        station: "ORCHESTRATOR",
        severity: minutes > t.alertMinutes ? "alert" : "warn",
        value: perMinute,
        threshold: t.minTokensPerMinute,
        n: calls.length,
        measures: { minutes: Math.round(minutes * 10) / 10, tokens },
        evidence: [subagentEventId(agent.agentId), ...newest(calls.map((a) => apiEventId(a.dedupeKey)), 19)],
      });
    }
    return out;
  },
};
