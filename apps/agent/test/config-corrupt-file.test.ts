import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";

describe("ConfigStore with a damaged config.json", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-config-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts on defaults when a crash left the file all zero bytes, keeping the bad file aside", () => {
    writeFileSync(join(dir, "config.json"), Buffer.alloc(3110));
    const store = new ConfigStore(dir);
    expect(store.get().maxSessions).toBe(50);
    expect(readdirSync(dir).some((f) => f.startsWith("config.json.corrupt-"))).toBe(true);
  });

  it("starts on defaults when the file is not a JSON object", () => {
    writeFileSync(join(dir, "config.json"), "[1,2]");
    expect(new ConfigStore(dir).get().trustedDirs).toEqual([]);
  });

  it("writes a readable file again after recovering", () => {
    writeFileSync(join(dir, "config.json"), "");
    new ConfigStore(dir).update((c) => {
      c.machineName = "pc";
    });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).machineName).toBe("pc");
    expect(new ConfigStore(dir).get().machineName).toBe("pc");
  });
});
