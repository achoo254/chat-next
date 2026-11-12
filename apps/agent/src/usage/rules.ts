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
//    searches or runs a command (MECHANICAL_TOOLS), and it wrote at most
//    maxOutput tokens. The rule holds once the session made at least
//    minCalls main-session calls on a strong model (its id names one of
//    strongModels) and at least minShare of them were mechanical.
// 4. subagents: the session's subagents carried more than maxShare of its
//    context (main and subagent calls together), once that context reached
//    minContext.
//
// Context of a call = input + cache read + cache write tokens. A suggestion
// holds numbers, a rule code and the session's id only.
import { type Turn, contextOf } from "./ledger.ts";

export const RULE_CODES = ["context", "turns", "mechanical", "subagents"] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/** Tools that read, search or run a command: what the mechanical rule counts. */
export const MECHANICAL_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "LS", "Bash", "BashOutput", "NotebookRead"];

/** Every threshold of the rules, in one place; `enabled` is each rule's default. */
export const USAGE_RULES = {
  context: { enabled: true, experimental: false, maxContext: 300_000 },
  turns: { enabled: true, experimental: false, maxTurns: 300 },
  mechanical: { enabled: true, experimental: true, strongModels: ["opus"], minCalls: 30, minShare: 0.75, maxOutput: 500 },
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

const isStrong = (model: string) => USAGE_RULES.mechanical.strongModels.some((m) => model.toLowerCase().includes(m));

/** A call that only read, searched or ran commands, and wrote little. */
export function isMechanical(t: Pick<Turn, "tools" | "output">): boolean {
  return t.tools.length > 0 && t.tools.every((x) => MECHANICAL_TOOLS.includes(x)) && t.output <= USAGE_RULES.mechanical.maxOutput;
}

function contextRule(s: SessionCalls): Omit<Suggestion, "provider" | "sessionId"> | undefined {
  const { maxContext, experimental } = USAGE_RULES.context;
  const i = s.main.findIndex((t) => contextOf(t) > maxContext);
  const t = s.main[i];
  return t ? { rule: "context", turn: i + 1, at: t.at, value: contextOf(t), experimental, cwd: t.cwd } : undefined;
}

function turnsRule(s: SessionCalls): Omit<Suggestion, "provider" | "sessionId"> | undefined {
  const { maxTurns, experimental } = USAGE_RULES.turns;
  const t = s.main[maxTurns];
  return t ? { rule: "turns", turn: maxTurns + 1, at: t.at, value: s.main.length, experimental, cwd: t.cwd } : undefined;
}

function mechanicalRule(s: SessionCalls): Omit<Suggestion, "provider" | "sessionId"> | undefined {
  const { minCalls, minShare, experimental } = USAGE_RULES.mechanical;
  let strong = 0;
  let mechanical = 0;
  for (const [i, t] of s.main.entries()) {
    if (!isStrong(t.model)) continue;
    strong++;
    if (isMechanical(t)) mechanical++;
    if (strong >= minCalls && mechanical / strong >= minShare) {
      return { rule: "mechanical", turn: i + 1, at: t.at, value: Math.round((1000 * mechanical) / strong), experimental, cwd: t.cwd };
    }
  }
  return undefined;
}

function subagentsRule(s: SessionCalls): Omit<Suggestion, "provider" | "sessionId"> | undefined {
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
      return { rule: "subagents", turn: mainCalls, at: t.at, value: Math.round((1000 * sub) / total), experimental, cwd: lastMainCwd || t.cwd };
    }
  }
  return undefined;
}

const RULES: Record<RuleCode, (s: SessionCalls) => Omit<Suggestion, "provider" | "sessionId"> | undefined> = {
  context: contextRule,
  turns: turnsRule,
  mechanical: mechanicalRule,
  subagents: subagentsRule,
};

/** The suggestions for one session from the rules switched on, in RULE_CODES order. */
export function evaluateSession(s: SessionCalls, on: RuleSwitches = ruleSwitches(undefined)): Suggestion[] {
  const out: Suggestion[] = [];
  for (const code of RULE_CODES) {
    if (!on[code]) continue;
    const hit = RULES[code](s);
    if (hit) out.push({ ...hit, provider: s.provider, sessionId: s.sessionId });
  }
  return out;
}

/** The suggestions for every session in `turns`. */
export function evaluate(turns: Iterable<Turn>, on?: RuleSwitches): Suggestion[] {
  return groupSessions(turns).flatMap((s) => evaluateSession(s, on));
}
