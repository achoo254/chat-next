import { ResetReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { answerIsCurrent, isContiguous, newer, resumeFrom } from "../src/index.ts";

const bounds = { epoch: 3n, firstSeq: 10n, lastSeq: 20n };

describe("resumeFrom", () => {
  it("sends everything to a new device", () => {
    expect(resumeFrom(bounds, undefined)).toEqual({ kind: "send", fromSeq: 10n });
    expect(resumeFrom(bounds, { epoch: 0n, seq: 0n })).toEqual({ kind: "send", fromSeq: 10n });
  });
  it("continues after the cursor", () => {
    expect(resumeFrom(bounds, { epoch: 3n, seq: 15n })).toEqual({ kind: "send", fromSeq: 16n });
    expect(resumeFrom(bounds, { epoch: 3n, seq: 20n })).toEqual({ kind: "send", fromSeq: 21n });
    expect(resumeFrom(bounds, { epoch: 3n, seq: 9n })).toEqual({ kind: "send", fromSeq: 10n });
  });
  it("resets on another epoch, a cursor ahead, or compacted items", () => {
    expect(resumeFrom(bounds, { epoch: 2n, seq: 15n })).toEqual({ kind: "reset", reason: ResetReason.EPOCH_CHANGED });
    expect(resumeFrom(bounds, { epoch: 3n, seq: 21n })).toEqual({ kind: "reset", reason: ResetReason.CURSOR_AHEAD });
    expect(resumeFrom(bounds, { epoch: 3n, seq: 5n })).toEqual({ kind: "reset", reason: ResetReason.CURSOR_COMPACTED });
  });
});

describe("item merge", () => {
  it("keeps the highest revision", () => {
    const a = { id: "x", revision: 2, v: "a" };
    expect(newer(a, { id: "x", revision: 1, v: "b" }).v).toBe("a");
    expect(newer(a, { id: "x", revision: 3, v: "c" }).v).toBe("c");
    expect(newer(undefined, a)).toBe(a);
  });
  it("detects holes in seq", () => {
    expect(isContiguous(5n, [6n, 7n, 8n])).toBe(true);
    expect(isContiguous(5n, [3n, 6n])).toBe(true);
    expect(isContiguous(5n, [7n])).toBe(false);
  });
  it("accepts an answer only for the revision shown", () => {
    expect(answerIsCurrent({ id: "q", revision: 2, pending: true }, 2)).toBe(true);
    expect(answerIsCurrent({ id: "q", revision: 3, pending: true }, 2)).toBe(false);
    expect(answerIsCurrent({ id: "q", revision: 2, pending: false }, 2)).toBe(false);
  });
});
