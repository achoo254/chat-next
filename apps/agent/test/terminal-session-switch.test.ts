// A thread's AI in the machine's terminal can go on in another session inside
// its CLI (Claude: /resume to another conversation, /clear for a new one). The
// thread does not lose that session: when its terminal ends, and before a
// newer terminal process opens the CLI again resumed, it takes the session
// the CLI holds, as Claude's register of running processes tells
// (<claude folder>/sessions/<pid>.json, told apart by folder and start time).
// Made-up transcripts and registers stand in for what claude writes; this
// test process (and its parent) stand in for running claudes.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import { isConversationBreak } from "@achoo254/chat-remote-protocol";
import type { AgentProvider } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, tempDir, until } from "./harness.ts";
import { HOST_PID, heldByTerminal as heldWith } from "./support/claude-terminal-thread.ts";

const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

const summaryOf = (core: AgentCore, id: string): ThreadSummary | undefined => core.list().find((s) => s.id === id);
const heldByTerminal = (...others: AgentProvider[]) => heldWith(cores, others);

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

  test("the CLI exits after /clear: the session it printed on exit is the one the terminal opens again, though no claude runs any more", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    const fresh = randomUUID();
    m.conversation(fresh, "now the docs", "Docs written.");
    // Nothing in the register: the process is gone, only the line it printed tells.
    m.core.terminalEnded(1, HOST_PID, fresh.toUpperCase());
    expect(m.segments()).toEqual([m.launched, fresh]);
    const spec = await m.core.terminalLaunch(m.thread.id);
    expect(spec.args.slice(0, 2)).toEqual(["--resume", fresh]);
  });

  test("a session another thread already holds is not taken: one conversation never shows as two threads", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    // /clear in the terminal; meanwhile the new session was opened as a thread of its own.
    const fresh = randomUUID();
    m.conversation(fresh, "now the docs", "Docs written.");
    const owner = await m.core.openLocal({ provider: "claude", sessionId: fresh, consent: { sensitive: false, projectSettings: false }, openAnyway: true, device: "phone" });
    m.register(process.pid, fresh);
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    await m.core.lookElsewhere();
    m.core.terminalEnded(1, HOST_PID);
    expect(m.segments()).toEqual([m.launched]);
    expect(m.core.sessionIdOf(owner.id)).toBe(fresh);
    expect(m.core.sessionIds().filter((s) => s.sessionId === fresh)).toHaveLength(1);
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

describe("the conversation a thread shows after its CLI went on in another one", () => {
  type Items = ReturnType<AgentCore["snapshot"]>;
  /** The texts of the items, in the journal's order (by seq). */
  const texts = (items: Items): string[] => items.flatMap((i) => (i.body.case === "text" ? [i.body.value.text] : []));
  const breaks = (items: Items): Items => items.filter((i) => isConversationBreak(i));
  /** What a device shows: the items after the latest break. */
  const shown = (items: Items): Items => {
    const from = breaks(items).at(-1)?.seq ?? 0n;
    return items.filter((i) => i.seq > from);
  };

  test("/clear: one break comes before the new conversation, and the earlier one stays in the journal", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    expect(texts(m.core.snapshot(m.thread.id))).toEqual(["build it", "Built."]);
    const fresh = randomUUID();
    m.conversation(fresh, "now the docs", "Docs written.");
    m.register(process.pid, fresh);
    await m.core.lookElsewhere();
    const items = m.core.snapshot(m.thread.id);
    expect(breaks(items)).toHaveLength(1);
    // A status item with no text, which every released agent and device reads and draws as nothing.
    expect(breaks(items)[0]?.body).toMatchObject({ case: "status", value: { text: "" } });
    const at = items.findIndex((i) => isConversationBreak(i));
    expect(texts(items.slice(0, at))).toEqual(["build it", "Built."]);
    expect(texts(items.slice(at + 1))).toEqual(["now the docs", "Docs written."]);
    // Looked at again, followed again and ended: still one break, nothing read twice.
    await m.core.lookElsewhere();
    expect(m.core.terminalFollow(m.thread.id)).toBe(false);
    m.core.terminalEnded(1, HOST_PID);
    expect(breaks(m.core.snapshot(m.thread.id))).toHaveLength(1);
    expect(texts(m.core.snapshot(m.thread.id))).toEqual(["build it", "Built.", "now the docs", "Docs written."]);
  });

  test("the last turn written moments before /clear is read in before the break", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    // Typed and answered, then /clear, all between two looks.
    m.reply(m.launched, "and test it", "Tested.");
    const fresh = randomUUID();
    m.conversation(fresh, "now the docs", "Docs written.");
    m.register(process.pid, fresh);
    await m.core.lookElsewhere();
    const items = m.core.snapshot(m.thread.id);
    const at = items.findIndex((i) => isConversationBreak(i));
    expect(texts(items.slice(0, at))).toEqual(["build it", "Built.", "and test it", "Tested."]);
    expect(texts(items.slice(at + 1))).toEqual(["now the docs", "Docs written."]);
  });

  test("a launch session that never got a transcript is replaced without a break while nothing was shown", async () => {
    const m = await heldByTerminal();
    const other = randomUUID();
    m.conversation(other, "fix the login bug", "Fixed.");
    m.register(process.pid, other);
    await m.core.lookElsewhere();
    expect(m.segments()).toEqual([other]);
    const items = m.core.snapshot(m.thread.id);
    expect(breaks(items)).toEqual([]);
    expect(texts(items)).toEqual(["fix the login bug", "Fixed."]);
  });

  test("/resume back to a conversation shown before: a new break, and that conversation shows again after it", async () => {
    const m = await heldByTerminal();
    m.conversation(m.launched, "build it", "Built.");
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    const fresh = randomUUID();
    m.conversation(fresh, "build it", "Built again.");
    m.register(process.pid, fresh);
    await m.core.lookElsewhere();
    // The same words in the new conversation are its own message, not the earlier one's.
    expect(texts(shown(m.core.snapshot(m.thread.id)))).toEqual(["build it", "Built again."]);
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    expect(m.segments()).toEqual([m.launched, fresh, m.launched]);
    const items = m.core.snapshot(m.thread.id);
    expect(breaks(items)).toHaveLength(2);
    expect(texts(shown(items))).toEqual(["build it", "Built."]);
  });

  test("handing over to another AI after /clear passes on only the conversation shown", async () => {
    const other = fakeProvider("other");
    const m = await heldByTerminal(other);
    m.conversation(m.launched, "the old task", "Old done.");
    m.register(process.pid, m.launched);
    await m.core.lookElsewhere();
    const fresh = randomUUID();
    m.conversation(fresh, "the new task", "New done.");
    m.register(process.pid, fresh);
    await m.core.lookElsewhere();
    m.core.terminalEnded(1, HOST_PID);
    await m.core.switchProvider(m.thread.id, "other", "");
    const items = await until(m.core, m.thread.id, (i) => byCase(i, "agentHandoff").length === 1 && other.log.sent.length > 0);
    const summary = byCase(items, "agentHandoff")[0]?.body.value.summary ?? "";
    expect(summary).toContain("the new task");
    expect(summary).not.toContain("the old task");
    expect(other.log.sent[0]).not.toContain("the old task");
  });
});
