// A stand-in for the Agent SDK `query()`: plays the same scripts as
// fake-provider.ts, but as raw SDK messages and canUseTool calls, so the
// Claude adapter's mapping is tested without a real `claude`.
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "../src/util/channel.ts";

export type SdkLog = {
  options: Options[];
  interrupts: number;
  models: string[];
  modes?: string[];
  flags?: unknown[];
  denials?: string[];
  /** Every user message's content as the adapter sent it. */
  prompts?: SDKUserMessage["message"]["content"][];
};

/** Whether allow rules cover a call: `Tool`, `Tool(exact)` or `Tool(prefix:*)`, as claude reads them. */
function allowedBy(rules: string[] | undefined, tool: string, content: string): boolean {
  return (rules ?? []).some((rule) => {
    if (rule === tool) return true;
    const m = /^([^(]+)\((.*)\)$/.exec(rule);
    if (!m || m[1] !== tool) return false;
    const body = m[2] ?? "";
    return body.endsWith(":*") ? content.startsWith(body.slice(0, -2)) : body === content;
  });
}

let idBase = 0;

/** `sessionId`: the id a new session gets (claude's own are UUIDs). */
export function fakeQuery(log: SdkLog = { options: [], interrupts: 0, models: [] }, opts: { sessionId?: string } = {}) {
  const fn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    log.options.push(params.options);
    const out = new Channel<SDKMessage>();
    const sessionId = params.options.resume ?? opts.sessionId ?? "claude-session-1";
    let interrupted = false;
    // Ids go on across sessions, as claude's own are unique (a resumed session never reuses one).
    let n = (idBase += 1000);
    const m = (x: unknown) => out.push(x as SDKMessage);

    const say = (text: string) => {
      const id = `msg${++n}`;
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } });
      m({ type: "assistant", parent_tool_use_id: null, uuid: `u${n}`, message: { id, content: [{ type: "text", text }] } });
    };
    const result = (ok: boolean) => m({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, duration_ms: 1 });

    void (async () => {
      m({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: [], model: "claude-test", permissionMode: params.options.permissionMode ?? "default", effort: params.options.effort ?? null, terminal_slash_commands: ["exit"] });
      const canUseTool = params.options.canUseTool;
      if (!canUseTool) throw new Error("adapter must pass canUseTool");
      for await (const msg of params.prompt) {
        (log.prompts ??= []).push(msg.message.content);
        const content = msg.message.content;
        const text =
          typeof content === "string"
            ? content
            : content.flatMap((b) => (typeof b === "object" && b.type === "text" ? [b.text] : [])).join("\n");
        const signal = new AbortController().signal;
        if (text.startsWith("ask ")) {
          const command = text.slice(4);
          const toolUseID = `tu${++n}`;
          m({ type: "assistant", parent_tool_use_id: null, uuid: `u${n}`, message: { id: `msg${n}`, content: [{ type: "tool_use", id: toolUseID, name: "Bash", input: { command } }] } });
          // As claude: a tool its allow rules (allowedTools) cover runs without asking.
          const r = allowedBy(params.options.allowedTools, "Bash", command)
            ? ({ behavior: "allow", updatedInput: { command } } as const)
            : await canUseTool("Bash", { command }, { signal, toolUseID } as Parameters<typeof canUseTool>[2]);
          if (r?.behavior === "deny") (log.denials ??= []).push(r.message);
          if (interrupted) {
            interrupted = false;
            result(false);
            continue;
          }
          m({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseID, is_error: r?.behavior === "deny", content: r?.behavior === "deny" ? "denied" : `ran ${command}` }] } });
          say(r?.behavior === "deny" ? "denied" : `ran ${command}`);
          result(true);
        } else if (text === "question") {
          const input = { questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }] };
          const r = await canUseTool("AskUserQuestion", input, { signal, toolUseID: `tu${++n}` } as Parameters<typeof canUseTool>[2]);
          const picked = r?.behavior === "allow" ? (r.updatedInput as { answers?: Record<string, string> } | undefined)?.answers?.["Pick one?"] : undefined;
          say(picked ? `you picked ${picked}` : "no answer");
          result(true);
        } else if (text.startsWith("mcpwrite ")) {
          // A write tool of tunelo's MCP (its PreToolUse hook always asks).
          const toolName = "mcp__tunelo__chat_send_message";
          const input = { chat_id: "c1", text: text.slice(9) };
          const r = allowedBy(params.options.allowedTools, toolName, "")
            ? ({ behavior: "allow", updatedInput: input } as const)
            : await canUseTool(toolName, input, { signal, toolUseID: `tu${++n}` } as Parameters<typeof canUseTool>[2]);
          say(r?.behavior === "deny" ? "not sent" : "sent");
          result(true);
        } else if (text === "limit") {
          // The account's plan usage ran out: claude says so and the turn fails.
          m({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 }, uuid: `u${++n}`, session_id: sessionId });
          m({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", uuid: `u${++n}`, message: { id: `msg${n}`, content: [{ type: "text", text: "Claude usage limit reached" }] } });
          result(false);
        } else if (text === "slow") {
          const id = `msg${++n}`;
          m({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
          m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
          while (!interrupted) {
            m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } } });
            await new Promise((r) => setTimeout(r, 5));
          }
          interrupted = false;
          result(false);
        } else {
          say(`echo: ${text.split("\n")[0]}`);
          result(true);
        }
      }
      out.close();
    })();

    const q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      async interrupt() {
        log.interrupts += 1;
        interrupted = true;
        return undefined;
      },
      async setModel(model?: string) {
        log.models.push(model ?? "");
      },
      async setPermissionMode(mode: string) {
        (log.modes ??= []).push(mode);
      },
      async applyFlagSettings(settings: unknown) {
        (log.flags ??= []).push(settings);
      },
      async accountInfo() {
        return { email: "me@example.com", subscriptionType: "max", tokenSource: "never-forwarded" };
      },
      async supportedCommands() {
        return [
          { name: "review", description: "Review the diff", argumentHint: "", builtin: false },
          { name: "exit", description: "Quit", argumentHint: "", builtin: true },
        ];
      },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return {
          session: { total_lines_added: 3, total_lines_removed: 1 },
          rate_limits: { five_hour: { utilization: 4.4, resets_at: "2026-11-08T12:00:00Z" }, seven_day: { utilization: 80, resets_at: null } },
        };
      },
      async getContextUsage() {
        return { totalTokens: 1000, maxTokens: 200000 };
      },
      close() {
        out.close();
      },
    };
    return q as unknown as Query;
  };
  return { fn, log };
}
