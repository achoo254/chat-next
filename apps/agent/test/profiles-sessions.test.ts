// Sessions and Claude profiles in the agent core: the selected profile is the
// machine's, and every session follows it. A parked session opens with it; an
// idle one restarts on it at once, resumed with the same conversation and
// settings (claude gets the profile's folder as CLAUDE_CONFIG_DIR); one in the
// middle of a turn moves when the turn ends. Usage a session reports belongs
// to the profile it ran with. A session that runs out of usage offers
// another profile with room, never switching by itself.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Decision, ErrorCode, TurnState } from "@achoo254/chat-proto/remote/remote";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { AgentCore, type ProfileSuggestion } from "../src/core/agent-core.ts";
import type { SessionMcpLease } from "../src/mcp/session-tickets.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, tempDir, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };
const turns = (n: number) => (items: Parameters<typeof byCase>[0]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** The Claude folder a session was started with; undefined for the machine's own. */
const configDirOf = (o: Options | undefined) => o?.env?.CLAUDE_CONFIG_DIR;

/** A core on the fake SDK whose machine profile the test picks ("" or "p2"). */
function machineCore(opts: { suggest?: (id: string) => Promise<ProfileSuggestion | undefined> } = {}) {
  const root = tempDir();
  const home = join(root, "home");
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  const sdk = fakeQuery();
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
  provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
  const p2 = join(root, "tunelo", "claude-profiles", "p2", "home");
  const dirOf = (id: string) => (id === "p2" ? p2 : undefined);
  const state = { selected: "" };
  const moved: string[] = [];
  const tickets = { issued: [] as string[], released: [] as string[] };
  const core = new AgentCore({
    dataDir: join(root, "data"),
    providers: [provider],
    audit: new AuditLog(join(root, "audit.jsonl")),
    isSensitive: createSensitiveCheck({ home }),
    profile: () => {
      const accountDir = dirOf(state.selected);
      return accountDir ? { id: state.selected, accountDir } : { id: state.selected };
    },
    selectedAccountDir: () => dirOf(state.selected),
    selectedProfileId: () => state.selected,
    profileAccount: (id) => (id === "p2" ? { email: "max@example.com", organization: "", plan: "max" } : undefined),
    onSessionProfile: (id) => moved.push(id),
    sessionMcp: (threadId): SessionMcpLease => {
      const ticket = `ticket-${tickets.issued.length + 1}`;
      tickets.issued.push(ticket);
      return { ticket, configDir: root, approveWrite: () => undefined, describeWrite: async () => undefined, release: () => tickets.released.push(`${threadId}:${ticket}`) };
    },
    ...(opts.suggest ? { suggestProfile: opts.suggest } : {}),
  });
  /** Picks the machine's profile, as ClaudeProfiles.select tells the core. */
  const select = (id: string) => {
    state.selected = id;
    core.followMachineProfile();
  };
  const ticketOf = (i: number) => {
    const server = sdk.log.options[i]?.mcpServers?.tunelo as { env?: Record<string, string> } | undefined;
    return server?.env?.TUNELO_MCP_TICKET;
  };
  return { core, sdk, work, p2, select, moved, tickets, ticketOf };
}

describe("sessions and Claude profiles", () => {
  it("restarts an idle session on the machine's new profile at once, resumed with its settings", async () => {
    const { core, sdk, work, p2, select, moved, tickets, ticketOf } = machineCore();
    const t = await core.create({ provider: "claude", model: "claude-test", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    await core.setEffort(t.id, "high");
    await core.setPermissionMode(t.id, "plan", "test");
    expect(configDirOf(sdk.log.options[0])).toBeUndefined();
    expect(core.info(t.id)).toMatchObject({ profileId: "", machineProfileId: "", profileSwitchPending: false });

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
    expect(core.info(t.id)).toMatchObject({ profileId: "p2", machineProfileId: "p2", profileSwitchPending: false });
    expect(core.list()[0]?.open).toBe(true);
    expect(core.profileInUse("")).toBe(false);
    expect(core.profileInUse("p2")).toBe(true);

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
    expect(core.info(t.id)).toMatchObject({ profileId: "", machineProfileId: "p2", profileSwitchPending: true, nextAccount: { email: "max@example.com" } });
    expect(core.profileStates()).toEqual([{ threadId: t.id, profileId: "", switchPending: true }]);

    core.respond(t.id, approval.id, approval.revision, { decision: Decision.ALLOW }, "test");
    await until(core, t.id, turns(1));
    await settle();
    expect(byCase(core.snapshot(t.id), "turn").at(-1)?.body.value.state).toBe(TurnState.COMPLETED);
    expect(sdk.log.options).toHaveLength(2);
    expect(configDirOf(sdk.log.options[1])).toBe(p2);
    expect(sdk.log.options[1]?.resume).toBe("claude-session-1");
    expect(moved).toEqual([t.id]);
    expect(core.info(t.id)).toMatchObject({ profileId: "p2", profileSwitchPending: false });
    expect(core.info(t.id).nextAccount).toBeUndefined();
    await core.stop();
  });

  it("shows a parked session on the machine's profile and opens it there", async () => {
    const { core, sdk, work, p2, select } = machineCore();
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    await core.close(t.id);
    select("p2");
    await settle();
    expect(sdk.log.options).toHaveLength(1);
    expect(core.info(t.id)).toMatchObject({ profileId: "p2", profileSwitchPending: false });
    expect(core.profileStates()).toEqual([{ threadId: t.id, profileId: "p2", switchPending: false }]);

    await core.send(t.id, "back", "");
    await until(core, t.id, turns(2));
    expect(configDirOf(sdk.log.options[1])).toBe(p2);
    expect(sdk.log.options[1]?.resume).toBe("claude-session-1");

    // Back to the default profile: the idle session restarts without CLAUDE_CONFIG_DIR.
    select("");
    await settle();
    expect(sdk.log.options).toHaveLength(3);
    expect(configDirOf(sdk.log.options[2])).toBeUndefined();
    expect(core.info(t.id).profileId).toBe("");
    await core.stop();
  });

  it("keeps usage with the profile that reported it", async () => {
    const { core, work, select } = machineCore();
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, turns(1));
    core.setProfileUsage("p2", { fiveHour: { utilization: 77, resetsAt: 1 } });
    expect(core.info(t.id).rateLimits?.fiveHour?.utilization).not.toBe(77);
    select("p2");
    await settle();
    expect(core.info(t.id).rateLimits?.fiveHour?.utilization).toBe(77);
    await core.stop();
  });

  it("offers another profile with room when the session's profile runs out, and never switches by itself", async () => {
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
    expect(core.info(t.id).profileSuggestion).toMatchObject({ profileId: "p2", email: "max@example.com", remaining: 64 });
    expect(core.info(t.id).profileId).toBe("");
    expect(sdk.log.options).toHaveLength(1);

    // Taking the offer: the session moves and the offer goes.
    select("p2");
    await settle();
    expect(core.info(t.id).profileSuggestion).toBeUndefined();
    expect(core.info(t.id).profileId).toBe("p2");
    await core.stop();
  });

  it("offers nothing when no other profile has room", async () => {
    const { core, work } = machineCore({ suggest: async () => undefined });
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "limit", consent, device: "test" });
    await until(core, t.id, turns(1));
    await settle();
    expect(core.info(t.id).profileSuggestion).toBeUndefined();
    await core.stop();
  });

  it("fails the turn rather than run on another account when the selected profile cannot be read", async () => {
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
      profile: () => {
        throw new Error("profiles.json is damaged");
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
