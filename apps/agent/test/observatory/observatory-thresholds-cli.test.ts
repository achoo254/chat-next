// `tunelo observatory thresholds`: listing, setting a threshold for a rule
// or one subkey, putting the default back, switching the rules, refusing a
// wrong value, both through the running agent's control routes and without an
// agent; every change in the consent log. The config's thresholds as the
// runner reads them: a value of the wrong type falls back to the default.
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { OBSERVATORY_THRESHOLD_ROUTES, observatoryThresholdsListCommand, observatoryThresholdsRulesCommand, observatoryThresholdsSetCommand, registerObservatoryThresholdsCommand } from "../../src/commands/observatory-thresholds.ts";
import type { Terminal } from "../../src/commands/mcp-local-writes.ts";
import { ConfigStore } from "../../src/config.ts";
import { DEFAULT_THRESHOLDS, ThresholdTable } from "../../src/observatory/bottlenecks/bottleneck-thresholds.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { tempDir } from "../harness.ts";

type Setup = { dir: string; out: string[]; err: string[]; deps: Parameters<typeof observatoryThresholdsListCommand>[0]; calls: unknown[] };

/** A config folder; `running` routes the commands through the control routes, called here without the socket. */
function setup(running: boolean): Setup {
  const dir = tempDir("thresholds-cli-");
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const config = new ConfigStore(dir);
  const machine = { config, audit: new AuditLog(join(dir, "audit.jsonl")) };
  const term: Terminal = { interactive: false, ask: async () => "", print: (l) => out.push(l), printError: (l) => err.push(l) };
  return {
    dir,
    out,
    err,
    calls,
    deps: {
      dir,
      term,
      running: async () => running,
      call: async (method, path, input) => {
        calls.push([method, path, input]);
        const route = OBSERVATORY_THRESHOLD_ROUTES[`${method} ${path}`];
        if (!route) throw new Error(`no route ${method} ${path}`);
        return route({ machine }, input);
      },
    },
  };
}

const audit = (dir: string): string[] => new AuditLog(join(dir, "audit.jsonl")).list().map((e) => `${e.action} ${e.path} ${e.detail}`);

describe.each([true, false])("with the agent running: %s", (running) => {
  it("sets a threshold for a rule and for one subkey, puts the default back, and logs each change", async () => {
    const s = setup(running);
    await observatoryThresholdsSetCommand(s.deps, "tool_slow", "warnRatio", "2", undefined);
    await observatoryThresholdsSetCommand(s.deps, "tool_slow", "minExcessMs", "20000", "Bash|TESTING|pnpm");
    let thresholds = new ConfigStore(s.dir).get().observatory?.thresholds;
    expect(thresholds?.rules?.tool_slow).toEqual({ values: { warnRatio: 2 }, subkeys: { "Bash|TESTING|pnpm": { minExcessMs: 20_000 } } });
    const table = new ThresholdTable(thresholds, () => undefined);
    expect(table.of("tool_slow", "Bash|TESTING|pnpm")).toMatchObject({ warnRatio: 2, minExcessMs: 20_000 });
    expect(table.of("tool_slow", "Bash|SANDBOX|ls")).toMatchObject({ warnRatio: 2, minExcessMs: 5_000 });
    await observatoryThresholdsSetCommand(s.deps, "tool_slow", "minExcessMs", "default", "Bash|TESTING|pnpm");
    thresholds = new ConfigStore(s.dir).get().observatory?.thresholds;
    expect(thresholds?.rules?.tool_slow).toEqual({ values: { warnRatio: 2 } });
    expect(audit(s.dir)).toEqual([
      "observatory_thresholds tool_slow Bash|TESTING|pnpm minExcessMs=default",
      "observatory_thresholds tool_slow Bash|TESTING|pnpm minExcessMs=20000",
      "observatory_thresholds tool_slow warnRatio=2",
    ]);
    expect(s.calls.length).toBe(running ? 3 : 0);
  });

  it("refuses an unknown rule, an unknown threshold or a wrong value, changing nothing", async () => {
    const s = setup(running);
    await expect(observatoryThresholdsSetCommand(s.deps, "slow_tools", "warnRatio", "2", undefined)).rejects.toThrow(/unknown rule/);
    await expect(observatoryThresholdsSetCommand(s.deps, "tool_slow", "ratio", "2", undefined)).rejects.toThrow(/unknown threshold/);
    await expect(observatoryThresholdsSetCommand(s.deps, "tool_slow", "warnRatio", "fast", undefined)).rejects.toThrow(/not a number/);
    await expect(observatoryThresholdsSetCommand(s.deps, "repeat_read", "warnReads", "2.5", undefined)).rejects.toThrow(/whole number/);
    await expect(observatoryThresholdsSetCommand(s.deps, "mcp_errors", "warnRate", "1.5", undefined)).rejects.toThrow(/above 1/);
    expect(new ConfigStore(s.dir).get().observatory?.thresholds).toBeUndefined();
    expect(audit(s.dir)).toEqual([]);
  });

  it("switches the rules off and on", async () => {
    const s = setup(running);
    await observatoryThresholdsRulesCommand(s.deps, "off");
    expect(new ConfigStore(s.dir).get().observatory?.thresholds?.enabled).toBe(false);
    await observatoryThresholdsRulesCommand(s.deps, "on");
    expect(new ConfigStore(s.dir).get().observatory?.thresholds?.enabled).toBe(true);
    await expect(observatoryThresholdsRulesCommand(s.deps, "maybe")).rejects.toThrow(/on or off/);
    expect(audit(s.dir)).toEqual(["observatory_thresholds  rules on", "observatory_thresholds  rules off"]);
  });
});

describe("listing", () => {
  it("shows every rule's thresholds, the overrides marked, and a bad value of a hand-edited config", async () => {
    const s = setup(false);
    new ConfigStore(s.dir).update((c) => (c.observatory = { thresholds: { rules: { repeat_read: { values: { warnReads: 4, alertReads: "many" } } } } }));
    await observatoryThresholdsListCommand(s.deps, false);
    expect(s.out[0]).toBe("Bottleneck rules: on");
    expect(s.out).toContain("repeat_read: warnReads=4 (set), alertReads=5");
    expect(s.out.filter((l) => !l.startsWith(" ")).length).toBe(8);
    expect(s.err).toEqual(["tunelo: repeat_read.alertReads: not a number, the default 5 is used"]);
    s.out.length = 0;
    await observatoryThresholdsListCommand(s.deps, true);
    const json = JSON.parse(s.out.join("\n")) as { enabled: boolean; rules: Record<string, { values: Record<string, number> }> };
    expect(json.rules.tool_slow?.values).toEqual(DEFAULT_THRESHOLDS.tool_slow);
  });

  it("is a subcommand group of `tunelo observatory`", async () => {
    const s = setup(false);
    const program = new Command().exitOverride();
    const observatory = program.command("observatory");
    const exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => async (...args: A): Promise<void> => void (await run(...args));
    registerObservatoryThresholdsCommand(observatory, exits, () => s.deps);
    await program.parseAsync(["observatory", "thresholds", "set", "cost_spike", "warnRatio", "3", "--subkey", "prompt-1"], { from: "user" });
    await program.parseAsync(["observatory", "thresholds"], { from: "user" });
    expect(new ConfigStore(s.dir).get().observatory?.thresholds?.rules?.cost_spike).toEqual({ subkeys: { "prompt-1": { warnRatio: 3 } } });
    expect(s.out).toContain("  prompt-1: warnRatio=3 (set), alertRatio=4, minN=20, minUsd=1, minTokens=2000000, closeAfterMs=60000");
  });
});
