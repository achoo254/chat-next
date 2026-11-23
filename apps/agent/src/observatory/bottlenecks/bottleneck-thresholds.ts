// The thresholds of the bottleneck rules: a default for every parameter of
// every rule, overridden in the agent's config (`observatory.thresholds`)
// for a rule, then for one subkey of it (a tool key, a model, an MCP
// server…). The config is a file a person may edit by hand: a value of the
// wrong type or out of range is reported (once per config read) and the
// default is used in its place, never the bad value.
//
// Every rule has floors besides its ratios (a minimum count of history, an
// absolute excess, a minimum cost), so thin history or tiny numbers never
// raise a finding on their own.
import type { ConfigStore, ObservatoryThresholdsConfig, ThresholdOverrides } from "../../config.ts";

export const BOTTLENECK_RULES = ["tool_slow", "api_slow_or_limited", "repeat_read", "context_high", "mcp_errors", "subagent_idle", "cost_spike"] as const;

export type BottleneckRule = (typeof BOTTLENECK_RULES)[number];

/** Each rule's parameters and their defaults. */
export const DEFAULT_THRESHOLDS = {
  tool_slow: {
    /** A call longer than this many times its key's p95 is a warning… */
    warnRatio: 1.5,
    /** …and this many times an alert. */
    alertRatio: 3,
    /** Floor: the call is at least this much longer than the p95. */
    minExcessMs: 5_000,
    /** Calls of the key in history needed before the p95 is trusted. */
    minN: 20,
    /** A finding closes this long after the slow call ended. */
    closeAfterMs: 60_000,
  },
  api_slow_or_limited: {
    /** ms per output token above this many times the model's p95… */
    warnRatio: 1,
    /** …on a call longer than this (floor). */
    minDurationMs: 10_000,
    minN: 20,
  },
  repeat_read: {
    /** Reads of the same page of one file with no write of it in between. */
    warnReads: 3,
    alertReads: 5,
  },
  context_high: {
    warnPercent: 80,
    alertPercent: 95,
  },
  mcp_errors: {
    /** Floor: failed calls of the server. */
    minErrors: 3,
    warnRate: 0.3,
    alertRate: 0.5,
    /** Successful calls in a row that close the finding. */
    closeSuccesses: 5,
  },
  subagent_idle: {
    warnMinutes: 5,
    alertMinutes: 15,
    /** Tokens per minute below which a running subagent is idle. */
    minTokensPerMinute: 2_000,
  },
  cost_spike: {
    warnRatio: 2,
    alertRatio: 4,
    /** Earlier turns of the project needed for their p95. */
    minN: 20,
    /** Floors: a turn costing less (or using fewer tokens, when cost is missing) is never a spike. */
    minUsd: 1,
    minTokens: 2_000_000,
    closeAfterMs: 60_000,
  },
} as const satisfies Record<BottleneckRule, Record<string, number>>;

export type ThresholdParams<R extends BottleneckRule> = { -readonly [P in keyof (typeof DEFAULT_THRESHOLDS)[R]]: number };

/** What a parameter may hold: a whole number, at most `max`, more than 0 when `positive`. */
type Limit = { integer?: boolean; max?: number; positive?: boolean };

const LIMITS: Readonly<Record<string, Limit>> = {
  warnRatio: { positive: true },
  alertRatio: { positive: true },
  minN: { integer: true },
  minErrors: { integer: true },
  closeSuccesses: { integer: true, positive: true },
  warnReads: { integer: true, positive: true },
  alertReads: { integer: true, positive: true },
  warnPercent: { max: 100, positive: true },
  alertPercent: { max: 100, positive: true },
  warnRate: { max: 1, positive: true },
  alertRate: { max: 1, positive: true },
};

/** The longest subkey an override names (a tool key, a model, a file key). */
export const MAX_SUBKEY_LENGTH = 512;

export function isBottleneckRule(name: string): name is BottleneckRule {
  return (BOTTLENECK_RULES as readonly string[]).includes(name);
}

/** The parameter names of `rule`. */
export function paramsOf(rule: BottleneckRule): string[] {
  return Object.keys(DEFAULT_THRESHOLDS[rule]);
}

/** Why `value` cannot be `param`'s; undefined when it can. */
export function invalidValue(param: string, value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return "not a number";
  const limit = LIMITS[param] ?? {};
  if (value < 0) return "below 0";
  if (limit.positive === true && value === 0) return "must be above 0";
  if (limit.integer === true && !Number.isInteger(value)) return "not a whole number";
  if (limit.max !== undefined && value > limit.max) return `above ${limit.max}`;
  return undefined;
}

const objectOf = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * The thresholds of one config read: the defaults with the overrides that
 * passed the checks. `report` hears every override refused, when the table is
 * built.
 */
export class ThresholdTable {
  private readonly byRule = new Map<BottleneckRule, { base: Record<string, number>; subkeys: Map<string, Record<string, number>> }>();

  constructor(config: ObservatoryThresholdsConfig | undefined, report: (problem: string) => void) {
    const rules = objectOf(config?.rules) ?? {};
    for (const rule of BOTTLENECK_RULES) {
      const defaults: Record<string, number> = { ...DEFAULT_THRESHOLDS[rule] };
      const given = objectOf(rules[rule]);
      const base = { ...defaults, ...this.checked(rule, "", objectOf(given?.values), defaults, report) };
      const subkeys = new Map<string, Record<string, number>>();
      for (const [subkey, values] of Object.entries(objectOf(given?.subkeys) ?? {})) {
        if (subkey.length > MAX_SUBKEY_LENGTH) {
          report(`${rule}: an override's subkey is longer than ${MAX_SUBKEY_LENGTH} characters, ignored`);
          continue;
        }
        subkeys.set(subkey, { ...base, ...this.checked(rule, subkey, objectOf(values), defaults, report) });
      }
      this.byRule.set(rule, { base, subkeys });
    }
    for (const name of Object.keys(rules)) if (!isBottleneckRule(name)) report(`unknown bottleneck rule ${JSON.stringify(name.slice(0, 40))} in the thresholds, ignored`);
  }

  private checked(rule: BottleneckRule, subkey: string, values: Record<string, unknown> | undefined, defaults: Record<string, number>, report: (problem: string) => void): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [param, value] of Object.entries(values ?? {})) {
      const where = `${rule}${subkey ? ` (${subkey.slice(0, 60)})` : ""}.${param.slice(0, 40)}`;
      if (!(param in defaults)) {
        report(`${where}: no such threshold, ignored`);
        continue;
      }
      const why = invalidValue(param, value);
      if (why) report(`${where}: ${why}, the default ${defaults[param]} is used`);
      else out[param] = value as number;
    }
    return out;
  }

  /** The parameters of `rule` for `subkey` ('' for the rule's own). */
  of<R extends BottleneckRule>(rule: R, subkey = ""): ThresholdParams<R> {
    const entry = this.byRule.get(rule);
    const values = entry?.subkeys.get(subkey) ?? entry?.base ?? { ...DEFAULT_THRESHOLDS[rule] };
    return values as ThresholdParams<R>;
  }

  /** Every subkey of `rule` with overrides of its own. */
  subkeysOf(rule: BottleneckRule): string[] {
    return [...(this.byRule.get(rule)?.subkeys.keys() ?? [])];
  }
}

/** A change of one threshold: `value` null puts the default back. */
export type ThresholdChange = { rule: BottleneckRule; param: string; value: number | null; subkey?: string | undefined };

/** Checks `change` against the rules and their parameters; throws with what is wrong. */
export function checkThresholdChange(change: { rule: string; param: string; value: unknown; subkey?: string | undefined }): ThresholdChange {
  const { rule, param, value, subkey } = change;
  if (!isBottleneckRule(rule)) throw new Error(`unknown rule ${rule}: one of ${BOTTLENECK_RULES.join(", ")}`);
  if (!paramsOf(rule).includes(param)) throw new Error(`unknown threshold ${param} of ${rule}: one of ${paramsOf(rule).join(", ")}`);
  if (subkey !== undefined && (subkey.length === 0 || subkey.length > MAX_SUBKEY_LENGTH)) throw new Error(`a subkey is 1 to ${MAX_SUBKEY_LENGTH} characters`);
  if (value !== null) {
    const why = invalidValue(param, value);
    if (why) throw new Error(`${rule}.${param}: ${why}`);
  }
  return { rule, param, value: value as number | null, subkey };
}

/** `values` with `param` set to `value`, or left out for null. */
function withValue(values: Record<string, unknown> | undefined, param: string, value: number | null): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(values ?? {}).filter(([p]) => p !== param));
  return value === null ? rest : { ...rest, [param]: value };
}

/** `record` without its empty objects, so the file shows only what differs from the defaults. */
function withoutEmpty<V extends object>(record: Record<string, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => Object.keys(v).length > 0));
}

/** Writes `change` into the config (the caller writes the consent log). */
export function applyThresholdChange(config: ConfigStore, change: ThresholdChange): void {
  const checked = checkThresholdChange(change);
  config.update((c) => {
    const observatory = (c.observatory ??= {});
    const thresholds = (observatory.thresholds ??= {});
    const entry = thresholds.rules?.[checked.rule] ?? {};
    const next: ThresholdOverrides =
      checked.subkey === undefined
        ? { ...entry, values: withValue(entry.values, checked.param, checked.value) }
        : { ...entry, subkeys: withoutEmpty({ ...entry.subkeys, [checked.subkey]: withValue(entry.subkeys?.[checked.subkey], checked.param, checked.value) }) };
    const trimmed = withoutEmpty({ values: next.values ?? {}, subkeys: next.subkeys ?? {} }) as ThresholdOverrides;
    thresholds.rules = withoutEmpty({ ...thresholds.rules, [checked.rule]: trimmed });
  });
}

/** Switches the bottleneck rules on or off (unset is on). */
export function setBottleneckRulesEnabled(config: ConfigStore, enabled: boolean): void {
  config.update((c) => {
    const observatory = (c.observatory ??= {});
    (observatory.thresholds ??= {}).enabled = enabled;
  });
}

/** Whether the bottleneck rules run (the Observatory switch aside). */
export function bottleneckRulesEnabled(config: ObservatoryThresholdsConfig | undefined): boolean {
  return config?.enabled !== false;
}
