// macOS: every terminal process (a shell, the AI's CLI) runs in tunelo's
// sandbox, and asking macOS for a folder has the terminal process read it
// too, so macOS asks about it while the user waits instead of later in a shell.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { TerminalService } from "../src/terminal/terminal-service.ts";
import { tempDir } from "./harness.ts";

function service(sandbox: string | undefined) {
  const dir = tempDir("term-sb-");
  const terminal = new TerminalService({
    configDir: join(dir, "cfg"),
    config: new ConfigStore(join(dir, "cfg")),
    audit: new AuditLog(join(dir, "audit.jsonl")),
    unit: undefined,
    log: () => undefined,
    sandbox: () => sandbox,
  });
  const calls: [string, Record<string, unknown>][] = [];
  vi.spyOn(terminal as never as { ensure: () => Promise<void> }, "ensure").mockResolvedValue(undefined);
  vi.spyOn(terminal, "call").mockImplementation(async (cmd, params) => {
    calls.push([cmd, params]);
    return { session: 7 };
  });
  return { terminal, calls };
}

describe("the terminal on macOS", () => {
  it("opens a shell in the sandbox tunelo gives, and as before without one", async () => {
    const fenced = service("(version 1)(allow default)");
    await fenced.terminal.open(80, 24, "/Users/an/work");
    expect(fenced.calls).toEqual([["open", { cols: 80, rows: 24, cwd: "/Users/an/work", sandbox: "(version 1)(allow default)" }]]);
    const plain = service(undefined);
    await plain.terminal.open(80, 24, "/Users/an/work");
    expect(plain.calls).toEqual([["open", { cols: 80, rows: 24, cwd: "/Users/an/work" }]]);
  });

  it("has the terminal process read a folder the user lets tunelo ask macOS for", async () => {
    const { terminal, calls } = service(undefined);
    terminal.probeFolder("/Users/an/Documents");
    await vi.waitFor(() => expect(calls).toEqual([["probe", { path: "/Users/an/Documents" }]]));
  });
});
