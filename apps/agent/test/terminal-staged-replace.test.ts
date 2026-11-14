// A newer terminal process staged by an update replaces the running one as
// soon as every program in it is a thread's idle AI: the old process shuts
// down, the staged binary becomes the current one, and each AI opens again in
// the new process resumed at its size. A plain shell, an AI in a turn (even
// one quiet for long: a tool still waiting) or a session its process no longer
// holds keeps the old process. A staged one that does not start is dropped,
// the old one starts again and no switch is tried again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ThreadState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProvider, Liveness, SessionHistory } from "../src/providers/types.ts";
import { TERM_HOST_BINARY } from "../src/terminal/host-supervisor.ts";
import { fakeProvider } from "./fake-provider.ts";
import { tempDir } from "./harness.ts";
import { FakeTermHost, fakeUnit } from "./support/fake-term-host.ts";
import { terminalMachine } from "./support/terminal-device.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** The fake AI with a CLI and a transcript whose liveness the test sets; `held` is the session its CLI in the thread's folder holds now, as the AI tells. */
function cliProvider(live: { now: Liveness; held?: { dir: string; sessionId: string } }): AgentProvider {
  const history: SessionHistory = {
    list: () => ({ sessions: [], total: 0, dirs: [] }),
    find: () => undefined,
    end: () => 1,
    read: () => undefined,
    liveness: async () => live.now,
    terminalHeldSession: (cli) => (live.held && live.held.dir === cli.dir && Math.abs(Date.now() - cli.startedAt) < 60_000 ? live.held.sessionId : undefined),
  };
  return {
    ...fakeProvider(),
    history,
    terminal: {
      async command(req) {
        return { file: "/opt/fake-ai", args: req.resumeId ? ["--resume", req.resumeId] : ["--new"], env: {} };
      },
    },
  };
}

const QUIET_MS = 1_000;
/** A session its running CLI holds, quiet for `ms`, outside any turn. */
const idleFor = (ms: number): Liveness => ({ state: "idle", since: Date.now() - ms, held: true, turnOpen: false, via: "transcript" });
const consent = { sensitive: false, projectSettings: false };

async function setup() {
  const live: { now: Liveness; held?: { dir: string; sessionId: string } } = { now: idleFor(5 * QUIET_MS) };
  const configDir = join(tempDir("term-replace-"), "cfg");
  const bin = join(configDir, "term-host", "bin");
  mkdirSync(join(bin, "current"), { recursive: true });
  writeFileSync(join(bin, "current", TERM_HOST_BINARY), "old");
  const host = new FakeTermHost(configDir);
  const fake = fakeUnit(host);
  // A binary that does not start, as a broken download would not.
  const unit = {
    ...fake,
    start: async () => {
      if (readFileSync(join(bin, "current", TERM_HOST_BINARY), "utf8") === "broken") throw new Error("crashed at start");
      await fake.start();
    },
  };
  const m = await terminalMachine({ unit, configDir, providers: [cliProvider(live)], replaceQuietMs: QUIET_MS });
  cleanup.push(() => rmSync(dirname(configDir), { recursive: true, force: true }), () => m.terminal.stop(), () => host.stop());
  const c = await m.connect(await m.pair());
  const thread = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "hi", consent, device: "test" });
  await until(() => m.core.list().find((s) => s.id === thread.id)?.state === ThreadState.IDLE, "first turn");
  const opened = await c.request("1", { case: "termOpen", value: { cols: 90, rows: 25, cwd: "", aiSession: { threadId: thread.id } } });
  expect(opened.body).toMatchObject({ case: "termOpened", value: { session: 1 } });
  /** An update stages a newer terminal process. */
  const stage = (content = "new") => {
    mkdirSync(join(bin, "next"), { recursive: true });
    writeFileSync(join(bin, "next", TERM_HOST_BINARY), content);
  };
  return { m, c, host, unit, live, bin, stage, threadId: thread.id };
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a staged terminal process", () => {
  it("replaces the running one while every program in it is an idle AI, which opens again resumed at its size", async () => {
    const { m, host, bin, stage, threadId } = await setup();
    const oldPid = host.pid;
    // Nothing staged: nothing happens.
    await m.terminal.replaceWhenIdle();
    expect(host.commands.some((x) => x.cmd === "shutdown")).toBe(false);

    stage();
    await m.terminal.replaceWhenIdle();
    expect(host.commands.filter((x) => x.cmd === "shutdown")).toHaveLength(1);
    expect(host.pid).toBe(oldPid + 1);
    expect(readFileSync(join(bin, "current", TERM_HOST_BINARY), "utf8")).toBe("new");
    expect(m.terminal.availability()).toBeDefined();
    const opens = host.commands.filter((x) => x.cmd === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1]).toMatchObject({ cols: 90, rows: 25, shell: "/opt/fake-ai", args: ["--resume", "fake-session-1"], cwd: m.work });
    expect(m.core.terminalSession(threadId, host.pid)).toBe(1);
    expect(m.logs.some((l) => l.includes("switching to the newer terminal process (1 idle AI session(s)"))).toBe(true);
  });

  it("opens the AI again in the session its CLI went on in (/resume, /clear), not the one it was started with", async () => {
    const { m, host, live, stage, threadId } = await setup();
    // The AI's record of running processes: the CLI the terminal started in the thread's folder holds another session now.
    live.held = { dir: m.work, sessionId: "fake-session-2" };
    stage();
    await m.terminal.replaceWhenIdle();
    expect(host.commands.filter((x) => x.cmd === "shutdown")).toHaveLength(1);
    expect(host.commands.filter((x) => x.cmd === "open").at(-1)).toMatchObject({ cols: 90, rows: 25, args: ["--resume", "fake-session-2"] });
    expect(m.core.terminalSession(threadId, host.pid)).toBe(1);
  });

  it("waits while an AI runs a turn, waits on a tool however long, was active too recently, or no longer holds the session", async () => {
    const { m, host, live, stage } = await setup();
    stage();
    for (const now of [
      { ...idleFor(5 * QUIET_MS), state: "busy" as const },
      // A long subagent, or a permission prompt nobody answered: the transcript is quiet, the turn is not over.
      { ...idleFor(5 * QUIET_MS), turnOpen: true },
      idleFor(0),
      // The CLI went on in another session (/clear): this one is not what runs.
      { ...idleFor(5 * QUIET_MS), held: false },
      { state: "unknown" as const, via: "transcript" as const },
    ]) {
      live.now = now;
      await m.terminal.replaceWhenIdle();
    }
    expect(host.commands.some((x) => x.cmd === "shutdown")).toBe(false);
  });

  it("a staged process that does not start: the previous one starts again, the AI opens there, no second try", async () => {
    const { m, host, bin, stage, threadId } = await setup();
    stage("broken");
    await expect(m.terminal.replaceWhenIdle()).rejects.toThrow(/crashed at start/);
    expect(readFileSync(join(bin, "current", TERM_HOST_BINARY), "utf8")).toBe("old");
    expect(existsSync(join(bin, "next"))).toBe(false);
    expect(m.core.terminalSession(threadId, host.pid)).toBe(1);
    expect(host.commands.filter((x) => x.cmd === "open").at(-1)).toMatchObject({ args: ["--resume", "fake-session-1"] });
    stage();
    await m.terminal.replaceWhenIdle();
    expect(host.commands.filter((x) => x.cmd === "shutdown")).toHaveLength(1);
  });

  it("waits while a plain shell runs", async () => {
    const { m, c, host, stage } = await setup();
    const shell = await c.request("2", { case: "termOpen", value: { cols: 80, rows: 24, cwd: m.work } });
    expect(shell.body).toMatchObject({ case: "termOpened" });
    stage();
    await m.terminal.replaceWhenIdle();
    expect(host.commands.some((x) => x.cmd === "shutdown")).toBe(false);
  });
});
