// Advisor over the encrypted link: the key goes in once (AdvisorSetKey) and no
// frame ever brings it back, refusals included; a session's automatic Advisor
// is kept with the thread and only turns on where the AI can reach tunelo's
// MCP.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { ErrorReason, type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { AdvisorKeyStore } from "../src/advisor/advisor-key-store.ts";
import { ConfigStore } from "../src/config.ts";
import { forgetSecrets, redact, secretVariants } from "../src/mcp/redact.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";

process.env.TUNELO_KEYSTORE = "file";

const KEY = "ts_live_9d1e5b3a7c2f4e6a8b0d1c3e5f7a9b2c";
const consent = { sensitive: false, projectSettings: false };

afterEach(() => forgetSecrets());

/** The fake AI, taking tunelo's MCP in its sessions or not. */
function ai(sessionMcp: boolean) {
  const p = fakeProvider();
  return { ...p, capabilities: { ...p.capabilities, sessionMcp } };
}

/** Every frame the device received, as bytes. */
function sentBytes(frames: readonly Frame[]): string {
  return frames.map((f) => Buffer.from(toBinary(FrameSchema, f)).toString("latin1")).join("\n");
}

describe("Advisor's key over the link", () => {
  it("sets and removes the key; every device hears it, no frame carries it", async () => {
    const dir = tempDir("advisor-link-");
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    const keys = new AdvisorKeyStore({ configDir: dir, audit });
    const { core } = makeCore([ai(true)]);
    let announced = 0;
    const device = await pairedDevice({ core, config: new ConfigStore(dir), audit, advisorKeys: keys, onAdvisorKey: () => announced++ });

    const set = await device.request("k1", { case: "advisorSetKey", value: { key: KEY } });
    expect(set.body.case).toBe("ack");
    expect(announced).toBe(1);
    expect(keys.status()).toMatchObject({ keySet: true, setByDevice: expect.stringMatching(/^phone \(/) });
    expect(await keys.key()).toBe(KEY);

    const removed = await device.request("k2", { case: "advisorRemoveKey", value: {} });
    expect(removed.body.case).toBe("ack");
    expect(announced).toBe(2);
    expect(keys.status().keySet).toBe(false);

    const sent = sentBytes(device.received);
    for (const form of secretVariants(KEY)) expect(sent).not.toContain(form);
    const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(log).toMatch(/"device":"phone \([^"]+\)","action":"advisor_key_set"/);
    expect(log).toContain('"action":"advisor_key_remove"');
    expect(log).not.toContain(KEY);
  });

  it("a refused key: a stable reason, a fixed message, the key nowhere in the frame and hidden from output", async () => {
    const dir = tempDir("advisor-link-");
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    const keys = new AdvisorKeyStore({ configDir: dir, audit });
    const { core } = makeCore([ai(true)]);
    let announced = 0;
    const device = await pairedDevice({ core, config: new ConfigStore(dir), audit, advisorKeys: keys, onAdvisorKey: () => announced++ });

    const spaced = `${KEY} trailing-words`;
    const answer = await device.request("k1", { case: "advisorSetKey", value: { key: spaced } });
    expect(answer.body.case === "error" && answer.body.value.reason).toBe(ErrorReason.ADVISOR_KEY_INVALID);
    expect(announced).toBe(0);
    const sent = sentBytes(device.received);
    for (const form of secretVariants(KEY)) expect(sent).not.toContain(form);
    // Remembered on arrival, before any check: the machine's output never shows it.
    expect(redact(`log: ${spaced}`)).not.toContain(KEY);
  });

  it("a machine without Advisor refuses the key frames as unsupported", async () => {
    const dir = tempDir("advisor-link-");
    const { core } = makeCore([ai(true)]);
    const device = await pairedDevice({ core, config: new ConfigStore(dir), audit: new AuditLog(join(dir, "audit.jsonl")) });
    const answer = await device.request("k1", { case: "advisorSetKey", value: { key: KEY } });
    expect(answer.body.case === "error" && answer.body.value.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    for (const form of secretVariants(KEY)) expect(sentBytes(device.received)).not.toContain(form);
  });
});

describe("the machine-wide automatic Advisor switch over the link", () => {
  it("is taken from a device, and refused when the machine runs sessions without tunelo's MCP, off always working", async () => {
    const dir = tempDir("advisor-link-");
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    const { core } = makeCore([ai(true)]);
    const held = { on: false, mcp: true };
    const device = await pairedDevice({
      core,
      config: new ConfigStore(dir),
      audit,
      advisorAuto: { available: () => held.mcp, set: (on) => (held.on = on) },
    });

    expect((await device.request("a1", { case: "advisorSetAuto", value: { on: true } })).body.case).toBe("ack");
    expect(held.on).toBe(true);

    held.mcp = false;
    const refused = await device.request("a2", { case: "advisorSetAuto", value: { on: true } });
    expect(refused.body.case === "error" && refused.body.value.reason).toBe(ErrorReason.ADVISOR_UNAVAILABLE);
    expect((await device.request("a3", { case: "advisorSetAuto", value: { on: false } })).body.case).toBe("ack");
    expect(held.on).toBe(false);
  });

  it("a machine without Advisor refuses it as unsupported", async () => {
    const dir = tempDir("advisor-link-");
    const { core } = makeCore([ai(true)]);
    const device = await pairedDevice({ core, config: new ConfigStore(dir), audit: new AuditLog(join(dir, "audit.jsonl")) });
    const answer = await device.request("a1", { case: "advisorSetAuto", value: { on: true } });
    expect(answer.body.case === "error" && answer.body.value.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
  });
});

describe("a session's automatic Advisor", () => {
  it("turns on and off, is shown in ThreadInfo, logged with the device, and kept across a restart and /clear", async () => {
    const dir = tempDir("advisor-link-");
    const first = makeCore([ai(true)], { sessionMcp: () => undefined });
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "hello", consent, device: "phone" });
    expect(first.core.info(t.id).advisor).toBe(false);
    const device = await pairedDevice({ core: first.core, config: new ConfigStore(dir), audit: first.audit });

    const on = await device.request("a1", { case: "threadSetAdvisor", value: { threadId: t.id, on: true } });
    expect(on.body.case).toBe("ack");
    expect(first.core.info(t.id).advisor).toBe(true);
    expect(first.core.advisorOn(t.id)).toBe(true);

    // The service starts again on the same data: still on.
    const second = makeCore([ai(true)], { dataDir: first.dataDir, home: first.home, sessionMcp: () => undefined });
    expect(second.core.info(t.id).advisor).toBe(true);
    const cleared = await second.core.clear(t.id);
    expect(second.core.info(cleared.id).advisor).toBe(true);
    // Started again with the machine's MCP off: the thread keeps the wish, but devices see it off.
    const noMcp = makeCore([ai(true)], { dataDir: first.dataDir, home: first.home });
    expect(noMcp.core.advisorOn(t.id)).toBe(true);
    expect(noMcp.core.info(t.id).advisor).toBe(false);

    const off = await device.request("a2", { case: "threadSetAdvisor", value: { threadId: t.id, on: false } });
    expect(off.body.case).toBe("ack");
    expect(first.core.info(t.id).advisor).toBe(false);
    const actions = first.audit.list().map((e) => `${e.device.split(" ")[0]} ${e.action} ${e.detail}`);
    expect(actions).toContain(`phone advisor_on ${t.id}`);
    expect(actions).toContain(`phone advisor_off ${t.id}`);
  });

  it("is refused for an AI without tunelo's MCP, or on a machine running sessions without it; off always works", async () => {
    const noMcpAi = makeCore([ai(false)], { sessionMcp: () => undefined });
    const a = await noMcpAi.core.create({ provider: "fake", model: "", dir: noMcpAi.work, text: "hello", consent, device: "phone" });
    const device = await pairedDevice({ core: noMcpAi.core, config: new ConfigStore(tempDir()), audit: noMcpAi.audit });
    const refused = await device.request("a1", { case: "threadSetAdvisor", value: { threadId: a.id, on: true } });
    expect(refused.body.case === "error" && refused.body.value.reason).toBe(ErrorReason.ADVISOR_UNAVAILABLE);
    expect(noMcpAi.core.info(a.id).advisor).toBe(false);
    expect((await device.request("a2", { case: "threadSetAdvisor", value: { threadId: a.id, on: false } })).body.case).toBe("ack");

    // The AI takes the MCP, but the machine runs its sessions without it.
    const mcpOff = makeCore([ai(true)]);
    const b = await mcpOff.core.create({ provider: "fake", model: "", dir: mcpOff.work, text: "hello", consent, device: "phone" });
    expect(() => mcpOff.core.setAdvisor(b.id, true, "phone")).toThrow(expect.objectContaining({ reason: ErrorReason.ADVISOR_UNAVAILABLE }));
    expect(mcpOff.core.advisorAvailable("fake")).toBe(false);
  });
});
