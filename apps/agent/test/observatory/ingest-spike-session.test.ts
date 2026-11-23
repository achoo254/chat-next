// The session the spike recorded (Claude Code 2.1.330, a -p session with
// hooks and OpenTelemetry on), rebuilt with fake values: 39 hook events of 10
// kinds through the hook filter and the spool, and the OpenTelemetry records
// through the OTLP filter, all into the agent's service with its default
// ingest. One timeline comes out: 7 tool calls, the subagent with its Grep,
// the cost of every API call, the commit with its sha and branch. And the
// Advisor's sessions stay out of the daily totals.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { DailyRollupScheduler } from "../../src/observatory/ingest/daily-rollup-scheduler.ts";
import { ObservatoryIngest } from "../../src/observatory/ingest/observatory-ingest.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import { filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import { filterOtlpLogs } from "../../src/observatory/privacy/filter-otel-record.ts";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";
import { SPOOL_GRACE_MS } from "../../src/observatory/spool/spool-files.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";
import { FAKE_CWD, FAKE_HOME, isFakeSensitive, otlpBody } from "./observatory-payloads.ts";

afterAll(removeObsTempDirs);

const MINUTE = 60_000;
const T = 29_400_000 * MINUTE;
const SESSION = "sess-spike-0001";
const PROJECT = "github.com/example/example-app";
const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const i = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } });
const d = (key: string, v: number): Attr => ({ key, value: { doubleValue: v } });
const b = (key: string, v: boolean): Attr => ({ key, value: { boolValue: v } });

/** The hook events in the order the spike saw them, with fake values. */
function spikeHookEvents(): [string, Record<string, unknown>][] {
  const tool = (prompt: string, id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ prompt_id: prompt, tool_use_id: id, tool_name: name, tool_input: input, ...extra });
  const inSub = { agent_id: "agent-0001", agent_type: "Explore" };
  const loads: [string, Record<string, unknown>][] = Array.from({ length: 13 }, (_, n) => [
    "InstructionsLoaded",
    { file_path: n === 0 ? join(FAKE_CWD, "CLAUDE.md") : join(FAKE_CWD, "docs", `rule-${String(n).padStart(2, "0")}.md`), memory_type: "Project", load_reason: "session_start" },
  ]);
  const read = tool("prompt-1", "toolu_01", "Read", { file_path: join(FAKE_CWD, "src", "app.ts") });
  const agent = tool("prompt-1", "toolu_02", "Agent", { subagent_type: "Explore", description: "find TODOs", prompt: "find every TODO" });
  const grep = tool("prompt-1", "toolu_03", "Grep", { pattern: "TODO", path: FAKE_CWD }, inSub);
  const writeA = tool("prompt-1", "toolu_04", "Write", { file_path: join(FAKE_CWD, "src", "a.ts"), content: "export const a = 1;\n" });
  const writeB = tool("prompt-1", "toolu_05", "Write", { file_path: join(FAKE_CWD, "src", "b.ts"), content: "export const b = 2;\n" });
  const test = tool("prompt-1", "toolu_06", "Bash", { command: "node --test", description: "run the tests" });
  const commit = tool("prompt-2", "toolu_07", "Bash", { command: 'git commit -am "add a and b"', description: "commit" });
  const batch = (...ids: string[]): Record<string, unknown> => ({ tool_calls: ids.map((id) => ({ tool_use_id: id })) });
  return [
    ["SessionStart", { source: "startup", model: "claude-haiku-4-5" }],
    ...loads,
    ["UserPromptSubmit", { prompt_id: "prompt-1", prompt: "read src/app.ts, find TODOs with a subagent, write a.ts and b.ts, run the tests" }],
    ["PreToolUse", read],
    ["PostToolUse", { ...read, duration_ms: 13, tool_response: { file: { content: "export const app = 1; // TODO" } } }],
    ["PostToolBatch", batch("toolu_01")],
    ["PreToolUse", agent],
    ["SubagentStart", { prompt_id: "prompt-1", ...inSub }],
    ["PreToolUse", grep],
    ["PostToolUse", { ...grep, duration_ms: 72, tool_response: { numFiles: 1, filenames: ["src/app.ts"] } }],
    ["SubagentStop", { prompt_id: "prompt-1", ...inSub, last_assistant_message: "one TODO in src/app.ts", background_tasks: [] }],
    ["PostToolUse", { ...agent, duration_ms: 14, tool_response: { content: "one TODO in src/app.ts" } }],
    ["PostToolBatch", batch("toolu_02")],
    ["PreToolUse", writeA],
    ["PostToolUse", { ...writeA, duration_ms: 11, tool_response: { type: "create" } }],
    ["PreToolUse", writeB],
    ["PostToolUse", { ...writeB, duration_ms: 15, tool_response: { type: "create" } }],
    ["PostToolBatch", batch("toolu_04", "toolu_05")],
    ["PreToolUse", test],
    ["PostToolUse", { ...test, duration_ms: 569, tool_response: { stdout: "# pass 2\n# fail 0", stderr: "" } }],
    ["PostToolBatch", batch("toolu_06")],
    ["Stop", { prompt_id: "prompt-1", stop_hook_active: false, last_assistant_message: "done" }],
    ["UserPromptSubmit", { prompt_id: "prompt-2", prompt: "commit it" }],
    ["PreToolUse", commit],
    ["PostToolUse", { ...commit, duration_ms: 626, tool_response: { stdout: "[feat/spike-branch 0f1e2d3] add a and b", gitOperation: { commit: { sha: SHA, kind: "commit", branch: "feat/spike-branch" } } } }],
    ["PostToolBatch", batch("toolu_07")],
    ["SessionEnd", { prompt_id: "prompt-2", reason: "other" }],
  ];
}

/** The OpenTelemetry log records of the session: 6 API calls (2 by the subagent, on Sonnet), 7 tool results, the subagent's totals. */
function spikeOtelLogs(): Record<string, unknown>[] {
  let seq = 0;
  const log = (event: string, ms: number, prompt: string, attrs: Attr[]): Record<string, unknown> => ({
    timeUnixNano: `${T + ms}000000`,
    attributes: [s("event.name", event), s("session.id", SESSION), s("prompt.id", prompt), i("event.sequence", seq++), s("user.email", "user@example.invalid"), ...attrs],
  });
  const api = (ms: number, prompt: string, req: string | undefined, model: string, cost: number, agent?: string): Record<string, unknown> =>
    log("api_request", ms, prompt, [
      s("model", model),
      d("cost_usd", cost),
      i("duration_ms", 900),
      i("ttft_ms", 300),
      i("input_tokens", 12),
      i("output_tokens", 240),
      i("cache_read_tokens", 18_000),
      i("cache_creation_tokens", 2_000),
      ...(req ? [s("request_id", req)] : []),
      ...(agent ? [s("agent_id", agent)] : []),
      s("query_source", agent ? "agent:builtin:Explore" : "repl_main_thread"),
    ]);
  const result = (ms: number, prompt: string, id: string, name: string, duration: number, agent?: string): Record<string, unknown> =>
    log("tool_result", ms, prompt, [s("tool_name", name), s("tool_use_id", id), b("success", true), i("duration_ms", duration), i("tool_input_size_bytes", 64), i("tool_result_size_bytes", 512), ...(agent ? [s("agent_id", agent)] : [])]);
  return [
    api(1_000, "prompt-1", "req_01", "claude-haiku-4-5", 0.03),
    result(2_000, "prompt-1", "toolu_01", "Read", 13),
    api(3_000, "prompt-1", "req_02", "claude-sonnet-4-5", 0.12, "agent-0001"),
    result(3_500, "prompt-1", "toolu_03", "Grep", 72, "agent-0001"),
    api(4_000, "prompt-1", "req_03", "claude-sonnet-4-5", 0.13, "agent-0001"),
    log("subagent_completed", 4_200, "prompt-1", [s("agent_id", "agent-0001"), s("agent_type", "Explore"), i("total_tokens", 31_000), i("total_tool_uses", 1), i("duration_ms", 2_400), s("model", "claude-sonnet-4-5")]),
    result(4_300, "prompt-1", "toolu_02", "Agent", 14),
    api(5_000, "prompt-1", "req_04", "claude-haiku-4-5", 0.04),
    result(5_500, "prompt-1", "toolu_04", "Write", 11),
    result(5_600, "prompt-1", "toolu_05", "Write", 15),
    // An API call without a request id: keyed by its event.
    api(6_000, "prompt-1", undefined, "claude-haiku-4-5", 0.027),
    result(6_800, "prompt-1", "toolu_06", "Bash", 569),
    api(8_000, "prompt-2", "req_06", "claude-haiku-4-5", 0.03),
    result(8_900, "prompt-2", "toolu_07", "Bash", 626),
  ];
}

describe("the spike's session through the service", () => {
  it("joins the hooks and OpenTelemetry into one timeline: 7 tool calls, the subagent's Grep, every API cost, the commit", async () => {
    const dir = obsTempDir("ingest-spike");
    const config = new ConfigStore(join(dir, "config"));
    const port = await pickFreePort();
    config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_395 }));
    const data = join(dir, "data");
    const now = (): number => T + 5 * MINUTE + SPOOL_GRACE_MS;
    const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], now, tokenTimings: { tokenRetryMs: [] } });
    await s.start();
    try {
      const events = spikeHookEvents();
      expect(events).toHaveLength(39);
      const ctx = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true, projectKey: PROJECT };
      for (const [n, [event, extra]] of events.entries()) {
        const at = T + n * 250;
        const payload = { session_id: SESSION, transcript_path: join(FAKE_HOME, ".claude", "projects", "x.jsonl"), cwd: FAKE_CWD, permission_mode: "default", hook_event_name: event, ...extra };
        const record = filterHookEvent(event, payload, ctx, at);
        expect(record, event).toBeDefined();
        expect(await appendSpoolLine(data, JSON.stringify(record), at)).toBe("written");
      }
      await s.drainSpool();
      expect(s.status().spool?.loaded).toBe(39);
      const otel = filterOtlpLogs(otlpBody(spikeOtelLogs()), [], now());
      expect(otel.records).toHaveLength(14);
      for (const r of otel.records) await s.accept(r, "otlp");
    } finally {
      await s.stop();
    }

    const store = await ObservatoryStore.open({ path: join(data, "observatory.db") });
    try {
      const t = store.sessionTimeline(SESSION);
      expect(t.session).toMatchObject({ source: "cli", projectKey: PROJECT, mainModel: "claude-haiku-4-5", startedAt: T, endedAt: T + 38 * 250 });
      expect(t.session?.cwd?.startsWith("~")).toBe(true);
      expect(t.prompts.map((p) => p.promptId)).toEqual(["prompt-1", "prompt-2"]);
      expect(t.prompts[0]?.excerpt).toContain("find TODOs");
      expect(t.instructionsLoaded).toHaveLength(13);

      expect(t.toolCalls).toHaveLength(7);
      const byId = new Map(t.toolCalls.map((c) => [c.toolUseId, c]));
      expect(t.toolCalls.every((c) => c.success === true && c.durationMs !== null && c.inputBytes !== null)).toBe(true);
      expect(byId.get("toolu_03")).toMatchObject({ toolName: "Grep", agentId: "agent-0001", durationMs: 72, officeRoom: null, outputBytes: 512 });
      expect(byId.get("toolu_01")).toMatchObject({ toolName: "Read", agentId: null, officeRoom: null, target: "src/app.ts" });
      expect(byId.get("toolu_02")).toMatchObject({ toolName: "Agent", officeRoom: null, target: "Explore" });
      expect(byId.get("toolu_04")).toMatchObject({ officeRoom: null });
      expect(byId.get("toolu_07")).toMatchObject({ officeRoom: null, target: "git", promptId: "prompt-2", durationMs: 626 });
      expect(JSON.parse(byId.get("toolu_01")?.content ?? "{}")).toMatchObject({ input: expect.stringContaining("app.ts"), output: expect.stringContaining("TODO") });

      expect(t.subagents).toEqual([
        expect.objectContaining({ agentId: "agent-0001", agentType: "Explore", promptId: "prompt-1", model: "claude-sonnet-4-5", totalTokens: 31_000, toolCount: 1 }),
      ]);
      expect(t.subagents[0]?.endedAt).not.toBeNull();

      expect(t.apiRequests).toHaveLength(6);
      const total = t.apiRequests.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      expect(total).toBeCloseTo(0.377, 10);
      const bySubagent = t.apiRequests.filter((r) => r.agentId === "agent-0001").reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      expect(bySubagent).toBeCloseTo(0.25, 10);
      expect(t.apiRequests.every((r) => r.cacheWrite5mTokens === 2_000 && r.cacheReadTokens === 18_000)).toBe(true);

      expect(t.gitOps).toEqual([expect.objectContaining({ sha: SHA, branch: "feat/spike-branch", kind: "commit", promptId: "prompt-2" })]);
    } finally {
      store.close();
    }
  });
});

describe("the Advisor's sessions", () => {
  it("are labelled internal and left out of the daily totals, while the rest is rolled up", async () => {
    const store = await ObservatoryStore.open({ path: join(obsTempDir("ingest-rollup"), "observatory.db") });
    try {
      const ops: WriteOp[] = [];
      const ingest = new ObservatoryIngest({ push: (op) => ops.push(op), home: FAKE_HOME, log: () => undefined });
      const old = T - 100 * 24 * 60 * MINUTE;
      const ctx = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true, projectKey: PROJECT, stage: "final" as const };
      for (const [session, label] of [["sess-work", undefined], ["sess-advisor", "advisor"]] as const) {
        const start = filterHookEvent("SessionStart", { session_id: session, cwd: FAKE_CWD, source: "startup", model: "claude-opus-4-5" }, ctx, old);
        if (!start) throw new Error("SessionStart was dropped");
        // The agent marks the records of an Advisor session it runs.
        const record: FilteredHookRecord = label ? { ...start, f: { ...start.f, internal_label: label } } : start;
        await ingest.accept(record, "sdk");
        const otel = filterOtlpLogs(
          otlpBody([{ timeUnixNano: `${old + 1_000}000000`, attributes: [s("event.name", "api_request"), s("session.id", session), s("request_id", `req-${session}`), s("model", "claude-opus-4-5"), d("cost_usd", 1.5), i("input_tokens", 100)] }]),
          [],
          old,
        );
        for (const r of otel.records) await ingest.accept(r, "otlp");
      }
      store.write(ops);
      expect(store.sessionTimeline("sess-advisor").session?.internalLabel).toBe("advisor");
      expect(store.sessionTimeline("sess-work").session?.internalLabel).toBeNull();

      const problems: string[] = [];
      const rollups = new DailyRollupScheduler({ prune: () => store.prune(T, 500, "UTC"), problems: (place) => problems.push(place) });
      await rollups.runOnce();
      expect(problems).toEqual([]);
      const days = store.dailyRollups();
      expect(days.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(1.5, 10);
      expect(days.reduce((sum, r) => sum + r.apiRequests, 0)).toBe(1);
      expect(days.reduce((sum, r) => sum + r.sessions, 0)).toBe(1);
      expect(days.every((r) => r.projectKey === PROJECT)).toBe(true);
      // Both sessions' detail is gone: the Advisor's was deleted without being counted.
      expect(store.sessionTimeline("sess-advisor").session).toBeNull();
      expect(store.sessionTimeline("sess-work").apiRequests).toEqual([]);
    } finally {
      store.close();
    }
  });
});
