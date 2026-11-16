// Advisor in each AI's adapter: advisor_weigh goes on without an approval
// card only while Advisor may be asked in the session (Claude: a PreToolUse
// hook; agy: its permission request), and Claude hears Advisor's
// instructions beside the prompt (UserPromptSubmit context), never in the
// user's words.
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AUTO_INSTRUCTIONS, AUTO_REMINDER, NOTE_SEPARATOR } from "../src/advisor/advisor-instructions.ts";
import { PromptNotes, advisorWeighHook, createClaudeProvider } from "../src/providers/claude/index.ts";
import { answerPermission, type PermissionContext } from "../src/providers/antigravity/permissions.ts";
import type { AcpPermissionParams } from "../src/providers/acp/acp-session.ts";
import type { ApprovalRequest, AskUser, SessionNote } from "../src/providers/types.ts";
import { ADVISOR_OFF_REFUSAL } from "../src/advisor/advisor-tools.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, until } from "./harness.ts";

const signal = new AbortController().signal;
const run = (hook: HookCallback, input: Record<string, unknown>) => hook(input as unknown as HookInput, undefined, { signal });
const preToolUse = (tool: string) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/w", permission_mode: "default" });
const prompt = (text: string) => ({ hook_event_name: "UserPromptSubmit", prompt: text, session_id: "s", transcript_path: "", cwd: "/w" });

describe("Claude: advisor_weigh without a card", () => {
  it("allowed while Advisor may be asked, refused at once otherwise; only advisor_weigh of tunelo's MCP", async () => {
    let allowed = true;
    const hook = advisorWeighHook(() => allowed);
    expect(await run(hook, preToolUse("mcp__tunelo__advisor_weigh"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    expect(await run(hook, preToolUse("mcp__tunelo__chat_send_message"))).toEqual({});
    expect(await run(hook, preToolUse("mcp__other__advisor_weigh"))).toEqual({});
    allowed = false;
    expect(await run(hook, preToolUse("mcp__tunelo__advisor_weigh"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_OFF_REFUSAL },
    });
  });
});

describe("Claude: notes beside the prompt", () => {
  /** A note as the core hands it: its text while it holds, and whether the AI got it. */
  const note = (text: string, holds = true) => {
    const seen = { delivered: false };
    const n: SessionNote = { take: () => (holds ? text : undefined), delivered: () => void (seen.delivered = true) };
    return { n, seen };
  };
  const context = (text: string) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });

  it("each prompt takes its own message's note, in order; a command takes none", async () => {
    const notes = new PromptNotes();
    const a = note(AUTO_INSTRUCTIONS);
    const b = note(AUTO_REMINDER);
    notes.add("first", a.n);
    notes.add("second", b.n);
    expect(await run(notes.hook, prompt("/compact"))).toEqual({});
    expect(await run(notes.hook, prompt("first"))).toEqual(context(AUTO_INSTRUCTIONS));
    expect(a.seen.delivered).toBe(true);
    expect(await run(notes.hook, prompt("second"))).toEqual(context(AUTO_REMINDER));
    expect(await run(notes.hook, prompt("third"))).toEqual({});
  });

  it("a prompt that matches no message takes no note (never an older one)", async () => {
    const notes = new PromptNotes();
    const a = note(AUTO_INSTRUCTIONS);
    notes.add("first", a.n);
    expect(await run(notes.hook, prompt("something else"))).toEqual({});
    expect(a.seen.delivered).toBe(false);
    expect(await run(notes.hook, prompt("first"))).toEqual(context(AUTO_INSTRUCTIONS));
  });

  it("a message whose hook never ran: its note is dropped, not given to the next prompt", async () => {
    const notes = new PromptNotes();
    const a = note(AUTO_INSTRUCTIONS);
    const b = note(AUTO_REMINDER);
    notes.add("first", a.n);
    notes.add("second", b.n);
    expect(await run(notes.hook, prompt("second"))).toEqual(context(AUTO_REMINDER));
    expect(a.seen.delivered).toBe(false);
    expect(await run(notes.hook, prompt("first"))).toEqual({});
  });

  it("a note that no longer holds (Advisor turned off since) gives nothing; a stopped turn drops what waits", async () => {
    const notes = new PromptNotes();
    const stale = note(AUTO_INSTRUCTIONS, false);
    notes.add("first", stale.n);
    expect(await run(notes.hook, prompt("first"))).toEqual({});
    expect(stale.seen.delivered).toBe(false);
    notes.add("second", note(AUTO_REMINDER).n);
    notes.clear();
    expect(await run(notes.hook, prompt("second"))).toEqual({});
  });

  it("through the core: the prompt is the user's words, the note goes in the hook, the card is skipped", async () => {
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const { core, work } = makeCore([provider], {
      sessionMcp: () => ({ ticket: "t-1", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => undefined }),
    });
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: false }, device: "test" });
    await until(core, t.id, (i) => byCase(i, "turn").every((x) => x.body.value.state !== TurnState.RUNNING));
    core.setAdvisor(t.id, true, "phone");
    await core.send(t.id, "fix it", "m1");
    await until(core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length === 2);
    expect(sdk.log.prompts?.at(-1)).toBe("fix it");
    expect(JSON.stringify(sdk.log.prompts)).not.toContain(NOTE_SEPARATOR.trim());
    const options = sdk.log.options.at(-1);
    const submit = options?.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    if (!submit) throw new Error("no UserPromptSubmit hook");
    // The hook already ran for "fix it" in a real claude; the fake does not run hooks, so the note still waits.
    expect(await run(submit, prompt("fix it"))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: AUTO_INSTRUCTIONS } });
    const pre = options?.hooks?.PreToolUse?.[0]?.hooks ?? [];
    const decisions = await Promise.all(pre.map((h) => run(h, preToolUse("mcp__tunelo__advisor_weigh"))));
    expect(decisions).toContainEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    core.setAdvisor(t.id, false, "phone");
    const after = await Promise.all(pre.map((h) => run(h, preToolUse("mcp__tunelo__advisor_weigh"))));
    expect(after).toContainEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_OFF_REFUSAL } });
    expect(after.some((d) => JSON.stringify(d).includes('"allow"'))).toBe(false);
    await core.stop();
  });
});

describe("Antigravity: advisor_weigh without a card", () => {
  const params: AcpPermissionParams = {
    sessionId: "s1",
    toolCall: { toolCallId: "call_1", name: "mcp_tunelo_advisor_weigh", kind: "other", title: "advisor_weigh", rawInput: { kind: "decision", toolSummary: "Ask" } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  const context = (allowed: boolean) => {
    const cards: ApprovalRequest[] = [];
    const askUser = (async (req: ApprovalRequest) => {
      cards.push(req);
      return { decision: "deny" };
    }) as unknown as AskUser;
    const ctx: PermissionContext = {
      dir: "/w",
      askUser,
      isSensitive: () => false,
      rules: new Set(),
      onRule: () => undefined,
      sessionMcp: { approveWrite: () => undefined, describeWrite: async () => undefined, advisorAllowed: () => allowed },
    };
    return { ctx, cards };
  };

  it("goes on while Advisor may be asked", async () => {
    const { ctx, cards } = context(true);
    expect(await answerPermission(params, ctx, signal)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(cards).toEqual([]);
  });

  it("is refused at once, without a card, while it may not", async () => {
    const { ctx, cards } = context(false);
    expect(await answerPermission(params, ctx, signal)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(cards).toEqual([]);
  });
});
