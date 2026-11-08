// local-forward.json: read again when it changed, so a running service sees
// what `tunelo config local-forward` wrote while it could not answer; every
// change is a locked read-modify-write, so changes from several processes at
// once are all kept; an unreadable file turns forwarding off.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FORWARD_SETTINGS_FILE, ForwardSettings } from "../../src/tunnels/forward-settings.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-forward-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function child(from: number, to: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(import.meta.dirname, "..", "support", "forward-settings-child.ts"), dir, String(from), String(to)], { stdio: ["ignore", "ignore", "inherit"] });
    p.once("error", reject);
    p.once("exit", (code) => resolve(code ?? 1));
  });
}

describe("local-forward.json", () => {
  test("no file: on, nothing extra blocked; an unreadable file: off", () => {
    const settings = new ForwardSettings(dir);
    expect(settings.read()).toEqual({ enabled: true, blockedPorts: [] });
    writeFileSync(join(dir, FORWARD_SETTINGS_FILE), "{not json");
    expect(settings.read().enabled).toBe(false);
  });

  test("a change by another writer is seen by the running service without a restart", async () => {
    const service = new ForwardSettings(dir);
    expect(service.read().enabled).toBe(true);
    await new ForwardSettings(dir).update((s) => {
      s.enabled = false;
    });
    expect(service.read().enabled).toBe(false);
    // The service's own change keeps what the command wrote.
    await service.update((s) => {
      s.blockedPorts.push(8080);
    });
    expect(new ForwardSettings(dir).read()).toEqual({ enabled: false, blockedPorts: [8080] });
  });

  test("changes from several processes at the same time are all kept", async () => {
    const codes = await Promise.all([child(1000, 1009), child(2000, 2009), child(3000, 3009)]);
    expect(codes).toEqual([0, 0, 0]);
    const blocked = new ForwardSettings(dir).read().blockedPorts;
    expect(blocked).toHaveLength(30);
  }, 60_000);
});
