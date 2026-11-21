// Retention: detail rows older than 90 days are counted into daily_rollups
// and deleted, a bounded number per pass; the totals survive, newer rows,
// sessions with newer rows and the content settings stay; internal sessions
// are deleted without being counted.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { RETENTION_DAYS } from "../../src/observatory/store/retention.ts";
import { ObservatoryStoreError } from "../../src/observatory/store/store-errors.ts";
import { DAY, openTempStore, sessionOps } from "./store-fixture.ts";

const NOW = Date.UTC(2026, 10, 21, 12);
const OLD = NOW - 100 * DAY;
const RECENT = NOW - 10 * DAY;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
let store: ObservatoryStore;

beforeEach(async () => {
  store = await openTempStore();
});
afterEach(() => store.close());

const prune = (limit?: number) => store.prune(NOW, limit, "UTC");

const zeros = {
  sessions: 0,
  prompts: 0,
  toolCalls: 0,
  toolFailures: 0,
  subagents: 0,
  apiRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 0,
  gitOps: 0,
};

describe("ObservatoryStore.prune", () => {
  it("rolls rows older than 90 days into daily totals, deletes them, and keeps newer ones", () => {
    store.write([...sessionOps("old", OLD), ...sessionOps("new", RECENT)]);
    store.write([{ kind: "contentSetting", row: { projectKey: "github.com/acme/app", storeContent: false, updatedAt: OLD } }]);

    const result = prune();
    expect(result.more).toBe(false);
    expect(result.deleted).toEqual({ prompts: 1, tool_calls: 2, subagents: 1, api_requests: 1, git_ops: 1, instructions_loaded: 1, sessions: 1 });

    expect(store.sessionTimeline("old")).toMatchObject({ session: null, prompts: [], toolCalls: [], subagents: [], apiRequests: [], instructionsLoaded: [], gitOps: [] });
    expect(store.sessionTimeline("new").toolCalls).toHaveLength(2);
    expect(store.contentSetting("github.com/acme/app")?.storeContent).toBe(false);

    const day = utcDay(OLD);
    const project = "github.com/acme/app";
    expect(store.dailyRollups()).toEqual([
      { ...zeros, day, projectKey: project, model: "", prompts: 1, toolCalls: 2, toolFailures: 1, gitOps: 1 },
      { ...zeros, day, projectKey: project, model: "claude-haiku", subagents: 1 },
      {
        ...zeros,
        day,
        projectKey: project,
        model: "claude-opus",
        sessions: 1,
        apiRequests: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWrite5mTokens: 40,
        cacheWrite1hTokens: 5,
        costUsd: 0.25,
      },
    ]);
  });

  it("keeps a session that started long ago but ended within 90 days", () => {
    store.write([{ kind: "session", row: { sessionId: "long", source: "terminal", startedAt: OLD, endedAt: RECENT } }]);
    prune();
    expect(store.sessionTimeline("long").session).not.toBeNull();
  });

  it("keeps an expired session while it has newer rows (resumed, or its SessionEnd never came), with its project", () => {
    // `claude --resume` keeps the id: the first run ended 95 days ago, the resumed one wrote yesterday and never ended.
    store.write([{ kind: "session", row: { sessionId: "res", source: "cli", startedAt: OLD, endedAt: NOW - 95 * DAY, projectKey: "github.com/acme/app" } }]);
    store.write([{ kind: "prompt", row: { promptId: "old-p", sessionId: "res", at: OLD + 1 } }]);
    store.write([{ kind: "toolCall", row: { toolUseId: "new-t", sessionId: "res", at: NOW - DAY } }]);
    // An agent stopped halfway: no SessionEnd, the start is old, a subagent ran recently.
    store.write([{ kind: "session", row: { sessionId: "cut", source: "sdk", startedAt: OLD } }]);
    store.write([{ kind: "subagent", row: { agentId: "ag", sessionId: "cut", startedAt: NOW - 2 * DAY } }]);

    expect(prune().deleted).toMatchObject({ prompts: 1, tool_calls: 0, subagents: 0, sessions: 0 });
    expect(store.sessionTimeline("res").session).not.toBeNull();
    expect(store.sessionTimeline("cut").session).not.toBeNull();
    expect(store.dailyRollups().map((r) => [r.projectKey, r.prompts])).toEqual([["github.com/acme/app", 1]]);

    // Once its newest row expires, the session goes with it.
    expect(store.prune(NOW + 100 * DAY, undefined, "UTC").deleted).toMatchObject({ tool_calls: 1, subagents: 1, sessions: 2 });
    expect(store.sessions()).toEqual([]);
  });

  it("deletes an internal session's rows after 90 days without counting them", () => {
    store.write(sessionOps("adv", OLD));
    store.write([{ kind: "session", row: { sessionId: "adv", source: "sdk", startedAt: OLD, internalLabel: "advisor" } }]);
    store.write([{ kind: "apiRequest", row: { dedupeKey: "adv-r2", sessionId: "adv", at: OLD, model: "claude-opus", costUsd: 3 } }]);
    const result = prune();
    expect(result.deleted).toMatchObject({ sessions: 1, api_requests: 2, prompts: 1 });
    expect(store.sessionTimeline("adv").session).toBeNull();
    expect(store.dailyRollups()).toEqual([]);
  });

  it("expires exactly at 90 days", () => {
    const edge = NOW - RETENTION_DAYS * DAY;
    store.write([
      { kind: "prompt", row: { promptId: "at-edge", sessionId: "s", at: edge } },
      { kind: "prompt", row: { promptId: "before-edge", sessionId: "s", at: edge - 1 } },
    ]);
    prune();
    expect(store.sessionTimeline("s").prompts.map((p) => p.promptId)).toEqual(["at-edge"]);
  });

  it("handles at most `limit` rows of a table per pass, a session once its rows are gone, and counts each row once", () => {
    const ops = sessionOps("big", OLD).slice(0, 1);
    for (let i = 0; i < 7; i++) ops.push({ kind: "prompt", row: { promptId: `p${i}`, sessionId: "big", at: OLD + i } });
    store.write(ops);

    const passes = [prune(3), prune(3), prune(3)];
    expect(passes.map((p) => [p.deleted.prompts, p.deleted.sessions, p.more])).toEqual([
      [3, 0, true],
      [3, 0, true],
      [1, 1, false],
    ]);
    expect(prune(3)).toMatchObject({ more: false, deleted: { prompts: 0, sessions: 0 } });

    const totals = store.dailyRollups();
    expect(totals.reduce((n, r) => n + r.prompts, 0)).toBe(7);
    expect(totals.reduce((n, r) => n + r.sessions, 0)).toBe(1);
    expect(totals.every((r) => r.projectKey === "github.com/acme/app")).toBe(true);
  });

  it("refuses a limit that is not a positive integer, and an unknown time zone", () => {
    store.write(sessionOps("s", OLD));
    for (const limit of [0, -1, 2.5, Number.NaN]) expect(() => prune(limit), String(limit)).toThrow(ObservatoryStoreError);
    expect(() => store.prune(NOW, 10, "Mars/Olympus")).toThrow(ObservatoryStoreError);
    // Nothing was deleted by the refused passes.
    expect(store.sessionTimeline("s").prompts).toHaveLength(1);
  });

  it("counts a row on its day in the time zone given", () => {
    // 2026-08-12 20:00 UTC is already 2026-08-13 in Saigon (UTC+7).
    const at = Date.UTC(2026, 7, 12, 20);
    store.write([{ kind: "prompt", row: { promptId: "p", sessionId: "s", at } }]);
    store.prune(NOW, undefined, "Asia/Saigon");
    expect(store.dailyRollups().map((r) => r.day)).toEqual(["2026-08-13"]);
  });

  it("adds to the totals of a day already rolled up", () => {
    store.write(sessionOps("a", OLD));
    prune();
    store.write(sessionOps("b", OLD + 1000));
    prune();
    const opus = store.dailyRollups().find((r) => r.model === "claude-opus");
    expect(opus).toMatchObject({ sessions: 2, apiRequests: 2, costUsd: 0.5 });
  });

  it("filters daily totals by day", () => {
    store.write([...sessionOps("a", OLD), ...sessionOps("b", OLD - 5 * DAY)]);
    prune();
    const day = utcDay(OLD);
    expect(new Set(store.dailyRollups({ fromDay: day, toDay: day }).map((r) => r.day))).toEqual(new Set([day]));
    expect(new Set(store.dailyRollups().map((r) => r.day)).size).toBe(2);
  });
});
