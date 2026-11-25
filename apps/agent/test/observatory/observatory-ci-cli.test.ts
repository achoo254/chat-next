// `tunelo observatory ci <on|off>`: the CI watcher's switch, through the
// running agent's control route and without an agent; every change in the
// consent log; a wrong action refused; unset is on.
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { OBSERVATORY_CI_ROUTES, observatoryCiCommand, registerObservatoryCiCommand } from "../../src/commands/observatory-ci.ts";
import type { Terminal } from "../../src/commands/mcp-local-writes.ts";
import { ConfigStore } from "../../src/config.ts";
import { ciWatchEnabled } from "../../src/observatory/ci/ci-watch-config.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { tempDir } from "../harness.ts";

type Setup = { dir: string; out: string[]; deps: Parameters<typeof observatoryCiCommand>[0]; calls: unknown[] };

/** A config folder; `running` routes the command through the control route, called here without the socket. */
function setup(running: boolean): Setup {
  const dir = tempDir("ci-cli-");
  const out: string[] = [];
  const calls: unknown[] = [];
  const machine = { config: new ConfigStore(dir), audit: new AuditLog(join(dir, "audit.jsonl")) };
  const term: Terminal = { interactive: false, ask: async () => "", print: (l) => out.push(l), printError: () => undefined };
  return {
    dir,
    out,
    calls,
    deps: {
      dir,
      term,
      running: async () => running,
      call: async (method, path, input) => {
        calls.push([method, path, input]);
        const route = OBSERVATORY_CI_ROUTES[`${method} ${path}`];
        if (!route) throw new Error(`no route ${method} ${path}`);
        return route({ machine }, input);
      },
    },
  };
}

const audit = (dir: string): string[] => new AuditLog(join(dir, "audit.jsonl")).list().map((e) => `${e.action} ${e.detail}`);
const enabled = (dir: string): boolean => ciWatchEnabled(new ConfigStore(dir).get().observatory?.ci);

describe.each([true, false])("with the agent running: %s", (running) => {
  it("switches the watcher off and on, each change in the consent log", async () => {
    const s = setup(running);
    expect(enabled(s.dir)).toBe(true);
    await observatoryCiCommand(s.deps, "off");
    expect(new ConfigStore(s.dir).get().observatory?.ci?.enabled).toBe(false);
    expect(enabled(s.dir)).toBe(false);
    await observatoryCiCommand(s.deps, "ON");
    expect(enabled(s.dir)).toBe(true);
    expect(audit(s.dir)).toEqual(["observatory_ci ci watch on", "observatory_ci ci watch off"]);
    expect(s.calls.length).toBe(running ? 2 : 0);
  });

  it("refuses an action other than on or off, changing nothing", async () => {
    const s = setup(running);
    await expect(observatoryCiCommand(s.deps, "maybe")).rejects.toThrow(/on or off/);
    expect(new ConfigStore(s.dir).get().observatory?.ci).toBeUndefined();
    expect(audit(s.dir)).toEqual([]);
  });
});

describe("the control route", () => {
  it("refuses input without a boolean, and a machine that runs tunnels only", () => {
    const s = setup(true);
    const route = OBSERVATORY_CI_ROUTES["POST /observatory/ci"];
    expect(route).toBeDefined();
    const machine = { config: new ConfigStore(s.dir), audit: new AuditLog(join(s.dir, "audit.jsonl")) };
    expect(() => route?.({ machine }, { enabled: "yes" })).toThrow();
    expect(() => route?.({}, { enabled: true })).toThrow(/tunnels only/);
    expect(audit(s.dir)).toEqual([]);
  });
});

describe("ciWatchEnabled", () => {
  it("is on unless set to false", () => {
    expect(ciWatchEnabled(undefined)).toBe(true);
    expect(ciWatchEnabled({})).toBe(true);
    expect(ciWatchEnabled({ enabled: true })).toBe(true);
    expect(ciWatchEnabled({ enabled: false })).toBe(false);
  });
});

it("is a subcommand of `tunelo observatory`", async () => {
  const s = setup(false);
  const program = new Command().exitOverride();
  const observatory = program.command("observatory");
  const exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => async (...args: A): Promise<void> => void (await run(...args));
  registerObservatoryCiCommand(observatory, exits, () => s.deps);
  await program.parseAsync(["observatory", "ci", "off"], { from: "user" });
  expect(enabled(s.dir)).toBe(false);
  expect(s.out).toEqual(["GitHub Actions runs are no longer followed after a push; events already stored stay."]);
});
