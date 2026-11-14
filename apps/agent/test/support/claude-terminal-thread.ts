// A thread whose Claude runs in a terminal of the machine, with what Claude
// itself keeps on disk made up by the test: transcripts in a Claude folder and
// the register of running claudes (<claude folder>/sessions/<pid>.json). This
// test process (and its parent) stand in for running claudes; when each of
// them started, as the system would tell, is set by the test too.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCore } from "../../src/core/agent-core.ts";
import { createClaudeProvider } from "../../src/providers/claude/index.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import { fakeQuery } from "../fake-sdk.ts";
import { makeCore, tempDir } from "../harness.ts";
import { Transcript } from "./claude-transcript.ts";

const none = { sensitive: false, projectSettings: false };

/** The pid the stand-in terminal process reports. */
export const HOST_PID = 4242;

/** What the tests read of a thread's saved record. */
type SavedMeta = { segments: { sessionId?: string }[]; terminal?: { startedAt?: number } };

export type HeldThread = {
  core: AgentCore;
  thread: { id: string };
  /** The session id the CLI was started with. */
  launched: string;
  /** Unix ms when the terminal started the CLI, as the thread recorded it. */
  startedAt: number;
  work: string;
  /**
   * A running claude's record in the register: by default the terminal's CLI
   * (this folder, started with the terminal). The process `pid` is taken to
   * have started then too, unless the test says otherwise (startedAgain).
   */
  register: (pid: number, sessionId: string, at?: number, cwd?: string, extra?: Record<string, unknown>) => void;
  /** Process `pid` now is another program that started at `at` (the pid was given out again). */
  startedAgain: (pid: number, at: number) => void;
  /** A session kept on the machine, written an hour ago. */
  conversation: (id: string, user: string, answer: string) => void;
  /** One more turn in a session made by `conversation`. */
  reply: (id: string, user: string, answer: string) => void;
  /** The session id of each of the thread's segments, oldest first. */
  segments: () => (string | undefined)[];
};

/**
 * A thread opened with no message and handed to the terminal: the CLI starts
 * a new session with the id the thread keeps. `cores` collects the core so
 * the test file stops it; `others` are more AIs the machine has.
 */
export async function heldByTerminal(cores: AgentCore[], others: AgentProvider[] = []): Promise<HeldThread> {
  const claudeHome = tempDir("claude-home-");
  mkdirSync(join(claudeHome, "sessions"));
  /** When each stand-in process started, as the system tells. */
  const starts = new Map<number, number>();
  const provider = createClaudeProvider({
    query: fakeQuery().fn,
    findBinary: async () => "claude",
    homes: () => [claudeHome],
    processStart: async (pid) => {
      const at = starts.get(pid);
      return at === undefined ? undefined : { startedAt: at };
    },
  });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const { core, work, dataDir } = makeCore([provider, ...others]);
  cores.push(core);
  const thread = await core.create({ provider: "claude", model: "", dir: work, text: "", consent: none, device: "phone" });
  const spec = await core.terminalLaunch(thread.id);
  const launched = spec.args[spec.args.indexOf("--session-id") + 1] ?? "";
  core.terminalStarted(thread.id, 1, HOST_PID);
  const meta = (): SavedMeta => JSON.parse(readFileSync(join(dataDir, "threads", thread.id, "meta.json"), "utf8")) as SavedMeta;
  const startedAt = meta().terminal?.startedAt ?? 0;
  const register = (pid: number, sessionId: string, at = startedAt + 1_200, cwd = work, extra: Record<string, unknown> = {}): void => {
    starts.set(pid, at);
    writeFileSync(join(claudeHome, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, startedAt: at, kind: "interactive", entrypoint: "cli", ...extra }));
  };
  const startedAgain = (pid: number, at: number): void => {
    starts.set(pid, at);
  };
  const transcripts = new Map<string, Transcript>();
  const save = (t: Transcript): void => {
    const file = t.write(claudeHome);
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(file, hourAgo, hourAgo);
  };
  const conversation = (id: string, user: string, answer: string): void => {
    const t = new Transcript(id, work, "cli").opening();
    t.user(user);
    t.assistant([{ type: "text", text: answer }]);
    transcripts.set(id, t);
    save(t);
  };
  const reply = (id: string, user: string, answer: string): void => {
    const t = transcripts.get(id);
    if (!t) throw new Error(`no conversation ${id}`);
    t.user(user);
    t.assistant([{ type: "text", text: answer }]);
    save(t);
  };
  const segments = (): (string | undefined)[] => meta().segments.map((s) => s.sessionId);
  return { core, thread, launched, startedAt, work, register, startedAgain, conversation, reply, segments };
}
