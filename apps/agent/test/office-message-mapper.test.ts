// What the Claude mapper adds for the office view: a subagent's kind and
// whether it runs in the background, its tool calls by name (start and end),
// and the end of background work; the chat sees no new card.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { MessageMapper } from "../src/providers/claude/message-mapper.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const sdk = (m: unknown) => m as SDKMessage;

function mapped(...messages: unknown[]): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const mapper = new MessageMapper("/w", (e) => events.push(e));
  for (const m of messages) mapper.map(sdk(m));
  return events;
}

describe("the Claude mapper for the office", () => {
  it("names a subagent's kind and whether it runs in the background", () => {
    const events = mapped({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "a1", name: "Agent", input: { description: "Review", subagent_type: "code-reviewer", prompt: "secret prompt" } },
          { type: "tool_use", id: "a2", name: "Task", input: { description: "Dig", subagent_type: "  scout\u0007 ", run_in_background: true } },
          { type: "tool_use", id: "a3", name: "Agent", input: { description: "Plain" } },
        ],
      },
    });
    expect(events).toEqual([
      { type: "subagent", toolId: "a1", description: "Review", done: false, agentType: "code-reviewer" },
      { type: "subagent", toolId: "a2", description: "Dig", done: false, agentType: "scout", background: true },
      { type: "subagent", toolId: "a3", description: "Plain", done: false },
    ]);
  });

  it("passes a subagent's tool calls by name, a shell's command kept for the room only, and their results' ok", () => {
    const events = mapped(
      {
        type: "assistant",
        parent_tool_use_id: "a1",
        message: {
          id: "m2",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test", description: "run tests" } },
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/secret.ts" } },
            { type: "tool_use", id: "t3", name: "Agent", input: { description: "Nested", subagent_type: "tester" } },
          ],
        },
      },
      {
        type: "user",
        parent_tool_use_id: "a1",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "secret output" }, { type: "tool_result", tool_use_id: "t2", content: "file body" }] },
      },
    );
    expect(events).toEqual([
      { type: "subagent-tool", parentToolId: "a1", toolId: "t1", name: "Bash", kind: "shell", done: false, command: "pnpm test" },
      { type: "subagent-tool", parentToolId: "a1", toolId: "t2", name: "Read", kind: "read", done: false },
      { type: "subagent-tool", parentToolId: "a1", toolId: "t3", name: "Agent", kind: "subagent", done: false, agentType: "tester" },
      { type: "subagent-tool", parentToolId: "a1", toolId: "t1", name: "", kind: "other", done: true, ok: false },
      { type: "subagent-tool", parentToolId: "a1", toolId: "t2", name: "", kind: "other", done: true, ok: true },
    ]);
    // Neither the subagent's tool input nor its results ride on any event.
    const text = JSON.stringify(events);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("file body");
    expect(events.some((e) => e.type === "tool-start" || e.type === "tool-end")).toBe(false);
  });

  it("reports the end of background work by its tool call", () => {
    const events = mapped(
      { type: "system", subtype: "task_notification", task_id: "x", tool_use_id: "a2", status: "completed", output_file: "/tmp/o", summary: "done: secret" },
      { type: "system", subtype: "task_notification", task_id: "y", tool_use_id: "b9", status: "failed", output_file: "", summary: "" },
      { type: "system", subtype: "task_notification", task_id: "z", status: "stopped", output_file: "", summary: "" },
    );
    expect(events).toEqual([
      { type: "background-task", toolId: "a2", ok: true },
      { type: "background-task", toolId: "b9", ok: false },
    ]);
  });

  it("keeps a background subagent's immediate tool result as the chat's done card", () => {
    const events = mapped(
      { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "tool_use", id: "a2", name: "Agent", input: { description: "Dig", run_in_background: true } }] } },
      { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a2", content: "launched" }] } },
    );
    expect(events.at(-1)).toEqual({ type: "subagent", toolId: "a2", description: "", done: true });
  });
});
