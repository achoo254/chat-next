// Automatic Advisor for a thread's AI opened in the machine's terminal: the
// CLI starts with tunelo's MCP offering advisor_weigh alone (a ticket the
// core holds from the launch until the terminal ends, is abandoned or the
// thread goes), a UserPromptSubmit hook that asks the service for Advisor's
// note (`tunelo advisor note`), and the verdicts it gets read back from its
// transcript into the thread's journal.
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADVISOR_OFF, AUTO_INSTRUCTIONS, AUTO_REMINDER, autoInstructions, autoReminder } from "../src/advisor/advisor-instructions.ts";
import type { AdvisorHooks } from "../src/advisor/advisor-tools.ts";
import { runAdvisorNote } from "../src/advisor/cli-advisor-command.ts";
import type { AgentCore } from "../src/core/agent-core.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { ADVISOR_WEIGH_MCP_ENV, TICKET_ENV, type TicketScope } from "../src/mcp/session-tickets.ts";
import { TURN_END_SETTINGS, shellArg, terminalCommand } from "../src/providers/claude/index.ts";
import type { AgentProvider, HistoryEntry, SessionHistory, TerminalCommand, TerminalLaunch } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };
const cores: AgentCore[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
});

const ADVISOR = { ticket: "tkt", configDir: "/cfg", noteCommand: ["/opt/tunelo", "advisor", "note", "thread-1"] };
const SESSION_ID = "0b0c3f6e-1d2a-4c5b-8e9f-0a1b2c3d4e5f";
/** advisor_weigh as the CLI in a terminal lists it. */
const TERMINAL_TOOL = { server: "tunelo-advisor", fullName: "mcp__tunelo-advisor__advisor_weigh" };

describe("claude in the terminal with Advisor", () => {
  it("without Advisor the arguments stay as before", () => {
    const out = terminalCommand("/bin/claude", { dir: "/w", resumeId: SESSION_ID }, () => "x");
    expect(out.args).toEqual(["--resume", SESSION_ID, "--settings", TURN_END_SETTINGS]);
  });

  it("one --settings with the turn-end hook, the note hook and advisor_weigh allowed, then tunelo's MCP with the ticket only", () => {
    const out = terminalCommand("/bin/claude", { dir: "/w", resumeId: SESSION_ID, model: "opus", advisor: ADVISOR }, () => "x", "darwin");
    expect(out.args.slice(0, 4)).toEqual(["--resume", SESSION_ID, "--model", "opus"]);
    expect(out.args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(out.args[4]).toBe("--settings");
    expect(out.args[6]).toBe("--mcp-config");
    expect(out.args).toHaveLength(8);
    const settings = JSON.parse(out.args[5] ?? "") as {
      hooks: { Stop: unknown[]; UserPromptSubmit: { hooks: { type: string; command: string; timeout: number }[] }[] };
      permissions: { allow: string[] };
    };
    expect(settings.hooks.Stop).toEqual((JSON.parse(TURN_END_SETTINGS) as { hooks: { Stop: unknown[] } }).hooks.Stop);
    // The hook asks the service of tunelo's own config folder, wherever that is.
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "TUNELO_HOME='/cfg' '/opt/tunelo' 'advisor' 'note' 'thread-1'", timeout: 5 }] }]);
    expect(settings.permissions.allow).toEqual(["mcp__tunelo-advisor__advisor_weigh"]);
    const mcp = JSON.parse(out.args[7] ?? "") as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    // Not "tunelo": a `claude mcp add tunelo` of the user's stays as it is, beside this one.
    expect(Object.keys(mcp.mcpServers)).toEqual(["tunelo-advisor"]);
    expect(out.args).not.toContain("--strict-mcp-config");
    expect(out.advisorTool).toEqual({ server: "tunelo-advisor", fullName: "mcp__tunelo-advisor__advisor_weigh" });
    const server = mcp.mcpServers["tunelo-advisor"];
    expect(server?.type).toBe("stdio");
    expect(server?.args.at(-1)).toBe("mcp");
    // The ticket, tunelo's folder and the advisor_weigh-only flag: nothing else, never a key.
    expect(server?.env).toEqual({ [TICKET_ENV]: "tkt", TUNELO_HOME: "/cfg", [ADVISOR_WEIGH_MCP_ENV]: "1" });
    expect(out.env).toEqual({});
  });

  it("each part of the note command, and tunelo's folder, reach the program as they are, through the shell the CLI runs hooks in", () => {
    const dir = tempDir("adv-term-quote-");
    const program = join(dir, "it's a tunelo $HOME");
    writeFileSync(program, '#!/bin/sh\nprintf "<%s>" "$TUNELO_HOME"; for a in "$@"; do printf "[%s]" "$a"; done\n');
    chmodSync(program, 0o755);
    const home = "/x/it's `here` $(y)";
    const out = terminalCommand("/bin/claude", { dir: "/w", advisor: { ...ADVISOR, configDir: home, noteCommand: [program, "advisor", "note", "a'b; rm -rf / `x` $(y)"] } }, () => SESSION_ID, "linux");
    const settings = JSON.parse(out.args.at(-3) ?? "") as { hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] } };
    const command = settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command ?? "";
    expect(execFileSync("/bin/sh", ["-c", command]).toString()).toBe(`<${home}>[advisor][note][a'b; rm -rf / \`x\` $(y)]`);
    expect(shellArg("a'b")).toBe("'a'\\''b'");
  });

  it("on Windows the hook names no folder (Git Bash's environment syntax is not relied on)", () => {
    const out = terminalCommand("/bin/claude", { dir: "/w", advisor: ADVISOR }, () => SESSION_ID, "win32");
    expect(out.args.at(-3)).toContain(`"command":"'/opt/tunelo' 'advisor' 'note' 'thread-1'"`);
  });

  it("refuses an Advisor without a note command", () => {
    expect(() => terminalCommand("/bin/claude", { dir: "/w", advisor: { ...ADVISOR, noteCommand: [] } }, () => SESSION_ID)).toThrow();
  });
});

type Lease = { threadId: string; scope: TicketScope | undefined; ticket: string; released: boolean };

/** An AI whose CLI takes Advisor in the terminal, with a transcript the test writes. */
function terminalAi(opts: { terminalAdvisor?: boolean; command?: (req: TerminalLaunch) => Promise<TerminalCommand | undefined> } = {}) {
  const launches: TerminalLaunch[] = [];
  const transcript: HistoryEntry[] = [];
  const history: SessionHistory = {
    list: () => ({ sessions: [], total: 0, dirs: [] }),
    find: () => undefined,
    end: () => transcript.length,
    read: (_id, from) => ({ entries: transcript.slice(from === "recent" ? 0 : from), end: transcript.length }),
  };
  const base = fakeProvider();
  const provider: AgentProvider = {
    ...base,
    capabilities: { ...base.capabilities, sessionMcp: true, ...(opts.terminalAdvisor === false ? {} : { terminalAdvisor: true }) },
    history,
    terminal: {
      command:
        opts.command ??
        (async (req) => {
          launches.push(req);
          return {
            file: "/opt/fake-ai",
            args: req.resumeId ? ["--resume", req.resumeId] : ["--new"],
            env: {},
            sessionId: SESSION_ID,
            ...(req.advisor ? { advisorTool: TERMINAL_TOOL } : {}),
          };
        }),
    },
  };
  return { provider, launches, transcript };
}

function machine(ai = terminalAi(), more: { sessionMcpEnabled?: () => boolean; key?: boolean } = {}) {
  const leases: Lease[] = [];
  const { core, work } = makeCore([ai.provider], {
    sessionMcp: (threadId, scope) => {
      const lease: Lease = { threadId, scope, ticket: `ticket-${leases.length + 1}`, released: false };
      leases.push(lease);
      return {
        ticket: lease.ticket,
        configDir: "/cfg",
        approveWrite: () => undefined,
        describeWrite: async () => undefined,
        release: () => {
          lease.released = true;
        },
      };
    },
    advisorKeySet: () => more.key !== false,
    more: more.sessionMcpEnabled ? { sessionMcpEnabled: more.sessionMcpEnabled } : {},
  });
  cores.push(core);
  const thread = () => core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone" });
  return { core, work, leases, thread, ...ai };
}

describe("the ticket of the CLI in the terminal", () => {
  it("is issued for advisor_weigh only at the launch, held while the terminal runs and ended with it", async () => {
    const m = machine();
    const t = await m.thread();
    await m.core.terminalLaunch(t.id);
    expect(m.leases).toEqual([{ threadId: t.id, scope: "advisor-weigh", ticket: "ticket-1", released: false }]);
    const advisor = m.launches[0]?.advisor;
    expect(advisor).toMatchObject({ ticket: "ticket-1", configDir: "/cfg" });
    expect(advisor?.noteCommand.slice(-3)).toEqual(["advisor", "note", t.id]);
    m.core.terminalStarted(t.id, 1, 42);
    expect(m.leases[0]?.released).toBe(false);
    m.core.terminalEnded(1, 42);
    expect(m.leases[0]?.released).toBe(true);
  });

  it("ends when the launch fails, finds no CLI or is abandoned", async () => {
    let fail = true;
    const ai = terminalAi({
      command: async () => {
        if (fail) throw new Error("not a session id");
        return undefined;
      },
    });
    const m = machine(ai);
    const t = await m.thread();
    await expect(m.core.terminalLaunch(t.id)).rejects.toThrow("not a session id");
    fail = false;
    await expect(m.core.terminalLaunch(t.id)).rejects.toMatchObject({ message: "Fake AI is not installed" });
    expect(m.leases.map((l) => l.released)).toEqual([true, true]);

    const ok = machine();
    const u = await ok.thread();
    await ok.core.terminalLaunch(u.id);
    ok.core.terminalAbandoned(u.id);
    expect(ok.leases[0]?.released).toBe(true);
  });

  it("ends when the thread is deleted while its terminal runs, and when the service stops", async () => {
    const m = machine();
    const t = await m.thread();
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    await m.core.deleteThread({ threadId: t.id, stopRunning: true, openAnyway: true, device: "phone" });
    expect(m.leases[0]?.released).toBe(true);

    const s = machine();
    const u = await s.thread();
    await s.core.terminalLaunch(u.id);
    s.core.terminalStarted(u.id, 1, 42);
    await s.core.stop();
    expect(s.leases[0]?.released).toBe(true);
  });

  it("a new terminal process opening the CLI again ends the old CLI's ticket once the new one runs", async () => {
    const m = machine();
    const t = await m.thread();
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    await m.core.terminalLaunch(t.id);
    // The new process says what it has before the CLI reported back: the new CLI's ticket stays.
    m.core.terminalAlive(43, new Set());
    expect(m.leases.map((l) => l.released)).toEqual([true, false]);
    m.core.terminalStarted(t.id, 1, 43);
    expect(m.leases.map((l) => l.released)).toEqual([true, false]);
    m.core.terminalEnded(1, 43);
    expect(m.leases.map((l) => l.released)).toEqual([true, true]);
  });

  it("none for an AI whose CLI does not take Advisor, or a machine that runs no session MCP", async () => {
    const other = machine(terminalAi({ terminalAdvisor: false }));
    const t = await other.thread();
    await other.core.terminalLaunch(t.id);
    expect(other.leases).toEqual([]);
    expect(other.launches[0]?.advisor).toBeUndefined();

    const off = machine(terminalAi(), { sessionMcpEnabled: () => false });
    const u = await off.thread();
    await off.core.terminalLaunch(u.id);
    expect(off.leases).toEqual([]);
    expect(off.launches[0]?.advisor).toBeUndefined();
  });

  it("none on a machine without a key for Advisor: the CLI opens exactly as before; a key set later counts from the next terminal", async () => {
    let key = false;
    const ai = terminalAi();
    const leases: unknown[] = [];
    const { core, work } = makeCore([ai.provider], {
      sessionMcp: (threadId) => {
        leases.push(threadId);
        return { ticket: "t", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => undefined };
      },
      advisorKeySet: () => key,
    });
    cores.push(core);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone" });
    core.setAdvisor(t.id, true, "phone");
    await core.terminalLaunch(t.id);
    core.terminalStarted(t.id, 1, 42);
    expect(leases).toEqual([]);
    expect(ai.launches[0]?.advisor).toBeUndefined();
    expect(core.terminalNote(t.id, "hello")).toBeUndefined();
    key = true;
    expect(core.terminalNote(t.id, "hello")).toBeUndefined();
    core.terminalEnded(1, 42);
    await core.terminalLaunch(t.id);
    core.terminalStarted(t.id, 1, 42);
    expect(leases).toEqual([t.id]);
    expect(core.terminalNote(t.id, "hello")).toBe(autoInstructions(TERMINAL_TOOL));
  });
});

describe("Advisor's note for a message typed in the terminal", () => {
  it("the whole text first, then a reminder; nothing for a command; one line once turned off; nothing after", async () => {
    const m = machine();
    const t = await m.thread();
    m.core.setAdvisor(t.id, true, "phone");
    // Not in a terminal: the chat view carries the note.
    expect(m.core.terminalNote(t.id, "hello")).toBeUndefined();
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    expect(m.core.terminalNote(t.id, "/clear")).toBeUndefined();
    // The CLI's own name for the tool, not the chat sessions' "tunelo" one.
    const full = m.core.terminalNote(t.id, "fix the push");
    expect(full).toBe(autoInstructions(TERMINAL_TOOL));
    expect(full).toContain("its full name is mcp__tunelo-advisor__advisor_weigh.");
    expect(full).not.toBe(AUTO_INSTRUCTIONS);
    expect(m.core.terminalNote(t.id, "  /compact")).toBeUndefined();
    // The CLI's shell ("!") and memory ("#") input: no note, nothing counted as said.
    expect(m.core.terminalNote(t.id, "!git status")).toBeUndefined();
    expect(m.core.terminalNote(t.id, " # always use pnpm")).toBeUndefined();
    expect(m.core.terminalNote(t.id, "and then?")).toBe(autoReminder(TERMINAL_TOOL));
    expect(autoReminder(TERMINAL_TOOL)).toContain("call the tunelo-advisor MCP tool mcp__tunelo-advisor__advisor_weigh");
    expect(AUTO_REMINDER).toContain("call the tunelo MCP tool advisor_weigh");
    m.core.setAdvisor(t.id, false, "phone");
    expect(m.core.terminalNote(t.id, "/review")).toBeUndefined();
    expect(m.core.terminalNote(t.id, "go on")).toBe(ADVISOR_OFF);
    expect(m.core.terminalNote(t.id, "go on")).toBeUndefined();
    expect(m.core.terminalNote("no-such-thread", "hi")).toBeUndefined();
  });

  it("another conversation of the CLI (/clear, /resume) gets the whole text again; the same one a reminder", async () => {
    const m = machine();
    const t = await m.thread();
    m.core.setAdvisor(t.id, true, "phone");
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    // The conversation the CLI was opened on.
    expect(m.core.terminalNote(t.id, "first", SESSION_ID)).toBe(autoInstructions(TERMINAL_TOOL));
    expect(m.core.terminalNote(t.id, "second", SESSION_ID)).toBe(autoReminder(TERMINAL_TOOL));
    // /clear: a new conversation, whose first message is a command and the next one words.
    expect(m.core.terminalNote(t.id, "/compact", "11111111-0000-4000-8000-000000000000")).toBeUndefined();
    expect(m.core.terminalNote(t.id, "after clear", "11111111-0000-4000-8000-000000000000")).toBe(autoInstructions(TERMINAL_TOOL));
    expect(m.core.terminalNote(t.id, "again", "11111111-0000-4000-8000-000000000000")).toBe(autoReminder(TERMINAL_TOOL));
    // Turned off, then /resume to another conversation: it never heard Advisor was on, so nothing to take back.
    m.core.setAdvisor(t.id, false, "phone");
    expect(m.core.terminalNote(t.id, "elsewhere", "22222222-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("a CLI resumed on a conversation already told in the chat view gets a reminder, a new one the whole text", async () => {
    const m = machine();
    const t = await m.thread();
    m.core.setAdvisor(t.id, true, "phone");
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    expect(m.core.terminalNote(t.id, "hi", SESSION_ID)).toBe(autoInstructions(TERMINAL_TOOL));
    m.core.terminalEnded(1, 42);
    // Opened again on the same conversation (the thread kept its session id).
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    expect(m.core.terminalNote(t.id, "back", SESSION_ID)).toBe(autoReminder(TERMINAL_TOOL));
  });

  it("nothing when Advisor was never on, or the terminal holds the thread without this service's ticket", async () => {
    const m = machine();
    const t = await m.thread();
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    expect(m.core.terminalNote(t.id, "hello")).toBeUndefined();

    const old = machine(terminalAi({ terminalAdvisor: false }));
    const u = await old.thread();
    old.core.setAdvisor(u.id, true, "phone");
    await old.core.terminalLaunch(u.id);
    old.core.terminalStarted(u.id, 1, 42);
    expect(old.core.terminalNote(u.id, "hello")).toBeUndefined();
  });
});

describe("`tunelo advisor note`", () => {
  const hook = (prompt: unknown) => JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt });

  it("prints the service's note as the hook's additionalContext, sending only the start of the message, the CLI's session and when it gives up", async () => {
    const printed: string[] = [];
    const asked: unknown[] = [];
    const code = await runAdvisorNote("thread-1", {
      now: () => 10_000,
      readStdin: async () => hook(`   ${"x".repeat(200)}`),
      ask: async (body) => {
        asked.push(body);
        return { note: "Advisor is on" };
      },
      print: async (line) => {
        printed.push(line);
      },
    });
    expect(code).toBe(0);
    // Gives up at 1.5 s; the service hands out nothing past 1.3 s, so the answer has time to come back.
    expect(asked).toEqual([{ thread: "thread-1", prompt: "x".repeat(64), session: "s", deadline: 11_300 }]);
    expect(printed.map((l) => JSON.parse(l) as unknown)).toEqual([{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Advisor is on" } }]);
  });

  it("prints {} and exits 0 when there is no note, no service, no answer in time or no hook input", async () => {
    const cases: { readStdin: () => Promise<string>; ask: () => Promise<unknown> }[] = [
      { readStdin: async () => hook("hi"), ask: async () => ({}) },
      { readStdin: async () => hook("hi"), ask: () => Promise.reject(new Error("tunelo is not running")) },
      { readStdin: async () => hook("hi"), ask: () => new Promise(() => undefined) },
      { readStdin: () => new Promise(() => undefined), ask: async () => ({ note: "x" }) },
      { readStdin: async () => "not json", ask: async () => ({ note: "x" }) },
      { readStdin: async () => hook(42), ask: async () => ({ note: "x" }) },
      { readStdin: () => Promise.reject(new Error("closed")), ask: async () => ({ note: "x" }) },
    ];
    for (const c of cases) {
      const printed: string[] = [];
      const started = Date.now();
      const code = await runAdvisorNote("thread-1", { ...c, timeoutMs: 50, print: async (line) => void printed.push(line) });
      expect(code).toBe(0);
      expect(printed).toEqual(["{}"]);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    // stdout gone: still exits 0.
    expect(await runAdvisorNote("t", { readStdin: async () => hook("hi"), ask: async () => ({}), print: () => Promise.reject(new Error("EPIPE")) })).toBe(0);
  });
});

describe("tunelo's MCP of the CLI in the terminal", () => {
  it("offers advisor_weigh and refuses everything else, with nothing to list from Chat or Localman", async () => {
    const { core, work } = makeCore([terminalAi().provider]);
    cores.push(core);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone" });
    const hooks: AdvisorHooks = {
      allowed: () => false,
      key: async () => undefined,
      call: (id, run) => core.advisorCall(id, run),
      isSensitive: () => false,
    };
    const host = new McpHost(tempDir("adv-term-mcp-"), { advisor: () => hooks, localWrites: () => true });
    const ticket = host.tickets.issue(t.id, "advisor-weigh");
    expect(host.maySeeWrites(ticket)).toBe(false);
    expect(await host.remoteTools(ticket)).toEqual({ tools: [], unavailable: [], writes: false });
    const session = host.open("https://tunnel.example", ticket);
    const weigh = await host.call(session, "advisor", "advisor_weigh", { kind: "decision", question: "Which?", options: ["A", "B"] });
    // Reached the tool: it refuses as automatic Advisor is off.
    expect(weigh.content).toEqual([{ type: "text", text: expect.stringContaining('"error": "off"') }]);
    for (const [group, tool] of [
      ["advisor", "advisor_git"],
      ["secrets", "request_secret"],
      ["browser", "browser_open"],
      ["tunnel", "list_local_tunnels"],
      ["chat", "send_message"],
    ] as const) {
      const refused = await host.call(session, group, tool, {});
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("only has advisor_weigh");
    }
  });
});

describe("tunelo's MCP the user added beside the terminal's", () => {
  it("a `tunelo mcp` without a ticket keeps every tool while the terminal's ticket offers advisor_weigh alone", async () => {
    const { core, work } = makeCore([terminalAi().provider]);
    cores.push(core);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone" });
    const hooks: AdvisorHooks = { allowed: () => false, key: async () => undefined, call: (id, run) => core.advisorCall(id, run), isSensitive: () => false };
    const host = new McpHost(tempDir("adv-term-both-"), { advisor: () => hooks, localWrites: () => true });
    const users = host.open("https://tunnel.example");
    const terminal = host.open("https://tunnel.example", host.tickets.issue(t.id, "advisor-weigh"));
    // The user's own server: the tunnel tools run (an empty list here), Advisor is not its business.
    const listed = await host.call(users, "tunnel", "list_local_tunnels", {});
    expect(listed.isError).not.toBe(true);
    expect(host.maySeeWrites()).toBe(true);
    // The terminal's server, at the same time: advisor_weigh only.
    expect((await host.call(terminal, "tunnel", "list_local_tunnels", {})).isError).toBe(true);
    expect(JSON.stringify((await host.call(terminal, "advisor", "advisor_weigh", { kind: "decision", question: "Which?", options: ["A", "B"] })).content)).toContain("off");
    // And the first still works after the second ran.
    expect((await host.call(users, "tunnel", "list_local_tunnels", {})).isError).not.toBe(true);
  });
});

describe("a verdict the CLI in the terminal got", () => {
  it("comes into the thread's journal from its transcript, once, beside the call it answers", async () => {
    const m = machine();
    const t = await m.thread();
    m.core.setAdvisor(t.id, true, "phone");
    await m.core.terminalLaunch(t.id);
    m.core.terminalStarted(t.id, 1, 42);
    const result = {
      advisor: "verdict",
      kind: "next_steps",
      verdict: "confident",
      choice: "Run the tests",
      confidence: 0.8,
      options: [
        { text: "Run the tests", probability: 0.8 },
        { text: "Push", probability: 0.2 },
      ],
      sent: { kind: "next_steps", question: "What next?", options: ["Run the tests", "Push"], context: "" },
    };
    m.transcript.push(
      { at: 1, type: "user", id: "u1", text: "fix it" },
      { at: 2, type: "tool-start", toolId: "tu1", kind: "mcp", name: "mcp__tunelo-advisor__advisor_weigh", summary: "", input: JSON.stringify({ kind: "next_steps" }) },
      { at: 3, type: "tool-end", toolId: "tu1", ok: true, output: JSON.stringify([{ type: "text", text: JSON.stringify(result) }]) },
      { at: 4, type: "tool-start", toolId: "tu2", kind: "read", name: "Read", summary: "a.ts", input: "{}" },
      { at: 5, type: "tool-end", toolId: "tu2", ok: true, output: "text" },
    );
    m.core.terminalEnded(1, 42);
    const items = m.core.snapshot(t.id);
    const verdicts = byCase(items, "advisorVerdict");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.id).toBe("advisor:tu1");
    expect(verdicts[0]?.body.value).toMatchObject({ toolId: "tu1", turnId: "", kind: "next_steps", verdict: "confident", error: "", question: "What next?" });
    const ids = items.map((i) => i.id);
    expect(ids.indexOf("advisor:tu1")).toBe(ids.indexOf("result:tu1") + 1);
  });
});
