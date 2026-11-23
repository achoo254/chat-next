// `tool_slow`: a tool call much longer than its own key's history
// (rules/tool-key.ts). Open when a call that ended in the last
// `closeAfterMs` took more than `warnRatio` × the key's p95 (alert past
// `alertRatio` ×) and at least `minExcessMs` more than the p95, with at least
// `minN` calls of the key in history; a call still running past the same
// line opens it too (the 15 s tick: a hung call sends no event). Closes
// `closeAfterMs` after the slow call ended. A call waiting for a person to
// allow it (a permission asked after it started) is not judged while it waits.
import { type ToolCallState, toolEndAt } from "../session-model.ts";
import type { Rule, RuleContext, Verdict } from "./rule-types.ts";
import { maxSeverity, newest, runningToolCalls, severityOf, toolEventId } from "./rule-support.ts";
import { toolKeyOf } from "./tool-key.ts";

/** How long a call took, or has run so far; `endAt` undefined while it runs. */
type Timing = { duration: number; endAt: number | undefined };

/** A permission was asked for this call's tool in its thread after it started: it may be waiting for a person. */
function mayWaitForPermission(ctx: RuleContext, call: ToolCallState): boolean {
  return ctx.session.events.some((e) => e.kind === "permission_request" && e.at >= call.at && e.label === call.toolName && e.agentId === call.agentId);
}

/** The timing of `call`; undefined when it cannot be told, or while it may wait for a person. */
function timingOf(ctx: RuleContext, call: ToolCallState, running: boolean): Timing | undefined {
  if (running) return mayWaitForPermission(ctx, call) ? undefined : { duration: ctx.now - call.at, endAt: undefined };
  const endAt = toolEndAt(call);
  return endAt === undefined ? undefined : { duration: call.durationMs ?? endAt - call.at, endAt };
}

export const toolSlow: Rule = {
  name: "tool_slow",
  evaluate(ctx) {
    const running = new Set(runningToolCalls(ctx.session).map((c) => c.toolUseId));
    const byKey = new Map<string, Verdict & { ids: string[] }>();
    for (const call of ctx.session.toolCalls) {
      if (call.toolName === null) continue;
      const timing = timingOf(ctx, call, running.has(call.toolUseId));
      if (!timing) continue;
      const key = toolKeyOf({ toolName: call.toolName, station: call.station, target: call.target, mcpServer: call.mcpServer });
      const t = ctx.thresholds.of("tool_slow", key);
      if (timing.endAt !== undefined && ctx.now - timing.endAt > t.closeAfterMs) continue;
      const hist = ctx.history.toolP95(call.toolName, key);
      if (!hist || hist.n < t.minN || timing.duration - hist.p95 < t.minExcessMs) continue;
      const severity = severityOf(timing.duration, hist.p95 * t.warnRatio, hist.p95 * t.alertRatio);
      if (!severity) continue;
      const seen = byKey.get(key);
      const longest = Math.max(timing.duration, seen?.value ?? 0);
      byKey.set(key, {
        subkey: key,
        station: call.station ?? "CORE",
        severity: maxSeverity(seen?.severity, severity) ?? severity,
        value: longest,
        threshold: hist.p95 * t.warnRatio,
        n: hist.n,
        measures: { p95Ms: hist.p95, ratio: Math.round((longest / Math.max(1, hist.p95)) * 100) / 100, running: running.has(call.toolUseId) || seen?.measures.running === 1 ? 1 : 0 },
        evidence: [],
        ids: [...(seen?.ids ?? []), toolEventId(call.toolUseId)],
      });
    }
    return [...byKey.values()].map(({ ids, ...verdict }) => ({ ...verdict, evidence: newest(ids) }));
  },
};
