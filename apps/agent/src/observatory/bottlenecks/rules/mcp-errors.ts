// `mcp_errors` (MCP, by server): at least `minErrors` failed calls of one MCP
// server that are `warnRate` of its calls in the session (alert at
// `alertRate`). A call refused by a permission or interrupted by the person
// is not the server's error. Closes after `closeSuccesses` successful calls
// of the server in a row; the count then starts again from the close.
import type { ToolCallState } from "../session-model.ts";
import { TOOL_ERROR } from "../../ingest/normalize-hook-record.ts";
import type { Rule, Verdict } from "./rule-types.ts";
import { newest, toolEventId } from "./rule-support.ts";

const NOT_THE_SERVER: ReadonlySet<string> = new Set([TOOL_ERROR.denied, TOOL_ERROR.interrupted]);

export const mcpErrors: Rule = {
  name: "mcp_errors",
  evaluate(ctx) {
    const byServer = new Map<string, ToolCallState[]>();
    for (const call of ctx.session.toolCalls) {
      if (call.mcpServer === null || call.success === null || (call.error !== null && NOT_THE_SERVER.has(call.error))) continue;
      byServer.set(call.mcpServer, [...(byServer.get(call.mcpServer) ?? []), call]);
    }
    const out: Verdict[] = [];
    for (const [server, all] of byServer) {
      const t = ctx.thresholds.of("mcp_errors", server);
      const prior = ctx.prior(server);
      const open = prior?.status === "open";
      // After a close, only the calls since count.
      const calls = !open && prior?.closedAt != null ? all.filter((c) => c.lastAt > (prior.closedAt ?? 0)) : all;
      const failed = calls.filter((c) => c.success === false);
      const rate = calls.length > 0 ? failed.length / calls.length : 0;
      let severity: Verdict["severity"] | undefined = failed.length >= t.minErrors ? (rate >= t.alertRate ? "alert" : rate >= t.warnRate ? "warn" : undefined) : undefined;
      if (open) {
        const lastRun = all.slice(-t.closeSuccesses);
        if (lastRun.length >= t.closeSuccesses && lastRun.every((c) => c.success === true)) continue;
        severity ??= prior.severity;
      }
      if (!severity) continue;
      out.push({
        subkey: server,
        station: "MCP",
        severity,
        value: rate,
        threshold: t.warnRate,
        n: calls.length,
        measures: { errors: failed.length, calls: calls.length },
        evidence: newest(failed.map((c) => toolEventId(c.toolUseId))),
      });
    }
    return out;
  },
};
