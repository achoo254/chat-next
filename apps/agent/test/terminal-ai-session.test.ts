// A thread's AI opened in the machine's terminal (TermOpen.ai_session): the
// agent picks the program, arguments, folder and account from the thread and
// the AI's adapter (a device names only the thread), one terminal per thread,
// the chat view read-only while the CLI holds the session, and chat writing
// again once the CLI exits or the session is ended.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorCode, ErrorReason, TermOpenSchema, ThreadState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { terminalCommand } from "../src/providers/claude/index.ts";
import type { AgentProvider, TerminalLaunch } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { tempDir } from "./harness.ts";
import { FakeTermHost, fakeUnit } from "./support/fake-term-host.ts";
import { terminalMachine } from "./support/terminal-device.ts";

const env = { TUNELO_TERM_HOST_BIN: "/bin/sh" };
/** The pid the stand-in terminal process reports. */
const HOST_PID = 999_999;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** The fake AI with a CLI that records what it was asked for. */
function cliProvider(launches: TerminalLaunch[] = []): AgentProvider & { launches: TerminalLaunch[] } {
  return {
    ...fakeProvider(),
    launches,
    terminal: {
      async command(req) {
        launches.push(req);
        return req.resumeId
          ? { file: "/opt/fake-ai", args: ["--resume", req.resumeId], env: {} }
          : { file: "/opt/fake-ai", args: ["--session-id", "11111111-2222-4333-8444-555555555555"], env: {}, sessionId: "11111111-2222-4333-8444-555555555555" };
      },
    },
  };
}

async function setup(provider: AgentProvider = cliProvider()) {
  const configDir = join(tempDir("term-ai-"), "cfg");
  const host = new FakeTermHost(configDir);
  const m = await terminalMachine({ unit: fakeUnit(host), env, configDir, providers: [provider] });
  cleanup.push(() => rmSync(dirname(configDir), { recursive: true, force: true }), () => m.terminal.stop(), () => host.stop());
  const c = await m.connect(await m.pair());
  return { ...m, host, c };
}

const consent = { sensitive: false, projectSettings: false };
const openAi = (threadId: string, cwd = "") => ({ case: "termOpen" as const, value: { cols: 100, rows: 30, cwd, aiSession: { threadId } } });
const summaryOf = (m: Awaited<ReturnType<typeof setup>>, id: string) => m.core.list().find((s) => s.id === id);

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a thread's AI in the terminal", () => {
  it("the device names only the thread: the agent runs the AI's CLI in the thread's folder, resuming its session", async () => {
    const provider = cliProvider();
    const m = await setup(provider);
    const created = await m.core.create({ provider: "fake", model: "small", dir: m.work, text: "hi", consent, device: "test" });
    await until(() => summaryOf(m, created.id)?.state === ThreadState.IDLE && summaryOf(m, created.id)?.open === true, "first turn");
    // A folder sent with the request is not used.
    const opened = await m.c.request("1", openAi(created.id, "/etc"));
    expect(opened.body).toMatchObject({ case: "termOpened", value: { session: 1 } });
    const open = m.host.commands.find((x) => x.cmd === "open");
    expect(open).toMatchObject({ cols: 100, rows: 30, shell: "/opt/fake-ai", args: ["--resume", "fake-session-1"], cwd: m.work });
    expect(open).not.toHaveProperty("env");
    expect(provider.launches).toEqual([{ dir: m.work, resumeId: "fake-session-1", model: "small" }]);
    // The machine's own session of the thread closed: only the terminal writes to it.
    expect(summaryOf(m, created.id)).toMatchObject({ open: false, terminalSession: 1 });
    await expect(m.core.send(created.id, "from chat", "")).rejects.toMatchObject({ reason: ErrorReason.SESSION_OPEN_ELSEWHERE });
    const list = await m.c.request("2", { case: "termListRequest", value: {} });
    expect(list.body).toMatchObject({ case: "termListResult", value: { sessions: [{ session: 1, threadId: created.id }] } });
    // Asking again (another device, a reload) attaches to the same terminal.
    const again = await m.c.request("3", openAi(created.id));
    expect(again.body).toMatchObject({ case: "termOpened", value: { session: 1 } });
    expect(m.host.commands.filter((x) => x.cmd === "open")).toHaveLength(1);
  });

  it("a new session starts with an id the thread keeps; dropped when the CLI exits before writing anything", async () => {
    const m = await setup();
    const created = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "", consent, device: "test" });
    await m.c.request("1", openAi(created.id));
    expect(m.host.commands.find((x) => x.cmd === "open")?.args).toEqual(["--session-id", "11111111-2222-4333-8444-555555555555"]);
    expect(m.core.terminalSession(created.id, HOST_PID)).toBe(1);
    m.host.exit(1);
    await until(() => summaryOf(m, created.id)?.terminalSession === 0, "terminal ended");
    // Nothing to resume (no transcript): the next open starts a new session again.
    await m.c.request("2", openAi(created.id));
    expect(m.host.commands.filter((x) => x.cmd === "open")[1]?.args).toEqual(["--session-id", "11111111-2222-4333-8444-555555555555"]);
  });

  it("ending the terminal (TermClose) lets chat write again", async () => {
    const m = await setup();
    const created = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "", consent, device: "test" });
    await m.c.request("1", openAi(created.id));
    expect(summaryOf(m, created.id)?.terminalSession).toBe(1);
    await m.c.request("2", { case: "termClose", value: { session: 1 } });
    expect(summaryOf(m, created.id)?.terminalSession).toBe(0);
    await expect(m.core.send(created.id, "back in chat", "")).resolves.toBeUndefined();
  });

  it("refuses an unknown thread, an AI without a CLI and a thread running a turn", async () => {
    const m = await setup();
    const unknown = await m.c.request("1", openAi("nope"));
    expect(unknown.body).toMatchObject({ case: "error", value: { code: ErrorCode.NOT_FOUND, reason: ErrorReason.THREAD_NOT_FOUND } });
    const empty = await m.c.request("2", openAi(""));
    expect(empty.body).toMatchObject({ case: "error", value: { code: ErrorCode.INVALID } });
    const busy = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "slow", consent, device: "test" });
    await until(() => summaryOf(m, busy.id)?.state === ThreadState.RUNNING, "turn running");
    const running = await m.c.request("3", openAi(busy.id));
    expect(running.body).toMatchObject({ case: "error", value: { reason: ErrorReason.THREAD_RUNNING } });
    await m.core.interrupt(busy.id);
    expect(m.host.commands.filter((x) => x.cmd === "open")).toEqual([]);

    const plain = await setup(fakeProvider());
    const t = await plain.core.create({ provider: "fake", model: "", dir: plain.work, text: "", consent, device: "test" });
    const unsupported = await plain.c.request("1", openAi(t.id));
    expect(unsupported.body).toMatchObject({ case: "error", value: { reason: ErrorReason.UNSUPPORTED_REQUEST } });
  });

  it("a terminal process that started again ends every thread's terminal it no longer has", async () => {
    const m = await setup();
    const created = await m.core.create({ provider: "fake", model: "", dir: m.work, text: "", consent, device: "test" });
    await m.c.request("1", openAi(created.id));
    m.core.terminalAlive(HOST_PID + 1, new Set([1]));
    expect(summaryOf(m, created.id)?.terminalSession).toBe(0);
  });
});

describe("what a device can ask the terminal to run", () => {
  it("TermOpen carries a size, a folder for a shell and a thread, never a program or arguments", () => {
    expect(TermOpenSchema.fields.map((f) => f.localName).sort()).toEqual(["aiSession", "cols", "cwd", "rows"]);
    const ai = TermOpenSchema.fields.find((f) => f.localName === "aiSession");
    expect(ai?.message?.fields.map((f) => f.localName)).toEqual(["threadId"]);
  });

  it("claude: resumes a Claude session id only, picks a new id otherwise, passes only its own models and modes", () => {
    const base = { dir: "/w" };
    const id = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
    expect(terminalCommand("/bin/claude", { ...base, resumeId: id, accountDir: "/p1", model: "opus", permissionMode: "plan" }, () => "x")).toEqual({
      file: "/bin/claude",
      args: ["--resume", id, "--model", "opus", "--permission-mode", "plan"],
      env: { CLAUDE_CONFIG_DIR: "/p1" },
    });
    expect(terminalCommand("/bin/claude", { ...base, model: "--evil", permissionMode: "bypassPermissions" }, () => id)).toEqual({
      file: "/bin/claude",
      args: ["--session-id", id],
      env: {},
      sessionId: id,
    });
    expect(() => terminalCommand("/bin/claude", { ...base, resumeId: "--dangerously-skip-permissions" }, () => id)).toThrow();
  });
});
