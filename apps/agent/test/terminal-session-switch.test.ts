// A thread's AI in the machine's terminal can go on in another session inside
// its CLI (Claude: /resume to another conversation, /clear for a new one). The
// thread does not lose that session: when its terminal ends, and before a
// newer terminal process opens the CLI again resumed, it takes the session
// the CLI holds, as Claude's register of running processes tells
// (<claude folder>/sessions/<pid>.json, told apart by folder and start time).
// Made-up transcripts and registers stand in for what claude writes; this
// test process (and its parent) stand in for running claudes.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { makeCore, tempDir } from "./harness.ts";
import { Transcript } from "./support/claude-transcript.ts";

const none = { sensitive: false, projectSettings: false };
const HOST_PID = 4242;

const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

/** What the test reads of a thread's saved record. */
type SavedMeta = { segments: { sessionId?: string }[]; terminal?: { startedAt?: number } };

const summaryOf = (core: AgentCore, id: string): ThreadSummary | undefined => core.list().find((s) => s.id === id);

/** A thread opened with no message and handed to the terminal: the CLI starts a new session with the id the thread keeps. */
async function heldByTerminal() {
  const claudeHome = tempDir("claude-home-");
  mkdirSync(join(claudeHome, "sessions"));
  const provider = createClaudeProvider({ query: fakeQuery().fn, findBinary: async () => "claude", homes: () => [claudeHome] });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const { core, work, dataDir } = makeCore([provider]);
  cores.push(core);
  const thread = await core.create({ provider: "claude", model: "", dir: work, text: "", consent: none, device: "phone" });
  const spec = await core.terminalLaunch(thread.id);
  const launched = spec.args[spec.args.indexOf("--session-id") + 1] ?? "";
  core.terminalStarted(thread.id, 1, HOST_PID);
  const meta = (): SavedMeta => JSON.parse(readFileSync(join(dataDir, "threads", thread.id, "meta.json"), "utf8")) as SavedMeta;
  const startedAt = meta().terminal?.startedAt ?? 0;
  /** A running claude's record in the register: by default the terminal's CLI (this folder, started with the terminal). */
  const register = (pid: number, sessionId: string, at = startedAt + 1_200, cwd = work) =>
    writeFileSync(join(claudeHome, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, startedAt: at, kind: "interactive" }));
  /** A session kept on the machine, written an hour ago. */
  const conversation = (id: string, user: string, answer: string) => {
    const t = new Transcript(id, work, "cli").opening();
    t.user(user);
    t.assistant([{ type: "text", text: answer }]);
    const file = t.write(claudeHome);
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(file, hourAgo, hourAgo);
  };
  const segments = () => meta().segments.map((s) => s.sessionId);
  return { core, thread, launched, startedAt, register, conversation, segments };
}

describe("a CLI in the terminal that went on in another session", () => {
  test("/resume, then the terminal is closed: the thread keeps the conversation that was on screen, and opens in it again", async () => {
    const m = await heldByTerminal();
    expect(m.startedAt).toBeGreaterThan(0);
    const other = randomUUID();
    m.conversation(other, "fix the login bug", "Fixed: the cookie was missing SameSite.");
    m.register(process.pid, other);
    m.core.terminalEnded(1, HOST_PID);
    // The launch session never got a transcript: replaced by the one the CLI went on in, not dropped.
    expect(m.segments()).toEqual([other]);
    expect(summaryOf(m.core, m.thread.id)).toMatchObject({ terminalSession: 0, preview: "Fixed: the cookie was missing SameSite." });
    const spec = await m.core.terminalLaunch(m.thread.id);
    expect(spec.args.slice(0, 2)).toEqual(["--resume", other]);
  });

  test("/clear from a conversation, then closed: the new session comes after the one it left", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    const fresh = randomUUID();
    m.conversation(fresh, "now the docs", "Docs written.");
    m.register(process.pid, fresh);
    m.core.terminalEnded(1, HOST_PID);
    expect(m.segments()).toEqual([m.launched, fresh]);
    expect(summaryOf(m.core, m.thread.id)).toMatchObject({ preview: "Docs written." });
  });

  test("before a newer terminal process opens the CLI again: it resumes the session the CLI holds", async () => {
    const m = await heldByTerminal();
    // Nothing in the register yet: nothing changes.
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    const other = randomUUID();
    m.conversation(other, "fix the login bug", "Fixed.");
    m.register(process.pid, other);
    expect(m.core.terminalFollow(m.thread.id)).toBe(true);
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    expect(m.segments()).toEqual([other]);
    expect(summaryOf(m.core, m.thread.id)).toMatchObject({ terminalSession: 1, preview: "Fixed." });
    const spec = await m.core.terminalLaunch(m.thread.id);
    expect(spec.args.slice(0, 2)).toEqual(["--resume", other]);
  });

  test("/resume while the terminal stays open: the regular look gives the thread the conversation's name and last message", async () => {
    const m = await heldByTerminal();
    await m.core.lookElsewhere();
    expect(summaryOf(m.core, m.thread.id)).toMatchObject({ title: "", preview: "" });
    const other = randomUUID();
    m.conversation(other, "fix the login bug", "Fixed: the cookie was missing SameSite.");
    m.register(process.pid, other);
    await m.core.lookElsewhere();
    expect(m.segments()).toEqual([other]);
    const row = summaryOf(m.core, m.thread.id);
    expect(row).toMatchObject({ terminalSession: 1, preview: "Fixed: the cookie was missing SameSite." });
    expect(row?.title).not.toBe("");
    // A second look with nothing new changes nothing.
    const updatedAt = row?.updatedAt;
    await m.core.lookElsewhere();
    expect(m.segments()).toEqual([other]);
    expect(summaryOf(m.core, m.thread.id)?.updatedAt).toBe(updatedAt);
  });

  test("a /clear session with nothing in it yet is not taken: the thread keeps the one it can resume", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    m.register(process.pid, randomUUID());
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    m.core.terminalEnded(1, HOST_PID);
    expect(m.segments()).toEqual([m.launched]);
  });

  test("two running claudes that could be the terminal's, or none started with it: nothing changes, as before", async () => {
    const m = await heldByTerminal();
    const a = randomUUID();
    const b = randomUUID();
    m.conversation(a, "one", "A.");
    m.conversation(b, "two", "B.");
    // Both in the thread's folder, both started with its terminal.
    m.register(process.pid, a);
    m.register(process.ppid, b, m.startedAt - 2_000);
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    // One started long before, the other in another folder: neither is the terminal's.
    m.register(process.pid, a, m.startedAt - 3_600_000);
    m.register(process.ppid, b, m.startedAt, join(tempDir("elsewhere-"), "x"));
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    // Ending the terminal then undoes the launch session that never got a transcript, as it always did.
    m.core.terminalEnded(1, HOST_PID);
    expect(m.segments()).toEqual([undefined]);
  });
});
