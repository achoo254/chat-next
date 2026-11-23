// Batched writes and the reads: a batch is one transaction (all or none),
// rows read back as written, and a second write of the same event merges
// into one row whatever order the two arrive in.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { ObservatoryStoreError } from "../../src/observatory/store/store-errors.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { openTempStore, sessionOps } from "./store-fixture.ts";

const T = Date.UTC(2026, 10, 21, 3, 0, 0);
let store: ObservatoryStore;

beforeEach(async () => {
  store = await openTempStore();
});
afterEach(() => store.close());

/** Writes each op in its own batch, in the order given. */
const writeEach = (ops: readonly WriteOp[]) => {
  for (const op of ops) store.write([op]);
};

describe("ObservatoryStore writes and reads", () => {
  it("writes a batch and reads a session's timeline back in time order", () => {
    store.write(sessionOps("s1", T));
    const t = store.sessionTimeline("s1");
    expect(t.session).toEqual({
      sessionId: "s1",
      previousSessionId: null,
      previousSessionInferred: null,
      projectKey: "github.com/acme/app",
      cwd: "~/work/app",
      source: "terminal",
      internalLabel: null,
      startedAt: T,
      endedAt: null,
      mainModel: "claude-opus",
    });
    expect(t.prompts).toEqual([{ promptId: "s1-p1", sessionId: "s1", at: T + 1, length: 42, excerpt: "fix the build", projectKey: null }]);
    expect(t.toolCalls.map((c) => [c.toolUseId, c.success, c.error])).toEqual([
      ["s1-t1", true, null],
      ["s1-t2", false, "ENOENT"],
    ]);
    expect(t.subagents[0]).toMatchObject({ agentId: "s1-a1", agentType: "Explore", model: "claude-haiku", totalTokens: 900, endedAt: null });
    expect(t.apiRequests[0]).toMatchObject({ dedupeKey: "s1-r1", costUsd: 0.25, cacheWrite5mTokens: 40, cacheWrite1hTokens: 5, ttftMs: 300 });
    expect(t.instructionsLoaded).toEqual([{ sessionId: "s1", seq: 0, at: T + 6, filePath: "~/work/app/CLAUDE.md", memoryType: "Project", loadReason: "session_start" }]);
    expect(t.gitOps).toEqual([{ sessionId: "s1", promptId: "s1-p1", at: T + 7, sha: "abc1234", branch: "main", kind: "commit" }]);
  });

  it("returns an empty timeline for an unknown session, and events of a session not stored yet", () => {
    expect(store.sessionTimeline("nope")).toMatchObject({ session: null, prompts: [], toolCalls: [] });
    store.write([{ kind: "prompt", row: { promptId: "p", sessionId: "later", at: T } }]);
    expect(store.sessionTimeline("later")).toMatchObject({ session: null, prompts: [{ promptId: "p" }] });
  });

  it("merges a tool call's Pre and Post into one row, the same in either order", () => {
    const pre = (id: string): WriteOp => ({ kind: "toolCall", row: { toolUseId: id, sessionId: "s", at: T, toolName: "Edit" } });
    const post = (id: string): WriteOp => ({ kind: "toolCall", row: { toolUseId: id, sessionId: "s", at: T + 50, durationMs: 50, success: true } });
    writeEach([pre("x"), post("x")]);
    writeEach([post("y"), pre("y")]);
    const [x, y] = store.sessionTimeline("s").toolCalls;
    expect(x).toMatchObject({ toolUseId: "x", at: T, toolName: "Edit", durationMs: 50, success: true });
    expect({ ...y, toolUseId: "x" }).toEqual(x);
  });

  it("merges a session's start and end the same in either order: earliest start, latest end, first source", () => {
    const start = (id: string): WriteOp => ({ kind: "session", row: { sessionId: id, source: "terminal", startedAt: T, projectKey: "p", cwd: "~/w" } });
    // An end event knows only when it ended; the ingest puts that time as the start too.
    const end = (id: string): WriteOp => ({ kind: "session", row: { sessionId: id, source: "terminal", startedAt: T + 5000, endedAt: T + 5000 } });
    writeEach([start("a"), end("a")]);
    writeEach([end("b"), start("b")]);
    const a = store.sessionTimeline("a").session;
    expect(a).toMatchObject({ startedAt: T, endedAt: T + 5000, source: "terminal", projectKey: "p", cwd: "~/w" });
    expect({ ...store.sessionTimeline("b").session, sessionId: "a" }).toEqual(a);
  });

  it("keeps the first source, the latest end and the first session of an event", () => {
    store.write([{ kind: "session", row: { sessionId: "s", source: "sdk", startedAt: T, endedAt: T + 10 } }]);
    store.write([{ kind: "session", row: { sessionId: "s", source: "cli", startedAt: T + 1, endedAt: T + 5 } }]);
    expect(store.sessionTimeline("s").session).toMatchObject({ source: "sdk", startedAt: T, endedAt: T + 10 });
    store.write([{ kind: "prompt", row: { promptId: "p", sessionId: "s", at: T } }]);
    store.write([{ kind: "prompt", row: { promptId: "p", sessionId: "other", at: T, length: 3 } }]);
    expect(store.sessionTimeline("s").prompts).toEqual([{ promptId: "p", sessionId: "s", at: T, length: 3, excerpt: null, projectKey: null }]);
  });

  it("merges other columns by filling in: a later value wins, a missing one keeps the stored", () => {
    store.write([
      { kind: "subagent", row: { agentId: "ag", sessionId: "s", startedAt: T, agentType: "Plan" } },
      { kind: "apiRequest", row: { dedupeKey: "rq", sessionId: "s", at: T, inputTokens: 5 } },
    ]);
    store.write([
      { kind: "subagent", row: { agentId: "ag", sessionId: "s", startedAt: T, endedAt: T + 9, model: "m", totalTokens: 77 } },
      { kind: "apiRequest", row: { dedupeKey: "rq", sessionId: "s", at: T, costUsd: 0.5 } },
      { kind: "apiRequest", row: { dedupeKey: "rq", sessionId: "s", at: T, costUsd: 0.5 } },
    ]);
    const t = store.sessionTimeline("s");
    expect(t.subagents).toEqual([{ sessionId: "s", agentId: "ag", promptId: null, agentType: "Plan", startedAt: T, endedAt: T + 9, model: "m", totalTokens: 77, toolCount: null }]);
    expect(t.apiRequests).toHaveLength(1);
    expect(t.apiRequests[0]).toMatchObject({ inputTokens: 5, costUsd: 0.5 });
  });

  it("keys a subagent by its session: the same agent id in two sessions is two rows", () => {
    store.write([
      { kind: "subagent", row: { agentId: "a1", sessionId: "s1", startedAt: T, model: "m1" } },
      { kind: "subagent", row: { agentId: "a1", sessionId: "s2", startedAt: T, model: "m2" } },
    ]);
    expect(store.sessionTimeline("s1").subagents.map((a) => a.model)).toEqual(["m1"]);
    expect(store.sessionTimeline("s2").subagents.map((a) => a.model)).toEqual(["m2"]);
  });

  it("keeps one copy of an instruction load and of a git operation written twice", () => {
    const load = (seq: number): WriteOp => ({ kind: "instructionLoaded", row: { sessionId: "s", seq, at: T + seq, filePath: "~/CLAUDE.md", loadReason: "session_start" } });
    const commit = (at: number): WriteOp => ({ kind: "gitOp", row: { sessionId: "s", at, sha: "abc", kind: "commit" } });
    const checkout: WriteOp = { kind: "gitOp", row: { sessionId: "s", at: T + 1, kind: "checkout" } };
    store.write([load(0), load(0), load(1), commit(T), commit(T), checkout]);
    // A batch read again after a crash.
    store.write([load(0), load(1), commit(T + 99), checkout]);
    const t = store.sessionTimeline("s");
    expect(t.instructionsLoaded.map((l) => l.seq)).toEqual([0, 1]);
    expect(t.gitOps.map((g) => [g.kind, g.sha, g.at])).toEqual([
      ["commit", "abc", T],
      ["checkout", null, T + 1],
    ]);
  });

  it("stores an inferred link to the previous session, which never replaces a certain one, in either order", () => {
    const link = (id: string, previous: string, inferred: boolean): WriteOp => ({
      kind: "session",
      row: { sessionId: id, source: "sdk", startedAt: T, previousSessionId: previous, previousSessionInferred: inferred },
    });
    store.write([link("b", "a", true)]);
    expect(store.sessionTimeline("b").session).toMatchObject({ previousSessionId: "a", previousSessionInferred: true });
    // Certain after inferred: the certain link wins.
    store.write([link("b", "x", false)]);
    expect(store.sessionTimeline("b").session).toMatchObject({ previousSessionId: "x", previousSessionInferred: false });
    // Inferred after certain: ignored.
    store.write([link("b", "y", true)]);
    expect(store.sessionTimeline("b").session).toMatchObject({ previousSessionId: "x", previousSessionInferred: false });
    // A write without a link keeps it.
    store.write([{ kind: "session", row: { sessionId: "b", source: "sdk", startedAt: T, endedAt: T + 1 } }]);
    expect(store.sessionTimeline("b").session).toMatchObject({ previousSessionId: "x", previousSessionInferred: false, endedAt: T + 1 });
  });

  it("keeps a commit and a push of the same sha in a session as two rows", () => {
    const op = (kind: string, at: number): WriteOp => ({ kind: "gitOp", row: { sessionId: "s", at, sha: "abc", kind } });
    const noSha = (kind: string): WriteOp => ({ kind: "gitOp", row: { sessionId: "s", promptId: "p", at: T + 9, kind } });
    store.write([op("commit", T), op("push", T + 5), op("push", T + 6), noSha("checkout"), noSha("stash"), noSha("stash")]);
    expect(store.sessionTimeline("s").gitOps.map((g) => [g.kind, g.sha])).toEqual([
      ["commit", "abc"],
      ["push", "abc"],
      ["checkout", null],
      ["stash", null],
    ]);
  });

  it("lists sessions in a time range, newest first, within the limit", () => {
    for (let i = 0; i < 5; i++) store.write([{ kind: "session", row: { sessionId: `s${i}`, source: "cli", startedAt: T + i } }]);
    expect(store.sessions({ from: T + 1, to: T + 4 }).map((s) => s.sessionId)).toEqual(["s3", "s2", "s1"]);
    expect(store.sessions({ limit: 2 }).map((s) => s.sessionId)).toEqual(["s4", "s3"]);
  });

  it("rolls the whole batch back when one write fails, and keeps working", () => {
    const bad = { kind: "prompt", row: { promptId: "bad", sessionId: "s", at: 1.5 } } as const satisfies WriteOp;
    expect(() => store.write([...sessionOps("s", T), bad])).toThrow(ObservatoryStoreError);
    expect(store.sessionTimeline("s")).toMatchObject({ session: null, prompts: [], toolCalls: [] });
    store.write(sessionOps("s", T));
    expect(store.sessionTimeline("s").prompts).toHaveLength(1);
  });

  it("refuses a write without a required value, or a value the schema refuses", () => {
    // Malformed ops from outside the type system: the codec and the schema's CHECK are the guards.
    const noSession = { kind: "prompt", row: { promptId: "p", at: T } } as unknown as WriteOp;
    const badSource = { kind: "session", row: { sessionId: "x", source: "web", startedAt: T } } as unknown as WriteOp;
    expect(() => store.write([noSession])).toThrow(ObservatoryStoreError);
    expect(() => store.write([badSource])).toThrow();
    expect(store.sessions()).toEqual([]);
  });

  it("keeps per-project content settings", () => {
    expect(store.contentSetting("github.com/acme/app")).toBeUndefined();
    store.write([{ kind: "contentSetting", row: { projectKey: "github.com/acme/app", storeContent: false, updatedAt: T } }]);
    store.write([{ kind: "contentSetting", row: { projectKey: "github.com/acme/app", storeContent: true, updatedAt: T + 1 } }]);
    expect(store.contentSetting("github.com/acme/app")).toEqual({ projectKey: "github.com/acme/app", storeContent: true, updatedAt: T + 1 });
  });

  it("drops content written for a project that has it switched off, whatever the order of the writes", () => {
    store.write(sessionOps("a", T));
    store.write([{ kind: "contentSetting", row: { projectKey: "github.com/acme/app", storeContent: false, updatedAt: T } }]);
    store.clearContent("github.com/acme/app");
    // Late writes of the same events, still carrying content (queued before the switch, or a second source).
    store.write([
      { kind: "toolCall", row: { toolUseId: "a-t1", sessionId: "a", at: T + 2, content: "secret diff", durationMs: 7 } },
      { kind: "prompt", row: { promptId: "a-p1", sessionId: "a", at: T + 1, excerpt: "secret prompt" } },
      { kind: "prompt", row: { promptId: "a-p1", sessionId: "a", at: T + 1, excerpt: "secret prompt" } },
    ]);
    const t = store.sessionTimeline("a");
    expect(t.toolCalls[0]).toMatchObject({ content: null, durationMs: 7 });
    expect(t.prompts).toEqual([{ promptId: "a-p1", sessionId: "a", at: T + 1, length: 42, excerpt: null, projectKey: null }]);

    // Switched on again: content is stored.
    store.write([{ kind: "contentSetting", row: { projectKey: "github.com/acme/app", storeContent: true, updatedAt: T + 1 } }]);
    store.write([{ kind: "toolCall", row: { toolUseId: "a-t1", sessionId: "a", at: T + 2, content: "new diff" } }]);
    expect(store.sessionTimeline("a").toolCalls[0]?.content).toBe("new diff");
  });

  it("clears the stored content of one project and nothing else", () => {
    store.write([...sessionOps("a", T), ...sessionOps("b", T, "github.com/acme/other")]);
    store.write([{ kind: "toolCall", row: { toolUseId: "a-t1", sessionId: "a", at: T, content: "secret diff" } }]);
    store.write([{ kind: "toolCall", row: { toolUseId: "b-t1", sessionId: "b", at: T, content: "kept" } }]);
    expect(store.clearContent("github.com/acme/app")).toEqual({ prompts: 1, toolCalls: 1 });
    const a = store.sessionTimeline("a");
    expect(a.prompts[0]).toMatchObject({ excerpt: null, length: 42 });
    expect(a.toolCalls.map((c) => c.content)).toEqual([null, null]);
    expect(a.toolCalls[0]).toMatchObject({ toolName: "Bash", durationMs: 120 });
    const b = store.sessionTimeline("b");
    expect(b.prompts[0]?.excerpt).toBe("fix the build");
    expect(b.toolCalls[0]?.content).toBe("kept");
    expect(store.clearContent("github.com/acme/app")).toEqual({ prompts: 0, toolCalls: 0 });
  });
});
