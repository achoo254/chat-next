// Claude account requests that wait on claude do not hold the device's link:
// a usage refresh that hangs still lets pings and other requests through,
// and the usage probe itself gives up after its time limit and stops the
// claude it started.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AgentCore } from "../src/core/agent-core.ts";
import { probeUsage } from "../src/providers/claude/index.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeProvider } from "./fake-provider.ts";
import { tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const saved = process.env.CLAUDE_CONFIG_DIR;
const savedPid = process.env.FAKE_CLAUDE_PID_DIR;
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "CLAUDE_CONFIG_DIR");
  else process.env.CLAUDE_CONFIG_DIR = saved;
  if (savedPid === undefined) Reflect.deleteProperty(process.env, "FAKE_CLAUDE_PID_DIR");
  else process.env.FAKE_CLAUDE_PID_DIR = savedPid;
});

describe("profile requests on the device link", () => {
  it("answers pings and other requests while a usage refresh hangs", async () => {
    let release: () => void = () => undefined;
    const f = profilesFixture({
      probe: () => new Promise((resolve) => (release = () => resolve({ fiveHour: { utilization: 5, resetsAt: 1 } }))),
    });
    const root = tempDir();
    mkdirSync(join(root, "home"), { recursive: true });
    const core = new AgentCore({ dataDir: join(root, "data"), providers: [fakeProvider()], audit: f.audit, isSensitive: createSensitiveCheck({ home: join(root, "home") }) });
    const claude = { ...fakeProvider("claude"), accounts: f.profiles };
    const device = await pairedDevice({ core, config: new ConfigStore(join(root, "cfg")), audit: f.audit, providers: [claude] });
    const usage = device.request("u", { case: "usageRefresh", value: { provider: "claude", id: "" } });
    const pong = await device.request("p", { case: "ping", value: {} });
    expect(pong.body.case).toBe("pong");
    const threads = await device.request("t", { case: "threadList", value: {} });
    expect(threads.body.case).toBe("threadListResult");
    expect(device.received.some((frame) => frame.id === "u")).toBe(false);
    release();
    expect((await usage).body.case).toBe("accountListResult");
    await core.stop();
  });
});

describe("usage probe", () => {
  it("gives up after its time limit and stops the session it opened", async () => {
    let closed = 0;
    let aborted = false;
    let options: Options | undefined;
    const hanging = (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
      options = p.options;
      p.options.abortController?.signal.addEventListener("abort", () => (aborted = true));
      return {
        initializationResult: () => new Promise(() => undefined),
        close: () => void (closed += 1),
      } as unknown as Query;
    };
    const started = Date.now();
    expect(await probeUsage("claude", "/p/home", hanging, 100)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(closed).toBe(1);
    expect(aborted).toBe(true);
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe("/p/home");
    expect(options?.settingSources).toEqual([]);
  });
});
