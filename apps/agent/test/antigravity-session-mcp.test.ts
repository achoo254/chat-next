// tunelo's own MCP in an Antigravity session: agy gets `tunelo mcp` with the
// session's ticket on session/new and session/resume, and a write of that MCP
// (agy names it `mcp_tunelo_<tool>`) is asked about every time, described on
// the card, and approved to the service with the arguments agy passes (its
// input without the `toolSummary` agy adds), as recorded from agy 1.5.8.
import { describe, expect, it } from "vitest";
import { TICKET_ENV } from "../src/mcp/session-tickets.ts";
import { AgyAcp } from "../src/providers/antigravity/acp-process.ts";
import { acpSessionMcpServer, createAntigravityProvider } from "../src/providers/antigravity/index.ts";
import { answerPermission, mcpArguments, tuneloTool, type PermissionContext } from "../src/providers/antigravity/permissions.ts";
import type { AcpPermissionParams } from "../src/providers/acp/acp-session.ts";
import type { ApprovalAnswer, ApprovalRequest, AskUser, SessionPolicy } from "../src/providers/types.ts";
import { fakeAgy } from "./support/fake-agy.ts";

const DIR = "/work/app";
const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function call(name: string, rawInput: Record<string, unknown>): AcpPermissionParams {
  return { sessionId: "s1", toolCall: { toolCallId: "call_1", name, kind: "other", title: `Run ${name}`, rawInput }, options: OPTIONS };
}

/** A context whose device answers `decision` and records every card and approval. */
function context(decision: ApprovalAnswer["decision"]) {
  const cards: ApprovalRequest[] = [];
  const approved: { exposed: string; input: Record<string, unknown> }[] = [];
  const rules = new Set<string>();
  const askUser = (async (req: ApprovalRequest) => {
    cards.push(req);
    return { decision };
  }) as unknown as AskUser;
  const ctx: PermissionContext = {
    dir: DIR,
    askUser,
    isSensitive: () => false,
    rules,
    onRule: () => undefined,
    sessionMcp: {
      approveWrite: (exposed, input) => approved.push({ exposed, input }),
      describeWrite: async (exposed, input) => (exposed === "chat_send_message" ? `Send to chat ${String(input.chat_id)}: ${String(input.text)}` : undefined),
    },
  };
  return { ctx, cards, approved, rules };
}

describe("tunelo's MCP tools as agy names them", () => {
  it("strips agy's prefix and the toolSummary it adds", () => {
    expect(tuneloTool("mcp_tunelo_chat_send_message")).toBe("chat_send_message");
    expect(tuneloTool("mcp_other_chat_send_message")).toBe("");
    expect(tuneloTool("run_command")).toBe("");
    expect(mcpArguments({ chat_id: 7, text: "hi", toolSummary: "Send a message" })).toEqual({ chat_id: 7, text: "hi" });
    expect(mcpArguments(undefined)).toEqual({});
  });

  it("is started over stdio with the session's ticket, in ACP's shape", () => {
    const server = acpSessionMcpServer({ ticket: "t-123", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined });
    expect(server.name).toBe("tunelo");
    expect(server.args.at(-1)).toBe("mcp");
    expect(server.env).toEqual([
      { name: TICKET_ENV, value: "t-123" },
      { name: "TUNELO_HOME", value: "/cfg" },
    ]);
  });
});

describe("a write of tunelo's MCP in an Antigravity session", () => {
  it("is described on the card and, once allowed, approved with the arguments agy passes", async () => {
    const { ctx, cards, approved } = context("allow");
    const out = await answerPermission(call("mcp_tunelo_chat_send_message", { chat_id: 7, text: "hi", toolSummary: "Send a message" }), ctx, new AbortController().signal);
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(cards.map((c) => c.summary)).toEqual(["Send to chat 7: hi"]);
    expect(approved).toEqual([{ exposed: "chat_send_message", input: { chat_id: 7, text: "hi" } }]);
  });

  it("denied: nothing is approved", async () => {
    const { ctx, approved } = context("deny");
    const out = await answerPermission(call("mcp_tunelo_chat_send_message", { chat_id: 7, text: "hi" }), ctx, new AbortController().signal);
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(approved).toEqual([]);
  });

  it("is asked about every time: 'allow for the session' keeps no rule, and a rule never lets it through", async () => {
    const { ctx, cards, rules } = context("allow-session");
    const params = call("mcp_tunelo_chat_send_message", { chat_id: 7, text: "hi" });
    await answerPermission(params, ctx, new AbortController().signal);
    expect(rules.size).toBe(0);
    rules.add("mcp_tunelo_chat_send_message");
    await answerPermission(params, ctx, new AbortController().signal);
    expect(cards).toHaveLength(2);
  });

  it("a tool whose own card on the device is the question goes on without a card here", async () => {
    const { ctx, cards, approved } = context("deny");
    const out = await answerPermission(call("mcp_tunelo_request_secret", { name: "github" }), ctx, new AbortController().signal);
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(cards).toEqual([]);
    expect(approved).toEqual([]);
  });

  it("a read tool of tunelo's MCP is asked as any tool and may be allowed for the session", async () => {
    const { ctx, cards, approved, rules } = context("allow-session");
    const params = call("mcp_tunelo_tunnel_status", { toolSummary: "Tunnel status check" });
    await answerPermission(params, ctx, new AbortController().signal);
    await answerPermission(params, ctx, new AbortController().signal);
    expect(cards).toHaveLength(1);
    expect(rules.size).toBe(1);
    expect(approved).toEqual([]);
  });
});

describe("an Antigravity session with tunelo's MCP", () => {
  const policy = (sessionMcp: SessionPolicy["sessionMcp"]): SessionPolicy => ({
    dir: DIR,
    mcpServers: {},
    projectSettings: false,
    isSensitive: () => false,
    ...(sessionMcp ? { sessionMcp } : {}),
  });

  async function opened(sessionMcp: SessionPolicy["sessionMcp"], resumeId?: string) {
    const agy = fakeAgy();
    const provider = createAntigravityProvider({
      findBinary: async () => "agy",
      acp: new AgyAcp({ findBinary: async () => "agy", log: () => undefined, spawnProcess: agy.spawnProcess }),
      toolPermission: () => "request-review",
      version: async () => "1.5.8",
    });
    const session = await provider.start({ policy: policy(sessionMcp), askUser: (async () => ({ decision: "deny" })) as unknown as AskUser, ...(resumeId ? { resumeId } : {}) });
    await session.close();
    return { provider, request: agy.log.requests.find((r) => r.method === "session/new" || r.method === "session/resume") };
  }

  it("says it takes the MCP, and agy gets it on a new session and on a resumed one", async () => {
    const mcp = { ticket: "t-9", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined };
    const fresh = await opened(mcp);
    expect(fresh.provider.capabilities.sessionMcp).toBe(true);
    const servers = fresh.request?.params.mcpServers as { name: string; env: { name: string; value: string }[] }[];
    expect(servers.map((s) => s.name)).toEqual(["tunelo"]);
    expect(servers[0]?.env).toContainEqual({ name: TICKET_ENV, value: "t-9" });
    const resumed = await opened(mcp, "conv-1");
    expect(resumed.request?.method).toBe("session/resume");
    expect((resumed.request?.params.mcpServers as unknown[]).length).toBe(1);
  });

  it("without the MCP (turned off on the machine) agy gets none", async () => {
    const { request } = await opened(undefined);
    expect(request?.params.mcpServers).toEqual([]);
  });
});
