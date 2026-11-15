// The audit board's numbers: turns the machine ran count by their journal
// item, calls read from the transcript only outside those turns (never twice).
import { describe, expect, it } from "vitest";
import { NO_USAGE, OfficeUsageTally } from "../src/office/office-usage.ts";

const turn = (at: number, durationMs: number, tokens: { input: number; output: number }, costUsd: number, running = false) => ({
  at,
  durationMs,
  running,
  inputTokens: tokens.input,
  outputTokens: tokens.output,
  costUsd,
});
const call = (key: string, at: number, input: number, output: number) => ({ key, at, inputTokens: input, outputTokens: output });

describe("office usage", () => {
  it("has no numbers before anything ended", () => {
    const u = new OfficeUsageTally();
    expect(u.numbers()).toEqual(NO_USAGE);
    u.addTurn("turn:1", turn(1000, 0, { input: 0, output: 0 }, 0, true));
    expect(u.numbers().available).toBe(false);
  });

  it("adds the turns the machine ran, each once", () => {
    const u = new OfficeUsageTally();
    u.addTurn("turn:1", turn(1000, 0, { input: 0, output: 0 }, 0, true));
    u.addTurn("turn:1", turn(1000, 5000, { input: 10, output: 20 }, 0.5));
    u.addTurn("turn:1", turn(1000, 5000, { input: 10, output: 20 }, 0.5));
    u.addTurn("turn:2", turn(10_000, 1000, { input: 1, output: 2 }, 0.25));
    expect(u.numbers()).toEqual({ inputTokens: 11, outputTokens: 22, costUsd: 0.75, hasCost: true, available: true });
  });

  it("an AI that reports no cost shows tokens only", () => {
    const u = new OfficeUsageTally();
    u.addTurn("turn:1", turn(1000, 100, { input: 5, output: 6 }, 0));
    expect(u.numbers()).toMatchObject({ inputTokens: 5, outputTokens: 6, hasCost: false, available: true });
  });

  it("counts calls from the transcript only outside the machine's turns, each key once", () => {
    const u = new OfficeUsageTally();
    u.addTurn("turn:1", turn(100_000, 10_000, { input: 10, output: 10 }, 1));
    u.addCalls([
      call("a", 50_000, 100, 200), // elsewhere, before
      call("b", 105_000, 1000, 1000), // inside the machine's turn: already counted by it
      call("c", 200_000, 1, 2), // elsewhere, after
    ]);
    u.addCalls([call("a", 50_000, 100, 200)]);
    expect(u.numbers()).toEqual({ inputTokens: 111, outputTokens: 212, costUsd: 1, hasCost: true, available: true });
  });

  it("a running turn of the machine covers every call from its start on", () => {
    const u = new OfficeUsageTally();
    u.addTurn("turn:1", turn(100_000, 0, { input: 0, output: 0 }, 0, true));
    u.addCalls([call("a", 99_000, 1, 1), call("b", 500_000, 7, 7)]);
    // Within the slack before the turn: counted with it.
    expect(u.numbers()).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false, available: false });
  });

  it("a session run only elsewhere has tokens and no cost", () => {
    const u = new OfficeUsageTally();
    u.addCalls([call("a", 1, 3, 4)]);
    expect(u.numbers()).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0, hasCost: false, available: true });
  });
});
