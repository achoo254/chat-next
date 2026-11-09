// Maps the Agent SDK's messages of a session's top-level conversation onto
// ProviderEvents. Tool calls and results go through the same code whether
// they arrive live or are read back from Claude Code's transcript.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent, TodoEntry } from "../types.ts";
import { resultText, toolDiff, toolKind, toolSummary } from "./tool-map.ts";

/** A reset time claude gives in Unix seconds (or milliseconds) as milliseconds; 0 when absent. */
const epochMs = (t: number | undefined) => (t && t > 0 ? (t < 1e12 ? t * 1000 : t) : 0);

/** Maps SDK messages of the top-level conversation onto ProviderEvents. */
export class MessageMapper {
  private messageId = "";
  private streamed = new Set<string>();
  private blocks = new Map<number, { id: string; role: "assistant" | "thinking"; text: string }>();
  private subagents = new Set<string>();
  private hidden = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly emit: (e: ProviderEvent) => void,
  ) {}

  map(msg: SDKMessage): void {
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return; // inside a subagent
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.emit({ type: "session", sessionId: msg.session_id });
        else if (msg.subtype === "compact_boundary") this.emit({ type: "compaction", tokensBefore: msg.compact_metadata.pre_tokens });
        return;
      case "stream_event":
        this.stream(msg.event);
        return;
      case "assistant":
        this.assistant(msg);
        return;
      case "user":
        this.toolResults(msg.message.content);
        return;
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        if (info.status === "rejected") this.emit({ type: "limit-reached", resetsAt: epochMs(info.resetsAt) });
        return;
      }
      default:
        return;
    }
  }

  private stream(ev: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    if (ev.type === "message_start") {
      this.messageId = ev.message.id;
      this.streamed.add(ev.message.id);
      this.blocks.clear();
    } else if (ev.type === "content_block_start") {
      const t = ev.content_block.type;
      if (t === "text" || t === "thinking") {
        this.blocks.set(ev.index, { id: `${this.messageId}:${ev.index}`, role: t === "text" ? "assistant" : "thinking", text: "" });
      }
    } else if (ev.type === "content_block_delta") {
      const b = this.blocks.get(ev.index);
      if (!b) return;
      const d = ev.delta;
      const text = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : "";
      if (!text) return;
      b.text += text;
      this.emit({ type: "text-delta", blockId: b.id, role: b.role, text });
    } else if (ev.type === "content_block_stop") {
      const b = this.blocks.get(ev.index);
      if (b) this.emit({ type: "text", blockId: b.id, role: b.role, text: b.text });
      this.blocks.delete(ev.index);
    }
  }

  private assistant(msg: Extract<SDKMessage, { type: "assistant" }>) {
    if (msg.error === "authentication_failed" || msg.error === "oauth_org_not_allowed") {
      this.emit({ type: "error", message: "Claude needs to sign in again on this machine.", needsLogin: true });
    }
    if (msg.error === "rate_limit") this.emit({ type: "limit-reached", resetsAt: 0 });
    const streamed = this.streamed.has(msg.message.id);
    msg.message.content.forEach((block, i) => {
      if (block.type === "text" && !streamed) {
        this.emit({ type: "text", blockId: `${msg.message.id}:${i}:${msg.uuid}`, role: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        this.toolUse(block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
      }
    });
  }

  /** A tool call of the conversation (also from a transcript read back). */
  toolUse(id: string, name: string, input: Record<string, unknown>) {
    if (name === "AskUserQuestion") {
      this.hidden.add(id);
      return;
    }
    if (name === "TodoWrite") {
      this.hidden.add(id);
      const todos = (input.todos as { content?: string; status?: string }[] | undefined) ?? [];
      const entries: TodoEntry[] = todos.map((t) => ({
        text: t.content ?? "",
        state: t.status === "completed" ? "done" : t.status === "in_progress" ? "in-progress" : "pending",
      }));
      this.emit({ type: "todo", entries });
      return;
    }
    const kind = toolKind(name);
    if (kind === "subagent") {
      this.subagents.add(id);
      this.emit({ type: "subagent", toolId: id, description: toolSummary(name, input, this.dir), done: false });
      return;
    }
    this.emit({
      type: "tool-start",
      toolId: id,
      kind,
      name,
      summary: toolSummary(name, input, this.dir),
      input: JSON.stringify(input),
    });
    const diff = toolDiff(name, input, this.dir);
    if (diff) this.emit({ type: "diff", toolId: id, ...diff });
  }

  /** Tool results in a user message's content (also from a transcript read back). */
  toolResults(content: unknown) {
    if (!Array.isArray(content)) return;
    for (const b of content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      if (this.hidden.has(b.tool_use_id)) continue;
      if (this.subagents.has(b.tool_use_id)) {
        this.emit({ type: "subagent", toolId: b.tool_use_id, description: "", done: true });
        continue;
      }
      this.emit({ type: "tool-end", toolId: b.tool_use_id, ok: !b.is_error, output: resultText(b.content) });
    }
  }
}
