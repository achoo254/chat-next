// The hub's Live Map part, on a real store: a thread's sessions (several
// segments, /clear both ways, another AI's thread has none); the live state
// in the snapshot and in `session` events; bottleneck findings as events and
// in the paged timeline; provisional rows of the spool's tail going out under
// the id their stored row takes, the stored row then replacing them as an
// update; a station's numbers against a hand count (parts, slowest, recent,
// earlier sessions of the project, replay time, the sample past 10 000
// durations); content only through the request by id, which follows the
// project's switch and clearContent; and the drill-down's speed on 200 000
// tool calls.
import {
  ErrorReason,
  type ObservatoryEvent,
  type ObservatoryEvents,
  ObservatoryContentState,
  ObservatoryCoreState,
} from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../../src/core/agent-core.ts";
import { type ObservatoryEventSink, ObservatoryHub } from "../../src/observatory/hub/observatory-hub.ts";
import type { LiveTailEvent } from "../../src/observatory/spool/spool-live-tail.ts";
import type { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { openTempStore, sessionOps } from "./store-fixture.ts";

const MARK = "ZZCONTENT-41c7-private";
const T = 1_790_000_000_000;
const P = "github.com/acme/app";

const opened: ObservatoryStore[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

async function setup() {
  const store = await openTempStore();
  opened.push(store);
  const hub = new ObservatoryHub({ store: () => store, watchSession: () => undefined, unwatchSession: () => undefined, problems: (place, err) => console.error(place, err), flushMs: 5 });
  hub.start();
  const write = (ops: WriteOp[]): void => {
    store.write(ops);
    hub.written(ops);
  };
  return { store, hub, write };
}

function recorder(): { sink: ObservatoryEventSink; frames: ObservatoryEvents[]; events: () => ObservatoryEvent[] } {
  const frames: ObservatoryEvents[] = [];
  return { sink: (f) => frames.push(f), frames, events: () => frames.flatMap((f) => f.events) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

function reasonOf(fn: () => unknown): ErrorReason | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AgentError ? err.reason : undefined;
  }
  return undefined;
}

const session = (sessionId: string, startedAt: number, extra: Partial<{ previousSessionId: string; projectKey: string; internalLabel: string; mainModel: string }> = {}): WriteOp => ({
  kind: "session",
  row: { sessionId, source: "cli", startedAt, projectKey: P, ...extra },
});

const toolCall = (sessionId: string, toolUseId: string, at: number, row: Partial<{ toolName: string; station: string | null; stationFlags: number; target: string; durationMs: number; success: boolean; mcpServer: string; content: string }>): WriteOp => ({
  kind: "toolCall",
  row: { toolUseId, sessionId, at, toolName: "Read", station: "FILES", stationFlags: 0, ...row, ...(row.station === null ? { station: undefined, stationFlags: undefined } : {}) },
});

const tail = (sessionId: string, at: number, ops: WriteOp[], extra: Partial<LiveTailEvent> = {}): LiveTailEvent => ({ provisional: true, sessionId, event: "PostToolUse", at, ops, file: "events-1.jsonl", ...extra });

describe("a thread's sessions", () => {
  it("are its segments' sessions and the ones linked to them by /clear both ways, newest first; another AI's thread has none", async () => {
    const { hub, write } = await setup();
    write([
      session("a1", T),
      session("a2", T + 10, { previousSessionId: "a1" }),
      session("a3", T + 20, { previousSessionId: "a2" }),
      session("b1", T + 30),
      session("other", T + 40),
    ]);
    // The first segment still names a2 (a /clear the thread did not see), the second names b1.
    expect(hub.listSessions(0, ["a2", "b1"]).sessions.map((s) => s.sessionId)).toEqual(["b1", "a3", "a2", "a1"]);
    // A segment's session not stored yet is followed all the same.
    write([session("c2", T + 50, { previousSessionId: "c1" })]);
    expect(hub.listSessions(0, ["c1"]).sessions.map((s) => s.sessionId)).toEqual(["c2"]);
    expect(hub.listSessions(2, ["a2", "b1"]).sessions).toHaveLength(2);
    expect(hub.listSessions(0, []).sessions).toEqual([]);
    expect(hub.listSessions(0).sessions.map((s) => s.sessionId)).toContain("other");
  });
});

describe("the live state", () => {
  it("is in the snapshot and in the session event when it changes", async () => {
    const { hub, write } = await setup();
    write([
      session("s", T, { mainModel: "claude-sonnet-5-5" }),
      { kind: "prompt", row: { promptId: "p1", sessionId: "s", at: T + 1 } },
      toolCall("s", "t1", T + 2, {}),
      { kind: "apiRequest", row: { dedupeKey: "r1", sessionId: "s", at: T + 3, model: "claude-sonnet-5-5", inputTokens: 20_000, outputTokens: 30, durationMs: 1_000, ttftMs: 400 } },
      { kind: "sessionEvent", row: { dedupeKey: "pr1", sessionId: "s", at: T + 4, kind: "permission_request", station: "SANDBOX", label: "Bash" } },
    ]);
    const a = recorder();
    const snap = hub.watch("s", a.sink);
    expect(snap.session?.live).toMatchObject({
      core: ObservatoryCoreState.WAITING_PERMISSION,
      tokensPerSecond: 50,
      contextPercent: 10,
      contextWindow: 200_000n,
      contextWindowAssumed: true,
      mainModel: "claude-sonnet-5-5",
      running: [{ station: "FILES", count: 1 }],
      openBottlenecks: 0,
    });
    write([{ kind: "sessionEvent", row: { dedupeKey: "stop1", sessionId: "s", at: T + 9, kind: "stop", station: "CORE" } }]);
    await wait(40);
    const state = a.events().at(-1)?.kind;
    expect(state?.case === "session" ? [state.value.live?.core, state.value.live?.running] : undefined).toEqual([ObservatoryCoreState.WAITING_USER, []]);
  });
});

describe("bottleneck findings", () => {
  it("go out as one event opened, raised and closed, count in the live state, and page with the rest of the timeline", async () => {
    const { hub, write } = await setup();
    write([session("s", T)]);
    const a = recorder();
    hub.watch("s", a.sink);
    const finding = (over: Partial<{ severity: "warn" | "alert"; status: "open" | "closed"; updatedAt: number; closedAt: number }>): WriteOp => ({
      kind: "bottleneck",
      row: { sessionId: "s", rule: "repeat_read", subkey: "k1", station: "FILES", severity: "warn", status: "open", openedAt: T + 5, updatedAt: T + 5, value: 3, threshold: 3, n: 3, evidenceJson: JSON.stringify({ eventIds: ["tool:t1", "tool:t2", "bad\nid", "nope:x", 7], value: 3 }), ...over },
    });
    write([finding({})]);
    await wait(40);
    write([finding({ severity: "alert", updatedAt: T + 9 })]);
    await wait(40);
    write([finding({ severity: "alert", status: "closed", updatedAt: T + 12, closedAt: T + 12 })]);
    await wait(40);
    const found = a.events().flatMap((e) => (e.kind.case === "bottleneck" ? [{ id: e.id, ...e.kind.value }] : []));
    expect(found.map((f) => [f.id, f.severity, f.status])).toEqual([
      ["bottleneck:repeat_read:k1", "warn", "open"],
      ["bottleneck:repeat_read:k1", "alert", "open"],
      ["bottleneck:repeat_read:k1", "alert", "closed"],
    ]);
    expect(found[0]?.evidenceIds).toEqual(["tool:t1", "tool:t2"]);
    const opens = a.events().flatMap((e) => (e.kind.case === "session" ? [e.kind.value.live?.openBottlenecks] : []));
    expect(opens).toEqual([1, 0]);
  });

  it("page one by one with rows of every kind written in the same millisecond", async () => {
    const { hub, write } = await setup();
    const at = (op: WriteOp): WriteOp => (op.kind === "subagent" ? { ...op, row: { ...op.row, startedAt: T } } : op.kind === "session" ? op : ({ ...op, row: { ...op.row, at: T } } as WriteOp));
    write([...sessionOps("same", T).map(at), { kind: "bottleneck", row: { sessionId: "same", rule: "tool_slow", subkey: "", severity: "warn", status: "open", openedAt: T, updatedAt: T } }]);
    const all = hub.watch("same", recorder().sink, 500).events.map((e) => e.id);
    expect(all).toContain("bottleneck:tool_slow:");
    const seen: string[] = [];
    const first = hub.watch("same", recorder().sink, 1);
    seen.unshift(...first.events.map((e) => e.id));
    let earlier = first.earlier;
    while (earlier !== "") {
      const older = hub.earlier("same", earlier, 1);
      seen.unshift(...older.events.map((e) => e.id));
      earlier = older.earlier;
    }
    expect(seen).toEqual(all);
  });
});

describe("provisional events", () => {
  it("go out under the stored row's id and are replaced by it as an update, a stored start with a provisional end staying provisional", async () => {
    const { hub, write } = await setup();
    write([session("s", T)]);
    const a = recorder();
    hub.watch("s", a.sink);
    const pre = toolCall("s", "t1", T + 1, { toolName: "Bash", station: "TESTING", target: "pnpm" });
    const post = toolCall("s", "t1", T + 1, { toolName: "Bash", station: "TESTING", target: "pnpm", durationMs: 40, success: true });
    hub.provisional(tail("s", T + 1, [pre], { event: "PreToolUse" }));
    // A session nobody watches: dropped.
    hub.provisional(tail("nobody", T + 1, [toolCall("nobody", "t1", T + 1, { toolName: "Bash", station: "TESTING", target: "pnpm" })]));
    await wait(40);
    hub.provisional(tail("s", T + 41, [post]));
    await wait(40);
    // The store takes the start, then the end.
    write([pre]);
    await wait(40);
    write([post]);
    await wait(40);
    const tools = a.events().flatMap((e) => (e.kind.case === "toolCall" ? [[e.id, e.provisional, e.kind.value.success, e.kind.value.durationMs]] : []));
    expect(tools).toEqual([
      ["tool:t1", true, undefined, undefined],
      ["tool:t1", true, true, 40],
      ["tool:t1", false, true, 40],
    ]);
    const seqs = a.events().map((e) => Number(e.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(hub.watched).toEqual(["s"]);
  });

  it("held while the store lags are looked up once, not at every flush, and still give way to their stored row", async () => {
    const { hub, write, store } = await setup();
    write([session("s", T)]);
    const a = recorder();
    hub.watch("s", a.sink);
    const held = Array.from({ length: 50 }, (_, i) => toolCall("s", `h${i}`, T + 1 + i, { toolName: "Bash", station: "TESTING", target: "pnpm" }));
    held.forEach((op, i) => hub.provisional(tail("s", T + 1 + i, [op], { event: "PreToolUse" })));
    await wait(40);
    const lookups = vi.spyOn(store, "timelineEntry");
    // The session's row changes at every flush (a stuck spool still moves the session), the held rows stay unstored.
    for (let i = 1; i <= 5; i++) {
      write([session("s", T, { mainModel: `claude-sonnet-5-${i}` })]);
      await wait(40);
    }
    expect(lookups).not.toHaveBeenCalled();
    hub.watch("s", recorder().sink);
    expect(lookups).not.toHaveBeenCalled();
    // The store takes one: it goes out stored, the others stay provisional.
    const first = held[0];
    if (!first) throw new Error("no held row");
    write([first]);
    await wait(40);
    const h0 = a.events().flatMap((e) => (e.id === "tool:h0" ? [e.provisional] : []));
    expect(h0).toEqual([true, false]);
    expect(hub.watch("s", recorder().sink).events.filter((e) => e.provisional)).toHaveLength(49);
    lookups.mockRestore();
  });

  it("never stored once the spool reader took their files are withdrawn through a seq gap, and a snapshot no longer holds them", async () => {
    const { hub, write } = await setup();
    write([session("s", T)]);
    const a = recorder();
    hub.watch("s", a.sink);
    const load = { sessionId: "s", at: T + 4, filePath: "~/work/app/CLAUDE.md", loadReason: "session_start" };
    // A tool call set aside by the reader, and an instruction load the hub numbered 0 that the ingest numbers 1.
    hub.provisional(tail("s", T + 3, [toolCall("s", "lost", T + 3, { toolName: "Bash", station: "TESTING", target: "pnpm" })], { event: "PreToolUse", file: "events-1.jsonl" }));
    hub.provisional(tail("s", T + 4, [], { event: "InstructionsLoaded", instruction: load, file: "events-1.jsonl" }));
    // A call still read from the next file stays.
    hub.provisional(tail("s", T + 70_000, [toolCall("s", "next", T + 70_000, {})], { event: "PreToolUse", file: "events-2.jsonl" }));
    await wait(40);
    expect(a.events().map((e) => [e.id, e.provisional])).toEqual([
      ["tool:lost", true],
      ["instruction:000000:session_start:~/work/app/CLAUDE.md", true],
      ["tool:next", true],
      ["session", false],
    ]);
    write([{ kind: "instructionLoaded", row: { ...load, seq: 1 } }]);
    await wait(40);
    const seen = a.events().length;
    hub.spoolFileTaken("events-1.jsonl");
    await wait(40);
    const after = a.events().slice(seen);
    const last = Number(a.events()[seen - 1]?.seq);
    expect(after.map((e) => e.kind.case)).toEqual(["session"]);
    // The frame starts past a skipped seq: every watcher asks for a snapshot.
    expect(Number(after[0]?.seq)).toBe(last + 2);
    const snap = hub.watch("s", a.sink);
    expect(snap.events.map((e) => [e.id, e.provisional])).toEqual([
      ["instruction:000001:session_start:~/work/app/CLAUDE.md", false],
      ["tool:next", true],
    ]);
  });

  it("stored in part once the spool reader took their files go out as stored, with no gap", async () => {
    const { hub, write } = await setup();
    write([session("s", T)]);
    const a = recorder();
    hub.watch("s", a.sink);
    const pre = toolCall("s", "t1", T + 1, { toolName: "Bash", station: "TESTING", target: "pnpm" });
    const post = toolCall("s", "t1", T + 1, { toolName: "Bash", station: "TESTING", target: "pnpm", durationMs: 40, success: true });
    hub.provisional(tail("s", T + 1, [pre], { event: "PreToolUse", file: "events-1.jsonl" }));
    hub.provisional(tail("s", T + 61_000, [post], { file: "events-2.jsonl" }));
    await wait(40);
    // The start is stored, its file taken; the end's file is still read.
    write([pre]);
    hub.spoolFileTaken("events-1.jsonl");
    await wait(40);
    // The end was set aside: its file goes too, the call is what the store has.
    hub.spoolFileTaken("events-2.jsonl");
    await wait(40);
    const tools = a.events().flatMap((e) => (e.kind.case === "toolCall" ? [[e.provisional, e.kind.value.success]] : []));
    expect(tools).toEqual([
      [true, true],
      [false, undefined],
    ]);
    const seqs = a.events().map((e) => Number(e.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(hub.watch("s", a.sink).events.map((e) => [e.id, e.provisional])).toEqual([["tool:t1", false]]);
  });

  it("are in a snapshot until stored, and an instruction file load takes the number the ingest will give it", async () => {
    const { hub, write } = await setup();
    write([session("s", T)]);
    hub.watch("s", recorder().sink);
    hub.provisional(tail("s", T + 3, [{ kind: "prompt", row: { promptId: "p1", sessionId: "s", at: T + 3, length: 5 } }], { event: "UserPromptSubmit" }));
    hub.provisional(tail("s", T + 4, [], { event: "InstructionsLoaded", instruction: { sessionId: "s", at: T + 4, filePath: "~/work/app/CLAUDE.md", loadReason: "session_start" } }));
    const snap = hub.watch("s", recorder().sink);
    expect(snap.events.map((e) => [e.id, e.provisional])).toEqual([
      ["prompt:p1", true],
      ["instruction:000000:session_start:~/work/app/CLAUDE.md", true],
    ]);
    expect(snap.session?.live?.core).toBe(ObservatoryCoreState.THINKING);
    write([
      { kind: "prompt", row: { promptId: "p1", sessionId: "s", at: T + 3, length: 5 } },
      { kind: "instructionLoaded", row: { sessionId: "s", seq: 0, at: T + 4, filePath: "~/work/app/CLAUDE.md", loadReason: "session_start" } },
    ]);
    const again = hub.watch("s", recorder().sink);
    expect(again.events.map((e) => [e.id, e.provisional])).toEqual([
      ["prompt:p1", false],
      ["instruction:000000:session_start:~/work/app/CLAUDE.md", false],
    ]);
  });
});

describe("a station's numbers", () => {
  async function drillSetup() {
    const s = await setup();
    s.write([
      session("prev-internal", T - 3_000, { internalLabel: "advisor" }),
      session("prev-other", T - 2_500, { projectKey: "github.com/acme/other" }),
      session("prev", T - 2_000),
      toolCall("prev", "pt1", T - 1_900, { target: "src/a.ts", durationMs: 50, success: true }),
      toolCall("prev-internal", "it1", T - 2_900, { durationMs: 9, success: true }),
      session("s", T),
      session("later", T + 5_000),
      toolCall("s", "t1", T + 1, { target: "src/a.ts", durationMs: 100, success: true }),
      toolCall("s", "t2", T + 2, { target: "src/a.ts", durationMs: 300, success: true }),
      toolCall("s", "t3", T + 3, { toolName: "Edit", target: "src/b.ts", durationMs: 200, success: false, stationFlags: 8 }),
      toolCall("s", "t4", T + 4, { target: "src/b.ts" }),
      toolCall("s", "t5", T + 5, { toolName: "Bash", station: "SANDBOX", target: "ls", durationMs: 50, success: true }),
      // Stored without a station (the first schema): counted where its target places it.
      toolCall("s", "t6", T + 6, { station: null, target: "src/c.ts", durationMs: 400, success: true }),
      { kind: "sessionEvent", row: { dedupeKey: "f1", sessionId: "s", at: T + 7, kind: "permission_request", station: "FILES", label: "Edit" } },
      toolCall("s", "w1", T + 10, { toolName: "WebFetch", station: "EXTERNAL", target: "example.com", durationMs: 500, success: true }),
      { kind: "apiRequest", row: { dedupeKey: "r1", sessionId: "s", at: T + 11, model: "m1", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWrite5mTokens: 1, cacheWrite1hTokens: 2, costUsd: 0.5, durationMs: 1_000 } },
      { kind: "apiRequest", row: { dedupeKey: "r2", sessionId: "s", at: T + 12, model: "m1", inputTokens: 5, outputTokens: 5, durationMs: 3_000 } },
      { kind: "apiRequest", row: { dedupeKey: "r3", sessionId: "s", at: T + 13, agentId: "a1", model: "m2", inputTokens: 7, outputTokens: 8, costUsd: 0.25, durationMs: 2_000 } },
      { kind: "sessionEvent", row: { dedupeKey: "e1", sessionId: "s", at: T + 14, kind: "api_error", station: "EXTERNAL", label: "m1", number: 429, flag: true } },
      {
        kind: "bottleneck",
        row: { sessionId: "s", rule: "repeat_read", subkey: "k", station: "FILES", severity: "warn", status: "open", openedAt: T + 3, updatedAt: T + 3, evidenceJson: JSON.stringify({ eventIds: ["tool:t1"] }) },
      },
    ]);
    return s;
  }

  it("count calls, failures, percentiles, parts, the slowest and newest and the project's earlier sessions as counted by hand", async () => {
    const { hub } = await drillSetup();
    const r = hub.station("s", "FILES");
    // t1, t2, t3, t4, t6: one failed, four ended; durations 100, 200, 300, 400.
    expect(r.numbers).toMatchObject({ calls: 5, failures: 1, ended: 4, p50Ms: 200, p95Ms: 400, sampled: false, apiRequests: 0, hasCost: false });
    expect(r.parts.map((p) => [p.kind, p.key, p.numbers?.calls, p.numbers?.failures, p.numbers?.p50Ms, p.numbers?.p95Ms])).toEqual([
      ["file", "src/a.ts", 2, 0, 100, 300],
      ["file", "src/b.ts", 2, 1, 200, 200],
      ["file", "src/c.ts", 1, 0, 400, 400],
    ]);
    expect(r.slowest.map((e) => e.id)).toEqual(["tool:t6", "tool:t2", "tool:t3", "tool:t1"]);
    expect(r.recent.map((e) => e.id)).toEqual(["event:f1", "tool:t6", "tool:t4", "tool:t3", "tool:t2", "tool:t1"]);
    expect(r.previous.map((p) => [p.sessionId, p.numbers?.calls, p.numbers?.p50Ms])).toEqual([["prev", 1, 50]]);
    expect(r.bottlenecks.map((b) => [b.rule, b.status, b.evidenceIds])).toEqual([["repeat_read", "open", ["tool:t1"]]]);

    // Replaying: only what happened up to the time asked.
    const at = hub.station("s", "FILES", T + 3);
    expect(at.numbers).toMatchObject({ calls: 3, failures: 1, ended: 3, p50Ms: 200, p95Ms: 300 });
    expect(at.at).toBe(BigInt(T + 3));
  });

  it("count API requests at EXTERNAL with the errors, and their tokens and cost at CORE, ORCHESTRATOR and EXTERNAL", async () => {
    const { hub } = await drillSetup();
    const ext = hub.station("s", "EXTERNAL");
    // w1, r1, r2, r3 and one API error; durations 500, 1000, 2000, 3000.
    expect(ext.numbers).toMatchObject({ calls: 5, failures: 1, ended: 5, p50Ms: 1_000, p95Ms: 3_000, apiRequests: 3, inputTokens: 22n, outputTokens: 33n, cacheReadTokens: 30n, cacheWriteTokens: 3n, hasCost: true, requestsWithoutCost: 1 });
    expect(ext.numbers?.costUsdEstimate).toBeCloseTo(0.75);
    expect(ext.parts.map((p) => [p.kind, p.key, p.numbers?.calls, p.numbers?.failures])).toEqual([
      ["model", "m1", 3, 1],
      ["domain", "example.com", 1, 0],
      ["model", "m2", 1, 0],
    ]);
    const core = hub.station("s", "CORE");
    expect(core.numbers).toMatchObject({ calls: 0, apiRequests: 2, inputTokens: 15n, outputTokens: 25n, hasCost: true, requestsWithoutCost: 1 });
    const orch = hub.station("s", "ORCHESTRATOR");
    expect(orch.numbers).toMatchObject({ apiRequests: 1, inputTokens: 7n, costUsdEstimate: 0.25, hasCost: true });
    // A station without rows, and one the agent does not draw: empty numbers, no cost.
    expect(hub.station("s", "SKILLS").numbers).toMatchObject({ calls: 0, hasCost: false, costUsdEstimate: 0 });
    expect(hub.station("s", "MONITORING").numbers?.calls).toBe(0);
    for (const bad of ["files", "", "FILES; DROP", "X".repeat(40)]) expect(reasonOf(() => hub.station("s", bad))).toBe(ErrorReason.OBSERVATORY_INVALID);
    expect(reasonOf(() => hub.station("s", "FILES", -1))).toBe(ErrorReason.OBSERVATORY_INVALID);
  });

  it("works its percentiles out from an even sample past 10 000 durations", async () => {
    const { hub, write } = await setup();
    const ops: WriteOp[] = [session("big", T)];
    for (let i = 0; i < 10_050; i++) ops.push(toolCall("big", `b${i}`, T + i, { toolName: "Bash", station: "TESTING", target: "pnpm", durationMs: i + 1, success: true }));
    write(ops);
    const r = hub.station("big", "TESTING");
    expect(r.numbers).toMatchObject({ calls: 10_050, ended: 10_050, sampled: true });
    expect(Math.abs((r.numbers?.p50Ms ?? 0) - 5_025)).toBeLessThan(10);
    expect(Math.abs((r.numbers?.p95Ms ?? 0) - 9_548)).toBeLessThan(10);
  });
});

describe("content", () => {
  it("leaves the machine only by id, as stored now: off as soon as the project is, none once cleared; never in an event, snapshot or station", async () => {
    const { hub, write, store } = await setup();
    write([
      session("s", T),
      { kind: "prompt", row: { promptId: "p1", sessionId: "s", at: T + 1, length: 9, excerpt: `ask ${MARK}` } },
      toolCall("s", "t1", T + 2, { toolName: "Bash", station: "SANDBOX", target: "echo", durationMs: 5, success: true, content: JSON.stringify({ input: `echo ${MARK}` }) }),
    ]);
    const a = recorder();
    const snap = hub.watch("s", a.sink);
    hub.provisional(tail("s", T + 3, [{ kind: "prompt", row: { promptId: "p2", sessionId: "s", at: T + 3, length: 3 } }]));
    write([toolCall("s", "t2", T + 4, { toolName: "Bash", station: "SANDBOX", target: "cat", content: MARK, success: true })]);
    await wait(40);

    const got = (id: string) => hub.content("s", id);
    expect([got("prompt:p1").state, got("prompt:p1").text]).toEqual([ObservatoryContentState.STORED, `ask ${MARK}`]);
    expect(got("tool:t1").text).toContain(MARK);
    expect(got("prompt:p2").state).toBe(ObservatoryContentState.NOT_YET);
    expect(got("event:nothing").state).toBe(ObservatoryContentState.NONE);
    for (const bad of ["p1", "bogus:p1", "prompt:", `prompt:a\nb`]) expect(reasonOf(() => got(bad))).toBe(ErrorReason.OBSERVATORY_INVALID);

    // Content switched off: none goes out, before the stored content is even cleared.
    write([{ kind: "contentSetting", row: { projectKey: P, storeContent: false, updatedAt: T + 10 } }]);
    expect(got("prompt:p1")).toMatchObject({ state: ObservatoryContentState.OFF, text: "" });
    expect(got("tool:t2").state).toBe(ObservatoryContentState.OFF);
    store.clearContent(P);
    expect(got("tool:t1").state).toBe(ObservatoryContentState.OFF);
    // On again: what was cleared stays gone.
    write([{ kind: "contentSetting", row: { projectKey: P, storeContent: true, updatedAt: T + 20 } }]);
    expect(got("prompt:p1").state).toBe(ObservatoryContentState.NONE);

    const station = hub.station("s", "SANDBOX");
    const page = hub.earlier("s", snap.earlier === "" ? "1.0.x" : snap.earlier);
    expect(a.events().length).toBeGreaterThan(0);
    for (const wire of [snap, station, page, ...a.frames]) expect(json(wire)).not.toContain(MARK);
  });
});

describe("the drill-down's speed", () => {
  // Ten sessions of one project (the drawer compares the newest with five of them), and one session holding every call.
  it.each([
    { sessions: 10, per: 20_000, previous: 5 },
    { sessions: 1, per: 200_000, previous: 0 },
  ])("answers in under 200 ms on 200 000 tool calls in $sessions session(s)", async ({ sessions, per, previous }) => {
    const { hub, store } = await setup();
    const stations = ["FILES", "SANDBOX", "TESTING", "GIT", "MCP"];
    for (let s = 0; s < sessions; s++) {
      const ops: WriteOp[] = [session(`p${s}`, T + s * 1_000_000)];
      for (let i = 0; i < per; i++) {
        const station = stations[i % stations.length] ?? "FILES";
        ops.push(toolCall(`p${s}`, `p${s}-t${i}`, T + s * 1_000_000 + i, { toolName: "Read", station, target: `src/f${i % 300}.ts`, durationMs: (i * 37) % 5_000, success: i % 17 !== 0, ...(station === "MCP" ? { mcpServer: `srv${i % 4}` } : {}) }));
      }
      store.write(ops);
    }
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const r = hub.station(`p${sessions - 1}`, "FILES");
      times.push(performance.now() - start);
      expect(r.numbers?.calls).toBe(per / stations.length);
      expect(r.previous).toHaveLength(previous);
    }
    console.info(`station drill-down, ${sessions} x ${per} tool calls: ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
    expect(Math.max(...times)).toBeLessThan(200);
  }, 120_000);
});
