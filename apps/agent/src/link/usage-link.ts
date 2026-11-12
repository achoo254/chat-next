// The usage requests of a device over the sealed link: the report of a range
// of days, the rules' switches, deleting the ledger; and the hint frame sent
// unasked while a session runs. Only numbers, rule codes, session ids,
// repository keys and days go out (see usage/report.ts).
import type { MessageInitShape } from "@bufbuild/protobuf";
import { type Frame, type FrameSchema, UsageRule } from "@achoo254/chat-proto/remote/remote";
import type { ConfigStore } from "../config.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import type { Ledger, QuotaWindow } from "../usage/ledger.ts";
import type { UsageHint } from "../usage/notify.ts";
import { type ReportQuery, type UsageReportData, usageReport } from "../usage/report.ts";
import { RULE_CODES, type RuleCode, type RuleSwitches, USAGE_RULES, ruleSwitches } from "../usage/rules.ts";

/** What the machine offers the link for usage. */
export type UsageApi = {
  report(q: ReportQuery): Promise<UsageReportData>;
  rules(): RuleSwitches;
  setRules(changes: Partial<RuleSwitches>, device: string): RuleSwitches;
  deleteLedger(device: string): Promise<void>;
};

/**
 * The machine's usage for the link: reports from `ledger`, the switches kept
 * in the config (each change written to the consent log), and deleting the
 * ledger through `deleteLedger` (which stops a scan under way).
 */
export function usageApiOf(o: { ledger: Ledger; config: ConfigStore; audit: AuditLog; deleteLedger: () => Promise<void>; now?: () => number }): UsageApi {
  const rules = () => ruleSwitches(o.config.get().usageRules);
  return {
    report: (q) => usageReport(o.ledger, q, rules(), (o.now ?? Date.now)()),
    rules,
    setRules: (changes, device) => {
      const detail = Object.entries(changes)
        .map(([code, on]) => `${code} ${on ? "on" : "off"}`)
        .join(", ");
      if (!detail) return rules();
      o.config.update((c) => {
        c.usageRules = { ...c.usageRules, ...changes };
      });
      o.audit.write({ device, action: "usage_rules", path: "", detail });
      return rules();
    },
    deleteLedger: async (device) => {
      await o.deleteLedger();
      o.audit.write({ device, action: "usage_delete", path: "", detail: "" });
    },
  };
}

export type UsageFrame = Extract<Frame["body"], { case: "usageReportRequest" | "usageSettingsGet" | "usageSettingsSet" | "usageDelete" }>;
type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

const RULE_WIRE: Record<RuleCode, UsageRule> = {
  context: UsageRule.CONTEXT,
  turns: UsageRule.TURNS,
  mechanical: UsageRule.MECHANICAL,
  subagents: UsageRule.SUBAGENTS,
};

/** The rule code of a wire rule; undefined for one this machine does not know. */
export function ruleCodeOf(rule: UsageRule): RuleCode | undefined {
  return RULE_CODES.find((c) => RULE_WIRE[c] === rule);
}

const window = (w?: QuotaWindow) =>
  w ? { utilization: Math.max(0, Math.min(100, Math.round(w.utilization))), resetsAt: BigInt(Math.max(0, Math.round(w.resetsAt))) } : undefined;

const big = (n: number) => BigInt(Math.max(0, Math.round(n)));

export function usageSuggestionBody(s: Omit<UsageHint, "provider"> & { notifiedAt: number }) {
  return {
    rule: RULE_WIRE[s.rule],
    sessionId: s.sessionId,
    repoKey: s.repoKey,
    turn: s.turn,
    at: big(s.at),
    value: big(s.value),
    experimental: s.experimental,
    notifiedAt: big(s.notifiedAt),
  };
}

export function usageReportBody(r: UsageReportData) {
  return {
    from: r.from,
    to: r.to,
    utcOffsetMinutes: r.utcOffsetMinutes,
    lastScanAt: big(r.lastScanAt),
    shape: {
      usageRatio: r.flags.usageRatio,
      lowUsageRatio: r.flags.lowUsageRatio,
      driftRatio: r.flags.driftRatio,
      drift: r.flags.drift,
      unknownTypes: r.flags.unknownTypes.length,
    },
    days: r.days.map((d) => ({
      repoKey: d.repoKey,
      day: d.day,
      inputTokens: big(d.input),
      cacheReadTokens: big(d.cacheRead),
      cacheWriteTokens: big(d.cacheWrite),
      outputTokens: big(d.output),
      mainTurns: d.mainTurns,
      subagentTurns: d.subagentTurns,
      sessions: d.sessions,
      appTurns: d.appTurns,
      meanContext: big(d.meanContext),
      medianContext: big(d.medianContext),
      p90Context: big(d.p90Context),
    })),
    suggestions: r.suggestions.map(usageSuggestionBody),
    quota: r.quota.map((q) => {
      const fiveHour = window(q.fiveHour);
      const sevenDay = window(q.sevenDay);
      return { profileId: q.profile, at: big(q.at), scheduled: q.via === "scheduled", ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
    }),
  };
}

export function usageSettingsBody(on: RuleSwitches) {
  return { rules: RULE_CODES.map((c) => ({ rule: RULE_WIRE[c], enabled: on[c], experimental: USAGE_RULES[c].experimental })) };
}

/** Answers one usage request; errors go back to the caller (they become an Error frame). */
export async function handleUsage(api: UsageApi, id: string, b: UsageFrame, send: (id: string, body: Body) => void, device: string): Promise<void> {
  switch (b.case) {
    case "usageReportRequest": {
      const v = b.value;
      const report = await api.report({ from: v.from, to: v.to, ...(v.repoKey ? { repoKey: v.repoKey } : {}) });
      return send(id, { case: "usageReport", value: usageReportBody(report) });
    }
    case "usageSettingsGet":
      return send(id, { case: "usageSettings", value: usageSettingsBody(api.rules()) });
    case "usageSettingsSet": {
      // Rules this machine does not know (a newer device) are left out.
      const changes: Partial<RuleSwitches> = {};
      for (const r of b.value.rules) {
        const code = ruleCodeOf(r.rule);
        if (code) changes[code] = r.enabled;
      }
      return send(id, { case: "usageSettings", value: usageSettingsBody(api.setRules(changes, device)) });
    }
    case "usageDelete":
      await api.deleteLedger(device);
      return send(id, { case: "ack", value: {} });
  }
}
