import { AgentUpdatePhase } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AgentUpdater, UpdateBusy, UpdateUnavailable, type UpdateProgress } from "../src/agent-updater.ts";

function setup(over: { supported?: boolean; check?: () => Promise<string | null>; install?: (log: (l: string) => void, p?: (r: number, t: number) => void, ph?: (x: "verifying" | "installing") => void) => Promise<string | null> } = {}) {
  const events: UpdateProgress[] = [];
  const state = { announced: 0, restarted: 0 };
  const updater = new AgentUpdater({
    supported: () => over.supported ?? true,
    announce: () => state.announced++,
    emit: (p) => events.push(p),
    restart: () => state.restarted++,
    log: () => undefined,
    check: over.check ?? (() => Promise.resolve("2.3.0")),
    ...(over.install ? { install: over.install } : {}),
  });
  return { updater, events, state };
}

describe("AgentUpdater", () => {
  it("remembers the newest release and tells devices when it changes", async () => {
    const { updater, state } = setup();
    await updater.check();
    expect(updater.info()).toEqual({ supported: true, latestVersion: "2.3.0", updating: false });
    await updater.check();
    expect(state.announced).toBe(1);
  });

  it("keeps what it knew when the release list cannot be reached", async () => {
    let fail = false;
    const { updater } = setup({ check: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve("2.3.0")) });
    await updater.check();
    fail = true;
    await updater.check();
    expect(updater.info().latestVersion).toBe("2.3.0");
  });

  it("reports each step, then restarts", async () => {
    const { updater, events, state } = setup({
      install: async (_log, progress, phase) => {
        progress?.(50, 100);
        progress?.(100, 100);
        phase?.("verifying");
        phase?.("installing");
        return "2.3.0";
      },
    });
    await updater.check();
    await updater.run();
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe(AgentUpdatePhase.DOWNLOADING);
    expect(phases.slice(-3)).toEqual([AgentUpdatePhase.VERIFYING, AgentUpdatePhase.INSTALLING, AgentUpdatePhase.RESTARTING]);
    expect(events.at(-1)?.version).toBe("2.3.0");
    expect(events.some((e) => e.received === 100 && e.total === 100)).toBe(true);
    expect(state.restarted).toBe(1);
    expect(updater.info().updating).toBe(false);
  });

  it("says so when it is already the newest, and does not restart", async () => {
    const { updater, events, state } = setup({ install: () => Promise.resolve(null) });
    await updater.run();
    expect(events.at(-1)?.phase).toBe(AgentUpdatePhase.UP_TO_DATE);
    expect(state.restarted).toBe(0);
  });

  it("reports a failure with its reason and stays running", async () => {
    const { updater, events, state } = setup({ install: () => Promise.reject(new Error("signature check failed")) });
    await updater.run();
    expect(events.at(-1)).toMatchObject({ phase: AgentUpdatePhase.FAILED, message: "signature check failed" });
    expect(state.restarted).toBe(0);
    expect(updater.info().updating).toBe(false);
  });

  it("refuses where it cannot replace its own file", () => {
    const { updater } = setup({ supported: false });
    expect(() => updater.assertCanRun()).toThrow(UpdateUnavailable);
  });

  it("refuses a second update while one runs", async () => {
    let release: (v: string | null) => void = () => undefined;
    const { updater } = setup({ install: () => new Promise((r) => (release = r)) });
    const first = updater.run();
    expect(() => updater.assertCanRun()).toThrow(UpdateBusy);
    release(null);
    await first;
    expect(() => updater.assertCanRun()).not.toThrow();
  });
});
