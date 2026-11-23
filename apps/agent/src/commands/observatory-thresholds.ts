// `tunelo observatory thresholds …`: the bottleneck rules' thresholds
// (observatory/bottlenecks/bottleneck-thresholds.ts).
// - `thresholds [--json]` lists every rule's thresholds as they apply now,
//   the overrides marked, and whether the rules run;
// - `thresholds set <rule> <threshold> <value|default> [--subkey <key>]`
//   changes one, for the rule or one subkey of it (`default` puts the default
//   back);
// - `thresholds rules <on|off>` switches the rules (findings already stored stay).
// With the agent running every change goes through its control channel (the
// agent owns the config); without it the command writes the config itself.
// Every change goes to the consent log (audit.jsonl), as the content switch.
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { ConfigStore } from "../config.ts";
import {
  BOTTLENECK_RULES,
  DEFAULT_THRESHOLDS,
  MAX_SUBKEY_LENGTH,
  type ThresholdChange,
  ThresholdTable,
  applyThresholdChange,
  bottleneckRulesEnabled,
  checkThresholdChange,
  setBottleneckRulesEnabled,
} from "../observatory/bottlenecks/bottleneck-thresholds.ts";
import { AuditLog } from "../safety/audit-log.ts";
import type { ObservatoryCliDeps } from "./observatory-actions.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;
type ThresholdsDeps = Pick<ObservatoryCliDeps, "dir" | "call" | "running" | "term">;

const changeInput = z.object({
  rule: z.string().min(1).max(64),
  param: z.string().min(1).max(64),
  value: z.number().finite().nullable(),
  subkey: z.string().min(1).max(MAX_SUBKEY_LENGTH).optional(),
});
const rulesInput = z.object({ enabled: z.boolean() });

/** The consent log's line of a change: the rule (and subkey) as path, `threshold=value` as detail. */
function auditChange(audit: AuditLog, change: ThresholdChange): void {
  audit.write({ device: "local", action: "observatory_thresholds", path: change.subkey === undefined ? change.rule : `${change.rule} ${change.subkey}`, detail: `${change.param}=${change.value ?? "default"}` });
}

/** What the routes use of the machine: its config (the runner reads the thresholds from it at every scoring) and the consent log. */
type ThresholdsMachine = { readonly config: ConfigStore; readonly audit: AuditLog };
type ThresholdsRoute = (target: { machine?: ThresholdsMachine | undefined }, input: unknown) => unknown;

function machineOf(target: { machine?: ThresholdsMachine | undefined }): ThresholdsMachine {
  if (!target.machine) throw new Error("this tunelo runs tunnels only");
  return target.machine;
}

/** The control channel's routes of these commands (control-socket.ts). */
export const OBSERVATORY_THRESHOLD_ROUTES: Readonly<Record<string, ThresholdsRoute>> = {
  "POST /observatory/thresholds": (t, input) => {
    const m = machineOf(t);
    const change = checkThresholdChange(changeInput.parse(input));
    applyThresholdChange(m.config, change);
    auditChange(m.audit, change);
    return { changed: true };
  },
  "POST /observatory/thresholds/rules": (t, input) => {
    const m = machineOf(t);
    const { enabled } = rulesInput.parse(input);
    setBottleneckRulesEnabled(m.config, enabled);
    m.audit.write({ device: "local", action: "observatory_thresholds", path: "", detail: enabled ? "rules on" : "rules off" });
    return { enabled };
  },
};

/** `tunelo observatory thresholds [--json]`. */
export async function observatoryThresholdsListCommand(deps: ThresholdsDeps, json: boolean): Promise<number> {
  const config = new ConfigStore(deps.dir).get().observatory?.thresholds;
  const problems: string[] = [];
  const table = new ThresholdTable(config, (p) => problems.push(p));
  const rules = Object.fromEntries(
    BOTTLENECK_RULES.map((rule) => [rule, { values: table.of(rule), subkeys: Object.fromEntries(table.subkeysOf(rule).map((s) => [s, table.of(rule, s)])) }]),
  );
  const enabled = bottleneckRulesEnabled(config);
  if (json) {
    deps.term.print(JSON.stringify({ enabled, rules, problems }, null, 2));
    return 0;
  }
  deps.term.print(`Bottleneck rules: ${enabled ? "on" : "off"}`);
  for (const rule of BOTTLENECK_RULES) {
    const defaults: Record<string, number> = DEFAULT_THRESHOLDS[rule];
    const shown = (values: Record<string, number>): string => Object.entries(values).map(([p, v]) => `${p}=${v}${v !== defaults[p] ? " (set)" : ""}`).join(", ");
    deps.term.print(`${rule}: ${shown(rules[rule]?.values ?? {})}`);
    for (const [subkey, values] of Object.entries(rules[rule]?.subkeys ?? {})) deps.term.print(`  ${subkey}: ${shown(values)}`);
  }
  for (const p of problems) deps.term.printError(`tunelo: ${p}`);
  return 0;
}

/** `tunelo observatory thresholds set <rule> <threshold> <value|default> [--subkey <key>]`. */
export async function observatoryThresholdsSetCommand(deps: ThresholdsDeps, rule: string, param: string, raw: string, subkey: string | undefined): Promise<number> {
  const value = raw.trim().toLowerCase() === "default" ? null : Number(raw);
  if (value !== null && (raw.trim() === "" || !Number.isFinite(value))) throw new Error(`${raw} is not a number: give a number or default`);
  const change = checkThresholdChange({ rule, param, value, subkey });
  if (await deps.running()) await deps.call("POST", "/observatory/thresholds", change);
  else {
    applyThresholdChange(new ConfigStore(deps.dir), change);
    auditChange(new AuditLog(join(deps.dir, "audit.jsonl")), change);
  }
  deps.term.print(`${change.rule}${subkey === undefined ? "" : ` (${subkey})`}: ${change.param} is ${value === null ? "back to its default" : `now ${value}`}.`);
  return 0;
}

/** `tunelo observatory thresholds rules <on|off>`. */
export async function observatoryThresholdsRulesCommand(deps: ThresholdsDeps, action: string): Promise<number> {
  const chosen = action.toLowerCase();
  if (chosen !== "on" && chosen !== "off") throw new Error(`unknown action ${action}: use on or off`);
  const enabled = chosen === "on";
  if (await deps.running()) await deps.call("POST", "/observatory/thresholds/rules", { enabled });
  else {
    setBottleneckRulesEnabled(new ConfigStore(deps.dir), enabled);
    new AuditLog(join(deps.dir, "audit.jsonl")).write({ device: "local", action: "observatory_thresholds", path: "", detail: enabled ? "rules on" : "rules off" });
  }
  deps.term.print(enabled ? "The bottleneck rules run again." : "The bottleneck rules are off; findings already stored stay.");
  return 0;
}

/** Adds `thresholds` to `tunelo observatory`. */
export function registerObservatoryThresholdsCommand(observatory: Command, exits: Exits, deps: () => ThresholdsDeps): void {
  const thresholds = observatory
    .command("thresholds")
    .description("the bottleneck rules' thresholds: list them, set one (for a rule or one subkey), switch the rules on or off")
    .option("--json", "as JSON")
    .action(exits((options: { json?: boolean }) => observatoryThresholdsListCommand(deps(), options.json === true)));
  thresholds
    .command("set <rule> <threshold> <value>")
    .description("set one threshold of a rule (a number, or default to put the default back)")
    .option("--subkey <key>", "only for this subkey of the rule (a tool key like Bash|TESTING|pnpm, a model, an MCP server)")
    .action(exits((rule: string, param: string, value: string, options: { subkey?: string }) => observatoryThresholdsSetCommand(deps(), rule, param, value, options.subkey)));
  thresholds
    .command("rules <action>")
    .description("on or off: run the bottleneck rules (on by default)")
    .action(exits((action: string) => observatoryThresholdsRulesCommand(deps(), action)));
}
