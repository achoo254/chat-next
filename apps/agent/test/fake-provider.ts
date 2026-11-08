// A scripted adapter for tests. The message text picks the script:
//   "ask <cmd>"  asks approval for a shell command, runs it if allowed
//   "question"   asks a question and echoes the answer
//   "slow"       streams until interrupted
//   anything else: echoes it back
import { Channel } from "../src/util/channel.ts";
import type { AgentProvider, AskUser, ProviderEvent, ProviderSession, SessionPolicy } from "../src/providers/types.ts";

export type FakeLog = {
  starts: { resumeId?: string; model?: string; effort?: string; permissionMode?: string; allowBypass?: boolean }[];
  sent: string[];
  closed: number;
  /** The mode the machine's own settings start a session in. */
  machineMode?: string;
  modes?: string[];
  efforts?: string[];
};

export function fakeProvider(id = "fake", log: FakeLog = { starts: [], sent: [], closed: 0 }): AgentProvider & { log: FakeLog } {
  return {
    id,
    name: id === "fake" ? "Fake AI" : id,
    log,
    capabilities: {
      interrupt: true,
      resume: true,
      sessionAllow: true,
      questions: true,
      todo: false,
      contextUsage: false,
      compaction: false,
      diff: false,
      images: false,
      models: [{ id: "small", name: "Small" }],
      effortLevels: ["low", "high"],
      permissionModes: ["default", "plan"],
    },
    async detect() {
      return { installed: true, version: "1.0.0", loginState: "ok" };
    },
    async start({ policy, resumeId, askUser }) {
      log.starts.push({
        ...(resumeId ? { resumeId } : {}),
        ...(policy.model ? { model: policy.model } : {}),
        ...(policy.effort ? { effort: policy.effort } : {}),
        ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}),
        ...(policy.allowBypass ? { allowBypass: true } : {}),
      });
      return fakeSession(id, policy, askUser, log, resumeId);
    },
  };
}

function fakeSession(id: string, policy: SessionPolicy, askUser: AskUser, log: FakeLog, resumeId?: string): ProviderSession {
  const events = new Channel<ProviderEvent>();
  let turn = 0;
  let abort: AbortController | undefined;
  let closed = false;
  events.push({ type: "session", sessionId: resumeId ?? `${id}-session-1` });
  events.push({ type: "info", permissionMode: policy.permissionMode ?? log.machineMode ?? "default", commands: [{ name: "review", description: "Review the diff", argumentHint: "", builtin: false }] });

  async function runTurn(text: string) {
    turn += 1;
    abort = new AbortController();
    const signal = abort.signal;
    const block = `t${turn}`;
    const say = (s: string) => {
      events.push({ type: "text-delta", blockId: block, role: "assistant", text: s });
      events.push({ type: "text", blockId: block, role: "assistant", text: s });
    };
    if (text.startsWith("ask ")) {
      const cmd = text.slice(4);
      const ans = await askUser(
        { kind: "approval", toolId: `tool${turn}`, toolKind: "shell", name: "Shell", summary: cmd, input: JSON.stringify({ command: cmd }), sensitive: policy.isSensitive(cmd) },
        signal,
      );
      if (signal.aborted) return events.push({ type: "turn-end", state: "interrupted", durationMs: 1 });
      if (ans.decision !== "deny") {
        events.push({ type: "tool-start", toolId: `tool${turn}`, kind: "shell", name: "Shell", summary: cmd, input: "{}" });
        events.push({ type: "tool-end", toolId: `tool${turn}`, ok: true, output: `ran ${cmd}` });
      }
      say(ans.decision === "deny" ? "denied" : `ran ${cmd}`);
    } else if (text === "question") {
      const ans = await askUser(
        { kind: "question", toolId: `q${turn}`, questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }] },
        signal,
      );
      say("cancelled" in ans ? "no answer" : `you picked ${ans.answers[0]?.join(",")}`);
    } else if (text === "slow") {
      while (!signal.aborted) {
        events.push({ type: "text-delta", blockId: block, role: "assistant", text: "." });
        await new Promise((r) => setTimeout(r, 5));
      }
      return events.push({ type: "turn-end", state: "interrupted", durationMs: 1 });
    } else {
      say(`echo: ${text.split("\n")[0]}`);
    }
    events.push({ type: "turn-end", state: "completed", durationMs: 1 });
  }

  let chain = Promise.resolve();
  return {
    events,
    async send(text) {
      log.sent.push(text);
      chain = chain.then(() => runTurn(text) as Promise<void>);
    },
    async interrupt() {
      abort?.abort();
    },
    async setModel() {
      // nothing to do
    },
    async setEffort(effort) {
      (log.efforts ??= []).push(effort);
      events.push({ type: "info", effort });
    },
    async setPermissionMode(mode) {
      (log.modes ??= []).push(mode);
      events.push({ type: "info", permissionMode: mode });
    },
    async close() {
      if (closed) return;
      closed = true;
      log.closed += 1;
      abort?.abort();
      await chain;
      events.close();
    },
  };
}
