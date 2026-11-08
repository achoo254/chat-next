// Write tools of tunelo's MCP in a session tunelo opened: an approval card on
// the device exactly once per acting call in default, acceptEdits and auto
// (even under an allow rule), none in bypassPermissions. The stand-in for
// claude below follows its permission order: PreToolUse hooks first ("ask"
// goes to canUseTool, past any allow rule), then the mode and allow rules.
import { Decision, PromptState, TurnState } from "@achoo254/chat-proto/remote/remote";
import type { HookCallbackMatcher, Options, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { AgentCore } from "../../src/core/agent-core.ts";
import { createClaudeProvider, writeApprovalHook } from "../../src/providers/claude/index.ts";
import { Channel } from "../../src/util/channel.ts";
import { byCase, makeCore, until } from "../harness.ts";

const consent = { sensitive: false, projectSettings: false };

type HookInput = Parameters<typeof writeApprovalHook>[0];

function hookInput(tool: string, input: Record<string, unknown>, mode: string): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tu", permission_mode: mode, session_id: "s", transcript_path: "", cwd: "/" } as HookInput;
}

async function decision(tool: string, input: Record<string, unknown>, mode: string): Promise<string | undefined> {
  const out = (await writeApprovalHook(hookInput(tool, input, mode), "tu", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision;
}

describe("the PreToolUse hook", () => {
  it("asks for write tools in every mode but bypassPermissions", async () => {
    for (const mode of ["default", "acceptEdits", "auto", "plan"]) {
      expect(await decision("mcp__tunelo__chat_send_message", { chat_id: 1, text: "x" }, mode)).toBe("ask");
      expect(await decision("mcp__tunelo__localman_send_request", { method: "GET", url: "http://localhost:5173" }, mode)).toBe("ask");
      expect(await decision("mcp__tunelo__open_http_tunnel", { port: 3000 }, mode)).toBe("ask");
    }
    expect(await decision("mcp__tunelo__chat_send_message", { chat_id: 1, text: "x" }, "bypassPermissions")).toBeUndefined();
  });

  it("leaves read tools, other servers and the dry run of a two-step tool alone", async () => {
    expect(await decision("mcp__tunelo__chat_get_messages", { chat_id: 1 }, "default")).toBeUndefined();
    expect(await decision("mcp__tunelo__localman_list_history", {}, "auto")).toBeUndefined();
    expect(await decision("mcp__other__chat_send_message", {}, "default")).toBeUndefined();
    expect(await decision("Bash", { command: "ls" }, "default")).toBeUndefined();
    expect(await decision("mcp__tunelo__revoke_linked_machine", { id: "l1", dry_run: true }, "auto")).toBeUndefined();
    expect(await decision("mcp__tunelo__revoke_linked_machine", { id: "l1", confirm_token: "abc" }, "auto")).toBe("ask");
  });
});

/** claude, as far as permissions go: mode from the machine's settings, allow rules, hooks, canUseTool. */
function fakeClaude(mode: string, allowRules: string[]) {
  const options: Options[] = [];
  const ran: string[] = [];
  const allowed = (tool: string) => allowRules.some((rule) => (rule.endsWith("*") ? tool.startsWith(rule.slice(0, -1)) : tool === rule));
  const fn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    options.push(params.options);
    const out = new Channel<SDKMessage>();
    const m = (x: unknown) => out.push(x as SDKMessage);
    let n = 0;
    void (async () => {
      const current = params.options.permissionMode ?? mode;
      m({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [], model: "m", permissionMode: current, terminal_slash_commands: [] });
      const canUseTool = params.options.canUseTool;
      if (!canUseTool) throw new Error("adapter must pass canUseTool");
      for await (const msg of params.prompt) {
        const text = typeof msg.message.content === "string" ? msg.message.content : "";
        const [, tool = "", json = "{}"] = /^call (\S+) (.*)$/.exec(text) ?? [];
        const input = JSON.parse(json) as Record<string, unknown>;
        const id = `tu${++n}`;
        m({ type: "assistant", parent_tool_use_id: null, uuid: `u${n}`, message: { id: `msg${n}`, content: [{ type: "tool_use", id, name: tool, input }] } });
        let hookDecision: string | undefined;
        for (const matcher of (params.options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
          if (matcher.matcher && !new RegExp(matcher.matcher).test(tool)) continue;
          for (const hook of matcher.hooks) {
            const r = (await hook(hookInput(tool, input, current), id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
            hookDecision = r.hookSpecificOutput?.permissionDecision ?? hookDecision;
          }
        }
        let ok: boolean;
        if (hookDecision === "ask" || !(current === "bypassPermissions" || current === "auto" || allowed(tool))) {
          const r = await canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: id } as Parameters<typeof canUseTool>[2]);
          ok = r?.behavior === "allow";
          if (r?.behavior === "allow") {
            const updates = (r as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions ?? [];
            for (const update of updates) {
              if (update.type === "addRules") for (const rule of update.rules) allowRules.push(rule.toolName);
            }
          }
        } else ok = true;
        if (ok) ran.push(tool);
        m({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !ok, content: ok ? "done" : "denied" }] } });
        m({ type: "result", subtype: "success", is_error: false, duration_ms: 1 });
      }
      out.close();
    })();
    const q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => undefined,
      accountInfo: async () => ({}),
      supportedCommands: async () => [],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session: { total_lines_added: 0, total_lines_removed: 0 } }),
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1 }),
      close: () => out.close(),
    };
    return q as unknown as Query;
  };
  return { fn, options, ran };
}

/** Runs `calls` in one thread, answering every card with `answer`; returns how many cards came. */
async function run(mode: string, allowRules: string[], calls: [string, Record<string, unknown>][], answer = Decision.ALLOW) {
  const claude = fakeClaude(mode, allowRules);
  const provider = createClaudeProvider({ query: claude.fn, findBinary: async () => "claude" });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const { core, work } = makeCore([provider]);
  const answered = new Set<string>();
  const answerCards = (c: AgentCore, threadId: string) => {
    for (const card of byCase(c.snapshot(threadId), "approval")) {
      if (card.body.value.state !== PromptState.PENDING || answered.has(card.id)) continue;
      answered.add(card.id);
      c.respond(threadId, card.id, card.revision, { decision: answer }, "test");
    }
  };
  const [first, ...rest] = calls;
  if (!first) throw new Error("no call");
  const t = await core.create({ provider: "claude", model: "", dir: work, text: `call ${first[0]} ${JSON.stringify(first[1])}`, consent, device: "test" });
  // A card is answerable once put() returns: answer on the next tick.
  const off = core.onItems((id) => {
    if (id === t.id) setTimeout(() => answerCards(core, t.id), 0);
  });
  answerCards(core, t.id);
  const turns = (k: number) => (items: ReturnType<AgentCore["snapshot"]>) => byCase(items, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length >= k;
  await until(core, t.id, turns(1));
  let done = 1;
  for (const [tool, input] of rest) {
    await core.send(t.id, `call ${tool} ${JSON.stringify(input)}`, "test");
    await until(core, t.id, turns(++done));
  }
  off();
  const cards = byCase(core.snapshot(t.id), "approval").length;
  await core.stop();
  return { cards, ran: claude.ran, options: claude.options };
}

const SEND: [string, Record<string, unknown>] = ["mcp__tunelo__chat_send_message", { chat_id: 7, text: "test" }];

describe("write tools in a session", () => {
  for (const mode of ["default", "acceptEdits", "auto"]) {
    it(`shows exactly one card per send in ${mode}, even with an allow rule for every tunelo tool`, async () => {
      const r = await run(mode, ["mcp__tunelo__*"], [SEND]);
      expect(r.cards).toBe(1);
      expect(r.ran).toEqual(["mcp__tunelo__chat_send_message"]);
    });
  }

  it("asks once for a two-step tool: on the call with the confirm token, not the dry run", async () => {
    const r = await run("auto", ["mcp__tunelo__*"], [
      ["mcp__tunelo__revoke_linked_machine", { id: "l1", dry_run: true }],
      ["mcp__tunelo__revoke_linked_machine", { id: "l1", confirm_token: "tok" }],
    ]);
    expect(r.cards).toBe(1);
  });

  it("runs read tools without a card under an allow rule", async () => {
    const r = await run("auto", ["mcp__tunelo__*"], [["mcp__tunelo__chat_get_messages", { chat_id: 7 }]]);
    expect(r.cards).toBe(0);
  });

  it("runs a write tool without a card in bypassPermissions set on the machine", async () => {
    const r = await run("bypassPermissions", [], [SEND, ["mcp__tunelo__localman_send_request", { method: "GET", url: "http://localhost:5173" }]]);
    expect(r.cards).toBe(0);
    expect(r.ran).toHaveLength(2);
  });

  it("allow for the session adds no rule for a write tool: the next send asks again", async () => {
    const r = await run("default", [], [SEND, SEND], Decision.ALLOW_SESSION);
    expect(r.cards).toBe(2);
  });

  it("a refused card sends nothing", async () => {
    const r = await run("auto", ["mcp__tunelo__*"], [SEND], Decision.DENY);
    expect(r.cards).toBe(1);
    expect(r.ran).toEqual([]);
  });
});
