// What devices see of a session while it runs: a turn running elsewhere on
// the machine (a terminal, an IDE) shows as busy elsewhere and clears once
// the session goes quiet; a turn the machine runs reports what it does (its
// phase, its start, its output tokens) at most once a second, and nothing
// once it ended. Made-up transcripts stand in for what claude writes.
import { randomUUID } from "node:crypto";
import { utimesSync } from "node:fs";
import { ActivityPhase, ThreadState, TurnState, type ThreadActivity, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import { ACTIVITY_MS } from "../src/core/agent-core.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { LocalSessions, REQUEST_BUSY_MS, TOOL_BUSY_MS } from "../src/providers/claude/local-sessions.ts";
import { ClaudeProcesses } from "../src/providers/claude/running-claude.ts";
import type { AgentProvider, ProviderEvent } from "../src/providers/types.ts";
import { Channel } from "../src/util/channel.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { Transcript } from "./support/claude-transcript.ts";

const none = { sensitive: false, projectSettings: false };
const HOUR = 3_600_000;

function setTime(file: string, at: number): void {
  const t = new Date(at);
  utimesSync(file, t, t);
}

const cores: AgentCore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

function claude(sessionId?: string) {
  const claudeHome = tempDir("claude-home-");
  const sdk = fakeQuery(undefined, sessionId ? { sessionId } : {});
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude", homes: () => [claudeHome] });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  return { sdk, provider, claudeHome };
}

/** A session typed in a terminal an hour ago: one question, one answer. */
function terminalSession(dir: string, claudeHome: string) {
  const t = new Transcript(randomUUID(), dir, "cli").opening();
  t.user("Build it");
  t.assistant([{ type: "text", text: "On it." }]);
  setTime(t.write(claudeHome), Date.now() - HOUR);
  return t;
}

const summaryOf = (core: AgentCore, id: string): ThreadSummary | undefined => core.list().find((s) => s.id === id);

describe("the AI's liveness of a session (Claude transcripts and processes)", () => {
  const NOW = Date.parse("2026-11-11T08:00:00.000Z");

  function session(tool: "open" | "done") {
    const home = tempDir("claude-home-");
    const t = new Transcript(randomUUID(), "/w/x").opening();
    t.user("run the build");
    t.assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make" } }]);
    if (tool === "done") t.toolResult("toolu_1", "ok");
    return { home, t, file: t.write(home) };
  }

  const probe = (held: string | undefined) =>
    new ClaudeProcesses({
      platform: "darwin",
      now: () => NOW,
      selfPid: 1,
      exec: async (cmd) => (cmd === "ps" ? (held ? `  42  77  09:00 claude claude --resume ${held}\n` : "") : "p42\nfcwd\nn/w/x\n"),
    });

  test("written in the last minute: busy, with the tool still waiting for its result", async () => {
    const { home, t, file } = session("open");
    setTime(file, NOW - 10_000);
    const live = await new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(undefined) }).liveness(t.sessionId);
    expect(live).toEqual({ state: "busy", since: NOW - 10_000, tool: "Bash", via: "transcript" });
  });

  test("a finished tool is not reported; nothing on record is unknown", async () => {
    const { home, t, file } = session("done");
    setTime(file, NOW - 10_000);
    const sessions = new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(undefined) });
    expect(await sessions.liveness(t.sessionId)).toEqual({ state: "busy", since: NOW - 10_000, via: "transcript" });
    expect(await sessions.liveness(randomUUID())).toEqual({ state: "unknown", via: "transcript" });
  });

  test("quiet for minutes: busy while a running claude holds the session and its tool runs, idle otherwise", async () => {
    const { home, t, file } = session("open");
    setTime(file, NOW - 5 * 60_000);
    expect(await new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(t.sessionId) }).liveness(t.sessionId)).toEqual({
      state: "busy",
      since: NOW - 5 * 60_000,
      tool: "Bash",
      held: true,
      via: "process",
    });
    expect((await new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(undefined) }).liveness(t.sessionId)).state).toBe("idle");
    // Past the longest a command may run without a word: idle even while held.
    setTime(file, NOW - TOOL_BUSY_MS - 1_000);
    expect((await new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(t.sessionId) }).liveness(t.sessionId)).state).toBe("idle");
  });

  test("the model asked and not answered yet: busy while a running claude holds the session, however long it thinks (to a limit)", async () => {
    const { home, t, file } = session("done");
    // The request's body records are big (one is longer than the tail read); the request record itself is last.
    t.blob(300 * 1024);
    t.apiRequest();
    t.write(home);
    setTime(file, NOW - 5 * 60_000);
    const held = new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(t.sessionId) });
    expect(await held.liveness(t.sessionId)).toEqual({ state: "busy", since: NOW - 5 * 60_000, held: true, via: "process" });
    const free = new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(undefined) });
    expect((await free.liveness(t.sessionId)).state).toBe("idle");
    setTime(file, NOW - REQUEST_BUSY_MS - 1_000);
    expect((await held.liveness(t.sessionId)).state).toBe("idle");
  });

  test("the model's answer, or a message after the request (an interruption): idle while quiet, even held", async () => {
    const answered = session("done");
    answered.t.apiRequest();
    answered.t.assistant([{ type: "text", text: "All set." }]);
    setTime(answered.t.write(answered.home), NOW - 5 * 60_000);
    expect((await new LocalSessions({ homes: () => [answered.home], now: () => NOW, processes: probe(answered.t.sessionId) }).liveness(answered.t.sessionId)).state).toBe("idle");
    const interrupted = session("done");
    interrupted.t.apiRequest();
    interrupted.t.user("[Request interrupted by user]");
    setTime(interrupted.t.write(interrupted.home), NOW - 5 * 60_000);
    expect((await new LocalSessions({ homes: () => [interrupted.home], now: () => NOW, processes: probe(interrupted.t.sessionId) }).liveness(interrupted.t.sessionId)).state).toBe("idle");
  });

  test("held open by a running claude while quiet: idle, and told as held once the processes were read", async () => {
    const { home, t, file } = session("done");
    setTime(file, NOW - 5 * 60_000);
    const sessions = new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(t.sessionId) });
    await sessions.prime();
    expect(await sessions.liveness(t.sessionId)).toEqual({ state: "idle", since: NOW - 5 * 60_000, held: true, via: "transcript" });
    const free = new LocalSessions({ homes: () => [home], now: () => NOW, processes: probe(undefined) });
    await free.prime();
    expect(await free.liveness(t.sessionId)).toEqual({ state: "idle", since: NOW - 5 * 60_000, via: "transcript" });
  });

  test("quiet for minutes with no tool running: idle without asking for the processes", async () => {
    const { home, t, file } = session("done");
    setTime(file, NOW - 5 * 60_000);
    const calls: string[] = [];
    const processes = new ClaudeProcesses({ platform: "darwin", now: () => NOW, exec: async (cmd) => (calls.push(cmd), "") });
    expect((await new LocalSessions({ homes: () => [home], now: () => NOW, processes }).liveness(t.sessionId)).state).toBe("idle");
    expect(calls).toEqual([]);
  });
});

describe("a session running elsewhere", () => {
  function setup(sessionId?: string, dataDir?: string) {
    const c = claude(sessionId);
    const m = makeCore([c.provider], dataDir ? { dataDir } : {});
    cores.push(m.core);
    return { ...c, ...m };
  }

  test("shows as busy elsewhere with its running tool while its transcript is written, and clears once it is quiet", async () => {
    const { core, claudeHome, work } = setup();
    const t = terminalSession(work, claudeHome);
    const thread = await core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)).toMatchObject({ state: ThreadState.IDLE, busyElsewhere: false, elsewhereActiveAt: 0n });

    const seen: ThreadSummary[] = [];
    core.onStatus((s) => s.id === thread.id && seen.push(s));
    // The terminal runs a command now.
    const lines = t.lines.length;
    t.user("now the tests");
    t.assistant([{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }]);
    const file = t.appendFrom(claudeHome, lines);
    // Some seconds after the thread's own last activity (opening it).
    const writtenAt = Date.now() + 10_000;
    setTime(file, writtenAt);
    await core.lookElsewhere();
    const busy = summaryOf(core, thread.id);
    expect(busy).toMatchObject({ state: ThreadState.IDLE, busyElsewhere: true, previewTool: "Bash", open: false });
    expect(Math.abs(Number(busy?.elsewhereActiveAt) - writtenAt)).toBeLessThan(1_000);
    expect(seen.at(-1)?.busyElsewhere).toBe(true);

    // The command ended and the session went quiet past the window.
    const more = t.lines.length;
    t.toolResult("toolu_9", "12 passed");
    setTime(t.appendFrom(claudeHome, more), Date.now() - 90_000);
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)).toMatchObject({ busyElsewhere: false, previewTool: "", elsewhereActiveAt: 0n });
    expect(seen.at(-1)?.busyElsewhere).toBe(false);
  });

  test("is never set while the machine runs or holds the thread's session, nor for the writes of its own session", async () => {
    const id = randomUUID();
    const { core, claudeHome, work } = setup(id);
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "slow", consent: none, device: "phone" });
    await until(core, thread.id, (items) => byCase(items, "text").length > 0);
    // claude writes the transcript of the machine's own turn as it runs.
    const t = new Transcript(id, work, "sdk-ts").opening();
    t.user("slow");
    t.assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 5" } }]);
    setTime(t.write(claudeHome), Date.now());
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)).toMatchObject({ state: ThreadState.RUNNING, busyElsewhere: false });
    await core.interrupt(thread.id);
    await until(core, thread.id, (items) => byCase(items, "turn").some((x) => x.body.value.state !== TurnState.RUNNING));
    // Open and idle on the machine: its own session, not elsewhere.
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)?.busyElsewhere).toBe(false);
    // Closed: what the closing session wrote right then is its own.
    await core.close(thread.id);
    setTime(t.write(claudeHome), Date.now());
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)?.busyElsewhere).toBe(false);
    // Later writes come from elsewhere.
    t.user("from the terminal");
    setTime(t.write(claudeHome), Date.now() + 20_000);
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)?.busyElsewhere).toBe(true);
    // A message from a device: the machine runs it, so it is no longer elsewhere at once.
    const sent = core.send(thread.id, "hello", "");
    expect(summaryOf(core, thread.id)).toMatchObject({ state: ThreadState.RUNNING, busyElsewhere: false });
    await sent;
  });

  test("is told again after the service restarts, and not once the session is quiet", async () => {
    const first = setup();
    const t = terminalSession(first.work, first.claudeHome);
    const thread = await first.core.openLocal({ provider: "claude", sessionId: t.sessionId, consent: none, openAnyway: false, device: "phone" });
    const lines = t.lines.length;
    t.assistant([{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "make" } }]);
    const file = t.appendFrom(first.claudeHome, lines);
    setTime(file, Date.now() + 20_000);
    await first.core.lookElsewhere();
    expect(summaryOf(first.core, thread.id)?.busyElsewhere).toBe(true);
    await first.core.stop();

    const again = makeCore([first.provider], { dataDir: first.dataDir });
    cores.push(again.core);
    expect(summaryOf(again.core, thread.id)?.busyElsewhere).toBe(false);
    await again.core.lookElsewhere();
    expect(summaryOf(again.core, thread.id)).toMatchObject({ busyElsewhere: true, previewTool: "Bash" });
    // Quiet past every window: nothing runs there any more.
    setTime(file, Date.now() - TOOL_BUSY_MS - 60_000);
    await again.core.lookElsewhere();
    expect(summaryOf(again.core, thread.id)?.busyElsewhere).toBe(false);
  });
});

describe("a session the machine opened in its terminal", () => {
  test("shows as busy elsewhere while the CLI writes its transcript, and while its model thinks, with the terminal still held", async () => {
    const claudeHome = tempDir("claude-home-");
    const provider = createClaudeProvider({ query: fakeQuery().fn, findBinary: async () => "claude", homes: () => [claudeHome] });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const { core, work } = makeCore([provider]);
    cores.push(core);
    // Opened with no message, then handed to the terminal: the CLI starts the session with the id the thread keeps.
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "", consent: none, device: "phone" });
    const spec = await core.terminalLaunch(thread.id);
    const sessionId = spec.args[spec.args.indexOf("--session-id") + 1] ?? "";
    expect(sessionId).not.toBe("");
    core.terminalStarted(thread.id, 1, 4242);
    expect(summaryOf(core, thread.id)).toMatchObject({ terminalSession: 1, busyElsewhere: false });
    // The CLI runs a command now, some seconds after the launch.
    const t = new Transcript(sessionId, work, "cli").opening();
    t.user("deploy it");
    t.assistant([{ type: "tool_use", id: "toolu_7", name: "Bash", input: { command: "make deploy" } }]);
    setTime(t.write(claudeHome), Date.now() + 10_000);
    await core.lookElsewhere();
    expect(summaryOf(core, thread.id)).toMatchObject({ state: ThreadState.IDLE, busyElsewhere: true, previewTool: "Bash", terminalSession: 1 });
    // The command ended minutes ago and the model thinks since, writing nothing: still a turn while the CLI holds the session.
    const lines = t.lines.length;
    t.toolResult("toolu_7", "deployed");
    t.apiRequest();
    setTime(t.appendFrom(claudeHome, lines), Date.now() - 5 * 60_000);
    const processes = new ClaudeProcesses({ platform: "darwin", selfPid: 1, exec: async (cmd) => (cmd === "ps" ? `  42  77  09:00 claude claude --session-id ${sessionId}\n` : `p42\nfcwd\nn${work}\n`) });
    expect((await new LocalSessions({ homes: () => [claudeHome], processes }).liveness(sessionId)).state).toBe("busy");
  });
});

/** An AI whose events the test pushes by hand. */
function manualProvider(): AgentProvider & { push: (e: ProviderEvent) => void } {
  let events: Channel<ProviderEvent> | undefined;
  return {
    id: "manual",
    name: "Manual AI",
    capabilities: {
      interrupt: true,
      resume: false,
      sessionAllow: false,
      questions: false,
      todo: false,
      contextUsage: false,
      compaction: false,
      diff: false,
      images: false,
      models: [],
      effortLevels: [],
      permissionModes: ["default"],
    },
    async detect() {
      return { installed: true, version: "1.0.0", loginState: "ok" };
    },
    async start() {
      const channel = new Channel<ProviderEvent>();
      events = channel;
      return {
        events: channel,
        async send() {
          // the test plays the AI
        },
        async interrupt() {
          channel.push({ type: "turn-end", state: "interrupted", durationMs: 0 });
        },
        async close() {
          channel.close();
        },
      };
    },
    push(e) {
      events?.push(e);
    },
  };
}

describe("the activity of a turn the machine runs", () => {
  async function running() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.parse("2026-11-11T08:00:00.000Z") });
    const ai = manualProvider();
    const m = makeCore([ai]);
    cores.push(m.core);
    const sent: ThreadActivity[] = [];
    m.core.onActivity((a) => sent.push(a));
    const started = Date.now();
    const thread = await m.core.create({ provider: "manual", model: "", dir: m.work, text: "go", consent: none, device: "phone" });
    const flush = () => vi.advanceTimersByTimeAsync(0);
    await flush();
    return { ...m, ai, sent, started, thread, flush };
  }

  const tokens = (a: ThreadActivity | undefined) => a?.outputTokens;

  test("starts at once, adds up output tokens of every reply, and sends at most once a second", async () => {
    const { core, ai, sent, started, thread, flush } = await running();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: thread.id, phase: ActivityPhase.THINKING, tool: "", turnStartedAt: BigInt(started) });
    // Absent, not zero, until the AI reports any.
    expect(sent[0]?.outputTokens).toBeUndefined();

    ai.push({ type: "output-tokens", messageId: "m1", tokens: 10 });
    ai.push({ type: "output-tokens", messageId: "m1", tokens: 50 });
    ai.push({ type: "output-tokens", messageId: "m1", tokens: 80 });
    await flush();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent).toHaveLength(2);
    expect(tokens(sent[1])).toBe(80n);

    // A second reply adds to the first; the writing shows as such.
    ai.push({ type: "output-tokens", messageId: "m2", tokens: 20 });
    ai.push({ type: "text-delta", blockId: "b1", role: "assistant", text: "Hi" });
    await flush();
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ phase: ActivityPhase.WRITING, turnStartedAt: BigInt(started) });
    expect(tokens(sent[2])).toBe(100n);

    // A tool, by its name; thinking again once its result is in.
    ai.push({ type: "tool-start", toolId: "x1", kind: "shell", name: "Bash", summary: "make", input: "{}" });
    await flush();
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent.at(-1)).toMatchObject({ phase: ActivityPhase.TOOL, tool: "Bash" });
    expect(core.activity(thread.id)).toMatchObject({ phase: ActivityPhase.TOOL, tool: "Bash" });
    ai.push({ type: "tool-end", toolId: "x1", ok: true, output: "done" });
    await flush();
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent.at(-1)).toMatchObject({ phase: ActivityPhase.THINKING, tool: "" });

    // Over ten seconds of many changes: never more than one a second.
    const before = sent.length;
    for (let i = 0; i < 100; i++) {
      ai.push({ type: "output-tokens", messageId: "m3", tokens: i + 1 });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sent.length - before).toBeLessThanOrEqual(11);
    expect(sent.length - before).toBeGreaterThanOrEqual(9);
    expect(tokens(sent.at(-1))).toBeGreaterThanOrEqual(100n + 95n);
  });

  test("sends nothing once the turn ended, and nothing for a thread that runs nothing", async () => {
    const { core, ai, sent, thread, flush } = await running();
    ai.push({ type: "output-tokens", messageId: "m1", tokens: 5 });
    ai.push({ type: "turn-end", state: "completed", durationMs: 10 });
    await flush();
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(10 * ACTIVITY_MS);
    expect(sent).toHaveLength(count);
    expect(core.activity(thread.id)).toBeUndefined();
    expect(summaryOf(core, thread.id)?.state).toBe(ThreadState.IDLE);
    // Late events of the ended turn change nothing.
    ai.push({ type: "output-tokens", messageId: "m9", tokens: 999 });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * ACTIVITY_MS);
    expect(sent).toHaveLength(count);
  });

  test("reports waiting while a prompt waits for the user", async () => {
    const { core, sent, thread } = await running();
    core.setOutsidePrompts(thread.id, 1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent.at(-1)?.phase).toBe(ActivityPhase.WAITING);
    core.setOutsidePrompts(thread.id, 0);
    await vi.advanceTimersByTimeAsync(ACTIVITY_MS);
    expect(sent.at(-1)?.phase).toBe(ActivityPhase.THINKING);
  });
});

describe("output tokens from the Claude adapter's stream", () => {
  test("message_start and message_delta usage become the reply's count as it grows", async () => {
    const { MessageMapper } = await import("../src/providers/claude/message-mapper.ts");
    const events: ProviderEvent[] = [];
    const mapper = new MessageMapper("/w", (e) => events.push(e));
    const stream = (event: unknown, parent: string | null = null) => mapper.map({ type: "stream_event", parent_tool_use_id: parent, event } as never);
    stream({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 1 } } });
    stream({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 42 } });
    // A subagent's reply counts on its own.
    stream({ type: "message_start", message: { id: "msg_s", usage: { output_tokens: 2 } } }, "toolu_task");
    stream({ type: "message_delta", delta: {}, usage: { output_tokens: 7 } }, "toolu_task");
    // A stream without usage says nothing.
    stream({ type: "message_start", message: { id: "msg_2" } });
    expect(events.filter((e) => e.type === "output-tokens")).toEqual([
      { type: "output-tokens", messageId: "msg_1", tokens: 1 },
      { type: "output-tokens", messageId: "msg_1", tokens: 42 },
      { type: "output-tokens", messageId: "msg_s", tokens: 2 },
      { type: "output-tokens", messageId: "msg_s", tokens: 7 },
    ]);
  });
});
