// How Advisor's answer reads: "confident" only when one option clearly
// stands out and Jev trusts its own answer; anything else is "unsure", and
// the AI then asks the user instead of acting on it.
import type { ItemBody } from "../threads/journal.ts";
import type { AdvisorResult } from "./advisor-tools.ts";
import type { JevAnswer } from "./jev-client.ts";

/** The top option needs at least this probability… */
export const CONFIDENT_TOP = 0.6;
/** …this lead over the next one… */
export const CONFIDENT_GAP = 0.2;
/** …and Jev at least this confidence in its own answer. */
export const CONFIDENT_SELF = 0.5;

export type Verdict = "confident" | "unsure";

export function verdictOf(answer: Pick<JevAnswer, "probabilities" | "confidence">): Verdict {
  const sorted = [...answer.probabilities].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  // Rounded so 0.8 - 0.6 counts as the 0.2 it is meant to be.
  const gap = Math.round((top - second) * 1e6) / 1e6;
  return top >= CONFIDENT_TOP && gap >= CONFIDENT_GAP && answer.confidence >= CONFIDENT_SELF ? "confident" : "unsure";
}

/** One advisor_weigh call of a turn, as its tool-start told it. */
export type AdvisorCall = { toolId: string; turnId: string; kind: string };

/**
 * The transcript item of an advisor_weigh call: what Advisor answered, or
 * why it did not (AdvisorVerdictItem.error). `result` is what the tool
 * returned (advisorResultOf); undefined when the call never answered or its
 * answer could not be read. A call of a turn that was stopped reads as
 * interrupted whatever came back late, so no stale suggestion is offered.
 */
export function verdictItem(call: AdvisorCall, result: AdvisorResult | undefined, interrupted: boolean): Extract<ItemBody, { case: "advisorVerdict" }> {
  const base = { toolId: call.toolId, turnId: call.turnId, kind: result && "kind" in result ? result.kind : call.kind };
  const sent = result?.sent;
  const body = sent ? { kind: sent.kind, question: sent.question, context: sent.context } : {};
  if (interrupted || !result || result.advisor === "error") {
    const error = interrupted ? "interrupted" : (result?.advisor === "error" ? result.error : "unavailable");
    return {
      case: "advisorVerdict",
      value: { ...base, ...body, options: (sent?.options ?? []).map((text) => ({ text, probability: 0 })), error },
    };
  }
  return {
    case: "advisorVerdict",
    value: {
      ...base,
      ...body,
      options: result.options.map((o) => ({ text: o.text, probability: o.probability })),
      confidence: result.confidence,
      verdict: result.verdict,
    },
  };
}
