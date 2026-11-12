// Usage over a device's sealed link: the report of a range of days, the
// rules' switches (kept in the config, written to the consent log), deleting
// the ledger, the refusals; and the hints of a running session reaching a
// connected device and the push.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason, UsageRule } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { usageApiOf } from "../../src/link/usage-link.ts";
import { Machine } from "../../src/machine.ts";
import type { UsageTurn } from "../../src/providers/types.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { Ledger } from "../../src/usage/ledger.ts";
import { fakeProvider } from "../fake-provider.ts";
import { makeCore, tempDir } from "../harness.ts";
import { pairedDevice } from "../support/device-link.ts";
import { connectDevice, waitFor } from "../support/machine-device.ts";

const D1 = new Date(2026, 10, 3, 10).getTime();
const STATS = { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} };

function call(key: string, at: number, sessionId: string, input: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return { key, sessionId, subagent: false, at, model: "m", cwd: "/work/app", inputTokens: input, outputTokens: 7, tools: [], ...extra };
}

async function setup() {
  const root = tempDir("usage-link-");
  const ledger = new Ledger(join(root, "config", "usage"));
  await ledger.apply("claude", { path: "/fake/a.jsonl", dev: 1, ino: 1, size: 1, mtimeMs: 1 }, { turns: [call("k1", D1, "s1", 100_000), call("k2", D1 + 60_000, "s1", 400_000)], end: 1, stats: STATS }, () => "example.com/team/app");
  await ledger.save();
  const config = new ConfigStore(join(root, "config"));
  const audit = new AuditLog(join(root, "audit.jsonl"));
  const usage = usageApiOf({ ledger, config, audit, deleteLedger: () => ledger.delete() });
  const { core } = makeCore([fakeProvider()]);
  const device = await pairedDevice({ core, config, audit, usage });
  return { root, ledger, config, audit, device, core };
}

describe("usage over a device's link", () => {
  it("answers a report with rows and the suggestions of the range", async () => {
    const { device } = await setup();
    const f = await device.request("1", { case: "usageReportRequest", value: { from: "2026-11-03", to: "2026-11-03", repoKey: "" } });
    expect(f.body.case).toBe("usageReport");
    if (f.body.case !== "usageReport") return;
    const r = f.body.value;
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      repoKey: "example.com/team/app",
      day: "2026-11-03",
      inputTokens: 500_000n,
      outputTokens: 14n,
      mainTurns: 2,
      sessions: 1,
      meanContext: 250_000n,
      medianContext: 250_000n,
      p90Context: 400_000n,
    });
    expect(r.suggestions).toEqual([expect.objectContaining({ rule: UsageRule.CONTEXT, sessionId: "s1", turn: 2, value: 400_000n, notifiedAt: 0n })]);
    expect(r.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset());
    device.close();
  });

  it("refuses a bad range and a blocked ledger with their reasons", async () => {
    const { device, ledger } = await setup();
    const bad = await device.request("1", { case: "usageReportRequest", value: { from: "2026-11-05", to: "2026-11-01", repoKey: "" } });
    expect(bad.body).toMatchObject({ case: "error", value: { reason: ErrorReason.USAGE_RANGE_INVALID } });
    writeFileSync(join(ledger.dir, "index.json"), JSON.stringify({ schemaVersion: 42 }));
    const fresh = new Ledger(ledger.dir);
    const root = tempDir("usage-link-");
    const config = new ConfigStore(join(root, "config"));
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const { core } = makeCore([fakeProvider()]);
    const other = await pairedDevice({ core, config, audit, usage: usageApiOf({ ledger: fresh, config, audit, deleteLedger: () => fresh.delete() }) });
    const blocked = await other.request("2", { case: "usageReportRequest", value: { from: "2026-11-01", to: "2026-11-02", repoKey: "" } });
    expect(blocked.body).toMatchObject({ case: "error", value: { reason: ErrorReason.USAGE_LEDGER_BLOCKED } });
    // Deleting it from the device unblocks it.
    expect((await other.request("3", { case: "usageDelete", value: {} })).body.case).toBe("ack");
    expect((await other.request("4", { case: "usageReportRequest", value: { from: "2026-11-01", to: "2026-11-02", repoKey: "" } })).body.case).toBe("usageReport");
    device.close();
    other.close();
  });

  it("gets and sets the rules' switches, keeping them in the config and the consent log", async () => {
    const { device, config, audit } = await setup();
    const got = await device.request("1", { case: "usageSettingsGet", value: {} });
    expect(got.body).toMatchObject({
      case: "usageSettings",
      value: {
        rules: [
          { rule: UsageRule.CONTEXT, enabled: true, experimental: false },
          { rule: UsageRule.TURNS, enabled: true, experimental: false },
          { rule: UsageRule.MECHANICAL, enabled: true, experimental: true },
          { rule: UsageRule.SUBAGENTS, enabled: true, experimental: false },
        ],
      },
    });
    const set = await device.request("2", {
      case: "usageSettingsSet",
      value: { rules: [{ rule: UsageRule.CONTEXT, enabled: false }, { rule: 99 as UsageRule, enabled: false }] },
    });
    expect(set.body.case === "usageSettings" && set.body.value.rules.map((r) => r.enabled)).toEqual([false, true, true, true]);
    expect(config.get().usageRules).toEqual({ context: false });
    expect(new ConfigStore(config.dir).get().usageRules).toEqual({ context: false });
    expect(audit.list(10).map((e) => [e.action, e.detail, e.device])).toContainEqual(["usage_rules", "context off", expect.stringContaining("phone")]);
    // A switched-off rule leaves the report too.
    const r = await device.request("3", { case: "usageReportRequest", value: { from: "2026-11-03", to: "2026-11-03", repoKey: "" } });
    expect(r.body.case === "usageReport" && r.body.value.suggestions).toEqual([]);
    device.close();
  });

  it("deletes the ledger, every file of it, and writes it to the consent log", async () => {
    const { device, ledger, audit } = await setup();
    expect(readdirSync(ledger.dir).length).toBeGreaterThan(0);
    const f = await device.request("1", { case: "usageDelete", value: {} });
    expect(f.body.case).toBe("ack");
    expect(readdirSync(ledger.dir)).toEqual([]);
    expect(audit.list(10).some((e) => e.action === "usage_delete")).toBe(true);
    device.close();
  });

  it("is refused as unsupported where the machine keeps no ledger", async () => {
    const root = tempDir("usage-link-");
    const config = new ConfigStore(join(root, "config"));
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const { core } = makeCore([fakeProvider()]);
    const device = await pairedDevice({ core, config, audit });
    const bodies: Parameters<typeof device.request>[1][] = [
      { case: "usageReportRequest", value: { from: "2026-11-01", to: "2026-11-01", repoKey: "" } },
      { case: "usageSettingsGet", value: {} },
      { case: "usageSettingsSet", value: { rules: [] } },
      { case: "usageDelete", value: {} },
    ];
    for (const [i, body] of bodies.entries()) {
      const f = await device.request(String(i), body);
      expect(f.body).toMatchObject({ case: "error", value: { reason: ErrorReason.UNSUPPORTED_REQUEST } });
    }
    device.close();
  });
});

describe("hints of a running session from the machine", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function runningMachine() {
    const dir = tempDir("usage-machine-");
    mkdirSync(dir, { recursive: true });
    const machine = new Machine({ config: new ConfigStore(dir), providers: [fakeProvider()], log: () => undefined });
    const port = await machine.start(0);
    cleanup.push(() => machine.stop());
    const now = Date.now();
    await machine.usage.ledger.apply(
      "claude",
      { path: "/fake/live.jsonl", dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      { turns: [call("live1", now - 2 * 60_000, "live-session", 350_000)], end: 1, stats: STATS },
      () => "example.com/team/app",
    );
    return { machine, port, dir };
  }

  it("sends the hint to connected devices and asks for one push, once", async () => {
    const { machine, port, dir } = await runningMachine();
    let pushes = 0;
    machine.setNotifyUsage(async () => {
      pushes++;
    });
    const phone = await connectDevice(machine, port, "phone");
    cleanup.push(() => phone.close());
    expect(await machine.usageNotifier.check()).toHaveLength(1);
    await waitFor(() => phone.frames.some((f) => f.body.case === "usageSuggestion"));
    const hint = phone.frames.find((f) => f.body.case === "usageSuggestion");
    expect(hint?.id).toBe("");
    expect(hint?.body.value).toMatchObject({ rule: UsageRule.CONTEXT, sessionId: "live-session", repoKey: "example.com/team/app", turn: 1, value: 350_000n });
    expect(pushes).toBe(1);
    expect(await machine.usageNotifier.check()).toEqual([]);
    expect(pushes).toBe(1);
    expect(existsSync(join(dir, "usage", "index.json"))).toBe(true);
    expect(readFileSync(join(dir, "usage", "index.json"), "utf8")).toContain("live-session");
  });

  it("counts a hint as delivered by the push alone, and tries again when neither reached anyone", async () => {
    const { machine } = await runningMachine();
    let fail = true;
    machine.setNotifyUsage(async () => {
      if (fail) throw new Error("the chat server does not send usage hint pushes");
    });
    // No device connected and the push refused: not delivered, not recorded.
    expect(await machine.usageNotifier.check()).toEqual([]);
    expect(machine.usage.ledger.notifiedAt("claude", "live-session", "context")).toBeUndefined();
    fail = false;
    expect(await machine.usageNotifier.check(false)).toHaveLength(1);
    expect(machine.usage.ledger.notifiedAt("claude", "live-session", "context")).toBeDefined();
  });
});
