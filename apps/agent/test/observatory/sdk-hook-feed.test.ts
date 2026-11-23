// The hook callbacks of the SDK sessions the agent runs, on their way to the
// store: a callback only queues and returns, so an ingest that is slow (or
// never answers) never holds a session; the queue is bounded; both privacy
// passes run at once; every record of an Advisor session carries its label,
// so the session stays out of the daily totals even when a wipe comes in the
// middle of it. And a project switched off while the store was closed has
// its stored content removed at the next start.
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { FilteredHookRecord, FilteredRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { SDK_FEED_MAX_QUEUED, SdkHookFeed } from "../../src/observatory/sdk-hook-feed.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const HOME = process.platform === "win32" ? "C:\\Users\\example-person" : process.platform === "darwin" ? "/Users/example-person" : "/home/example-person";
const CWD = join(HOME, "work", "app");
const PROJECT = "github.com/example/app";
const DAY = 24 * 60 * 60 * 1000;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function feed(accept: (r: FilteredHookRecord) => Promise<void>, over: Partial<ConstructorParameters<typeof SdkHookFeed>[0]> = {}): SdkHookFeed {
  return new SdkHookFeed({
    accept,
    home: HOME,
    isSensitive: (p) => p.includes(".env"),
    repoKey: () => PROJECT,
    contentAllowed: () => true,
    known: () => ["example-machine-secret-value"],
    enabled: () => true,
    problems: () => undefined,
    ...over,
  });
}

describe("the SDK sessions' hook callbacks", () => {
  it("return before an ingest that never answers, which runs later, off the callback's path", async () => {
    let accepted = 0;
    const f = feed(() => {
      accepted++;
      return new Promise<void>(() => undefined);
    });
    const started = performance.now();
    for (let i = 0; i < 200; i++) f.take("PostToolUse", { session_id: "s", cwd: CWD, tool_name: "Read", tool_use_id: `t${i}`, tool_input: { file_path: join(CWD, "a.ts") } });
    expect(performance.now() - started).toBeLessThan(50);
    expect(accepted).toBe(0);
    await turn();
    expect(accepted).toBe(200);
    expect(f.stats).toMatchObject({ taken: 200, fed: 200, dropped: 0 });
  });

  it("drops past the queue's bound and counts it, and takes nothing while Observatory is off", async () => {
    const got: FilteredHookRecord[] = [];
    const f = feed(async (r) => void got.push(r));
    for (let i = 0; i < SDK_FEED_MAX_QUEUED + 5; i++) f.take("Stop", { session_id: "s", cwd: CWD });
    expect(f.stats.dropped).toBe(5);
    await turn();
    expect(got).toHaveLength(SDK_FEED_MAX_QUEUED);
    const off = feed(async (r) => void got.push(r), { enabled: () => false });
    off.take("Stop", { session_id: "s" });
    await turn();
    expect(off.stats.taken).toBe(0);
    expect(got).toHaveLength(SDK_FEED_MAX_QUEUED);
  });

  it("filters with both passes, keeps the project, and labels every record of an internal session", async () => {
    const got: FilteredHookRecord[] = [];
    const f = feed(async (r) => void got.push(r));
    f.take("UserPromptSubmit", { session_id: "s", prompt_id: "p", cwd: CWD, prompt: `${"x".repeat(3_000)} example-machine-secret-value`, transcript_path: join(HOME, "t.jsonl") }, "advisor");
    f.take("PostToolUse", { session_id: "s", cwd: CWD, tool_name: "Read", tool_use_id: "t", tool_input: { file_path: join(CWD, ".env") }, tool_response: "SECRET=1" }, "advisor");
    f.take("MessageDisplay", { session_id: "s", delta: "text" });
    await turn();
    expect(got).toHaveLength(2);
    for (const r of got) {
      expect(r.f.internal_label).toBe("advisor");
      expect(r.f.project_key).toBe(PROJECT);
      expect(String(r.f.cwd).replaceAll("\\", "/")).toBe("~/work/app");
      expect(r.truncated).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("example-person");
      expect(JSON.stringify(r)).not.toContain("transcript");
    }
    expect((got[0]?.c?.prompt ?? "").length).toBeLessThanOrEqual(2_049);
    expect(JSON.stringify(got[0])).not.toContain("example-machine");
    // A secret file's content is never kept.
    expect(got[1]?.c).toBeUndefined();
    expect(f.stats.ignored).toBe(1);
  });
});

async function runningService(dir: string, now: () => number): Promise<{ s: ObservatoryService; config: ConfigStore; db: string }> {
  const config = new ConfigStore(join(dir, "config"));
  const port = await pickFreePort();
  config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_398 }));
  const data = join(dir, "data");
  const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] }, now });
  await s.start();
  stops.push(() => s.stop());
  return { s, config, db: join(data, "observatory.db") };
}

async function readStore<T>(path: string, read: (store: ObservatoryStore) => T): Promise<T> {
  const store = await ObservatoryStore.open({ path });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

const apiRequest = (session: string, at: number, cost: number): FilteredRecord => ({
  v: 1,
  src: "otel",
  event: "api_request",
  at,
  f: { "session.id": session, request_id: `req-${session}-${at}`, model: "claude-opus-4-5", cost_usd: cost, input_tokens: 10 },
});

describe("an Advisor session through the service", () => {
  it("stays out of the daily totals after pruning, even with a wipe in the middle of it", async () => {
    const T = Date.UTC(2026, 0, 10, 12);
    let clock = T;
    const { s, db } = await runningService(obsTempDir("sdk-advisor"), () => clock);
    const events = (session: string, label: string | undefined, tool: string): void => {
      s.takeHookEvent("SessionStart", { session_id: session, cwd: CWD, source: "startup", model: "claude-opus-4-5" }, label);
      s.takeHookEvent("PostToolUse", { session_id: session, cwd: CWD, tool_name: "Read", tool_use_id: tool, tool_input: { file_path: join(CWD, "a.ts") }, duration_ms: 5 }, label);
    };
    events("sess-advisor", "advisor", "t1");
    events("sess-work", undefined, "t2");
    await turn();
    await s.accept(apiRequest("sess-advisor", T, 1.25), "otlp");
    await s.accept(apiRequest("sess-work", T, 0.5), "otlp");
    // The wipe in the middle: the Advisor session goes on, its row written again from its next record.
    await s.wipe();
    clock = T + 60_000;
    s.takeHookEvent("PostToolUse", { session_id: "sess-advisor", cwd: CWD, tool_name: "Grep", tool_use_id: "t3", tool_input: { pattern: "x" }, duration_ms: 7 }, "advisor");
    s.takeHookEvent("PostToolUse", { session_id: "sess-work", cwd: CWD, tool_name: "Grep", tool_use_id: "t4", tool_input: { pattern: "x" }, duration_ms: 7 });
    await turn();
    await s.accept(apiRequest("sess-advisor", T + 60_000, 2), "otlp");
    await s.accept(apiRequest("sess-work", T + 60_000, 0.75), "otlp");
    await s.stop();
    const before = await readStore(db, (store) => store.sessionTimeline("sess-advisor").session?.internalLabel);
    expect(before).toBe("advisor");
    const days = await readStore(db, (store) => {
      store.prune(T + 100 * DAY, 500, "UTC");
      return store.dailyRollups();
    });
    expect(days.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(0.75, 10);
    expect(days.reduce((sum, r) => sum + r.sessions, 0)).toBe(1);
    expect(days.reduce((sum, r) => sum + r.apiRequests, 0)).toBe(1);
  });
});

describe("content switched off while the store was closed", () => {
  it("is removed from the store at the next start", async () => {
    const dir = obsTempDir("sdk-offline-off");
    const { s, db } = await runningService(dir, Date.now);
    const record: FilteredHookRecord = {
      v: 1,
      src: "hook",
      event: "UserPromptSubmit",
      at: Date.now(),
      f: { session_id: "sess-c", prompt_id: "p1", cwd: "~/work/app", project_key: PROJECT },
      c: { prompt: "kept-while-on" },
    };
    const start: FilteredHookRecord = { v: 1, src: "hook", event: "SessionStart", at: record.at, f: { session_id: "sess-c", cwd: "~/work/app", project_key: PROJECT, source: "startup" } };
    await s.accept(start, "sdk");
    await s.accept(record, "sdk");
    await s.stop();
    expect(await readStore(db, (store) => store.sessionTimeline("sess-c").prompts.map((p) => p.excerpt))).toEqual(["kept-while-on"]);
    // Switched off with the store closed: the config and state.json follow, the store cannot.
    await s.setProjectContent(PROJECT, false);
    expect(await readStore(db, (store) => store.sessionTimeline("sess-c").prompts.map((p) => p.excerpt))).toEqual(["kept-while-on"]);
    await s.start();
    expect(s.status().store).toBe("open");
    await s.stop();
    expect(await readStore(db, (store) => store.sessionTimeline("sess-c").prompts.map((p) => p.excerpt))).toEqual([null]);
    expect(await readStore(db, (store) => store.contentSetting(PROJECT)?.storeContent)).toBe(false);
  });
});
