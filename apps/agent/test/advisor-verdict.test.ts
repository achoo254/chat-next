import { describe, expect, it } from "vitest";
import type { AdvisorResult } from "../src/advisor/advisor-tools.ts";
import { verdictItem, verdictOf } from "../src/advisor/advisor-verdict.ts";

describe("verdictOf", () => {
  it("confident only with a clear top option and Jev sure of itself", () => {
    // Exactly at every bar (0.6 - 0.4 is not quite 0.2 in floating point).
    expect(verdictOf({ probabilities: [0.6, 0.4], confidence: 0.5 })).toBe("confident");
    expect(verdictOf({ probabilities: [0.8, 0.2], confidence: 0.5 })).toBe("confident");
    expect(verdictOf({ probabilities: [0.2, 0.8, 0], confidence: 0.9 })).toBe("confident");
    expect(verdictOf({ probabilities: [0.8, 0.6], confidence: 0.9 })).toBe("confident");
  });

  it("unsure below each bar", () => {
    expect(verdictOf({ probabilities: [0.59, 0.1], confidence: 0.9 })).toBe("unsure");
    expect(verdictOf({ probabilities: [0.7, 0.55], confidence: 0.9 })).toBe("unsure");
    expect(verdictOf({ probabilities: [0.9, 0.1], confidence: 0.49 })).toBe("unsure");
    expect(verdictOf({ probabilities: [], confidence: 1 })).toBe("unsure");
  });
});

const CALL = { toolId: "toolu_1", turnId: "turn:3:abcd", kind: "decision" };
const SENT = { kind: "decision" as const, question: "Which?", options: ["A", "B"], context: "ctx" };

describe("verdictItem", () => {
  it("carries the call's tool and turn, what was sent and Advisor's answer", () => {
    const result: AdvisorResult = {
      advisor: "verdict",
      kind: "decision",
      verdict: "confident",
      choice: "A",
      confidence: 0.8,
      options: [
        { text: "A", probability: 0.9 },
        { text: "B", probability: 0.1 },
      ],
      sent: SENT,
      guidance: "",
    };
    expect(verdictItem(CALL, result, false)).toEqual({
      case: "advisorVerdict",
      value: {
        toolId: "toolu_1",
        turnId: "turn:3:abcd",
        kind: "decision",
        question: "Which?",
        context: "ctx",
        options: [
          { text: "A", probability: 0.9 },
          { text: "B", probability: 0.1 },
        ],
        confidence: 0.8,
        verdict: "confident",
      },
    });
  });

  it("an error keeps what was sent, without probabilities or a verdict", () => {
    const item = verdictItem(CALL, { advisor: "error", error: "timeout", message: "late", sent: SENT }, false);
    expect(item.value).toMatchObject({ error: "timeout", question: "Which?", options: [{ text: "A", probability: 0 }, { text: "B", probability: 0 }] });
    expect(item.value).not.toHaveProperty("verdict");
  });

  it("a refused call shows nothing of the request", () => {
    const item = verdictItem(CALL, { advisor: "error", error: "refused", message: "no" }, false);
    expect(item.value).toEqual({ toolId: "toolu_1", turnId: "turn:3:abcd", kind: "decision", options: [], error: "refused" });
  });

  it("a stopped turn's answer, even a late good one, reads as interrupted; no answer at all too", () => {
    const late: AdvisorResult = { advisor: "verdict", kind: "next_steps", verdict: "confident", choice: "A", confidence: 1, options: [{ text: "A", probability: 1 }], sent: { ...SENT, kind: "next_steps" }, guidance: "" };
    expect(verdictItem(CALL, late, true).value).toMatchObject({ error: "interrupted", kind: "next_steps" });
    expect(verdictItem(CALL, late, true).value).not.toHaveProperty("verdict");
    expect(verdictItem(CALL, undefined, true).value).toMatchObject({ error: "interrupted", kind: "decision" });
    expect(verdictItem(CALL, undefined, false).value).toMatchObject({ error: "unavailable" });
  });
});
