// Telling which Claude Code sessions run elsewhere on the machine from the
// running claude processes: their folder and start time, read with ps and
// lsof, never any application's own files.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSessions } from "../src/providers/claude/local-sessions.ts";
import { ClaudeProcesses, elapsedMs, heldSessions, isClaudeCommand, parseLsofCwd, parsePs, sessionIdOf } from "../src/providers/claude/running-claude.ts";
import { tempDir } from "./harness.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const same = (a: string, b: string) => a === b;

describe("reading ps and lsof", () => {
  it("reads elapsed times", () => {
    expect(elapsedMs("00:05")).toBe(5_000);
    expect(elapsedMs("11:51")).toBe(711_000);
    expect(elapsedMs("05:04:22")).toBe(18_262_000);
    expect(elapsedMs("04-23:50:06")).toBe(((4 * 24 + 23) * 3600 + 50 * 60 + 6) * 1000);
    expect(elapsedMs("soon")).toBeUndefined();
  });

  it("knows Claude Code by its program, not by a path that mentions claude", () => {
    expect(isClaudeCommand("claude", "claude")).toBe(true);
    expect(isClaudeCommand("/Users/me/.local/bin/claude", "claude --resume x")).toBe(true);
    expect(isClaudeCommand("node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
    expect(isClaudeCommand("ssh", "ssh -F /tmp/claude-501/config host")).toBe(false);
    expect(isClaudeCommand("/Applications/Claude.app/Contents/Helpers/chrome-native-host", "x")).toBe(false);
  });

  it("finds a session id on the command line", () => {
    expect(sessionIdOf(`claude --resume ${A}`)).toBe(A);
    expect(sessionIdOf(`claude -r ${A.toUpperCase()} --model opus`)).toBe(A);
    expect(sessionIdOf(`claude --session-id=${B}`)).toBe(B);
    expect(sessionIdOf("claude --resume")).toBe("");
    expect(sessionIdOf("claude --continue")).toBe("");
  });

  it("keeps Claude processes that are not tunelo's own", () => {
    const out = [
      `  101     1    11:51 claude           claude`,
      `  102     1 05:04:22 claude           claude --resume ${A}`,
      `  103   999    00:10 claude           claude --output-format stream-json`,
      `  104     1    00:10 /usr/bin/ssh     ssh -F /tmp/claude-1/c host`,
    ].join("\n");
    expect(parsePs(out, 1_000_000_000, 999)).toEqual([
      { pid: 101, startedAt: 1_000_000_000 - 711_000, sessionId: "" },
      { pid: 102, startedAt: 1_000_000_000 - 18_262_000, sessionId: A },
    ]);
    expect(parseLsofCwd("p101\nfcwd\nn/work/a\np102\nfcwd\nn/work/b c\n")).toEqual(
      new Map([
        [101, "/work/a"],
        [102, "/work/b c"],
      ]),
    );
  });

  it("reads at most every few seconds, and nothing on Windows", async () => {
    let now = 100_000;
    const calls: string[] = [];
    const exec = async (cmd: string) => {
      calls.push(cmd);
      return cmd === "ps" ? "  7  1  00:30 claude claude\n" : "p7\nfcwd\nn/work/x\n";
    };
    const probe = new ClaudeProcesses({ platform: "darwin", now: () => now, exec, selfPid: 1234 });
    await Promise.all([probe.refresh(), probe.refresh()]);
    expect(probe.current).toEqual([{ pid: 7, cwd: "/work/x", startedAt: 70_000, sessionId: "" }]);
    await probe.refresh();
    expect(calls).toEqual(["ps", "lsof"]);
    now += 6_000;
    await probe.refresh();
    expect(calls).toHaveLength(4);
    const win = new ClaudeProcesses({ platform: "win32", exec });
    await win.refresh();
    expect(win.current).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it("gives an empty list when ps fails", async () => {
    const probe = new ClaudeProcesses({ platform: "linux", exec: async () => Promise.reject(new Error("no ps")) });
    await probe.refresh();
    expect(probe.current).toEqual([]);
  });
});

describe("sessions held by running processes", () => {
  const sessions = [
    { sessionId: A, dir: "/work/x", mtimeMs: 50_000 },
    { sessionId: B, dir: "/work/x", mtimeMs: 90_000 },
    { sessionId: C, dir: "/work/y", mtimeMs: 95_000 },
  ];

  it("marks the newest session of the folder changed since the process started", () => {
    const held = heldSessions([{ pid: 1, cwd: "/work/x", startedAt: 60_000, sessionId: "" }], sessions, same);
    expect([...held]).toEqual([B]);
  });

  it("marks nothing for a process whose session has not changed since it started", () => {
    expect(heldSessions([{ pid: 1, cwd: "/work/x", startedAt: 95_000, sessionId: "" }], sessions, same).size).toBe(0);
  });

  it("marks one session per process, and the one named on a command line", () => {
    const procs = [
      { pid: 1, cwd: "/work/x", startedAt: 10_000, sessionId: "" },
      { pid: 2, cwd: "/work/x", startedAt: 20_000, sessionId: "" },
      { pid: 3, cwd: "/elsewhere", startedAt: 0, sessionId: C },
    ];
    expect([...heldSessions(procs, sessions, same)].sort()).toEqual([A, B, C].sort());
  });
});

describe("the session list", () => {
  it("shows a session as open elsewhere when a claude works in its folder", async () => {
    const home = tempDir();
    const project = join(home, "projects", "-work-x");
    mkdirSync(project, { recursive: true });
    const line = (id: string) => `${JSON.stringify({ type: "user", cwd: "/work/x", sessionId: id, entrypoint: "cli", message: { role: "user", content: `hello ${id}` } })}\n`;
    const old = Date.now() / 1000 - 3600;
    for (const id of [A, B]) {
      writeFileSync(join(project, `${id}.jsonl`), line(id));
      utimesSync(join(project, `${id}.jsonl`), old, id === B ? old + 60 : old);
    }
    const processes = new ClaudeProcesses({
      platform: "darwin",
      exec: async (cmd) => (cmd === "ps" ? "  42  1  02:00:00 claude claude\n" : "p42\nfcwd\nn/work/x\n"),
    });
    const sessions = new LocalSessions({ homes: () => [home], processes });
    const before = sessions.list({ dir: "", query: "", offset: 0, limit: 0 }).sessions;
    expect(before.map((s) => s.busy)).toEqual([false, false]);
    await sessions.prime();
    const after = sessions.list({ dir: "", query: "", offset: 0, limit: 0 }).sessions;
    expect(after.find((s) => s.sessionId === B)?.busy).toBe(true);
    expect(after.find((s) => s.sessionId === A)?.busy).toBe(false);
    expect(sessions.find(B)?.busy).toBe(true);
  });
});
