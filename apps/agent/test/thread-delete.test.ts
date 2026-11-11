// Deleting a thread and archiving one: only the session's own files go to
// the trash (its transcript, the folder beside it, the files its messages
// saved), a running thread and a session open elsewhere are asked about
// first, a thread from a link or with odd paths never reaches anything else,
// and every device hears about it.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorReason, ThreadState, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { Transcript } from "./support/claude-transcript.ts";

const none = { sensitive: false, projectSettings: false };
const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});
const turnsDone = (n: number) => (items: Item[]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;

function setup() {
  const sessionId = randomUUID();
  const claudeHome = tempDir("claude-home-");
  const sdk = fakeQuery(undefined, { sessionId });
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude", homes: () => [claudeHome] });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const trashed: string[][] = [];
  const m = makeCore([provider], { trash: async (paths) => void trashed.push([...paths]) });
  cores.push(m.core);
  return { ...m, sessionId, claudeHome, trashed };
}

/** What claude wrote for the session, made old so it does not look busy. */
function transcriptOf(claudeHome: string, sessionId: string, cwd: string, ago = 3_600_000): string {
  const t = new Transcript(sessionId, cwd, "sdk-ts").opening();
  t.user("hello");
  t.assistant([{ type: "text", text: "echo: hello" }]);
  const file = t.write(claudeHome);
  const when = new Date(Date.now() - ago);
  utimesSync(file, when, when);
  return file;
}

describe("deleting a thread", () => {
  test("moves only the session's transcript, its folder and the files its messages saved to the trash, and tells every device", async () => {
    const { core, work, sessionId, claudeHome, trashed, audit } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    const file = transcriptOf(claudeHome, sessionId, work);
    const beside = join(dirname(file), sessionId);
    mkdirSync(join(beside, "subagents"), { recursive: true });
    // Another session in the same project folder stays.
    const other = transcriptOf(claudeHome, randomUUID(), work);
    core.upload({ uploadId: "upload-del1", threadId: thread.id, name: "notes.txt", mimeType: "", size: 2, offset: 0, data: new Uint8Array([104, 105]) });
    await core.send(thread.id, "read", "m1", ["upload-del1"]);
    await until(core, thread.id, turnsDone(2));
    // A file the user put there by hand is not the thread's.
    const day = join(work, ".tunelo-attachments", "keep");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "mine.txt"), "x");
    const heard: string[] = [];
    core.onDeleted((id) => heard.push(id));
    const n = await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" });
    expect(n).toBe(3);
    const sent = trashed[0] ?? [];
    expect(sent).toContain(file);
    expect(sent).toContain(beside);
    expect(sent.some((p) => p.endsWith("/notes.txt") && p.includes(".tunelo-attachments"))).toBe(true);
    expect(sent).not.toContain(other);
    expect(sent.some((p) => p.endsWith("mine.txt"))).toBe(false);
    expect(heard).toEqual([thread.id]);
    expect(core.list().some((t) => t.id === thread.id)).toBe(false);
    expect(audit.list(10).some((e) => e.action === "delete_session" && e.detail === sessionId && e.device === "phone")).toBe(true);
  });

  test("a thread running a turn is refused until the user agrees to stop it", async () => {
    const { core, work, trashed } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "ask rm -rf build", consent: none, device: "phone" });
    await until(core, thread.id, (i) => byCase(i, "approval").length > 0);
    await expect(core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" })).rejects.toMatchObject({ reason: ErrorReason.THREAD_RUNNING });
    expect(trashed).toHaveLength(0);
    await core.deleteThread({ threadId: thread.id, stopRunning: true, openAnyway: false, device: "phone" });
    expect(core.list()).toHaveLength(0);
  });

  test("a session changed elsewhere after the thread is refused until the user goes on", async () => {
    const { core, work, sessionId, claudeHome } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    await core.close(thread.id);
    // A terminal wrote to it just now, after the thread's last change.
    const file = transcriptOf(claudeHome, sessionId, work, 0);
    const later = new Date(Date.now() + 30_000);
    utimesSync(file, later, later);
    await expect(core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" })).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: true, device: "phone" });
    expect(core.list()).toHaveLength(0);
  });

  test("a saved path that leaves the attachments folder, or a link in it, is never trashed", async () => {
    const { core, work, trashed, dataDir } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    const outside = join(tempDir(), "secret.txt");
    writeFileSync(outside, "x");
    mkdirSync(join(work, ".tunelo-attachments"), { recursive: true });
    symlinkSync(outside, join(work, ".tunelo-attachments", "link.txt"));
    writeFileSync(join(work, "README.md"), "x");
    // A journal entry naming paths it should not (as a damaged or crafted journal would).
    const journal = join(dataDir, "threads", thread.id, "journal.jsonl");
    expect(existsSync(journal)).toBe(true);
    (core as unknown as { threads: Map<string, { journal: { put: (id: string, body: unknown, o: object) => void } }> }).threads
      .get(thread.id)
      ?.journal.put("user:x", { case: "text", value: { role: 1, text: "", attachments: [{ id: "a", name: "a", path: "../../../../etc/hosts" }, { id: "b", name: "b", path: "README.md" }, { id: "c", name: "c", path: ".tunelo-attachments/link.txt" }] } }, { provider: "claude", model: "", now: Date.now() });
    await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" });
    const sent = trashed.flat();
    expect(sent.some((p) => p.endsWith("hosts") || p.endsWith("README.md") || p.endsWith("secret.txt") || p.endsWith("link.txt"))).toBe(false);
    expect(existsSync(join(dataDir, "threads", thread.id))).toBe(false);
  });

  test("when the trash refuses, the thread stays", async () => {
    const sessionId = randomUUID();
    const claudeHome = tempDir("claude-home-");
    const provider = createClaudeProvider({ query: fakeQuery(undefined, { sessionId }).fn, findBinary: async () => "claude", homes: () => [claudeHome] });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const m = makeCore([provider], { trash: async () => Promise.reject(new Error("no trash here")) });
    cores.push(m.core);
    const thread = await m.core.create({ provider: "claude", model: "", dir: m.work, text: "hello", consent: none, device: "phone" });
    await until(m.core, thread.id, turnsDone(1));
    transcriptOf(claudeHome, sessionId, m.work);
    await expect(m.core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" })).rejects.toMatchObject({ reason: ErrorReason.TRASH_UNAVAILABLE });
    expect(m.core.list().some((t) => t.id === thread.id)).toBe(true);
  });
});

/**
 * A terminal session opened as a thread ten minutes ago by the machine's
 * clock, written to five minutes ago (after the thread's last change) and
 * quiet since; `held`: a running claude registered it as its session.
 */
async function openedTerminalSession(held: boolean) {
  const sessionId = randomUUID();
  const claudeHome = tempDir("claude-home-");
  const provider = createClaudeProvider({ query: fakeQuery(undefined, { sessionId }).fn, findBinary: async () => "claude", homes: () => [claudeHome] });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const trashed: string[][] = [];
  const m = makeCore([provider], { trash: async (paths) => void trashed.push([...paths]), now: () => Date.now() - 10 * 60_000 });
  cores.push(m.core);
  const file = transcriptOf(claudeHome, sessionId, m.work);
  const thread = await m.core.openLocal({ provider: "claude", sessionId, consent: none, openAnyway: false, device: "phone" });
  const quietSince = new Date(Date.now() - 5 * 60_000);
  utimesSync(file, quietSince, quietSince);
  if (held) {
    mkdirSync(join(claudeHome, "sessions"), { recursive: true });
    writeFileSync(join(claudeHome, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd: m.work, kind: "interactive", entrypoint: "cli" }));
  }
  return { ...m, thread, file, trashed };
}

describe("deleting a thread whose session a terminal may hold", () => {
  test("held open by a running claude while idle: refused until the user goes on, and not shown as running elsewhere", async () => {
    const { core, thread, file, trashed } = await openedTerminalSession(true);
    await core.lookElsewhere();
    expect(core.list().find((s) => s.id === thread.id)).toMatchObject({ state: ThreadState.IDLE, busyElsewhere: false });
    await expect(core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" })).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    expect(trashed).toHaveLength(0);
    await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: true, device: "phone" });
    expect(trashed.flat()).toContain(file);
  });

  test("neither held nor running a turn: deleted at once", async () => {
    const { core, thread, file, trashed } = await openedTerminalSession(false);
    await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" });
    expect(trashed.flat()).toContain(file);
    expect(core.list()).toHaveLength(0);
  });

  test("running a turn there: refused", async () => {
    const { core, thread, file, trashed } = await openedTerminalSession(false);
    const now = new Date();
    utimesSync(file, now, now);
    await expect(core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "phone" })).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    expect(trashed).toHaveLength(0);
  });
});

describe("archiving a thread", () => {
  test("hides it on every device and shows it again, touching nothing on disk", async () => {
    const { core, work, trashed } = setup();
    const thread = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: none, device: "phone" });
    await until(core, thread.id, turnsDone(1));
    const seen: boolean[] = [];
    core.onStatus((s) => s.id === thread.id && seen.push(s.archived));
    const before = core.list()[0]?.updatedAt;
    core.setArchived(thread.id, true);
    expect(core.list()[0]?.archived).toBe(true);
    expect(core.list()[0]?.updatedAt).toBe(before);
    core.setArchived(thread.id, false);
    expect(seen).toEqual([true, false]);
    expect(trashed).toHaveLength(0);
  });
});
