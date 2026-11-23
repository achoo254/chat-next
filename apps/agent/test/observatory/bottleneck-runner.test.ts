// The bottleneck runner on a real store: findings opened, raised in place and
// closed by their rule's condition or the session's end, written as rows with
// evidence ids and heard by onFinding; the 15 s tick catching a hung call and
// a silent subagent with no new event; a provisional event from the spool's
// tail scored before the store has it; internal sessions left out; switching
// the rules off closes their open findings; a session quiet without a
// SessionEnd is forgotten; a normal
// session (the spike's, and a real working session reduced to tool names,
// timings and file numbers) yields no finding; no content ever reaches a
// finding; a batch of 1 000 writes is scored in under 50 ms.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { ACTIVE_MS, BottleneckRunner } from "../../src/observatory/bottlenecks/bottleneck-runner.ts";
import type { FindingChange } from "../../src/observatory/bottlenecks/finding-lifecycle.ts";
import { classifyTool } from "../../src/observatory/ingest/tool-classification.ts";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import type { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { tempDir } from "../harness.ts";
import { openTempStore } from "./store-fixture.ts";

const SEC = 1_000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const T = 1_790_000_000_000;
const PROJECT = "github.com/acme/app";

type Rig = { store: ObservatoryStore; runner: BottleneckRunner; config: ConfigStore; clock: { now: number }; changes: FindingChange[]; problems: string[]; put: (ops: WriteOp[]) => Promise<void> };
const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.runner.stop();
    r.store.close();
  }
});

/**
 * Windows as the service gives them from live-map/model-window.ts: 1M once a
 * request went past the standard 200 000; the standard window is only assumed
 * then (a 1M session reads too full below 200 000), so it is not judged.
 */
const claudeWindow = (_model: string, largest: number): number | undefined => (largest > 200_000 ? 1_000_000 : undefined);

async function rig(opts: { windows?: boolean } = {}): Promise<Rig> {
  const store = await openTempStore();
  const config = new ConfigStore(tempDir("bottleneck-config-"));
  const clock = { now: T };
  const changes: FindingChange[] = [];
  const problems: string[] = [];
  const runner = new BottleneckRunner({
    config,
    store: () => store,
    push: (op) => store.write([op]),
    problems: (place, err) => problems.push(`${place}: ${err instanceof Error ? err.message : String(err)}`),
    now: () => clock.now,
    tickMs: 3_600_000,
    contextWindow: opts.windows === true ? claudeWindow : undefined,
  });
  runner.onFinding((c) => changes.push(c));
  await runner.start();
  const put = async (ops: WriteOp[]): Promise<void> => {
    store.write(ops);
    runner.written(ops);
    await runner.idle();
  };
  const r = { store, runner, config, clock, changes, problems, put };
  rigs.push(r);
  return r;
}

/** Every bottleneck row, read through the export (the store's public surface). */
async function bottleneckRows(store: ObservatoryStore): Promise<Record<string, unknown>[]> {
  const file = join(tempDir("bottleneck-export-"), "export.json");
  await store.exportToFile(file);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tables: Record<string, Record<string, unknown>[]> };
  return parsed.tables.bottlenecks ?? [];
}

const session = (id: string, at: number, extra: Partial<Extract<WriteOp, { kind: "session" }>["row"]> = {}): WriteOp => ({ kind: "session", row: { sessionId: id, source: "cli", startedAt: at, projectKey: PROJECT, ...extra } });
const prompt = (id: string, sid: string, at: number, excerpt?: string): WriteOp => ({ kind: "prompt", row: { promptId: id, sessionId: sid, at, ...(excerpt ? { excerpt } : {}) } });
function call(sid: string, id: string, name: string, at: number, durationMs: number | undefined, extra: Partial<Extract<WriteOp, { kind: "toolCall" }>["row"]> = {}): WriteOp[] {
  const pre: WriteOp = { kind: "toolCall", row: { toolUseId: id, sessionId: sid, promptId: extra.promptId ?? "p1", at, toolName: name, ...extra } };
  return durationMs === undefined ? [pre] : [pre, { kind: "toolCall", row: { ...pre.row, durationMs, success: extra.success ?? true } }];
}
const read = (sid: string, id: string, at: number, key: string, content?: string): WriteOp[] =>
  call(sid, id, "Read", at, 12, { station: "FILES", stationFlags: 0, target: "src/index.ts", targetKey: key, ...(content ? { content } : {}) });
const stop = (sid: string, at: number): WriteOp => ({ kind: "sessionEvent", row: { dedupeKey: `stop:${sid}:${at}`, sessionId: sid, at, kind: "stop", station: "CORE" } });

/** 30 past `pnpm test` runs of about 10 s, in another session within the 90 days. */
function pnpmHistory(): WriteOp[] {
  const sid = "sess-history";
  return [session(sid, T - 5 * DAY), ...Array.from({ length: 30 }, (_, i) => call(sid, `h${i}`, "Bash", T - 5 * DAY + i * MIN, 9_000 + (i % 5) * 300, { station: "TESTING", stationFlags: 0, target: "pnpm" })).flat()];
}

describe("finding lifecycle", () => {
  it("opens, raises the same row, and closes when the file is written", async () => {
    const r = await rig();
    const S = "sess-life";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2, 3].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1"))]);
    expect(r.changes.map((c) => [c.type, c.row.rule, c.row.severity])).toEqual([["open", "repeat_read", "warn"]]);
    await r.put([...read(S, "r4", T + 4 * SEC, "k1"), ...read(S, "r5", T + 5 * SEC, "k1")]);
    expect(r.changes.at(-1)).toMatchObject({ type: "update", row: { severity: "alert", status: "open", openedAt: T } });
    let rows = await bottleneckRows(r.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: S, rule: "repeat_read", subkey: "k1", station: "FILES", severity: "alert", status: "open" });
    const evidence = JSON.parse(String(rows[0]?.evidence_json)) as { eventIds: string[]; measures: Record<string, unknown> };
    expect(evidence.eventIds).toEqual(["tool:r5", "tool:r4", "tool:r3", "tool:r2", "tool:r1"]);
    r.clock.now = T + 10 * SEC;
    await r.put(call(S, "e1", "Edit", T + 9 * SEC, 20, { station: "FILES", stationFlags: StationFlag.write, targetKey: "k1" }));
    expect(r.changes.at(-1)).toMatchObject({ type: "close", row: { status: "closed", closedAt: T + 10 * SEC } });
    rows = await bottleneckRows(r.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "closed", closed_at: T + 10 * SEC });
  });

  it("closes every open finding when the session ends", async () => {
    const r = await rig();
    const S = "sess-end";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2, 3].flatMap((i) => [...read(S, `a${i}`, T + i * SEC, "ka"), ...read(S, `b${i}`, T + i * SEC, "kb")])]);
    expect(r.changes.filter((c) => c.type === "open")).toHaveLength(2);
    await r.put([session(S, T, { endedAt: T + 20 * SEC })]);
    expect(r.changes.filter((c) => c.type === "close").map((c) => c.row.closedAt)).toEqual([T + 20 * SEC, T + 20 * SEC]);
    expect((await bottleneckRows(r.store)).every((row) => row.status === "closed")).toBe(true);
  });

  it("goes on from the findings stored by an earlier run, and closes those of a session that ended meanwhile", async () => {
    const r = await rig();
    const S = "sess-resume";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2, 3].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1"))]);
    r.runner.stop();
    r.store.write([session(S, T, { endedAt: T + MIN })]);
    r.changes.length = 0;
    await r.runner.start();
    expect(r.changes).toMatchObject([{ type: "close", row: { rule: "repeat_read", closedAt: T + MIN } }]);
  });
});

describe("the 15 s tick", () => {
  it("opens tool_slow on a call hung for 30 s with no new event", async () => {
    const r = await rig();
    await r.put(pnpmHistory());
    const S = "sess-hung";
    await r.put([session(S, T), prompt("p1", S, T), ...call(S, "t1", "Bash", T + SEC, undefined, { station: "TESTING", stationFlags: 0, target: "pnpm" })]);
    r.clock.now = T + 16 * SEC;
    r.runner.tick();
    expect(r.changes).toEqual([]);
    r.clock.now = T + 31 * SEC;
    r.runner.tick();
    expect(r.changes).toMatchObject([{ type: "open", row: { rule: "tool_slow", subkey: "Bash|TESTING|pnpm", station: "TESTING", severity: "warn", n: 30 } }]);
    // It ends after 40 s (past 3× the p95: raised to an alert): the finding stays until 60 s after its end.
    r.clock.now = T + 41 * SEC;
    await r.put(call(S, "t1", "Bash", T + SEC, 40 * SEC, { station: "TESTING", stationFlags: 0, target: "pnpm" }));
    expect(r.changes.at(-1)).toMatchObject({ type: "update", row: { severity: "alert" } });
    r.clock.now = T + 41 * SEC + 59 * SEC;
    r.runner.tick();
    expect(r.changes.at(-1)?.type).toBe("update");
    r.clock.now = T + 41 * SEC + 61 * SEC;
    r.runner.tick();
    expect(r.changes.at(-1)).toMatchObject({ type: "close", row: { rule: "tool_slow" } });
  });

  it("opens subagent_idle on a subagent silent for 6 minutes", async () => {
    const r = await rig();
    const S = "sess-idle";
    await r.put([session(S, T), prompt("p1", S, T), ...call(S, "ag1", "Agent", T, undefined, { station: "ORCHESTRATOR" }), { kind: "subagent", row: { sessionId: S, agentId: "agent-1", promptId: "p1", startedAt: T + SEC } }]);
    r.clock.now = T + 6 * MIN + SEC;
    r.runner.tick();
    expect(r.changes).toMatchObject([{ type: "open", row: { rule: "subagent_idle", subkey: "agent-1", station: "ORCHESTRATOR", severity: "warn" } }]);
    await r.put([{ kind: "subagent", row: { sessionId: S, agentId: "agent-1", startedAt: T + SEC, endedAt: T + 7 * MIN } }]);
    expect(r.changes.at(-1)).toMatchObject({ type: "close", row: { rule: "subagent_idle" } });
  });
});

describe("what is scored", () => {
  it("scores a provisional event from the spool's tail before the store has it, with the ids the stored rows get", async () => {
    const r = await rig();
    const S = "sess-live";
    await r.put([session(S, T), prompt("p1", S, T)]);
    for (const i of [1, 2, 3]) r.runner.liveEvent({ provisional: true, sessionId: S, event: "PreToolUse", at: T + i * SEC, ops: read(S, `r${i}`, T + i * SEC, "k1").slice(0, 1), file: "events-1.jsonl" });
    await r.runner.idle();
    expect(r.changes).toMatchObject([{ type: "open", row: { rule: "repeat_read" } }]);
    const rows = await bottleneckRows(r.store);
    expect(JSON.parse(String(rows[0]?.evidence_json)).eventIds).toEqual(["tool:r3", "tool:r2", "tool:r1"]);
    r.runner.liveEvent({ provisional: true, sessionId: S, event: "SessionEnd", at: T + 9 * SEC, ops: [], file: "events-1.jsonl" });
    await r.runner.idle();
    expect(r.changes.at(-1)).toMatchObject({ type: "close", row: { closedAt: T + 9 * SEC } });
  });

  it("leaves internal sessions (the Advisor's) out", async () => {
    const r = await rig();
    const S = "sess-advisor";
    await r.put([session(S, T, { source: "sdk", internalLabel: "advisor" }), prompt("p1", S, T), ...[1, 2, 3, 4, 5].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1"))]);
    expect(r.changes).toEqual([]);
    expect(await bottleneckRows(r.store)).toEqual([]);
  });

  it("does nothing while switched off in the config", async () => {
    const r = await rig();
    r.config.update((c) => (c.observatory = { thresholds: { enabled: false } }));
    const S = "sess-off";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2, 3].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1"))]);
    expect(r.changes).toEqual([]);
  });

  it("closes the open findings once switched off, those it follows and those an earlier run stored", async () => {
    const r = await rig();
    const S = "sess-switched-off";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2, 3].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1"))]);
    expect(r.changes).toMatchObject([{ type: "open", row: { rule: "repeat_read" } }]);
    r.config.update((c) => (c.observatory = { thresholds: { enabled: false } }));
    r.clock.now = T + MIN;
    r.runner.tick();
    expect(r.changes.at(-1)).toMatchObject({ type: "close", row: { rule: "repeat_read", closedAt: T + MIN } });
    expect(r.runner.followed).toBe(0);

    // Stored open by a run while on, then the agent starts again switched off.
    r.config.update((c) => (c.observatory = { thresholds: { enabled: true } }));
    const S2 = "sess-switched-off-later";
    await r.put([session(S2, T), prompt("p1", S2, T), ...[1, 2, 3].flatMap((i) => read(S2, `s${i}`, T + i * SEC, "k2"))]);
    r.runner.stop();
    r.config.update((c) => (c.observatory = { thresholds: { enabled: false } }));
    r.changes.length = 0;
    await r.runner.start();
    expect(r.changes).toMatchObject([{ type: "close", row: { rule: "repeat_read", subkey: "k2" } }]);
    expect((await bottleneckRows(r.store)).every((row) => row.status === "closed")).toBe(true);
  });

  it("forgets a session quiet for ACTIVE_MS that never ended (no SessionEnd)", async () => {
    const r = await rig();
    const S = "sess-quiet";
    await r.put([session(S, T), prompt("p1", S, T), ...read(S, "r1", T + SEC, "k1"), stop(S, T + 2 * SEC)]);
    expect(r.runner.followed).toBe(1);
    r.clock.now = T + 2 * SEC + ACTIVE_MS - 1;
    r.runner.tick();
    expect(r.runner.followed).toBe(1);
    r.clock.now = T + 2 * SEC + ACTIVE_MS + 1;
    r.runner.tick();
    expect(r.runner.followed).toBe(0);
  });

  it("takes thresholds from the config, by subkey, and uses the default for a value of the wrong type (logged)", async () => {
    const r = await rig();
    r.config.update((c) => (c.observatory = { thresholds: { rules: { repeat_read: { values: { warnReads: "two" }, subkeys: { k2: { warnReads: 2 } } } } } }));
    const S = "sess-config";
    await r.put([session(S, T), prompt("p1", S, T), ...[1, 2].flatMap((i) => [...read(S, `a${i}`, T + i * SEC, "k1"), ...read(S, `b${i}`, T + i * SEC, "k2")])]);
    expect(r.changes.map((c) => c.row.subkey)).toEqual(["k2"]);
    expect(r.problems.some((p) => p.includes("repeat_read.warnReads: not a number, the default 3 is used"))).toBe(true);
  });

  it("never puts content in a finding", async () => {
    const r = await rig();
    const S = "sess-content";
    const secret = "CONTENT-SAMPLE-7f3a91";
    await r.put([session(S, T), prompt("p1", S, T, `${secret} prompt`), ...[1, 2, 3, 4, 5].flatMap((i) => read(S, `r${i}`, T + i * SEC, "k1", JSON.stringify({ output: `${secret} file` })))]);
    const rows = await bottleneckRows(r.store);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(r.changes)).not.toContain(secret);
  });

  it("scores a batch of 1 000 writes in under 50 ms once the history is read", async () => {
    const r = await rig();
    await r.put(pnpmHistory());
    const S = "sess-perf";
    const warm: WriteOp[] = [session(S, T), prompt("p1", S, T), ...call(S, "w0", "Bash", T, 9_000, { station: "TESTING", stationFlags: 0, target: "pnpm" })];
    await r.put(warm);
    const ops: WriteOp[] = [];
    for (let i = 0; ops.length < 1_000; i++) {
      ops.push(...call(S, `c${i}`, i % 2 ? "Read" : "Bash", T + i * 100, 300, i % 2 ? { station: "FILES", targetKey: `k${i % 50}` } : { station: "TESTING", stationFlags: 0, target: "pnpm" }));
    }
    r.store.write(ops);
    const timings: number[] = [];
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      r.runner.written(ops.slice(0, 1_000));
      await r.runner.idle();
      timings.push(performance.now() - started);
    }
    expect(Math.min(...timings)).toBeLessThan(50);
  });
});

/** The anonymized working session: tool names, times, durations, file numbers, read pages, shell programs, token counts. */
type WorkSession = {
  prompts: number[];
  calls: { t: number; n: string; d?: number; ok?: number; f?: number; o?: number; l?: number; p?: string }[];
  apis: { t: number; d: number; in: number; out: number; cr: number; cw: number }[];
};

/** The working session as the ingest would write it, starting at `start` in session `sid`. */
function workSessionOps(sid: string, start: number): WriteOp[] {
  const w = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "bottleneck-work-session.json"), "utf8")) as WorkSession;
  const promptAt = (t: number): string => `${sid}-p${w.prompts.filter((p) => p <= t).length}`;
  const ops: WriteOp[] = [session(sid, start)];
  w.prompts.forEach((p, i) => {
    if (i > 0) ops.push(stop(sid, start + p - 1));
    ops.push(prompt(`${sid}-p${i + 1}`, sid, start + p));
  });
  for (const [i, c] of w.calls.entries()) {
    const target = c.n === "Bash" ? (c.p ?? null) : c.f !== undefined ? `src/file-${c.f}.ts` : null;
    const cls = classifyTool(c.n, target ?? undefined);
    ops.push(
      ...call(sid, `${sid}-t${i}`, c.n, start + c.t, c.d, {
        promptId: promptAt(c.t),
        station: cls.station,
        stationFlags: cls.stationFlags & ~StationFlag.estimated,
        target,
        mcpServer: cls.mcpServer ?? null,
        targetKey: c.f !== undefined ? `${sid}-file-${c.f}` : null,
        readOffset: c.o ?? null,
        readLimit: c.l ?? null,
        success: c.ok !== 0,
      }),
    );
  }
  for (const [i, a] of w.apis.entries()) {
    ops.push({
      kind: "apiRequest",
      row: { dedupeKey: `${sid}-req-${i}`, sessionId: sid, promptId: promptAt(a.t), at: start + a.t, model: "claude-opus-5-5", inputTokens: a.in, outputTokens: a.out, cacheReadTokens: a.cr, cacheWrite5mTokens: a.cw, durationMs: a.d, querySource: "repl_main_thread" },
    });
  }
  const last = Math.max(...w.calls.map((c) => c.t + (c.d ?? 0)), ...w.apis.map((a) => a.t));
  ops.push(stop(sid, start + last + 1), session(sid, start, { endedAt: start + last + 2 }));
  return ops;
}

/** The session the spike recorded (ingest-spike-session.test.ts), as its writes. */
function spikeOps(sid: string, start: number): WriteOp[] {
  const sub = { agentId: "agent-0001" };
  return [
    session(sid, start),
    prompt(`${sid}-p1`, sid, start + 100),
    ...call(sid, `${sid}-01`, "Read", start + 200, 13, { promptId: `${sid}-p1`, station: "FILES", target: "src/app.ts", targetKey: `${sid}-k-app` }),
    ...call(sid, `${sid}-02`, "Agent", start + 300, 2_400, { promptId: `${sid}-p1`, station: "ORCHESTRATOR", target: "Explore" }),
    { kind: "subagent", row: { sessionId: sid, agentId: sub.agentId, promptId: `${sid}-p1`, agentType: "Explore", startedAt: start + 400, endedAt: start + 2_600, totalTokens: 31_000 } },
    ...call(sid, `${sid}-03`, "Grep", start + 500, 72, { promptId: `${sid}-p1`, station: "FILES", target: "src", ...sub }),
    ...call(sid, `${sid}-04`, "Write", start + 3_000, 11, { promptId: `${sid}-p1`, station: "FILES", stationFlags: StationFlag.write, targetKey: `${sid}-k-a` }),
    ...call(sid, `${sid}-05`, "Write", start + 3_100, 15, { promptId: `${sid}-p1`, station: "FILES", stationFlags: StationFlag.write, targetKey: `${sid}-k-b` }),
    ...call(sid, `${sid}-06`, "Bash", start + 3_200, 569, { promptId: `${sid}-p1`, station: "TESTING", target: "node" }),
    stop(sid, start + 4_000),
    prompt(`${sid}-p2`, sid, start + 5_000),
    ...call(sid, `${sid}-07`, "Bash", start + 5_100, 626, { promptId: `${sid}-p2`, station: "GIT", stationFlags: StationFlag.commit, target: "git" }),
    ...[0.03, 0.12, 0.13, 0.04, 0.05, 0.02].map((cost, i): WriteOp => ({
      kind: "apiRequest",
      row: { dedupeKey: `${sid}-req-${i}`, sessionId: sid, promptId: i < 5 ? `${sid}-p1` : `${sid}-p2`, at: start + 1_000 + i * 900, model: i === 1 || i === 2 ? "claude-sonnet-4-5" : "claude-haiku-4-5", inputTokens: 12, outputTokens: 240, cacheReadTokens: 18_000, cacheWrite5mTokens: 2_000, costUsd: cost, durationMs: 900, ...(i === 1 || i === 2 ? sub : { querySource: "repl_main_thread" }) },
    })),
    stop(sid, start + 6_000),
    session(sid, start, { endedAt: start + 6_500 }),
  ];
}

describe("a normal session", () => {
  it("yields no finding: the spike's session, and a real working session over its own history", async () => {
    const r = await rig({ windows: true });
    // The machine's history: the same kind of work 20 days before, and earlier spike sessions.
    r.store.write(workSessionOps("sess-work-before", T - 20 * DAY));
    for (let i = 0; i < 6; i++) r.store.write(spikeOps(`sess-spike-before-${i}`, T - (i + 1) * DAY));
    // The sessions replayed as they happen: each write once its time has come, the tick every 15 s.
    const replay = [...workSessionOps("sess-work", T), ...spikeOps("sess-spike", T + 30 * MIN)].sort((a, b) => atOf(a) - atOf(b));
    let next = 0;
    const end = Math.max(...replay.map(atOf)) + 2 * MIN;
    for (let now = T; now <= end; now += 15 * SEC) {
      r.clock.now = now;
      const due: WriteOp[] = [];
      while (next < replay.length && atOf(replay[next] as WriteOp) <= now) due.push(replay[next++] as WriteOp);
      if (due.length > 0) await r.put(due);
      r.runner.tick();
    }
    expect(r.changes.map((c) => `${c.type} ${c.row.rule} ${c.row.subkey}`)).toEqual([]);
    expect(await bottleneckRows(r.store)).toEqual([]);
    expect(r.problems).toEqual([]);
  });
});

/** The time a write happened (a call's end when it tells its duration). */
function atOf(op: WriteOp): number {
  switch (op.kind) {
    case "session":
      return op.row.endedAt ?? op.row.startedAt;
    case "subagent":
      return op.row.endedAt ?? op.row.startedAt;
    case "toolCall":
      return op.row.at + (op.row.durationMs ?? 0);
    case "prompt":
    case "apiRequest":
    case "sessionEvent":
      return op.row.at;
    default:
      return 0;
  }
}
