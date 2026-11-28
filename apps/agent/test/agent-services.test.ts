// tunelo's services a device works from the machine's page: Observatory's
// state as told, its switch, and which requests are done or refused.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPortKind, AgentServiceAction, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { type AgentServices, controlService, serviceAuditDetail } from "../src/agent-services.ts";
import { ConfigStore } from "../src/config.ts";
import type { ObservatoryStatus } from "../src/observatory/observatory-status.ts";
import { ObservatorySwitch, observatoryRuntime } from "../src/observatory/observatory-switch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function status(enabled: boolean, receiverState: ObservatoryStatus["receiver"]["state"], port: number | undefined, store: ObservatoryStatus["store"] = "open"): ObservatoryStatus {
  return { enabled, store, receiver: { state: receiverState, port } } as ObservatoryStatus;
}

describe("observatoryRuntime", () => {
  it("runs, is off, or waits for its port", () => {
    expect(observatoryRuntime(status(true, "listening", 47300), undefined)).toEqual({ state: "running", port: 47300 });
    expect(observatoryRuntime(status(false, "off", undefined), 47301)).toEqual({ state: "off", port: 47301 });
    expect(observatoryRuntime(status(false, "off", undefined), undefined)).toEqual({ state: "off", port: 0 });
    expect(observatoryRuntime(status(true, "port-taken", 47300), undefined)).toEqual({ state: "port-taken", port: 47300 });
  });

  it("says why it failed", () => {
    expect(observatoryRuntime(status(true, "token-unreadable", undefined), 47300)).toEqual({ state: "failed", port: 47300, problem: "token-unreadable" });
    expect(observatoryRuntime(status(true, "no-port", undefined), undefined)).toEqual({ state: "failed", port: 0, problem: "no-free-port" });
    expect(observatoryRuntime(status(true, "listening", 47300, "failed"), undefined)).toEqual({ state: "failed", port: 47300, problem: "store-failed" });
    expect(observatoryRuntime(status(true, "failed", 47300), undefined)).toEqual({ state: "failed", port: 47300, problem: "other" });
  });
});

describe("ObservatorySwitch", () => {
  it("keeps on/off in the settings and stops then starts the service, one change at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-switch-"));
    dirs.push(dir);
    const config = new ConfigStore(dir);
    const calls: string[] = [];
    const service = {
      start: async () => void calls.push(`start:${String(config.get().observatory?.enabled)}`),
      stop: async () => void calls.push("stop"),
    };
    const sw = new ObservatorySwitch(service, config);
    await Promise.all([sw.setEnabled(false), sw.restart(), sw.setEnabled(true)]);
    expect(calls).toEqual(["stop", "start:false", "stop", "start:false", "stop", "start:true"]);
    expect(config.get().observatory?.enabled).toBe(true);
    // Already on: nothing is stopped or started.
    await sw.setEnabled(true);
    expect(calls).toHaveLength(6);
  });
});

describe("controlService", () => {
  function services(): AgentServices & { done: string[] } {
    const done: string[] = [];
    return {
      done,
      restartable: () => true,
      restart: () => void done.push("restart"),
      observatory: { setEnabled: async (on) => void done.push(`observatory:${on ? "on" : "off"}`), restart: async () => void done.push("observatory:restart") },
      closeTunnel: (id) => {
        done.push(`close:${id}`);
        return id === "a";
      },
    };
  }

  it("turns Observatory on, off and restarts it", async () => {
    const s = services();
    for (const action of [AgentServiceAction.START, AgentServiceAction.STOP, AgentServiceAction.RESTART]) {
      expect(await controlService(s, { kind: AgentPortKind.OBSERVATORY, action, tunnelId: "" })).toBeUndefined();
    }
    expect(s.done).toEqual(["observatory:on", "observatory:off", "observatory:restart"]);
  });

  it("closes a tunnel, and says when it is already gone", async () => {
    const s = services();
    expect(await controlService(s, { kind: AgentPortKind.TUNNEL_HTTP, action: AgentServiceAction.STOP, tunnelId: "a" })).toBeUndefined();
    expect((await controlService(s, { kind: AgentPortKind.TUNNEL_TCP, action: AgentServiceAction.STOP, tunnelId: "z" }))?.reason).toBe(ErrorReason.ITEM_NOT_FOUND);
  });

  it("refuses what only stops with tunelo, and starting a tunnel", async () => {
    const s = services();
    for (const kind of [AgentPortKind.DEVICE_LINK, AgentPortKind.SESSION_MCP, AgentPortKind.CONTROL]) {
      expect((await controlService(s, { kind, action: AgentServiceAction.STOP, tunnelId: "" }))?.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    }
    expect((await controlService(s, { kind: AgentPortKind.TUNNEL_HTTP, action: AgentServiceAction.START, tunnelId: "a" }))?.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    expect(s.done).toEqual([]);
  });

  it("names the service and the action for the consent log", () => {
    expect(serviceAuditDetail({ kind: AgentPortKind.TUNNEL_HTTP, action: AgentServiceAction.STOP, tunnelId: "a" })).toEqual({ path: "tunnel_http:a", detail: "stop" });
    expect(serviceAuditDetail({ kind: AgentPortKind.OBSERVATORY, action: AgentServiceAction.RESTART, tunnelId: "" })).toEqual({ path: "observatory", detail: "restart" });
  });
});
