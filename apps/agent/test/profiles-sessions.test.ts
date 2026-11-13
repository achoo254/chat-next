// Sessions and Claude accounts in the agent core: the selected account is the
// machine's, and every session follows it. A parked session opens with it; an
// idle one restarts on it at once, resumed with the same conversation and
// settings (claude gets the account's folder as CLAUDE_CONFIG_DIR); one in the
// middle of a turn moves when the turn ends. Usage a session reports belongs
// to the account it ran with. A session that runs out of usage offers
// another account with room, never switching by itself.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Decision, ErrorCode, TurnState } from "@achoo254/chat-proto/remote/remote";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { AgentCore } from "../src/core/agent-core.ts";
import type { SessionMcpLease } from "../src/mcp/session-tickets.ts";
import { createClaudeProvider, replayableRule, ruleString } from "../src/providers/claude/index.ts";
import type { AccountScopeRef, AccountSuggestion } from "../src/providers/types.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, tempDir, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };
const turns = (n: number) => (items: Parameters<typeof byCase>[0]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** The Claude folder a session was started with; undefined for the machine's own. */
const configDirOf = (o: Options | undefined) => o?.env?.CLAUDE_CONFIG_DIR;

/** A core on the fake SDK whose machine account the test picks ("" or "p2"). */
function machineCore(opts: { suggest?: (id: string) => Promise<AccountSuggestion | undefined>; root?: string } = {}) {
  const root = opts.root ?? tempDir();
  const suggest = opts.suggest;
  const home = join(root, "home");
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  const sdk = fakeQuery();
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const p2 = join(root, "tunelo", "ai-accounts", "claude", "p2", "home");
  const scopeOf = (id: string): AccountScopeRef | undefined => (id === "p2" ? { id, dir: p2 } : undefined);
  const state = { selected: "" };
  const moved: string[] = [];
  const tickets = { issued: [] as string[], released: [] as string[] };
  const core = new AgentCore({
    dataDir: join(root, "data"),
    providers: [provider],
    audit: new AuditLog(join(root, "audit.jsonl")),
    isSensitive: createSensitiveCheck({ home }),
    sessionAccount: () => {
      const scope = scopeOf(state.selected);
      return scope ? { id: state.selected, scope } : { id: state.selected };
    },
    selectedScope: () => scopeOf(state.selected),
    selectedAccountId: () => state.selected,
    accountInfo: (_provider, id) => (id === "p2" ? { email: "max@example.com", organization: "", plan: "max" } : undefined),
    onSessionAccount: (threadId) => moved.push(threadId),
    sessionMcp: (threadId): SessionMcpLease => {
      const ticket = `ticket-${tickets.issued.length + 1}`;
      tickets.issued.push(ticket);
      return { ticket, configDir: root, approveWrite: () => undefined, describeWrite: async () => undefined, release: () => tickets.released.push(`${threadId}:${ticket}`) };
    },
    ...(suggest ? { suggestAccount: (_provider: string, exhaustedId: string) => suggest(exhaustedId) } : {}),
  });
  /** Picks the machine's account, as ClaudeProfiles.select tells the core. */
  const select = (id: string) => {
    state.selected = id;
    core.followMachineAccount("claude");
  };
  const ticketOf = (i: number) => {
    const server = sdk.log.options[i]?.mcpServers?.tunelo as { env?: Record<string, string> } | undefined;
    return server?.env?.TUNELO_MCP_TICKET;
  };
  return { core, sdk, work, p2, root, select, moved, tickets, ticketOf };
}

describe("sessions and Claude accounts", () => {
  it("restarts an idle session on the machine's new account at once, resumed with its settings", async () => {
    const { core, sdk, work, p2, select, moved, tickets, ticketOf } = machineCore();
    const t = await core.create({ provider: "claude", model: "claude-test", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    await core.setEffort(t.id, "high");
    await core.setPermissionMode(t.id, "plan", "test");
    expect(configDirOf(sdk.log.options[0])).toBeUndefined();
    expect(core.info(t.id)).toMatchObject({ accountId: "", machineAccountId: "", accountSwitchPending: false });

    select("p2");
    await settle();
    // Closed and opened again on p2: same conversation, model, effort, mode and folder; a new ticket.
    expect(sdk.log.options).toHaveLength(2);
    const reopened = sdk.log.options[1];
    expect(configDirOf(reopened)).toBe(p2);
    expect(reopened?.resume).toBe("claude-session-1");
    expect(reopened).toMatchObject({ model: "claude-test", effort: "high", permissionMode: "plan", cwd: work });
    expect(ticketOf(0)).toBe("ticket-1");
    expect(ticketOf(1)).toBe("ticket-2");
    expect(tickets.released).toEqual([`${t.id}:ticket-1`]);
    expect(moved).toEqual([t.id]);
    expect(core.info(t.id)).toMatchObject({ accountId: "p2", machineAccountId: "p2", accountSwitchPending: false });
    expect(core.list()[0]?.open).toBe(true);
    expect(core.accountInUse("claude", "")).toBe(false);
    expect(core.accountInUse("claude", "p2")).toBe(true);

    // The next message goes to the session on p2; nothing opens again.
    await core.send(t.id, "again", "");
    await until(core, t.id, turns(2));
    expect(sdk.log.options).toHaveLength(2);
    expect(byCase(core.snapshot(t.id), "text").some((i) => i.body.value.text === "echo: again")).toBe(true);
    await core.stop();
  });

  it("moves a session busy with a turn (waiting for an approval) only when the turn ends", async () => {
    const { core, sdk, work, p2, select, moved } = machineCore();
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "ask ls", consent, device: "test" });
    const items = await until(core, t.id, (xs) => byCase(xs, "approval").length === 1);
    const approval = byCase(items, "approval")[0];
    if (!approval) throw new Error("no approval");

    select("p2");
    await settle();
    expect(sdk.log.options).toHaveLength(1);
    expect(core.info(t.id)).toMatchObject({ accountId: "", machineAccountId: "p2", accountSwitchPending: true, nextAccount: { email: "max@example.com" } });
    expect(core.accountStates()).toEqual([{ threadId: t.id, provider: "claude", accountId: "", switchPending: true }]);

    core.respond(t.id, approval.id, approval.revision, { decision: Decision.ALLOW }, "test");
    await until(core, t.id, turns(1));
    await settle();
    expect(byCase(core.snapshot(t.id), "turn").at(-1)?.body.value.state).toBe(TurnState.COMPLETED);
    expect(sdk.log.options).toHaveLength(2);
    expect(configDirOf(sdk.log.options[1])).toBe(p2);
    expect(sdk.log.options[1]?.resume).toBe("claude-session-1");
    expect(moved).toEqual([t.id]);
    expect(core.info(t.id)).toMatchObject({ accountId: "p2", accountSwitchPending: false });
    expect(core.info(t.id).nextAccount).toBeUndefined();
    await core.stop();
  });

  it("shows a parked session on the machine's account and opens it there", async () => {
    const { core, sdk, work, p2, select } = machineCore();
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    await core.close(t.id);
    select("p2");
    await settle();
    expect(sdk.log.options).toHaveLength(1);
    expect(core.info(t.id)).toMatchObject({ accountId: "p2", accountSwitchPending: false });
    expect(core.accountStates()).toEqual([{ threadId: t.id, provider: "claude", accountId: "p2", switchPending: false }]);

    await core.send(t.id, "back", "");
    await until(core, t.id, turns(2));
    expect(configDirOf(sdk.log.options[1])).toBe(p2);
    expect(sdk.log.options[1]?.resume).toBe("claude-session-1");

    // Back to the default account: the idle session restarts without CLAUDE_CONFIG_DIR.
    select("");
    await settle();
    expect(sdk.log.options).toHaveLength(3);
    expect(configDirOf(sdk.log.options[2])).toBeUndefined();
    expect(core.info(t.id).accountId).toBe("");
    await core.stop();
  });

  it("keeps \"allow for the session\" across an account switch and a restart; tunelo's MCP writes still ask", async () => {
    const { core, sdk, work, root, select } = machineCore();
    const approvals = (id: string) => byCase(core.snapshot(id), "approval");
    const answer = async (id: string, n: number, decision: Decision) => {
      const items = await until(core, id, (xs) => byCase(xs, "approval").length === n);
      const a = byCase(items, "approval")[n - 1];
      if (!a) throw new Error("no approval");
      core.respond(id, a.id, a.revision, { decision }, "test");
    };
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "ask ls", consent, device: "test" });
    await answer(t.id, 1, Decision.ALLOW_SESSION);
    await until(core, t.id, turns(1));

    select("p2");
    await settle();
    expect(sdk.log.options).toHaveLength(2);
    expect(sdk.log.options[1]?.allowedTools).toEqual(["Bash"]);
    // Same kind of tool in the resumed session: no new approval.
    await core.send(t.id, "ask pwd", "");
    await until(core, t.id, turns(2));
    expect(approvals(t.id)).toHaveLength(1);
    expect(byCase(core.snapshot(t.id), "text").some((i) => i.body.value.text === "ran pwd")).toBe(true);

    // A write of tunelo's MCP: asked, and "for the session" keeps nothing.
    await core.send(t.id, "mcpwrite hi", "");
    await answer(t.id, 2, Decision.ALLOW_SESSION);
    await until(core, t.id, turns(3));
    select("");
    await settle();
    expect(sdk.log.options.at(-1)?.allowedTools).toEqual(["Bash"]);
    await core.send(t.id, "mcpwrite again", "");
    await answer(t.id, 3, Decision.ALLOW);
    await until(core, t.id, turns(4));
    await core.stop();

    // The service restarts: the thread still carries the rule.
    const again = machineCore({ root });
    await again.core.send(t.id, "ask whoami", "");
    await until(again.core, t.id, turns(5));
    expect(again.sdk.log.options[0]?.allowedTools).toEqual(["Bash"]);
    expect(again.sdk.log.options[0]?.resume).toBe("claude-session-1");
    expect(byCase(again.core.snapshot(t.id), "approval")).toHaveLength(3);
    await again.core.stop();
  });

  it("writes and filters session rules as claude reads them", () => {
    expect(ruleString({ toolName: "Bash", ruleContent: "npm test:*" })).toBe("Bash(npm test:*)");
    expect(ruleString({ toolName: "Bash", ruleContent: "echo (x)" })).toBe("Bash(echo \\(x\\))");
    expect(ruleString({ toolName: "Read" })).toBe("Read");
    expect(replayableRule("Bash(npm test:*)")).toBe(true);
    expect(replayableRule("mcp__tunelo__chat_list_chats")).toBe(true);
    expect(replayableRule("mcp__tunelo__chat_send_message")).toBe(false);
    expect(replayableRule("mcp__tunelo__localman_send_request")).toBe(false);
    expect(replayableRule("mcp__tunelo")).toBe(false);
    expect(replayableRule("mcp__tunelo__*")).toBe(false);
    expect(replayableRule("")).toBe(false);
  });

  it("keeps usage with the account that reported it", async () => {
    const { core, work, select } = machineCore();
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    core.setAccountUsage("claude", "p2", { fiveHour: { utilization: 77, resetsAt: 1 } });
    expect(core.info(t.id).rateLimits?.fiveHour?.utilization).not.toBe(77);
    select("p2");
    await settle();
    expect(core.info(t.id).rateLimits?.fiveHour?.utilization).toBe(77);
    await core.stop();
  });

  it("offers another account with room when the session's account runs out, and never switches by itself", async () => {
    const asked: string[] = [];
    const { core, sdk, work, select } = machineCore({
      suggest: async (id) => {
        asked.push(id);
        return { id: "p2", email: "max@example.com", remaining: 64 };
      },
    });
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "limit", consent, device: "test" });
    await until(core, t.id, turns(1));
    await settle();
    expect(asked).toEqual([""]);
    expect(core.info(t.id).accountSuggestion).toMatchObject({ provider: "claude", accountId: "p2", email: "max@example.com", remaining: 64 });
    expect(core.info(t.id).accountId).toBe("");
    expect(sdk.log.options).toHaveLength(1);

    // Taking the offer: the session moves and the offer goes.
    select("p2");
    await settle();
    expect(core.info(t.id).accountSuggestion).toBeUndefined();
    expect(core.info(t.id).accountId).toBe("p2");
    await core.stop();
  });

  it("offers nothing when no other account has room", async () => {
    const { core, work } = machineCore({ suggest: async () => undefined });
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "limit", consent, device: "test" });
    await until(core, t.id, turns(1));
    await settle();
    expect(core.info(t.id).accountSuggestion).toBeUndefined();
    await core.stop();
  });

  it("fails the turn rather than run on another account when the selected account cannot be read", async () => {
    const root = tempDir();
    const work = join(root, "home", "work");
    mkdirSync(work, { recursive: true });
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const core = new AgentCore({
      dataDir: join(root, "data"),
      providers: [provider],
      audit: new AuditLog(join(root, "audit.jsonl")),
      isSensitive: createSensitiveCheck({ home: join(root, "home") }),
      sessionAccount: () => {
        throw new Error("ai-accounts.json is damaged");
      },
    });
    await expect(core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" })).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
    });
    expect(sdk.log.options).toHaveLength(0);
    const [thread] = core.list();
    if (!thread) throw new Error("no thread");
    const items = core.snapshot(thread.id);
    expect(items.some((i) => i.body.case === "error" && i.body.value.message.includes("damaged"))).toBe(true);
    expect(byCase(items, "turn").at(-1)?.body.value.state).toBe(TurnState.FAILED);
    await core.stop();
  });
});
