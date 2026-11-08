// Every adapter must pass this contract, driven through the agent core the
// way a device drives it. Runs for the Claude adapter (fake SDK) and for the
// scripted fake adapter.
import { Decision, ErrorCode, PromptState, Role, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createClaudeProvider } from "../src/providers/claude/index.ts";
import type { AgentProvider } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };

const adapters: [string, () => { provider: AgentProvider; resumeIds: () => (string | undefined)[] }][] = [
  [
    "claude (fake SDK)",
    () => {
      const sdk = fakeQuery();
      const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
      provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
      return { provider, resumeIds: () => sdk.log.options.map((o) => o.resume) };
    },
  ],
  [
    "fake adapter",
    () => {
      const p = fakeProvider();
      return { provider: p, resumeIds: () => p.log.starts.map((s) => s.resumeId) };
    },
  ],
];

const turnDone = (n: number) => (items: ReturnType<typeof byCase<"turn">>) => items.filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;

describe("claude adapter usage", () => {
  it("passes plan usage and lines changed", async () => {
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await new Promise((r) => setTimeout(r, 20));
    const info = core.info(t.id);
    expect([info.linesAdded, info.linesRemoved]).toEqual([3, 1]);
    expect(info.rateLimits?.fiveHour?.utilization).toBe(4);
    expect(info.rateLimits?.fiveHour?.resetsAt).toBe(BigInt(Date.parse("2026-11-08T12:00:00Z")));
    expect(info.rateLimits?.sevenDay?.utilization).toBe(80);
    expect(sdk.log.options[0]?.permissionMode).toBeUndefined();
    await core.stop();
  });

  it("reports the signed-in account without any token source, and sets effort and mode live", async () => {
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: "claude", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await new Promise((r) => setTimeout(r, 20));
    expect(core.info(t.id).account).toMatchObject({ email: "me@example.com", organization: "", plan: "max" });
    expect(JSON.stringify(core.info(t.id).account)).not.toContain("never-forwarded");
    await core.setEffort(t.id, "high");
    await core.setEffort(t.id, "");
    await core.setPermissionMode(t.id, "acceptEdits", "test");
    expect(sdk.log.flags).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
    expect(sdk.log.modes).toEqual(["acceptEdits"]);
    await core.stop();
  });
});

describe("effort and permission mode from a device", () => {
  it("keeps the picks across a parked session and logs a mode change", async () => {
    const p = fakeProvider();
    const { core, work, audit } = makeCore([p]);
    const t = await core.create({ provider: p.id, model: "", dir: work, text: "one", consent, device: "phone" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await core.setEffort(t.id, "high");
    await core.setPermissionMode(t.id, "plan", "phone");
    expect(core.info(t.id)).toMatchObject({ effort: "high", permissionMode: "plan" });
    await expect(core.setEffort(t.id, "turbo")).rejects.toMatchObject({ code: ErrorCode.INVALID });
    await core.close(t.id);
    await core.send(t.id, "two", "");
    await until(core, t.id, (i) => turnDone(2)(byCase(i, "turn")));
    expect(p.log.starts[1]).toMatchObject({ effort: "high", permissionMode: "plan" });
    expect(audit.list(10).map((e) => [e.device, e.action, e.detail])).toContainEqual(["phone", "permission_mode", "plan"]);
    await core.stop();
  });

  it("never turns bypass on from a device unless the machine itself starts there", async () => {
    const p = fakeProvider();
    const { core, work } = makeCore([p]);
    const t = await core.create({ provider: p.id, model: "", dir: work, text: "one", consent, device: "phone" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(core.info(t.id).permissionModes).toEqual(["default", "plan"]);
    await expect(core.setPermissionMode(t.id, "bypassPermissions", "phone")).rejects.toMatchObject({ code: ErrorCode.INVALID });
    await core.stop();

    const q = fakeProvider();
    q.log.machineMode = "bypassPermissions";
    const m = makeCore([q]);
    const u = await m.core.create({ provider: q.id, model: "", dir: m.work, text: "one", consent, device: "phone" });
    await until(m.core, u.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(m.core.info(u.id).permissionModes).toContain("bypassPermissions");
    await m.core.setPermissionMode(u.id, "default", "phone");
    await m.core.close(u.id);
    await m.core.send(u.id, "two", "");
    await until(m.core, u.id, (i) => turnDone(2)(byCase(i, "turn")));
    // Still the machine's choice after the device's pick restarted the session.
    expect(q.log.starts[1]).toMatchObject({ permissionMode: "default", allowBypass: true });
    await m.core.setPermissionMode(u.id, "bypassPermissions", "phone");
    expect(m.core.info(u.id).permissionMode).toBe("bypassPermissions");
    await m.core.stop();
  });
});

describe.each(adapters)("provider contract: %s", (_name, make) => {
  it("streams an answer and ends the turn", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "hello", consent, device: "test" });
    const items = await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    const texts = byCase(items, "text");
    expect(texts.map((x) => [x.body.value.role, x.body.value.text])).toEqual([
      [Role.USER, "hello"],
      [Role.ASSISTANT, "echo: hello"],
    ]);
    expect(texts.every((x) => !x.body.value.partial)).toBe(true);
    expect(byCase(items, "turn")[0]?.body.value.state).toBe(TurnState.COMPLETED);
    const seqs = items.map((i) => i.seq);
    expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
    await core.stop();
  });

  it("reports the statusline info of the thread", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await new Promise((r) => setTimeout(r, 20));
    const info = core.info(t.id);
    expect(info.permissionMode).toBe("default");
    expect(info.commands.map((c) => c.name)).toEqual(["review"]);
    await core.stop();
  });

  it("asks before a tool and respects a deny", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "ask rm -rf build", consent, device: "test" });
    const pending = await until(core, t.id, (i) => byCase(i, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const card = byCase(pending, "approval")[0];
    if (!card) throw new Error("no approval");
    expect(card.body.value.summary).toContain("rm -rf build");
    expect(() => core.respond(t.id, card.id, card.revision + 1, { decision: Decision.ALLOW }, "test")).toThrow(/changed or was answered/);
    core.respond(t.id, card.id, card.revision, { decision: Decision.DENY }, "test");
    const items = await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(byCase(items, "approval")[0]?.body.value.state).toBe(PromptState.ANSWERED);
    expect(byCase(items, "toolResult").filter((r) => r.body.value.ok)).toHaveLength(0);
    expect(byCase(items, "text").at(-1)?.body.value.text).toBe("denied");
    await core.stop();
  });

  it("answers a question", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "question", consent, device: "test" });
    const pending = await until(core, t.id, (i) => byCase(i, "question").length > 0);
    const q = byCase(pending, "question")[0];
    if (!q) throw new Error("no question");
    core.respond(t.id, q.id, q.revision, { answers: { $typeName: "remote.v1.Answers", answers: [{ $typeName: "remote.v1.Answer", values: ["B"] }] } }, "test");
    const items = await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(byCase(items, "text").at(-1)?.body.value.text).toBe("you picked B");
    await core.stop();
  });

  it("stops mid-turn", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "slow", consent, device: "test" });
    await until(core, t.id, (i) => byCase(i, "text").some((x) => x.body.value.role === Role.ASSISTANT));
    await core.interrupt(t.id);
    const items = await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(byCase(items, "turn")[0]?.body.value.state).toBe(TurnState.INTERRUPTED);
    await core.stop();
  });

  it("resumes a parked session with its own session id", async () => {
    const { provider, resumeIds } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "one", consent, device: "test" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await core.close(t.id);
    expect(core.openSessions()).toBe(0);
    await core.send(t.id, "two", "m2");
    await core.send(t.id, "two", "m2"); // a repeated client id is dropped
    const items = await until(core, t.id, (i) => turnDone(2)(byCase(i, "turn")));
    expect(byCase(items, "text").filter((x) => x.body.value.role === Role.USER)).toHaveLength(2);
    expect(resumeIds()).toHaveLength(2);
    expect(resumeIds()[1]).toBeTruthy();
    await core.stop();
  });

  it("changes model without losing the thread", async () => {
    const { provider } = make();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "one", consent, device: "test" });
    await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    await core.setModel(t.id, "small");
    await core.send(t.id, "two", "");
    const items = await until(core, t.id, (i) => turnDone(2)(byCase(i, "turn")));
    expect(byCase(items, "modelChange")[0]?.body.value.to).toBe("small");
    expect(core.list()[0]?.model).toBe("small");
    await core.stop();
  });

  it("hands over to another AI and back, cancelling open prompts", async () => {
    const { provider } = make();
    const other = fakeProvider("other");
    const { core, work } = makeCore([provider, other]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "ask make build", consent, device: "test" });
    await until(core, t.id, (i) => byCase(i, "approval").length > 0);
    await core.switchProvider(t.id, "other", "");
    let items = await until(core, t.id, (i) => byCase(i, "agentHandoff").length === 1 && turnDone(2)(byCase(i, "turn")));
    expect(byCase(items, "approval")[0]?.body.value.state).toBe(PromptState.CANCELLED);
    const handoff = byCase(items, "agentHandoff")[0]?.body.value;
    expect(handoff?.summary).toContain("ask make build");
    expect(other.log.sent[0]).toContain("ask make build");
    await core.switchProvider(t.id, provider.id, "");
    items = await until(core, t.id, (i) => byCase(i, "agentHandoff").length === 2 && turnDone(3)(byCase(i, "turn")));
    expect(byCase(items, "agentHandoff")[1]?.body.value.to).toBe(provider.name);
    expect(core.list()[0]?.provider).toBe(provider.id);
    await core.stop();
  });

  it("marks a tool touching a sensitive path and never allows it for the session", async () => {
    const { provider } = make();
    const { core, work, home, audit } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: `ask cat ${join(home, ".ssh", "id_ed25519")}`, consent, device: "phone" });
    const pending = await until(core, t.id, (i) => byCase(i, "approval").length > 0);
    const card = byCase(pending, "approval")[0];
    if (!card) throw new Error("no approval");
    expect(card.body.value.sensitive).toBe(true);
    core.respond(t.id, card.id, card.revision, { decision: Decision.ALLOW_SESSION }, "phone");
    const items = await until(core, t.id, (i) => turnDone(1)(byCase(i, "turn")));
    expect(byCase(items, "approval")[0]?.body.value.decision).toBe(Decision.ALLOW);
    expect(audit.list().map((e) => e.action)).toContain("approve_sensitive");
    await core.stop();
  });

  it("refuses a sensitive folder without consent and logs consent", async () => {
    const { provider } = make();
    const { core, home, audit } = makeCore([provider]);
    await expect(core.create({ provider: provider.id, model: "", dir: home, text: "hi", consent, device: "phone" })).rejects.toMatchObject({
      code: ErrorCode.NEEDS_CONSENT,
    });
    await expect(
      core.create({ provider: provider.id, model: "", dir: home, text: "hi", consent: { sensitive: true, projectSettings: true }, device: "phone" }),
    ).rejects.toThrow(/tunelo trust/);
    await core.create({ provider: provider.id, model: "", dir: home, text: "hi", consent: { sensitive: true, projectSettings: false }, device: "phone" });
    expect(audit.list().map((e) => e.action)).toEqual(["open_sensitive"]);
    await core.stop();
  });

  it("loads project settings only in folders trusted on the machine", async () => {
    const { provider } = make();
    const { core, work, audit } = makeCore([provider], { trusted: (d) => d.endsWith("work") });
    await core.create({ provider: provider.id, model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: true }, device: "phone" });
    expect(audit.list().map((e) => e.action)).toEqual(["project_settings"]);
    await core.stop();
  });
});
