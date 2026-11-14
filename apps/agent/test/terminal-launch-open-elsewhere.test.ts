// Terminal mode never starts a second process of the AI on a session another
// one has open, busy or idle (the owner's own terminal window on the
// machine): two writers of one transcript would each show their own
// conversation. The thread's own CLI (from its terminal, maybe still
// exiting), the machine's own chat session it closes first, a register entry
// left behind by a process that is gone (or whose pid another program got
// since), a process a program drives and another conversation open in the
// same folder never count.
import { randomUUID } from "node:crypto";
import { ErrorReason, TurnState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentCore } from "../src/core/agent-core.ts";
import type { AgentProvider, SessionHistory } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, until } from "./harness.ts";
import { HOST_PID, heldByTerminal } from "./support/claude-terminal-thread.ts";

const cores: AgentCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

const consent = { sensitive: false, projectSettings: false };
/** A pid no process has. */
const GONE_PID = 2_147_483_000;
const HOUR_MS = 3_600_000;

/** A thread whose terminal ran a conversation and ended: the next Terminal mode resumes that session. */
async function endedTerminal() {
  const m = await heldByTerminal(cores);
  m.conversation(m.launched, "build it", "Built.");
  m.core.terminalEnded(1, HOST_PID);
  expect(m.core.list().find((s) => s.id === m.thread.id)?.terminalSession).toBe(0);
  return m;
}

describe("starting Terminal mode on a session another process of the AI has open", () => {
  test("refused while a claude started long before (the owner's own window) has it open idle", async () => {
    const m = await endedTerminal();
    m.register(process.ppid, m.launched, m.startedAt - HOUR_MS);
    await expect(m.core.terminalLaunch(m.thread.id)).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE, subject: m.work });
    // Once that window is closed, it starts.
    m.register(GONE_PID, m.launched, m.startedAt - HOUR_MS);
    m.register(process.ppid, randomUUID(), m.startedAt - HOUR_MS);
    const spec = await m.core.terminalLaunch(m.thread.id);
    expect(spec.args.slice(0, 2)).toEqual(["--resume", m.launched]);
  });

  test("a record whose pid another program got since (Windows gives pids out again) does not count", async () => {
    const m = await endedTerminal();
    m.register(process.ppid, m.launched, m.startedAt - HOUR_MS, m.work, { procStart: "133000000000000000" });
    // The claude that wrote it was killed outright; the pid now belongs to a program started a minute ago.
    m.startedAgain(process.ppid, Date.now() - 60_000);
    expect((await m.core.terminalLaunch(m.thread.id)).args.slice(0, 2)).toEqual(["--resume", m.launched]);
  });

  test("a claude a program drives (this machine's own chat sessions) does not count", async () => {
    const m = await endedTerminal();
    m.register(process.ppid, m.launched, m.startedAt - HOUR_MS, m.work, { entrypoint: "sdk-ts" });
    expect((await m.core.terminalLaunch(m.thread.id)).args.slice(0, 2)).toEqual(["--resume", m.launched]);
  });

  test("the thread's own CLI still holding the session (exiting, or a newer terminal process opening it again) does not count", async () => {
    const m = await endedTerminal();
    // Started with the thread's terminal, in its folder.
    m.register(process.pid, m.launched);
    expect((await m.core.terminalLaunch(m.thread.id)).args.slice(0, 2)).toEqual(["--resume", m.launched]);

    const held = await heldByTerminal(cores);
    held.conversation(held.launched, "build it", "Built.");
    held.register(process.pid, held.launched);
    expect((await held.core.terminalLaunch(held.thread.id)).args.slice(0, 2)).toEqual(["--resume", held.launched]);
  });

  test("a register entry of a process that is gone, or another conversation open in the same folder, does not count", async () => {
    const m = await endedTerminal();
    m.register(GONE_PID, m.launched, m.startedAt - HOUR_MS);
    m.register(process.ppid, randomUUID(), m.startedAt - HOUR_MS);
    expect((await m.core.terminalLaunch(m.thread.id)).args.slice(0, 2)).toEqual(["--resume", m.launched]);
  });
});

/** The fake AI with a CLI, whose record says a process has a session open while `open()` says so. */
function cliWithRecord(open: () => boolean, id = "fake") {
  const asked: string[] = [];
  const history: SessionHistory = {
    list: () => ({ sessions: [], total: 0, dirs: [] }),
    find: () => undefined,
    end: () => undefined,
    read: () => undefined,
    openInOtherProcess: async (sessionId) => {
      asked.push(sessionId);
      return open();
    },
  };
  const base = fakeProvider(id);
  const provider: AgentProvider = {
    ...base,
    history,
    terminal: {
      async command(req) {
        return { file: "/opt/fake-ai", args: req.resumeId ? ["--resume", req.resumeId] : ["--new"], env: {} };
      },
    },
  };
  return { provider, log: base.log, asked };
}

/** A machine with that AI, and a thread whose first turn has run (its session open and idle). */
async function idleThread(open: () => boolean, opts: { maxSessions?: number } = {}) {
  const fake = cliWithRecord(open);
  const { core, work } = makeCore([fake.provider], opts);
  cores.push(core);
  const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "test" });
  await expect.poll(() => core.list().find((s) => s.id === t.id)?.open).toBe(true);
  return { ...fake, core, work, t };
}

describe("the machine's own session and a new thread", () => {
  test("the machine's own chat session is closed first, and its process given time to exit", async () => {
    let looks = 0;
    const m = await idleThread(() => ++looks <= 2);
    const spec = await m.core.terminalLaunch(m.t.id);
    expect(spec.args).toEqual(["--resume", "fake-session-1"]);
    expect(m.log.closed).toBe(1);
    expect(looks).toBe(3);
  });

  test("a session the machine closed moments before (to make room for another) is given that time too", async () => {
    let looks = 0;
    const m = await idleThread(() => ++looks <= 2, { maxSessions: 1 });
    // A second thread takes the only room: the first one's session closes now, not when the terminal opens.
    const second = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "hello", consent, device: "test" });
    await expect.poll(() => m.core.list().find((s) => s.id === second.id)?.open).toBe(true);
    expect(m.core.list().find((s) => s.id === m.t.id)?.open).toBe(false);
    expect((await m.core.terminalLaunch(m.t.id)).args).toEqual(["--resume", "fake-session-1"]);
    expect(looks).toBe(3);
  });

  test("refused when the closed session's process does not go away", { timeout: 10_000 }, async () => {
    const m = await idleThread(() => true);
    await expect(m.core.terminalLaunch(m.t.id)).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    expect(m.asked.length).toBeGreaterThan(1);
  });

  test("a message from another device while it waits is a turn, not another window; once the CLI is starting chat sends nothing", { timeout: 10_000 }, async () => {
    const m = await idleThread(() => true);
    const launching = m.core.terminalLaunch(m.t.id);
    await expect.poll(() => m.asked.length).toBeGreaterThan(0);
    await m.core.send(m.t.id, "one more thing", "");
    await expect(launching).rejects.toMatchObject({ reason: ErrorReason.THREAD_RUNNING });
    await until(m.core, m.t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length >= 2);

    // Nothing holds it now: the CLI is being started, and a message waits for it to run or give up.
    const free = await idleThread(() => false);
    await free.core.terminalLaunch(free.t.id);
    await expect(free.core.send(free.t.id, "from chat", "")).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    free.core.terminalAbandoned(free.t.id);
    await expect(free.core.send(free.t.id, "from chat", "")).resolves.toBeUndefined();
  });

  test("a question asked again after a restart is answered in chat first", async () => {
    const fake = cliWithRecord(() => false);
    const first = makeCore([fake.provider]);
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "question", consent, device: "d" });
    await until(first.core, t.id, (i) => byCase(i, "question").length > 0);
    await first.core.stop();
    const again = cliWithRecord(() => false);
    const second = makeCore([again.provider], { dataDir: first.dataDir, home: first.home });
    cores.push(second.core);
    await expect(second.core.terminalLaunch(t.id)).rejects.toMatchObject({ reason: ErrorReason.THREAD_RUNNING });
  });

  test("a new thread has no session for anything to hold: nothing is asked", async () => {
    const fake = cliWithRecord(() => true);
    const { core, work } = makeCore([fake.provider]);
    cores.push(core);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "test" });
    expect((await core.terminalLaunch(t.id)).args).toEqual(["--new"]);
    expect(fake.asked).toEqual([]);
  });
});
