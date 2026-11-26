// How the "Hiệu quả" page writes its numbers and the rules' suggestions, in
// the page's language (MachinesCopy["usage"].locale).
import { UsageRule, type UsageSuggestion } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../copy-vi.ts";

type UsageCopy = MachinesCopy["usage"];
type RuleText = UsageCopy["rules"]["context"];

/** Token counts, short: "396,5 N" / "396.5K". */
export function tokens(u: UsageCopy, n: number): string {
	return new Intl.NumberFormat(u.locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Whole numbers with the language's grouping. */
export function count(u: UsageCopy, n: number): string {
	return new Intl.NumberFormat(u.locale).format(n);
}

/** A moment, short date and time. */
export function moment(u: UsageCopy, ms: number): string {
	return new Intl.DateTimeFormat(u.locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
}

/** The name and sentence of a rule; a rule this page does not know yet gets a neutral one. */
export function ruleCopy(u: UsageCopy, rule: UsageRule): RuleText {
	switch (rule) {
		case UsageRule.CONTEXT:
			return u.rules.context;
		case UsageRule.TURNS:
			return u.rules.turns;
		case UsageRule.MECHANICAL:
			return u.rules.mechanical;
		case UsageRule.SUBAGENTS:
			return u.rules.subagents;
		default:
			return u.rules.unknown;
	}
}

/** A suggestion's value as its rule means it: context in tokens, calls, or a share given per mille. */
export function hintValue(u: UsageCopy, s: Pick<UsageSuggestion, "rule" | "value">): string {
	const v = Number(s.value);
	switch (s.rule) {
		case UsageRule.CONTEXT:
			return tokens(u, v);
		case UsageRule.MECHANICAL:
		case UsageRule.SUBAGENTS:
			return `${Math.round(v / 10)}%`;
		default:
			return count(u, v);
	}
}

/** Dollars at API prices: "$512", "$3,50", "$0,0123". */
export function usd(u: UsageCopy, n: number): string {
	const digits = n >= 100 ? 0 : n >= 1 ? 2 : 4;
	return new Intl.NumberFormat(u.locale, { style: "currency", currency: "USD", minimumFractionDigits: n >= 100 ? 0 : 2, maximumFractionDigits: digits }).format(n);
}

/** A share 0-1 as a whole percent, a small non-zero share as "<1%". */
export function percent(u: UsageCopy, share: number): string {
	if (share > 0 && share < 0.005) return `<${new Intl.NumberFormat(u.locale, { style: "percent" }).format(0.01)}`;
	return new Intl.NumberFormat(u.locale, { style: "percent", maximumFractionDigits: 0 }).format(share);
}
