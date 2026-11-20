// A message sent in chat to a thread whose AI runs in the machine's terminal
// takes the session back, as opening the terminal takes it from chat: while
// that CLI is idle its terminal is hung up, the message waits until no
// process of the AI has the session open any more, then runs in the
// machine's own session resumed. A CLI answering or waiting on a prompt keeps
// the session (TERMINAL_TURN_RUNNING); a machine without the wiring refuses as
// before.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorReason, Role, ThreadState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProvider, Liveness, SessionHistory } from "../src/providers/types.ts";
import { fakeProvider, type FakeLog } from "./fake-provider.ts";
import { tempDir } from "./harness.ts";
import { FakeTermHost, fakeUnit } from "./support/fake-term-host.ts";
import { terminalMachine } from "./support/terminal-device.ts";

// The fake terminal host listens on a unix socket at a file path, which Windows does not support.
const posix = process.platform !== "win32";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Live = {
  now: Liveness;
  /** Times the AI still says another process has the session open, before it says none. */
  openFor: number;
  asked: number;
  /** Nothing was typed in the session: it has no transcript, as a CLI opened with `--session-id` has none. */
  empty?: boolean;
};

/** The fake AI with a CLI and a transcript whose liveness the test sets. */
function cliProvider(live: Live): AgentProvider & { log: FakeLog } {
  const history: SessionHistory = {
    list: () => ({ sessions: [], total: 0, dirs: [] }),
    find: () => undefined,
    end: () => (live.empty ? undefined : 1),
    read: () => undefined,
    liveness: async () => live.now,
    openInOtherProcess: async () => {
      live.asked += 1;
      return live.asked <= live.openFor;
    },
  };
  return {
    ...fakeProvider(),
    history,
    terminal: {
      async command(req) {
        return req.resumeId
          ? { file: "/opt/fake-ai", args: ["--resume", req.resumeId], env: {} }
          : { file: "/opt/fake-ai", args: ["--new"], env: {}, sessionId: "11111111-2222-4333-8444-555555555555" };
      },
    },
  };
}

/** The session its running CLI holds, quiet for `ms`; `turnOpen` while a turn (or a prompt) waits. */
const quietFor = (ms: number, turnOpen = false): Liveness => ({ state: "idle", since: Date.now() - ms, held: true, turnOpen, via: "transcript" });
/** The empty session its running CLI calls idle since `ms` ago (the AI's own record of the process; no transcript to read). */
const emptyIdleFor = (ms: number): Liveness => ({ state: "idle", since: Date.now() - ms, held: true, turnOpen: false, untranscribed: true, via: "process" });
const consent = { sensitive: false, projectSettings: false };

async function setup(chatTakesTerminal = true, empty = false) {
  const live: Live = empty ? { now: emptyIdleFor(10_000), openFor: 0, asked: 0, empty } : { now: quietFor(10_000), openFor: 0, asked: 0 };
  const provider = cliProvider(live);
  const configDir = join(tempDir("term-take-"), "cfg");
  const host = new FakeTermHost(configDir);
  const m = await terminalMachine({ unit: fakeUnit(host), env: { TUNELO_TERM_HOST_BIN: "/bin/sh" }, configDir, providers: [provider], chatTakesTerminal });
  cleanup.push(() => rmSync(dirname(configDir), { recursive: true, force: true }), () => m.terminal.stop(), () => host.stop());
  const c = await m.connect(await m.pair());
  // An empty session is opened without a message: it waits, parked, for the one typed in it.
  const thread = await m.core.create({ provider: "fake", model: "", dir: m.work, text: empty ? "" : "hi", consent, device: "test" });
  if (!empty) await until(() => summary(m, thread.id)?.state === ThreadState.IDLE, "first turn");
  const opened = await c.request("1", { case: "termOpen", value: { cols: 90, rows: 25, cwd: "", aiSession: { threadId: thread.id } } });
  expect(opened.body).toMatchObject({ case: "termOpened", value: { session: 1 } });
  expect(summary(m, thread.id)?.terminalSession).toBe(1);
  return { m, c, host, live, provider, threadId: thread.id };
}

const summary = (m: Awaited<ReturnType<typeof terminalMachine>>, id: string) => m.core.list().find((s) => s.id === id);

/** The user messages of the thread's journal, in order. */
function userTexts(m: Awaited<ReturnType<typeof terminalMachine>>, id: string): string[] {
  return m.core
    .snapshot(id)
    .flatMap((item) => (item.body.case === "text" && item.body.value.role === Role.USER ? [item.body.value.text] : []));
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!posix)("chat taking a thread back from its terminal", () => {
  it("hangs up the idle CLI's terminal and runs the message in the machine's own session", async () => {
    const { m, host, threadId } = await setup();
    await m.core.send(threadId, "from chat", "c1");
    expect(host.commands.filter((x) => x.cmd === "close")).toEqual([expect.objectContaining({ session: 1 })]);
    expect(summary(m, threadId)?.terminalSession).toBe(0);
    expect(userTexts(m, threadId)).toContain("from chat");
    await until(() => summary(m, threadId)?.state === ThreadState.IDLE && summary(m, threadId)?.open === true, "the chat turn");
  });

  it("waits for the CLI to exit before the machine opens the session", async () => {
    const { m, live, threadId } = await setup();
    live.openFor = 2;
    await m.core.send(threadId, "after it exits", "c1");
    expect(live.asked).toBe(3);
    expect(userTexts(m, threadId)).toContain("after it exits");
  });

  it("leaves a CLI that answers or waits on a prompt alone: TERMINAL_TURN_RUNNING, nothing written", async () => {
    const { m, host, live, threadId } = await setup();
    live.now = { state: "busy", since: Date.now(), held: true, turnOpen: true, via: "transcript" };
    await expect(m.core.send(threadId, "too early", "c1")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    live.now = quietFor(10_000, true);
    await expect(m.core.send(threadId, "still waiting", "c2")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    // Written moments ago: maybe between two steps of a turn.
    live.now = quietFor(200);
    await expect(m.core.send(threadId, "just wrote", "c3")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    expect(host.commands.some((x) => x.cmd === "close")).toBe(false);
    expect(summary(m, threadId)?.terminalSession).toBe(1);
    expect(userTexts(m, threadId)).not.toContain("too early");
  });

  it("takes back a session nothing was typed in: its CLI says it is idle, the message starts a new session", async () => {
    const { m, host, provider, threadId } = await setup(true, true);
    await m.core.send(threadId, "first words", "c1");
    expect(host.commands.filter((x) => x.cmd === "close")).toEqual([expect.objectContaining({ session: 1 })]);
    expect(summary(m, threadId)?.terminalSession).toBe(0);
    expect(userTexts(m, threadId)).toContain("first words");
    // The id the CLI was opened with was never written: resuming it would find nothing.
    await until(() => provider.log.starts.length === 1, "the chat session");
    expect(provider.log.starts[0]?.resumeId).toBeUndefined();
    await until(() => summary(m, threadId)?.state === ThreadState.IDLE && summary(m, threadId)?.open === true, "the chat turn");
  });

  it("leaves an empty session alone while its CLI is not idle or was idle only a moment: TERMINAL_TURN_RUNNING", async () => {
    const { m, host, live, threadId } = await setup(true, true);
    live.now = { state: "busy", since: Date.now(), held: true, turnOpen: false, untranscribed: true, via: "process" };
    await expect(m.core.send(threadId, "typed in the CLI first", "c1")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    live.now = emptyIdleFor(200);
    await expect(m.core.send(threadId, "too soon", "c2")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    // Nothing tells the CLI idle (no record, several processes): as for any session whose state cannot be read.
    live.now = { state: "unknown", via: "transcript" };
    await expect(m.core.send(threadId, "cannot tell", "c3")).rejects.toMatchObject({ reason: ErrorReason.TERMINAL_TURN_RUNNING });
    expect(host.commands.some((x) => x.cmd === "close")).toBe(false);
    expect(summary(m, threadId)?.terminalSession).toBe(1);
  });

  it("hands over once for two messages arriving together", async () => {
    const { m, host, threadId } = await setup();
    await Promise.all([m.core.send(threadId, "one", "c1"), m.core.send(threadId, "two", "c2")]);
    expect(host.commands.filter((x) => x.cmd === "close")).toHaveLength(1);
    expect(userTexts(m, threadId)).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("a machine without the wiring refuses as before", async () => {
    const { m, host, threadId } = await setup(false);
    await expect(m.core.send(threadId, "from chat", "c1")).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    expect(host.commands.some((x) => x.cmd === "close")).toBe(false);
  });
});
