// A stand-in for `agy acp` speaking ACP over in-memory streams, with the
// message shapes recorded from agy 1.5.8 (test/fixtures/acp/antigravity).
// It plays the same scripts as the fake Claude SDK: "ask <command>" asks for
// permission to run it, "slow" streams until cancelled, anything else echoes.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AcpLaunch, AcpProcess } from "../../src/providers/acp/acp-client.ts";

export type FakeAgyLog = {
  launches: AcpLaunch[];
  requests: { method: string; params: Record<string, unknown> }[];
  /** Option ids answered to permission requests. */
  answers: string[];
};

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

export function fakeAgy(log: FakeAgyLog = { launches: [], requests: [], answers: [] }) {
  let sessions = 0;
  const spawnProcess = (launch: AcpLaunch): AcpProcess => {
    log.launches.push(launch);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let nextAsk = 0;
    const asks = new Map<string, (optionId: string) => void>();
    const cancelled = new Set<string>();
    const send = (m: unknown) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...(m as object) })}\n`);
    const update = (sessionId: string, u: Record<string, unknown>) => send({ method: "session/update", params: { sessionId, update: u } });
    const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const answer = (id: number | string | undefined, result: unknown) => send({ id, result });
    const opened = (id: number | string | undefined, sessionId: string) => {
      answer(id, {
        sessionId,
        models: { availableModels: [{ modelId: "gemini-test", name: "Gemini Test" }, { modelId: "small", name: "Small" }], currentModelId: "gemini-test" },
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }] },
      });
      setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review the diff" }] }), 0);
    };

    const prompt = async (id: number | string | undefined, p: Record<string, unknown>) => {
      const sessionId = String(p.sessionId);
      const blocks = (p.prompt as { type: string; text?: string }[]) ?? [];
      const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
      const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 0, totalTokens: 15 };
      update(sessionId, { sessionUpdate: "usage_update", used: 1000, size: 1_048_576 });
      if (text.startsWith("ask ")) {
        const command = text.slice(4);
        const toolCallId = `call_${++nextAsk}`;
        const call = { toolCallId, name: "run_command", kind: "execute", title: command, rawInput: { CommandLine: command } };
        update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
        const askId = String(nextAsk);
        const picked = await new Promise<string>((resolve) => {
          asks.set(askId, resolve);
          send({ id: askId, method: "session/request_permission", params: { sessionId, toolCall: { ...call, status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
        });
        log.answers.push(picked);
        if (cancelled.delete(sessionId) || picked === "") return answer(id, { stopReason: "cancelled" });
        const ok = picked === "allow";
        update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: ok ? "completed" : "failed", ...(ok ? { rawOutput: { output: `ran ${command}`, exit_code: 0 } } : {}) });
        say(sessionId, ok ? `ran ${command}` : "denied");
        return answer(id, { stopReason: "end_turn", usage });
      }
      if (text === "slow") {
        while (!cancelled.has(sessionId)) {
          say(sessionId, ".");
          await new Promise((r) => setTimeout(r, 5));
        }
        cancelled.delete(sessionId);
        return answer(id, { stopReason: "cancelled" });
      }
      if (text === "think") update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      say(sessionId, `echo: ${text.split("\n")[0] ?? ""}`);
      return answer(id, { stopReason: "end_turn", usage });
    };

    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = JSON.parse(line) as Msg;
        if (m.method === undefined) {
          // An answer to our permission request.
          const r = m.result as { outcome?: { outcome?: string; optionId?: string } } | undefined;
          asks.get(String(m.id))?.(r?.outcome?.outcome === "selected" ? (r.outcome.optionId ?? "") : "");
          asks.delete(String(m.id));
          continue;
        }
        const p = m.params ?? {};
        log.requests.push({ method: m.method, params: p });
        switch (m.method) {
          case "initialize":
            answer(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
            break;
          case "session/new":
            opened(m.id, `agy-session-${++sessions}`);
            break;
          case "session/resume":
            opened(m.id, String(p.sessionId));
            break;
          case "session/prompt":
            void prompt(m.id, p);
            break;
          case "session/cancel":
            cancelled.add(String(p.sessionId));
            for (const [k, resolve] of asks) {
              resolve("");
              asks.delete(k);
            }
            break;
          case "session/set_mode":
            answer(m.id, {});
            update(String(p.sessionId), { sessionUpdate: "current_mode_update", currentModeId: String(p.modeId) });
            break;
          case "session/list":
            answer(m.id, { sessions: [] });
            break;
          default:
            answer(m.id, {});
        }
      }
    });
    const proc = {
      stdin,
      stdout,
      stderr,
      kill: () => {
        setTimeout(() => events.emit("exit", 0, null), 0);
        return true;
      },
      once: (event: string, fn: (...args: unknown[]) => void) => {
        events.once(event, fn);
        return proc;
      },
    };
    return proc as unknown as AcpProcess;
  };
  return { spawnProcess, log };
}
