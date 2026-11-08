// Sessions and Claude profiles in the agent core: a new session opens with
// the profile selected at that moment (claude gets its folder as
// CLAUDE_CONFIG_DIR), an open session keeps its own, and the account and
// usage a session reports belong to its profile only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AgentCore } from "../src/core/agent-core.ts";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, tempDir, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };
const turns = (n: number) => (items: Parameters<typeof byCase>[0]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;

describe("sessions and Claude profiles", () => {
  it("opens new sessions with the selected profile and leaves open ones on theirs", async () => {
    const root = tempDir();
    const home = join(root, "home");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    const detected: (string | undefined)[] = [];
    provider.detect = async (opts) => {
      detected.push(opts?.accountDir);
      return { installed: true, version: "2.1.319", loginState: "ok" };
    };
    let selected: { id: string; accountDir?: string } = { id: "" };
    const usage: string[] = [];
    const core = new AgentCore({
      dataDir: join(root, "data"),
      providers: [provider],
      audit: new AuditLog(join(root, "audit.jsonl")),
      isSensitive: createSensitiveCheck({ home }),
      profile: () => selected,
      selectedAccountDir: () => selected.accountDir,
      onProfileUsage: (id) => usage.push(id),
    });

    const first = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, first.id, turns(1));
    expect(sdk.log.options[0]?.env).toBeUndefined();

    selected = { id: "p2", accountDir: join(root, "tunelo", "claude-profiles", "p2", "home") };
    const second = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, second.id, turns(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.log.options[1]?.env?.CLAUDE_CONFIG_DIR).toBe(selected.accountDir);
    expect(detected).toEqual([undefined, selected.accountDir]);

    // The first session is still open: it keeps the default profile.
    await core.send(first.id, "again", "");
    await until(core, first.id, turns(2));
    expect(sdk.log.options).toHaveLength(2);
    expect(core.info(first.id).profileId).toBe("");
    expect(core.info(second.id).profileId).toBe("p2");
    expect(core.profileInUse("p2")).toBe(true);
    expect(usage).toContain("p2");
    expect(usage).toContain("");

    // Usage read for p2 shows on p2's threads only.
    core.setProfileUsage("p2", { fiveHour: { utilization: 77, resetsAt: 1 } });
    expect(core.info(second.id).rateLimits?.fiveHour?.utilization).toBe(77);
    expect(core.info(first.id).rateLimits?.fiveHour?.utilization).not.toBe(77);

    // Reopened after parking, a thread takes the profile selected then.
    selected = { id: "" };
    await core.close(second.id);
    expect(core.profileInUse("p2")).toBe(false);
    await core.send(second.id, "back", "");
    await until(core, second.id, turns(2));
    expect(sdk.log.options[2]?.env).toBeUndefined();
    expect(core.info(second.id).profileId).toBe("");
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
