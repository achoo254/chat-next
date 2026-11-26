// Suggestions from the ledger's calls: pure functions over one session's
// calls, each rule firing at most once per session, at the call where it
// first held. Thresholds live in USAGE_RULES only; a person can switch each
// rule off (kept in the agent's config, `usageRules`).
//
// 1. context: a main-session call carried more context than maxContext
//    (open a new session or compact).
// 2. turns: the main session went past maxTurns calls.
// 3. mechanical (experimental): a strong model doing mechanical work. A call
//    is mechanical when it used at least one tool, every tool it used reads,
//    searches or runs a command (the AI's ModelCatalog.mechanicalTools), and
//    it wrote at most maxOutput tokens. The rule holds once the session made
//    at least minCalls main-session calls on a model its AI's catalog ranks
//    strong and at least minShare of them were mechanical. An AI without a
//    catalog never fires it.
// 4. subagents: the session's subagents carried more than maxShare of its
//    context (main and subagent calls together), once that context reached
//    minContext.
//
// Each suggestion also carries what the habit cost the whole session at API
// prices (excessUsd, an estimate; 0 without prices): for context, the cache
// reads of every main call's context above maxContext; for turns, the calls
// after maxTurns; for mechanical, the mechanical calls on a strong model
// against the AI's standard model; for subagents, nothing.
//
// Context of a call = input + cache read + cache write tokens. A suggestion
// holds numbers, a rule code and the session's id only.
import type { ModelCatalog } from "../providers/types.ts";
import { type Catalogs, costAt, noCatalogs } from "./costs.ts";
import { type Turn, contextOf } from "./ledger.ts";

export const RULE_CODES = ["context", "turns", "mechanical", "subagents"] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/** Every threshold of the rules, in one place; `enabled` is each rule's default. */
export const USAGE_RULES = {
  context: { enabled: true, experimental: false, maxContext: 300_000 },
  turns: { enabled: true, experimental: false, maxTurns: 300 },
  mechanical: { enabled: true, experimental: true, minCalls: 30, minShare: 0.75, maxOutput: 500 },
  subagents: { enabled: true, experimental: false, maxShare: 0.5, minContext: 1_000_000 },
} as const;

export type RuleSwitches = Record<RuleCode, boolean>;

export type Suggestion = {
  rule: RuleCode;
  provider: string;
  sessionId: string;
  /** The main-session call (1-based) at which the rule first held; for subagents, main calls made by then. */
  turn: number;
  /** Unix milliseconds of the call at which it held. */
  at: number;
  /** context: that call's context; turns: the session's main calls; mechanical, subagents: the share in per mille. */
  value: number;
  experimental: boolean;
  /** What the habit cost the whole session at API prices, in dollars; 0 when unknown. */
  excessUsd: number;
  /** The working directory of that call (for its repository key; never sent). */
  cwd: string;
};

/** One session's calls, each list in time order. */
export type SessionCalls = { provider: string; sessionId: string; main: Turn[]; subagents: Turn[] };

export const isRuleCode = (s: string): s is RuleCode => (RULE_CODES as readonly string[]).includes(s);

/** The switches in force: the stored ones, the defaults for the rest. */
export function ruleSwitches(stored: Partial<Record<string, boolean>> | undefined): RuleSwitches {
  const out = {} as RuleSwitches;
  for (const code of RULE_CODES) {
    const v = stored?.[code];
    out[code] = typeof v === "boolean" ? v : USAGE_RULES[code].enabled;
  }
  return out;
}

/** Calls grouped by session (a subagent's calls go to its parent session), in time order. */
export function groupSessions(turns: Iterable<Turn>): SessionCalls[] {
  const by = new Map<string, SessionCalls>();
  for (const t of turns) {
    const id = `${t.provider}\u0000${t.sessionId}`;
    let s = by.get(id);
    if (!s) by.set(id, (s = { provider: t.provider, sessionId: t.sessionId, main: [], subagents: [] }));
    (t.subagent ? s.subagents : s.main).push(t);
  }
  for (const s of by.values()) {
    s.main.sort((a, b) => a.at - b.at);
    s.subagents.sort((a, b) => a.at - b.at);
  }
  return [...by.values()];
}

/** A call that only read, searched or ran commands (as `catalog` names them), and wrote little. */
export function isMechanical(t: Pick<Turn, "tools" | "output">, catalog: Pick<ModelCatalog, "mechanicalTools">): boolean {
  return t.tools.length > 0 && t.tools.every((x) => catalog.mechanicalTools.includes(x)) && t.output <= USAGE_RULES.mechanical.maxOutput;
}

type Hit = Omit<Suggestion, "provider" | "sessionId">;
type Rule = (s: SessionCalls, catalog: ModelCatalog | undefined) => Hit | undefined;

const sum = (xs: Iterable<number>) => {
  let total = 0;
  for (const x of xs) total += x;
  return total;
};

/** Dollars of `t` at its model's price; 0 when unknown. */
const costIn = (catalog: ModelCatalog | undefined, t: Turn) => {
  const price = catalog?.price(t.model);
  return price ? costAt(t, price) : 0;
};

const contextRule: Rule = (s, catalog) => {
  const { maxContext, experimental } = USAGE_RULES.context;
  const i = s.main.findIndex((t) => contextOf(t) > maxContext);
  const t = s.main[i];
  if (!t) return undefined;
  const excessUsd = sum(s.main.map((c) => (Math.max(0, contextOf(c) - maxContext) * (catalog?.price(c.model)?.cacheRead ?? 0)) / 1e6));
  return { rule: "context", turn: i + 1, at: t.at, value: contextOf(t), experimental, excessUsd, cwd: t.cwd };
};

const turnsRule: Rule = (s, catalog) => {
  const { maxTurns, experimental } = USAGE_RULES.turns;
  const t = s.main[maxTurns];
  if (!t) return undefined;
  const excessUsd = sum(s.main.slice(maxTurns).map((c) => costIn(catalog, c)));
  return { rule: "turns", turn: maxTurns + 1, at: t.at, value: s.main.length, experimental, excessUsd, cwd: t.cwd };
};

const mechanicalRule: Rule = (s, catalog) => {
  if (!catalog) return undefined;
  const { minCalls, minShare, experimental } = USAGE_RULES.mechanical;
  const strongCalls = s.main.filter((t) => catalog.tier(t.model) === "strong");
  let strong = 0;
  let mechanical = 0;
  for (const t of strongCalls) {
    strong++;
    if (isMechanical(t, catalog)) mechanical++;
    if (strong >= minCalls && mechanical / strong >= minShare) {
      const excessUsd = sum(
        strongCalls
          .filter((c) => isMechanical(c, catalog))
          .map((c) => {
            const price = catalog.price(c.model);
            const lighter = catalog.lighterPrice(c.model);
            return price && lighter ? Math.max(0, costAt(c, price) - costAt(c, lighter)) : 0;
          }),
      );
      return { rule: "mechanical", turn: s.main.indexOf(t) + 1, at: t.at, value: Math.round((1000 * mechanical) / strong), experimental, excessUsd, cwd: t.cwd };
    }
  }
  return undefined;
};

const subagentsRule: Rule = (s) => {
  const { maxShare, minContext, experimental } = USAGE_RULES.subagents;
  if (s.subagents.length === 0) return undefined;
  let main = 0;
  let sub = 0;
  let mainCalls = 0;
  let lastMainCwd = "";
  let i = 0;
  let j = 0;
  // Both lists in time order, merged; a main call goes first at the same time.
  while (i < s.main.length || j < s.subagents.length) {
    const m = s.main[i];
    const a = s.subagents[j];
    const t = m && (!a || m.at <= a.at) ? m : a;
    if (!t) break;
    if (t === m) {
      i++;
      main += contextOf(t);
      mainCalls++;
      lastMainCwd = t.cwd;
    } else {
      j++;
      sub += contextOf(t);
    }
    const total = main + sub;
    if (total >= minContext && sub / total > maxShare) {
      return { rule: "subagents", turn: mainCalls, at: t.at, value: Math.round((1000 * sub) / total), experimental, excessUsd: 0, cwd: lastMainCwd || t.cwd };
    }
  }
  return undefined;
};

const RULES: Record<RuleCode, Rule> = {
  context: contextRule,
  turns: turnsRule,
  mechanical: mechanicalRule,
  subagents: subagentsRule,
};

/** The suggestions for one session from the rules switched on, in RULE_CODES order. */
export function evaluateSession(s: SessionCalls, on: RuleSwitches = ruleSwitches(undefined), catalogs: Catalogs = noCatalogs): Suggestion[] {
  const out: Suggestion[] = [];
  const catalog = catalogs(s.provider);
  for (const code of RULE_CODES) {
    if (!on[code]) continue;
    const hit = RULES[code](s, catalog);
    if (hit) out.push({ ...hit, provider: s.provider, sessionId: s.sessionId });
  }
  return out;
}

/** The suggestions for every session in `turns`. */
export function evaluate(turns: Iterable<Turn>, on?: RuleSwitches, catalogs: Catalogs = noCatalogs): Suggestion[] {
  return groupSessions(turns).flatMap((s) => evaluateSession(s, on, catalogs));
}
