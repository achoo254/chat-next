// What the ingest makes of the moments of a session that are not a tool call,
// a prompt or an API call (session_events), and of a tool call's station:
// one row per event even when read twice, different events never merged; a
// hook's exact station winning over OpenTelemetry's estimate in either order;
// permission mode and model changes; API errors flagged when rate limited;
// a hook's block told from a permission decision. Never content in an event,
// even when the project stores content.
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ObservatoryIngest } from "../../src/observatory/ingest/observatory-ingest.ts";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import type { FilteredHookRecord, FilteredOtelRecord, FilteredRecord, RecordOrigin } from "../../src/observatory/privacy/filtered-record.ts";
import type { SessionEventRow } from "../../src/observatory/store/observatory-rows.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);
const stores: ObservatoryStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const SECRET = "SAMPLE-CONTENT-do-not-store-7f3a";

async function rig(): Promise<{ store: ObservatoryStore; path: string; feed: (records: readonly FilteredRecord[], origin?: RecordOrigin) => Promise<void> }> {
  const path = join(obsTempDir("ingest-events"), "observatory.db");
  const store = await ObservatoryStore.open({ path });
  stores.push(store);
  const ops: WriteOp[] = [];
  const ingest = new ObservatoryIngest({ push: (op) => ops.push(op), home: "/home/nobody", log: () => undefined });
  const feed = async (records: readonly FilteredRecord[], origin: RecordOrigin = "spool"): Promise<void> => {
    for (const r of records) await ingest.accept(r, origin);
    store.write(ops.splice(0));
  };
  return { store, path, feed };
}

const hook = (event: string, at: number, f: Record<string, string | number | boolean | string[]>, c?: Record<string, string>): FilteredHookRecord => ({
  v: 1,
  src: "hook",
  event,
  at,
  f: { session_id: "s1", cwd: "~/work/app", project_key: "github.com/example/app", ...f },
  ...(c ? { c } : {}),
});
const otel = (event: string, at: number, f: Record<string, string | number | boolean>): FilteredOtelRecord => ({ v: 1, src: "otel", event, at, f: { "session.id": "s1", ...f } });

const brief = (e: SessionEventRow): unknown[] => [e.kind, e.at, e.label, e.number, e.flag, e.station];

/** A session with every kind of event, content in every field that can hold it. */
function eventful(): FilteredRecord[] {
  return [
    hook("SessionStart", 1_000, { source: "startup", model: "claude-opus-4-5", permission_mode: "default" }),
    hook("UserPromptSubmit", 1_010, { prompt_id: "p1", prompt_length: 30 }, { prompt: `please ${SECRET}` }),
    hook("PermissionRequest", 1_020, { prompt_id: "p1", tool_name: "Write", station: "FILES", station_flags: StationFlag.write }, { tool_input: SECRET }),
    hook("PermissionDenied", 1_030, { prompt_id: "p1", tool_use_id: "t-denied", tool_name: "Write", station: "FILES", station_flags: StationFlag.write }, { reason: SECRET, tool_input: SECRET }),
    hook("PreToolUse", 1_040, { prompt_id: "p1", tool_use_id: "t-todo", tool_name: "TodoWrite", station: "ORCHESTRATOR", station_flags: 0, todo_pending: 2, todo_in_progress: 1, todo_done: 4 }, { tool_input: SECRET }),
    hook("PostToolUse", 1_045, { prompt_id: "p1", tool_use_id: "t-todo", tool_name: "TodoWrite", station: "ORCHESTRATOR", station_flags: 0, todo_pending: 2, todo_in_progress: 1, todo_done: 4 }, { tool_response: SECRET }),
    hook("PreCompact", 1_050, { trigger: "auto" }),
    hook("PostCompact", 1_060, { trigger: "auto" }),
    hook("Notification", 1_070, { notification_type: "idle_prompt" }),
    hook("UserPromptSubmit", 1_080, { prompt_id: "p2", permission_mode: "plan" }, { prompt: SECRET }),
    hook("Stop", 1_090, { prompt_id: "p1" }, { last_assistant_message: SECRET }),
    hook("StopFailure", 1_095, { prompt_id: "p2", error: "rate_limit" }, { last_assistant_message: SECRET }),
    otel("tool_decision", 1_100, { "prompt.id": "p1", tool_use_id: "t-blocked", tool_name: "Bash", decision: "reject", source: "hook", permission_mode: "plan" }),
    otel("tool_decision", 1_110, { "prompt.id": "p1", tool_use_id: "t-refused", tool_name: "Write", decision: "reject", source: "config" }),
    otel("tool_decision", 1_120, { "prompt.id": "p1", tool_use_id: "t-ok", tool_name: "Read", decision: "accept", source: "config" }),
    otel("api_request", 1_130, { "prompt.id": "p1", request_id: "r1", model: "claude-opus-4-5", query_source: "repl_main_thread" }),
    otel("api_request", 1_140, { "prompt.id": "p1", request_id: "r2", model: "claude-haiku-4-5", query_source: "compact" }),
    otel("api_request", 1_150, { "prompt.id": "p1", request_id: "r3", model: "claude-haiku-4-5", agent_id: "ag1" }),
    otel("api_request", 1_160, { "prompt.id": "p2", request_id: "r4", model: "claude-sonnet-4-5", query_source: "repl_main_thread" }),
    otel("api_error", 1_170, { "prompt.id": "p2", request_id: "r5", model: "claude-sonnet-4-5", status_code: 429, attempt: 1, duration_ms: 300 }),
    otel("api_error", 1_180, { "prompt.id": "p2", request_id: "r5", model: "claude-sonnet-4-5", status_code: 529, attempt: 2, duration_ms: 300 }),
    otel("mcp_server_connection", 1_190, { "event.sequence": 7, status: "connected", transport_type: "http", duration_ms: 120 }),
  ];
}

const EXPECTED = [
  ["permission_request", 1_020, "Write", null, null, "FILES"],
  ["permission_denied", 1_030, "Write", null, null, "FILES"],
  ["todo_counts", 1_040, "2/1/4", 7, null, "ORCHESTRATOR"],
  ["compact_start", 1_050, "auto", null, null, "CORE"],
  ["compact_end", 1_060, "auto", null, null, "CORE"],
  ["notification", 1_070, "idle_prompt", null, null, null],
  ["permission_mode", 1_080, "plan", null, null, "CORE"],
  ["stop", 1_090, null, null, null, "CORE"],
  ["stop_failure", 1_095, "rate_limit", null, null, "CORE"],
  ["hook_block", 1_100, "Bash", null, null, null],
  ["permission_decision", 1_110, "config", null, null, "FILES"],
  ["model_change", 1_160, "claude-sonnet-4-5", null, null, "CORE"],
  ["api_error", 1_170, "claude-sonnet-4-5", 429, true, "EXTERNAL"],
  ["api_error", 1_180, "claude-sonnet-4-5", 529, false, "EXTERNAL"],
  ["mcp_connection", 1_190, "connected", 120, false, "MCP"],
];

describe("session events", () => {
  it("are one row per event, read once or twice, from hooks and OpenTelemetry", async () => {
    const r = await rig();
    await r.feed(eventful());
    await r.feed(eventful());
    expect(r.store.sessionTimeline("s1").sessionEvents.map(brief)).toEqual(EXPECTED);
  });

  it("are the same rows whatever the order of the sources, changes of mode and model aside", async () => {
    const inOrder = await rig();
    await inOrder.feed(eventful());
    const reversed = await rig();
    await reversed.feed([...eventful()].reverse());
    // Changes are told against the record before (by time): reversed, the earlier records are ignored, so no change is made up.
    const stable = (rows: SessionEventRow[]): unknown[] => rows.filter((e) => e.kind !== "permission_mode" && e.kind !== "model_change").map(brief);
    expect(stable(reversed.store.sessionTimeline("s1").sessionEvents)).toEqual(stable(inOrder.store.sessionTimeline("s1").sessionEvents));
    expect(reversed.store.sessionTimeline("s1").sessionEvents.filter((e) => e.kind === "model_change" || e.kind === "permission_mode")).toEqual([]);
  });

  it("of two different stops in a session are not merged", async () => {
    const r = await rig();
    await r.feed([hook("Stop", 10, { prompt_id: "p1" }), hook("Stop", 20, { prompt_id: "p2" }), hook("Stop", 30, {}), hook("Stop", 40, {})]);
    expect(r.store.sessionTimeline("s1").sessionEvents.map((e) => e.at)).toEqual([10, 20, 30, 40]);
  });

  it("hold no content, nor do bottleneck findings, though the project stores content", async () => {
    const r = await rig();
    await r.feed(eventful());
    r.store.close();
    const db = await openSqlite(r.path);
    // The content is stored where it belongs (the project keeps content)…
    expect(JSON.stringify(db.all("SELECT excerpt FROM prompts"))).toContain(SECRET);
    // …and nowhere in an event or a finding.
    for (const table of ["session_events", "bottlenecks"]) expect(JSON.stringify(db.all(`SELECT * FROM ${table}`)), table).not.toContain(SECRET);
    db.close();
  });
});

describe("a tool call's station through the ingest", () => {
  const pre = hook("PreToolUse", 2_000, { tool_use_id: "t1", tool_name: "Bash", target: "git", station: "GIT", station_flags: StationFlag.push });
  const result = otel("tool_result", 2_050, { tool_use_id: "t1", tool_name: "Edit", success: true, duration_ms: 40 });
  const read = hook("PostToolUse", 2_100, { tool_use_id: "t2", tool_name: "Read", target: "src/a.ts", station: "FILES", station_flags: 0, target_key: "a".repeat(32), read_offset: 10, read_limit: 50 });
  const readResult = otel("tool_result", 2_120, { tool_use_id: "t2", tool_name: "Read", success: true, duration_ms: 20 });

  it("is the hook's exact one, OpenTelemetry's estimate first or last", async () => {
    for (const order of [
      [pre, result, read, readResult],
      [readResult, result, read, pre],
    ]) {
      const r = await rig();
      await r.feed(order);
      expect(r.store.sessionTimeline("s1").toolCalls.map((c) => [c.toolUseId, c.station, c.stationFlags, c.targetKey, c.readOffset, c.readLimit])).toEqual([
        ["t1", "GIT", StationFlag.push, null, null, null],
        ["t2", "FILES", 0, "a".repeat(32), 10, 50],
      ]);
    }
  });

  it("is OpenTelemetry's estimate for a call no hook told, and none for a shell call it cannot place", async () => {
    const r = await rig();
    await r.feed([readResult, otel("tool_result", 3_000, { tool_use_id: "t3", tool_name: "Bash", success: true })]);
    const calls = r.store.sessionTimeline("s1").toolCalls;
    expect(calls.find((c) => c.toolUseId === "t2")).toMatchObject({ station: "FILES", stationFlags: StationFlag.estimated });
    // Read back with the estimate its tool suggests, as an older row would be.
    expect(calls.find((c) => c.toolUseId === "t3")).toMatchObject({ station: "SANDBOX", stationFlags: StationFlag.estimated });
  });
});
