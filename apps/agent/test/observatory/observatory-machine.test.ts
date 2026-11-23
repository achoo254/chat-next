// Observatory in the running agent: the master switch off opens no port
// and reads no spool; a store that cannot open never stops the agent, and
// stopping it closes the receiver's port. The service itself:
// observatory-service.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { Machine } from "../../src/machine.ts";
import { hookStatePath } from "../../src/observatory/spool/hook-state-file.ts";
import { fakeProvider } from "../fake-provider.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** Something listens on `port` of this machine. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

describe("Observatory in the machine", () => {
  it("opens no port and reads no spool with the switch off, and tells the hooks", async () => {
    const dir = obsTempDir("machine");
    const config = new ConfigStore(dir);
    config.update((c) => (c.observatory = { enabled: false }));
    const machine = new Machine({ config, providers: [fakeProvider()], log: () => undefined });
    await machine.start(0);
    stops.push(() => machine.stop());
    const status = machine.observatory.status();
    expect(status).toMatchObject({ enabled: false, store: "off", receiver: { state: "off", port: undefined }, spool: undefined });
    expect(config.get().observatory?.otlpPort).toBeUndefined();
    expect(JSON.parse(readFileSync(hookStatePath(join(dir, "observatory")), "utf8"))).toEqual({ enabled: false, contentOff: [] });
    expect(existsSync(join(dir, "observatory", "observatory.db"))).toBe(false);
  });

  it("starts and stops the agent when the store cannot be opened, the receiver still answering", async () => {
    const dir = obsTempDir("machine");
    const lines: string[] = [];
    const machine = new Machine({
      config: new ConfigStore(dir),
      providers: [fakeProvider()],
      log: (l) => lines.push(l),
      observatory: { openStore: () => Promise.reject(Object.assign(new Error("disk says no"), { code: "EIO" })), ingest: () => ({ accept: async () => undefined }) },
    });
    const port = await machine.start(0);
    expect(port).toBeGreaterThan(0);
    const status = machine.observatory.status();
    expect(status.store).toBe("failed");
    expect(status.spool).toBeUndefined();
    expect(status.receiver.state).toBe("listening");
    const otlpPort = status.receiver.port ?? 0;
    expect(await portOpen(otlpPort)).toBe(true);
    expect(lines).toContain("observatory: store-open failed: EIO");
    await machine.stop();
    expect(await portOpen(otlpPort)).toBe(false);
  });
});
