// What only the real OS can show, so each part runs on the system it is
// about (CI runs this file on Windows; macOS and Windows for the listings):
// DPAPI seals the keys of a Windows machine, deleting a profile removes a
// junction and never what it points to, and the port and process listings
// (lsof, netstat + tasklist, PowerShell) see this very process.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { machineKey, seal, unseal } from "../src/keystore.ts";
import { removeTreeSafely } from "../src/accounts/remove.ts";
import { listeningPorts, processLines } from "../src/tunnels/listening-ports.ts";
import { tempDir } from "./harness.ts";

const windows = process.platform === "win32";

describe.runIf(windows)("DPAPI key store (Windows)", () => {
  const saved = { keystore: process.env.TUNELO_KEYSTORE };
  beforeEach(() => {
    delete process.env.TUNELO_KEYSTORE;
  });
  afterEach(() => {
    process.env.TUNELO_KEYSTORE = saved.keystore ?? "";
  });

  it("seals a secret with a DPAPI-protected key, never a plain key file", async () => {
    const dir = tempDir("dpapi-");
    const sealed = await seal(dir, "refresh-token-secret");
    expect(sealed).not.toContain("refresh-token-secret");
    expect(await unseal(dir, sealed)).toBe("refresh-token-secret");
    expect(existsSync(join(dir, "session-key.dpapi"))).toBe(true);
    expect(existsSync(join(dir, "session-key"))).toBe(false);
  });

  it("keeps one machine key across loads", async () => {
    const dir = tempDir("dpapi-");
    const first = await machineKey(dir);
    const again = await machineKey(dir);
    expect(Buffer.from(again.publicKey).equals(Buffer.from(first.publicKey))).toBe(true);
    expect(existsSync(join(dir, "machine-key.dpapi"))).toBe(true);
    expect(existsSync(join(dir, "machine-key"))).toBe(false);
  });
});

describe.runIf(windows)("deleting a profile (Windows)", () => {
  it("removes a junction without touching what it points to", () => {
    const root = tempDir("junction-");
    const target = join(root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    const dir = join(root, "profile");
    mkdirSync(dir);
    symlinkSync(target, join(dir, "projects"), "junction");
    removeTreeSafely(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe.runIf(windows || process.platform === "darwin")("listings of this machine", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("a port this process listens on, with its pid", async () => {
    const ports = await listeningPorts();
    expect(ports).toContainEqual(expect.objectContaining({ port, pid: process.pid }));
  });

  it("this process among the running ones, with its command line", async () => {
    const lines = await processLines();
    const own = lines.find((line) => line.pid === process.pid);
    expect(own?.command).toMatch(/node|vitest/i);
  });
});
